import { requiredFormatContributionFor, type DocumentFormat } from '@sciemd/core';
import type { FileMetadata } from '../app/documentState';
import {
  canonicalComparisonKey,
  type DocumentId,
  type DocumentLocator,
  type SourceRevision,
} from '../app/documentIdentity';
import {
  clearNativeRecoverySnapshot,
  listNativeRecoverySnapshots,
  writeNativeRecoverySnapshot,
  type NativeRecoverySnapshot,
} from './nativeRecoveryService';
import {
  createPersistenceEnvelope,
  decodeRecoveryDraft,
  encodePersistenceEnvelope,
  nextPersistenceGeneration,
  PERSISTENCE_QUARANTINE_PREFIX,
  quarantinePersistenceValue,
  sha256Hex,
  type PersistenceEnvelope,
  type RecoveryDraftPayload,
} from './persistence/persistenceRegistry';

export const RECOVERY_CATALOG_SCHEMA_VERSION = 1;
export const RECOVERY_CHECKPOINT_LAG_MS = 600;
export const RECOVERY_CHECKPOINT_MAX_LAG_MS = 2_000;
export const RECOVERY_CATALOG_SOFT_QUOTA_BYTES = 128 * 1024 * 1024;

const CATALOG_KEY_PREFIX = 'scie_md.recoveryCatalog.v1.';
const TOMBSTONE_KEY_PREFIX = 'scie_md.recoveryCatalog.tombstone.v1.';
const PENDING_SUFFIX = '.pending';
const DB_NAME = 'scie_md_drafts';
const STORE_NAME = 'drafts';
const LOCAL_STORAGE_LIMIT_BYTES = 512 * 1024;
const memoryEntries = new Map<string, string>();
const memoryTombstones = new Map<DocumentId, RecoveryCatalogTombstone>();
const pendingOperations = new Map<string, Promise<void>>();

export interface RecoveryCatalogEntry {
  schemaVersion: 1;
  documentId: DocumentId;
  sourceRevision: SourceRevision;
  locator: DocumentLocator;
  sourceText: string;
  savedSourceText?: string;
  format: DocumentFormat;
  mediaType: string;
  savedAt: number;
  generation: number;
  baseMetadata?: {
    lastKnownMtimeMs: number;
    lastKnownSizeBytes: number;
    contentHash: string | null;
  };
}

export interface RecoveryCatalogTombstone {
  schemaVersion: 1;
  documentId: DocumentId;
  sourceRevision: SourceRevision;
  deletedAt: number;
}

export interface RecoveryCatalogItemModel {
  documentId: DocumentId;
  sourceRevision: SourceRevision;
  locator: DocumentLocator;
  format: DocumentFormat;
  mediaType: string;
  savedAt: number;
  generation: number;
  sourceTextBytes: number;
  emptySource: boolean;
}

export interface RecoveryCenterModel {
  schemaVersion: 1;
  entries: RecoveryCatalogItemModel[];
  totalBytes: number;
  softQuotaBytes: number;
  quotaState: 'within-budget' | 'attention-required';
  pruningPolicy: 'never-delete-current-dirty-entry';
}

export interface RecoveryCheckpointInput {
  documentId: DocumentId;
  sourceRevision: SourceRevision;
  locator: DocumentLocator;
  sourceText: string;
  savedSourceText?: string;
  format: DocumentFormat;
  savedAt?: number;
  baseMetadata?: FileMetadata | null;
  /** Optional bounded native fallback; browser catalog always retains sourceText. */
  nativeSourceText?: string;
}

export function checkpointRecoveryEntrySync(input: RecoveryCheckpointInput): RecoveryCatalogEntry {
  const key = catalogKey(input.documentId);
  const previousRaw = safeLocalGet(key) ?? memoryEntries.get(key);
  return publishBrowserEntry(input, nextPersistenceGeneration(previousRaw, 'recoveryDraft'));
}

export async function checkpointRecoveryEntry(input: RecoveryCheckpointInput): Promise<RecoveryCatalogEntry> {
  const key = catalogKey(input.documentId);
  const indexedRaw = await readIndexed(key);
  const previousRaw = indexedRaw ?? safeLocalGet(key) ?? memoryEntries.get(key);
  const entry = publishBrowserEntry(input, nextPersistenceGeneration(previousRaw, 'recoveryDraft'));
  const raw = encodeCatalogEntry(entry);
  if (supportsIndexedDb()) {
    await queueOperation(key, async () => {
      const stored = await writeIndexed(key, raw);
      if (stored) removeLocalCommitted(key);
    });
  }
  await writeNativeRecoverySnapshot({
    sourceText: input.nativeSourceText ?? entry.sourceText,
    markdown: input.nativeSourceText ?? entry.sourceText,
    filePath: entry.locator.kind === 'file' ? entry.locator.displayPath : null,
    format: entry.format,
    updatedAtMs: entry.savedAt,
    documentId: entry.documentId,
    sourceRevision: entry.sourceRevision,
    catalogSchemaVersion: entry.schemaVersion,
    mediaType: entry.mediaType,
  });
  return entry;
}

export async function clearRecoveryCatalogEntry(
  documentId: DocumentId,
  upToSourceRevision: SourceRevision,
): Promise<boolean> {
  const key = catalogKey(documentId);
  const raws = [safeLocalGet(key), memoryEntries.get(key), await readIndexed(key)].filter((value): value is string => typeof value === 'string');
  const newest = newestEntry(raws.map((raw) => decodeCatalogRaw(raw)).filter((entry): entry is RecoveryCatalogEntry => entry !== null));
  if (newest && newest.sourceRevision > upToSourceRevision) return false;
  writeTombstone({ schemaVersion: 1, documentId, sourceRevision: upToSourceRevision, deletedAt: Date.now() });
  memoryEntries.delete(key);
  safeLocalRemove(key);
  safeLocalRemove(`${key}${PENDING_SUFFIX}`);
  await queueOperation(key, () => deleteIndexed(key));
  await clearNativeRecoverySnapshot(
    newest?.locator.kind === 'file' ? newest.locator.displayPath : null,
    documentId,
    upToSourceRevision,
  );
  return true;
}

export async function loadRecoveryCatalog(options: { includeNative?: boolean } = {}): Promise<RecoveryCatalogEntry[]> {
  const candidates: RecoveryCatalogEntry[] = [];
  for (const [key, raw] of memoryEntries) {
    if (key.startsWith(CATALOG_KEY_PREFIX)) collectDecoded(key, raw, candidates);
  }
  if (typeof localStorage !== 'undefined') {
    const keys = Array.from({ length: localStorage.length }, (_value, index) => localStorage.key(index));
    for (const key of keys) {
      if (!key?.startsWith(CATALOG_KEY_PREFIX)) continue;
      const raw = safeLocalGet(key);
      if (key.endsWith(PENDING_SUFFIX)) {
        if (raw) quarantinePersistenceValue(localStorage, key, raw, 'interrupted-publication', 'recoveryDraft');
        continue;
      }
      if (raw) collectDecoded(key, raw, candidates);
    }
  }
  for (const [key, raw] of await listIndexedCatalogValues()) collectDecoded(key, raw, candidates);
  if (options.includeNative !== false) {
    for (const snapshot of await listNativeRecoverySnapshots()) {
      const entry = nativeSnapshotToEntry(snapshot);
      if (entry) candidates.push(entry);
    }
  }
  const byDocument = new Map<DocumentId, RecoveryCatalogEntry>();
  const tombstones = readTombstones();
  for (const entry of candidates) {
    if ((tombstones.get(entry.documentId)?.sourceRevision ?? -1) >= entry.sourceRevision) continue;
    const current = byDocument.get(entry.documentId);
    if (!current || compareEntry(entry, current) > 0) byDocument.set(entry.documentId, entry);
  }
  return Array.from(byDocument.values()).sort((left, right) => right.savedAt - left.savedAt || String(left.documentId).localeCompare(String(right.documentId)));
}

export async function createRecoveryCenterModel(existingEntries?: readonly RecoveryCatalogEntry[]): Promise<RecoveryCenterModel> {
  const entries = existingEntries?.slice() ?? await loadRecoveryCatalog();
  const items = entries.map((entry): RecoveryCatalogItemModel => ({
    documentId: entry.documentId,
    sourceRevision: entry.sourceRevision,
    locator: entry.locator,
    format: entry.format,
    mediaType: entry.mediaType,
    savedAt: entry.savedAt,
    generation: entry.generation,
    sourceTextBytes: byteLength(entry.sourceText),
    emptySource: entry.sourceText.length === 0,
  }));
  const totalBytes = items.reduce((sum, entry) => sum + entry.sourceTextBytes, 0);
  return {
    schemaVersion: 1,
    entries: items,
    totalBytes,
    softQuotaBytes: RECOVERY_CATALOG_SOFT_QUOTA_BYTES,
    quotaState: recoveryQuotaState(totalBytes),
    pruningPolicy: 'never-delete-current-dirty-entry',
  };
}

export function recoveryQuotaState(totalBytes: number): RecoveryCenterModel['quotaState'] {
  return totalBytes <= RECOVERY_CATALOG_SOFT_QUOTA_BYTES ? 'within-budget' : 'attention-required';
}

export async function flushRecoveryCatalogForTests(): Promise<void> {
  while (pendingOperations.size > 0) await Promise.all(Array.from(pendingOperations.values()));
}

export function resetRecoveryCatalogForTests(): void {
  memoryEntries.clear();
  memoryTombstones.clear();
  pendingOperations.clear();
}

function publishBrowserEntry(input: RecoveryCheckpointInput, generation: number): RecoveryCatalogEntry {
  const entry = entryFromInput(input, generation);
  const key = catalogKey(input.documentId);
  const raw = encodeCatalogEntry(entry);
  memoryEntries.set(key, raw);
  if (byteLength(raw) <= LOCAL_STORAGE_LIMIT_BYTES && typeof localStorage !== 'undefined') {
    const pending = encodePersistenceEnvelope(createPersistenceEnvelope('recoveryDraft', payloadForEntry(entry), generation, 'pending'));
    try {
      localStorage.setItem(`${key}${PENDING_SUFFIX}`, pending);
      localStorage.setItem(key, raw);
      localStorage.removeItem(`${key}${PENDING_SUFFIX}`);
    } catch (error) {
      emitQuotaWarning(error);
    }
  }
  return entry;
}

function entryFromInput(input: RecoveryCheckpointInput, generation: number): RecoveryCatalogEntry {
  const definition = requiredFormatContributionFor(input.format);
  const entry: RecoveryCatalogEntry = {
    schemaVersion: RECOVERY_CATALOG_SCHEMA_VERSION,
    documentId: input.documentId,
    sourceRevision: input.sourceRevision,
    locator: cloneLocator(input.locator),
    sourceText: input.sourceText,
    ...(typeof input.savedSourceText === 'string' ? { savedSourceText: input.savedSourceText } : {}),
    format: input.format,
    mediaType: definition.mediaTypes[0] ?? 'text/plain',
    savedAt: input.savedAt ?? Date.now(),
    generation,
  };
  if (input.baseMetadata) {
    entry.baseMetadata = {
      lastKnownMtimeMs: input.baseMetadata.lastKnownMtimeMs,
      lastKnownSizeBytes: input.baseMetadata.lastKnownSizeBytes,
      contentHash: input.baseMetadata.contentHash,
    };
  }
  return entry;
}

function payloadForEntry(entry: RecoveryCatalogEntry): RecoveryDraftPayload {
  return {
    sourceText: entry.sourceText,
    ...(typeof entry.savedSourceText === 'string' ? { savedSourceText: entry.savedSourceText } : {}),
    savedAt: entry.savedAt,
    format: entry.format,
    ...(entry.baseMetadata ? { baseMetadata: entry.baseMetadata } : {}),
    catalogEntry: {
      schemaVersion: 1,
      documentId: entry.documentId,
      sourceRevision: entry.sourceRevision,
      locator: entry.locator.kind === 'untitled'
        ? { kind: 'untitled', untitledId: entry.locator.untitledId }
        : { ...entry.locator, aliases: [...entry.locator.aliases] },
      mediaType: entry.mediaType,
    },
  };
}

function encodeCatalogEntry(entry: RecoveryCatalogEntry): string {
  return encodePersistenceEnvelope(createPersistenceEnvelope('recoveryDraft', payloadForEntry(entry), entry.generation));
}

function decodeCatalogRaw(raw: string): RecoveryCatalogEntry | null {
  const decoded = decodeRecoveryDraft(raw, 'markdown');
  if (decoded.status !== 'ready' || !decoded.envelope.payload.catalogEntry) return null;
  return entryFromPayload(decoded.envelope as PersistenceEnvelope<RecoveryDraftPayload>);
}

function entryFromPayload(envelope: PersistenceEnvelope<RecoveryDraftPayload>): RecoveryCatalogEntry {
  const payload = envelope.payload;
  const catalog = payload.catalogEntry!;
  return {
    schemaVersion: 1,
    documentId: catalog.documentId as DocumentId,
    sourceRevision: catalog.sourceRevision as SourceRevision,
    locator: cloneLocator(catalog.locator as DocumentLocator),
    sourceText: payload.sourceText,
    ...(typeof payload.savedSourceText === 'string' ? { savedSourceText: payload.savedSourceText } : {}),
    format: payload.format,
    mediaType: catalog.mediaType,
    savedAt: payload.savedAt,
    generation: envelope.generation,
    ...(payload.baseMetadata ? { baseMetadata: payload.baseMetadata } : {}),
  };
}

function collectDecoded(key: string, raw: string, target: RecoveryCatalogEntry[]): void {
  const decoded = decodeRecoveryDraft(raw, 'markdown');
  if (decoded.status === 'ready' && decoded.envelope.payload.catalogEntry) {
    target.push(entryFromPayload(decoded.envelope));
    return;
  }
  if (decoded.status === 'quarantine' && typeof localStorage !== 'undefined' && safeLocalGet(key) !== null) {
    quarantinePersistenceValue(localStorage, key, raw, decoded.reason, 'recoveryDraft');
  }
}

function nativeSnapshotToEntry(snapshot: NativeRecoverySnapshot): RecoveryCatalogEntry | null {
  if (!snapshot.documentId || snapshot.catalogSchemaVersion !== 1 || typeof snapshot.sourceRevision !== 'number') return null;
  const format = snapshot.format ?? 'markdown';
  const filePath = snapshot.filePath;
  const locator: DocumentLocator = filePath
    ? {
        kind: 'file',
        displayPath: filePath,
        comparisonKey: canonicalComparisonKey(filePath),
        identityConfidence: 'pathOnly',
        aliases: [],
      }
    : { kind: 'untitled', untitledId: `recovered-${snapshot.documentId}` as never };
  return {
    schemaVersion: 1,
    documentId: snapshot.documentId as DocumentId,
    sourceRevision: snapshot.sourceRevision as SourceRevision,
    locator,
    sourceText: snapshot.sourceText ?? snapshot.markdown,
    format,
    mediaType: snapshot.mediaType ?? requiredFormatContributionFor(format).mediaTypes[0] ?? 'text/plain',
    savedAt: snapshot.updatedAtMs,
    generation: snapshot.generation ?? 1,
  };
}

function newestEntry(entries: RecoveryCatalogEntry[]): RecoveryCatalogEntry | null {
  return entries.sort(compareEntry).at(-1) ?? null;
}

function compareEntry(left: RecoveryCatalogEntry, right: RecoveryCatalogEntry): number {
  return left.sourceRevision - right.sourceRevision || left.generation - right.generation || left.savedAt - right.savedAt;
}

function cloneLocator(locator: DocumentLocator): DocumentLocator {
  return locator.kind === 'untitled'
    ? { kind: 'untitled', untitledId: locator.untitledId }
    : { ...locator, aliases: [...locator.aliases] };
}

function catalogKey(documentId: DocumentId): string {
  return `${CATALOG_KEY_PREFIX}${sha256Hex(String(documentId))}`;
}

function tombstoneKey(documentId: DocumentId): string {
  return `${TOMBSTONE_KEY_PREFIX}${sha256Hex(String(documentId))}`;
}

function writeTombstone(next: RecoveryCatalogTombstone): void {
  const current = readTombstones().get(next.documentId);
  if (current && current.sourceRevision >= next.sourceRevision) return;
  memoryTombstones.set(next.documentId, next);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(tombstoneKey(next.documentId), JSON.stringify(next));
  } catch {
    // In-memory tombstone still prevents same-session resurrection; native clear remains revision-fenced.
  }
}

function readTombstones(): Map<DocumentId, RecoveryCatalogTombstone> {
  const result = new Map(memoryTombstones);
  if (typeof localStorage === 'undefined') return result;
  const keys = Array.from({ length: localStorage.length }, (_value, index) => localStorage.key(index));
  for (const key of keys) {
    if (!key?.startsWith(TOMBSTONE_KEY_PREFIX)) continue;
    try {
      const record = JSON.parse(localStorage.getItem(key) ?? '') as Partial<RecoveryCatalogTombstone>;
      if (record.schemaVersion !== 1 || typeof record.documentId !== 'string' || !Number.isSafeInteger(record.sourceRevision) || typeof record.deletedAt !== 'number') continue;
      const tombstone = record as RecoveryCatalogTombstone;
      const current = result.get(tombstone.documentId);
      if (!current || current.sourceRevision < tombstone.sourceRevision) result.set(tombstone.documentId, tombstone);
    } catch {
      // Invalid tombstones do not authorize deletion or hide recovery content.
    }
  }
  return result;
}

function safeLocalGet(key: string): string | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key); } catch { return null; }
}

function safeLocalRemove(key: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(key); } catch { /* best effort */ }
}

function removeLocalCommitted(key: string): void {
  safeLocalRemove(key);
  safeLocalRemove(`${key}${PENDING_SUFFIX}`);
}

function supportsIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!supportsIndexedDb()) return reject(new Error('IndexedDB is unavailable.'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open recovery database.'));
  });
}

async function writeIndexed(key: string, raw: string): Promise<boolean> {
  try {
    const db = await openDb();
    await transact(db, 'readwrite', (store) => store.put(raw, key));
    db.close();
    return true;
  } catch (error) {
    emitQuotaWarning(error);
    return false;
  }
}

async function readIndexed(key: string): Promise<string | null> {
  try {
    const db = await openDb();
    const value = await transact<unknown>(db, 'readonly', (store) => store.get(key));
    db.close();
    return typeof value === 'string' ? value : null;
  } catch { return null; }
}

async function deleteIndexed(key: string): Promise<void> {
  try {
    const db = await openDb();
    await transact(db, 'readwrite', (store) => store.delete(key));
    db.close();
  } catch { /* retaining a tombstoned browser copy is safer than failing close */ }
}

async function listIndexedCatalogValues(): Promise<Array<[string, string]>> {
  if (!supportsIndexedDb()) return [];
  try {
    const db = await openDb();
    const values = await new Promise<Array<[string, string]>>((resolve, reject) => {
      const result: Array<[string, string]> = [];
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (typeof cursor.key === 'string' && cursor.key.startsWith(CATALOG_KEY_PREFIX) && typeof cursor.value === 'string') {
          result.push([cursor.key, cursor.value]);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    return values;
  } catch { return []; }
}

function queueOperation(key: string, operation: () => Promise<void>): Promise<void> {
  const previous = pendingOperations.get(key) ?? Promise.resolve();
  let next: Promise<void>;
  next = previous.catch(() => undefined).then(operation).finally(() => {
    if (pendingOperations.get(key) === next) pendingOperations.delete(key);
  });
  pendingOperations.set(key, next);
  return next;
}

function transact<T>(db: IDBDatabase, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    let result: T;
    let requestComplete = false;
    request.onsuccess = () => {
      result = request.result;
      requestComplete = true;
    };
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Recovery catalog transaction aborted.'));
    transaction.oncomplete = () => {
      if (requestComplete) resolve(result);
      else reject(new Error('Recovery catalog transaction completed without a request result.'));
    };
  });
}

function emitQuotaWarning(error: unknown): void {
  console.warn('Recovery catalog storage is unavailable or full; the in-memory and native fallbacks remain active.', error);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('scienfy:draft-storage-warning', {
    detail: { message: 'Recovery storage is near its limit. Save documents to disk; ScieMD will not prune a current dirty recovery entry automatically.' },
  }));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
