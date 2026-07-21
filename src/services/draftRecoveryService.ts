import type { FileMetadata } from '../app/documentState';
import { formatFromPath } from '@sciemd/core';
import type { DocumentFormat } from '@sciemd/core';
import { canonicalComparisonKey } from '../app/documentIdentity';
import {
  clearNativeRecoverySnapshot,
  readNativeRecoverySnapshot,
  writeNativeRecoverySnapshot,
} from './nativeRecoveryService';
import {
  createPersistenceEnvelope,
  decodeRecoveryDraft,
  encodePersistenceEnvelope,
  nextPersistenceGeneration,
  PERSISTENCE_QUARANTINE_PREFIX,
  quarantinePersistenceValue,
  sha256Hex,
  type PersistenceQuarantineReason,
  type RecoveryDraftPayload,
} from './persistence/persistenceRegistry';

export interface UntitledDraft {
  sourceText?: string;
  markdown: string;
  savedAt: number;
  format: DocumentFormat;
  baseMetadata?: DraftBaseMetadata;
}

interface DraftBaseMetadata {
  lastKnownMtimeMs: number;
  lastKnownSizeBytes: number;
  contentHash: string | null;
}

const UNTITLED_DRAFT_KEY = 'scie_md.untitledDraft.v1';
const FILE_DRAFT_PREFIX = 'scie_md.fileDraft.v2.sha256.';
const LEGACY_FILE_DRAFT_PREFIX = 'scie_md.fileDraft.v1.';
const DRAFT_DB_NAME = 'scie_md_drafts';
const DRAFT_STORE_NAME = 'drafts';
const MAX_DRAFT_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const INDEXED_DRAFT_THRESHOLD_BYTES = 1024 * 1024;
const MAX_FILE_DRAFTS = 40;
const PENDING_SUFFIX = '.pending';
const memoryDrafts = new Map<string, string>();
const indexedDraftOperations = new Map<string, Promise<void>>();
let lastQuotaWarningAt = 0;

export function loadUntitledDraft(now = Date.now()): UntitledDraft | null {
  return loadBrowserDraft(UNTITLED_DRAFT_KEY, [], now, 'markdown');
}

export function saveUntitledDraft(sourceText: string, savedAt = Date.now(), format: DocumentFormat = 'markdown'): void {
  persistDraft(UNTITLED_DRAFT_KEY, draftWithOptionalBaseMetadata(sourceText, savedAt, undefined, format));
}

export async function saveUntitledDraftAsync(sourceText: string, savedAt = Date.now(), format: DocumentFormat = 'markdown'): Promise<void> {
  saveUntitledDraft(sourceText, savedAt, format);
  await drainIndexedDraftOperations();
  await writeNativeDraftSnapshot({ sourceText, filePath: null, savedAt, format });
}

export function clearUntitledDraft(): void {
  memoryDrafts.delete(UNTITLED_DRAFT_KEY);
  memoryDrafts.delete(`${UNTITLED_DRAFT_KEY}${PENDING_SUFFIX}`);
  try {
    localStorage.removeItem(UNTITLED_DRAFT_KEY);
    localStorage.removeItem(`${UNTITLED_DRAFT_KEY}${PENDING_SUFFIX}`);
  } catch {
    // Ignore storage failures; the saved document state remains authoritative.
  }
  void queueIndexedDraftDelete(UNTITLED_DRAFT_KEY);
}

export async function clearUntitledDraftAsync(): Promise<void> {
  clearUntitledDraft();
  await drainIndexedDraftOperations();
  await clearNativeRecoverySnapshot(null);
}

export function loadFileDraft(filePath: string, now = Date.now()): UntitledDraft | null {
  const key = fileDraftKey(filePath);
  const legacyKeys = legacyFileDraftKeys(filePath);
  const fallbackFormat = inferDraftFormat(filePath);
  return loadBrowserDraft(key, legacyKeys, now, fallbackFormat);
}

export function saveFileDraft(
  filePath: string,
  sourceText: string,
  savedAt = Date.now(),
  baseMetadata?: FileMetadata | null,
  format: DocumentFormat = inferDraftFormat(filePath),
): void {
  persistDraft(fileDraftKey(filePath), draftWithOptionalBaseMetadata(
    sourceText,
    savedAt,
    baseMetadata ? draftBaseMetadata(baseMetadata) : undefined,
    format,
  ));
}

export async function saveFileDraftAsync(
  filePath: string,
  sourceText: string,
  savedAt = Date.now(),
  baseMetadata?: FileMetadata | null,
  format: DocumentFormat = inferDraftFormat(filePath),
): Promise<void> {
  saveFileDraft(filePath, sourceText, savedAt, baseMetadata, format);
  await drainIndexedDraftOperations();
  await writeNativeDraftSnapshot({ sourceText, filePath, savedAt, format });
}

export function clearFileDraft(filePath: string): void {
  const key = fileDraftKey(filePath);
  const legacyKeys = legacyFileDraftKeys(filePath);
  memoryDrafts.delete(key);
  memoryDrafts.delete(`${key}${PENDING_SUFFIX}`);
  for (const legacyKey of legacyKeys) memoryDrafts.delete(legacyKey);
  try {
    localStorage.removeItem(key);
    localStorage.removeItem(`${key}${PENDING_SUFFIX}`);
    for (const legacyKey of legacyKeys) localStorage.removeItem(legacyKey);
  } catch {
    // Ignore storage failures; the saved document state remains authoritative.
  }
  void queueIndexedDraftDelete(key);
  for (const legacyKey of legacyKeys) void queueIndexedDraftDelete(legacyKey);
}

export async function clearFileDraftAsync(filePath: string): Promise<void> {
  clearFileDraft(filePath);
  await drainIndexedDraftOperations();
  await clearNativeRecoverySnapshot(filePath);
}

export async function loadUntitledDraftAsync(now = Date.now()): Promise<UntitledDraft | null> {
  return loadUntitledDraft(now)
    ?? await loadIndexedDraft(UNTITLED_DRAFT_KEY, now, 'markdown')
    ?? await loadNativeUntitledDraft(now);
}

export async function loadFileDraftAsync(filePath: string, now = Date.now()): Promise<UntitledDraft | null> {
  const legacyKeys = legacyFileDraftKeys(filePath);
  const fallbackFormat = inferDraftFormat(filePath);
  return loadFileDraft(filePath, now)
    ?? await loadIndexedDraft(fileDraftKey(filePath), now, fallbackFormat)
    ?? await loadFirstIndexedDraft(legacyKeys, now, fallbackFormat)
    ?? await loadNativeFileDraft(filePath, now);
}

export function shouldPersistUntitledDraft(sourceText: string, initialSourceText: string, options: { suppressBundledWelcome?: boolean } = {}): boolean {
  if (sourceText === initialSourceText) return false;
  if (options.suppressBundledWelcome && isBundledWelcomeMarkdown(sourceText) && isBundledWelcomeMarkdown(initialSourceText)) return false;
  return true;
}

export function shouldOfferFileDraftRestore(draft: UntitledDraft, diskMetadata: FileMetadata): boolean {
  if (draft.baseMetadata) {
    const base = draft.baseMetadata;
    if (base.contentHash && diskMetadata.contentHash && base.contentHash === diskMetadata.contentHash) return true;
    if (
      base.lastKnownMtimeMs > 0
      && base.lastKnownMtimeMs === diskMetadata.lastKnownMtimeMs
      && base.lastKnownSizeBytes === diskMetadata.lastKnownSizeBytes
    ) {
      return true;
    }
  }

  return draft.savedAt > diskMetadata.lastKnownMtimeMs + 1000;
}

export function isBundledWelcomeMarkdown(markdown: string): boolean {
  return /(?:^|\n)title:\s*["']?ScieMD Tutorial["']?/i.test(markdown)
    || /^#\s+ScieMD Tutorial\s*$/im.test(markdown);
}

function fileDraftKey(filePath: string): string {
  return `${FILE_DRAFT_PREFIX}${sha256Hex(normalizeDraftPath(filePath))}`;
}

function legacyFileDraftKeys(filePath: string): string[] {
  const normalized = normalizeDraftPath(filePath);
  const round3Normalized = legacyRound3NormalizeDraftPath(filePath);
  return Array.from(new Set([
    `${FILE_DRAFT_PREFIX}${sha256Hex(round3Normalized)}`,
    `${LEGACY_FILE_DRAFT_PREFIX}${encodeURIComponent(normalized)}`,
    `${LEGACY_FILE_DRAFT_PREFIX}${encodeURIComponent(round3Normalized)}`,
    `${LEGACY_FILE_DRAFT_PREFIX}${legacyStablePathHash(normalized)}`,
    `${LEGACY_FILE_DRAFT_PREFIX}${legacyStablePathHash(round3Normalized)}`,
  ]));
}

function normalizeDraftPath(value: string): string {
  return canonicalComparisonKey(value);
}

function legacyRound3NormalizeDraftPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized)) return normalized.toLowerCase();
  if (/^\/\/[^/]+\/[^/]+/.test(normalized)) return normalized.toLowerCase();
  return normalized;
}

function persistDraft(key: string, draft: UntitledDraft): void {
  const payload = draftToPersistencePayload(draft);
  const previousRaw = safeLocalStorageGet(key) ?? memoryDrafts.get(key);
  const generation = nextPersistenceGeneration(previousRaw, 'recoveryDraft');
  const pendingRaw = encodePersistenceEnvelope(createPersistenceEnvelope('recoveryDraft', payload, generation, 'pending'));
  const committedRaw = encodePersistenceEnvelope(createPersistenceEnvelope('recoveryDraft', payload, generation));
  memoryDrafts.set(key, committedRaw);
  pruneFileDrafts(key);
  const rawBytes = byteLength(committedRaw);
  void warnIfStorageQuotaIsTight(rawBytes);
  if (rawBytes >= INDEXED_DRAFT_THRESHOLD_BYTES) {
    void queueIndexedDraftSave(key, committedRaw, () => removeLocalDraft(key));
    return;
  }

  try {
    localStorage.setItem(`${key}${PENDING_SUFFIX}`, pendingRaw);
    localStorage.setItem(key, committedRaw);
    localStorage.removeItem(`${key}${PENDING_SUFFIX}`);
    pruneFileDrafts(key);
    void queueIndexedDraftDelete(key);
  } catch (error) {
    emitDraftStorageWarning(
      'Local draft storage is full. ScieMD will keep using the larger draft database for recovery.',
      error,
    );
    void queueIndexedDraftSave(key, committedRaw);
  }
}

function loadBrowserDraft(
  key: string,
  legacyKeys: readonly string[],
  now: number,
  fallbackFormat: DocumentFormat,
): UntitledDraft | null {
  const candidates = Array.from(new Set([key, ...legacyKeys]));
  for (const candidateKey of candidates) reconcileInterruptedLocalPublication(candidateKey);
  for (const candidateKey of candidates) {
    const localRaw = safeLocalStorageGet(candidateKey);
    const raw = localRaw ?? memoryDrafts.get(candidateKey);
    if (raw === null || raw === undefined) continue;
    const decoded = decodeRecoveryDraft(raw, fallbackFormat);
    if (decoded.status === 'quarantine') {
      if (localRaw !== null) {
        quarantinePersistenceValue(localStorage, candidateKey, raw, decoded.reason, 'recoveryDraft');
      }
      memoryDrafts.delete(candidateKey);
      continue;
    }
    const draft = persistencePayloadToDraft(decoded.envelope.payload);
    if (now - draft.savedAt > MAX_DRAFT_AGE_MS) {
      removeStoredDraftCandidate(candidateKey);
      continue;
    }
    if (candidateKey !== key || decoded.migratedFromVersion !== null || !isPersistenceEnvelopeRaw(raw)) {
      persistDraft(key, draft);
      if (candidateKey !== key && (memoryDrafts.has(key) || safeLocalStorageGet(key) !== null)) {
        removeStoredDraftCandidate(candidateKey);
      }
    } else {
      memoryDrafts.set(key, encodePersistenceEnvelope(decoded.envelope));
    }
    return draft;
  }
  return null;
}

function reconcileInterruptedLocalPublication(key: string): void {
  const pendingKey = `${key}${PENDING_SUFFIX}`;
  const raw = safeLocalStorageGet(pendingKey);
  if (raw === null) return;
  const decoded = decodeRecoveryDraft(raw, 'markdown');
  const reason = decoded.status === 'quarantine' ? decoded.reason : 'interrupted-publication';
  quarantinePersistenceValue(localStorage, pendingKey, raw, reason, 'recoveryDraft');
}

function removeStoredDraftCandidate(key: string): void {
  memoryDrafts.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // Expiry cleanup is best-effort and must not prevent other recovery reads.
  }
  void queueIndexedDraftDelete(key);
}

function safeLocalStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function draftToPersistencePayload(draft: UntitledDraft): RecoveryDraftPayload {
  const payload: RecoveryDraftPayload = {
    sourceText: draft.sourceText ?? draft.markdown,
    savedAt: draft.savedAt,
    format: draft.format,
  };
  if (draft.baseMetadata) payload.baseMetadata = draft.baseMetadata;
  return payload;
}

function persistencePayloadToDraft(payload: RecoveryDraftPayload): UntitledDraft {
  return draftWithOptionalBaseMetadata(payload.sourceText, payload.savedAt, payload.baseMetadata, payload.format);
}

function isPersistenceEnvelopeRaw(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as { family?: unknown; commitState?: unknown };
    return value.family === 'recoveryDraft' && value.commitState === 'committed';
  } catch {
    return false;
  }
}

function savedAtForStoredDraft(raw: unknown): number {
  const decoded = decodeRecoveryDraft(raw, 'markdown');
  return decoded.status === 'ready' ? decoded.envelope.payload.savedAt : 0;
}

function pruneFileDrafts(currentKey: string): void {
  if (!isFileDraftKey(currentKey)) return;

  const memoryCandidates = Array.from(memoryDrafts.entries())
    .filter(([key]) => isFileDraftKey(key))
    .map(([key, raw]) => ({ key, savedAt: savedAtForStoredDraft(raw) }));
  for (const stale of staleDraftKeys(memoryCandidates, currentKey)) {
    memoryDrafts.delete(stale);
  }

  try {
    const localCandidates: Array<{ key: string; savedAt: number }> = [];
    const localKeys = Array.from({ length: localStorage.length }, (_value, index) => localStorage.key(index));
    for (const key of localKeys) {
      if (!key || !isFileDraftKey(key)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const decoded = decodeRecoveryDraft(raw, 'markdown');
      if (decoded.status === 'quarantine') {
        quarantinePersistenceValue(localStorage, key, raw, decoded.reason, 'recoveryDraft');
        continue;
      }
      localCandidates.push({ key, savedAt: decoded.envelope.payload.savedAt });
    }
    for (const stale of staleDraftKeys(localCandidates, currentKey)) {
      localStorage.removeItem(stale);
      void queueIndexedDraftDelete(stale);
    }
  } catch {
    // Draft pruning is best-effort. Failure must not interrupt recovery writes.
  }
  void pruneIndexedFileDrafts(currentKey);
}

function staleDraftKeys(candidates: Array<{ key: string; savedAt: number }>, currentKey: string): string[] {
  return candidates
    .sort((left, right) => right.savedAt - left.savedAt || left.key.localeCompare(right.key))
    .slice(MAX_FILE_DRAFTS)
    .map((candidate) => candidate.key)
    .filter((key) => key !== currentKey);
}

function isFileDraftKey(key: string): boolean {
  return key.startsWith(FILE_DRAFT_PREFIX) || key.startsWith(LEGACY_FILE_DRAFT_PREFIX);
}

function draftBaseMetadata(metadata: FileMetadata): DraftBaseMetadata {
  return {
    lastKnownMtimeMs: metadata.lastKnownMtimeMs,
    lastKnownSizeBytes: metadata.lastKnownSizeBytes,
    contentHash: metadata.contentHash,
  };
}

function normalizeDraftBaseMetadata(value: unknown): DraftBaseMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<DraftBaseMetadata>;
  if (
    typeof record.lastKnownMtimeMs !== 'number'
    || typeof record.lastKnownSizeBytes !== 'number'
    || !(typeof record.contentHash === 'string' || record.contentHash === null)
  ) {
    return undefined;
  }
  return {
    lastKnownMtimeMs: record.lastKnownMtimeMs,
    lastKnownSizeBytes: record.lastKnownSizeBytes,
    contentHash: record.contentHash,
  };
}

function draftWithOptionalBaseMetadata(
  sourceText: string,
  savedAt: number,
  baseMetadata: unknown,
  format: DocumentFormat,
): UntitledDraft {
  const normalizedBaseMetadata = normalizeDraftBaseMetadata(baseMetadata);
  return normalizedBaseMetadata
    ? { markdown: sourceText, savedAt, format, baseMetadata: normalizedBaseMetadata }
    : { markdown: sourceText, savedAt, format };
}

function normalizeDraftFormat(value: unknown, fallbackFormat: DocumentFormat): DocumentFormat {
  return isDocumentFormat(value) ? value : fallbackFormat;
}

function inferDraftFormat(path: string | null | undefined, fallbackFormat: DocumentFormat = 'markdown'): DocumentFormat {
  return formatFromPath(path) ?? fallbackFormat;
}

function isDocumentFormat(value: unknown): value is DocumentFormat {
  return value === 'markdown'
    || value === 'json'
    || value === 'jsonl'
    || value === 'yaml'
    || value === 'toml'
    || value === 'xml'
    || value === 'csv'
    || value === 'tsv'
    || value === 'plainText';
}

function removeLocalDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Local storage cleanup is opportunistic; memory/IndexedDB remain authoritative.
  }
}

async function loadFirstIndexedDraft(keys: string[], now: number, fallbackFormat: DocumentFormat): Promise<UntitledDraft | null> {
  for (const key of keys) {
    const draft = await loadIndexedDraft(key, now, fallbackFormat);
    if (draft) return draft;
  }
  return null;
}

async function loadNativeUntitledDraft(now: number): Promise<UntitledDraft | null> {
  const snapshot = await readNativeRecoverySnapshot(null);
  if (!snapshot || snapshot.filePath !== null) return null;
  return nativeSnapshotToDraft(
    snapshot.sourceText ?? snapshot.markdown,
    snapshot.updatedAtMs,
    now,
    normalizeDraftFormat(snapshot.format, 'markdown'),
  );
}

async function loadNativeFileDraft(filePath: string, now: number): Promise<UntitledDraft | null> {
  const snapshot = await readNativeRecoverySnapshot(filePath);
  if (!snapshot?.filePath) return null;
  if (normalizeDraftPath(snapshot.filePath) !== normalizeDraftPath(filePath)) return null;
  return nativeSnapshotToDraft(
    snapshot.sourceText ?? snapshot.markdown,
    snapshot.updatedAtMs,
    now,
    normalizeDraftFormat(snapshot.format, inferDraftFormat(filePath)),
  );
}

function nativeSnapshotToDraft(
  sourceText: string,
  savedAt: number,
  now: number,
  format: DocumentFormat,
): UntitledDraft | null {
  if (now - savedAt > MAX_DRAFT_AGE_MS) return null;
  return { markdown: sourceText, savedAt, format };
}

async function writeNativeDraftSnapshot({
  sourceText,
  filePath,
  savedAt,
  format,
}: {
  sourceText: string;
  filePath: string | null;
  savedAt: number;
  format: DocumentFormat;
}): Promise<void> {
  // Desktop recovery lives in the Tauri app-data diagnostics directory as a
  // keyed snapshot, with latest-recovery-snapshot.json kept as a compatibility mirror.
  await writeNativeRecoverySnapshot({
    sourceText,
    filePath,
    updatedAtMs: savedAt,
    format,
  });
}

function byteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  return unescape(encodeURIComponent(value)).length;
}

function emitDraftStorageWarning(message: string, error: unknown): void {
  console.warn(message, error);
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('scienfy:draft-storage-warning', {
    detail: { message },
  }));
}

async function warnIfStorageQuotaIsTight(nextWriteBytes: number): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return;
  const now = Date.now();
  if (now - lastQuotaWarningAt < 60_000) return;
  try {
    const estimate = await navigator.storage.estimate();
    const quota = estimate.quota ?? 0;
    if (quota <= 0) return;
    const usage = estimate.usage ?? 0;
    const projectedUsage = usage + nextWriteBytes;
    if (projectedUsage < quota * 0.9) return;
    lastQuotaWarningAt = now;
    emitDraftStorageWarning(
      'Local draft storage is nearly full. Save this document to disk or free browser storage so recovery drafts remain available.',
      new Error(`Storage usage ${usage} + draft ${nextWriteBytes} is close to quota ${quota}.`),
    );
  } catch {
    // Some runtimes expose navigator.storage but block estimate(); reactive recovery remains active.
  }
}

function legacyStablePathHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function supportsIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!supportsIndexedDb()) {
      reject(new Error('IndexedDB is not available.'));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DRAFT_DB_NAME, 1);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DRAFT_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open draft database.'));
  });
}

function queueIndexedDraftSave(key: string, raw: string, onCommitted?: () => void): Promise<void> {
  return queueIndexedDraftOperation(key, async () => {
    const committed = await saveIndexedDraft(key, raw);
    if (committed) onCommitted?.();
  });
}

function queueIndexedDraftDelete(key: string): Promise<void> {
  return queueIndexedDraftOperation(key, () => deleteIndexedDraft(key));
}

function queueIndexedDraftOperation(key: string, operation: () => Promise<void>): Promise<void> {
  const previous = indexedDraftOperations.get(key) ?? Promise.resolve();
  let next: Promise<void>;
  next = previous
    .catch(() => undefined)
    .then(operation)
    .catch(() => undefined)
    .finally(() => {
      if (indexedDraftOperations.get(key) === next) {
        indexedDraftOperations.delete(key);
      }
    });
  indexedDraftOperations.set(key, next);
  return next;
}

async function saveIndexedDraft(key: string, raw: string): Promise<boolean> {
  try {
    const db = await openDraftDb();
    await runDraftTransaction(db, 'readwrite', (store) => store.put(raw, key));
    db.close();
    return true;
  } catch (error) {
    emitDraftStorageWarning(
      'Draft database storage is unavailable or full. ScieMD will keep this recovery draft in memory for this session.',
      error,
    );
    return false;
  }
}

async function loadIndexedDraft(key: string, now: number, fallbackFormat: DocumentFormat): Promise<UntitledDraft | null> {
  try {
    const db = await openDraftDb();
    const rawDraft = await runDraftTransaction<unknown>(db, 'readonly', (store) => store.get(key));
    db.close();
    if (rawDraft === undefined) return null;
    const decoded = decodeRecoveryDraft(rawDraft, fallbackFormat);
    if (decoded.status === 'quarantine') {
      const raw = typeof rawDraft === 'string' ? rawDraft : JSON.stringify(rawDraft);
      await quarantineIndexedDraft(key, raw, decoded.reason);
      return null;
    }
    const draft = persistencePayloadToDraft(decoded.envelope.payload);
    if (now - draft.savedAt > MAX_DRAFT_AGE_MS) {
      await deleteIndexedDraft(key);
      return null;
    }
    if (decoded.migratedFromVersion !== null || typeof rawDraft !== 'string') {
      await saveIndexedDraft(key, encodePersistenceEnvelope(decoded.envelope));
    }
    return draft;
  } catch {
    return null;
  }
}

async function deleteIndexedDraft(key: string): Promise<void> {
  try {
    const db = await openDraftDb();
    await runDraftTransaction(db, 'readwrite', (store) => store.delete(key));
    db.close();
  } catch {
    // Ignore storage failures; the saved document state remains authoritative.
  }
}

async function quarantineIndexedDraft(
  key: string,
  raw: string,
  reason: PersistenceQuarantineReason,
): Promise<void> {
  const quarantineKey = `${PERSISTENCE_QUARANTINE_PREFIX}${sha256Hex(`${key}\0${raw}`)}`;
  const quarantineRaw = JSON.stringify({
    schemaVersion: 1,
    sourceKey: key,
    familyHint: 'recoveryDraft',
    reason,
    quarantinedAt: Date.now(),
    raw,
  });
  try {
    const published = await saveIndexedDraft(quarantineKey, quarantineRaw);
    if (published) await deleteIndexedDraft(key);
  } catch {
    // The original value remains available when quarantine publication fails.
  }
}

async function pruneIndexedFileDrafts(currentKey: string): Promise<void> {
  try {
    const db = await openDraftDb();
    const candidates = await listIndexedFileDraftCandidates(db);
    const stale = staleDraftKeys(candidates, currentKey);
    if (stale.length > 0) {
      await runDraftTransaction(db, 'readwrite', (store) => {
        for (const key of stale) store.delete(key);
        return store.get(currentKey);
      });
    }
    db.close();
  } catch {
    // IndexedDB pruning is opportunistic; load paths still expire stale drafts.
  }
}

function listIndexedFileDraftCandidates(db: IDBDatabase): Promise<Array<{ key: string; savedAt: number }>> {
  return new Promise((resolve, reject) => {
    const candidates: Array<{ key: string; savedAt: number }> = [];
    const transaction = db.transaction(DRAFT_STORE_NAME, 'readonly');
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const key = typeof cursor.key === 'string' ? cursor.key : '';
      const value = cursor.value;
      if (isFileDraftKey(key)) {
        const decoded = decodeRecoveryDraft(value, 'markdown');
        if (decoded.status === 'ready') {
          candidates.push({ key, savedAt: decoded.envelope.payload.savedAt });
        }
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('Could not enumerate draft database.'));
    transaction.oncomplete = () => resolve(candidates);
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not enumerate draft database.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Draft database enumeration was aborted.'));
  });
}

async function drainIndexedDraftOperations(): Promise<void> {
  while (indexedDraftOperations.size > 0) {
    await Promise.all(Array.from(indexedDraftOperations.values()));
  }
}

export async function flushDraftRecoveryForTests(): Promise<void> {
  await drainIndexedDraftOperations();
}

export function resetDraftRecoveryForTests(): void {
  memoryDrafts.clear();
  indexedDraftOperations.clear();
  lastQuotaWarningAt = 0;
}

function runDraftTransaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DRAFT_STORE_NAME, mode);
    let requestResult: T | undefined;
    let requestCompleted = false;
    let settled = false;
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    transaction.oncomplete = () => {
      if (settled) return;
      if (!requestCompleted) {
        rejectOnce(new Error('Draft database request did not complete.'));
        return;
      }
      settled = true;
      resolve(requestResult as T);
    };
    transaction.onerror = () => rejectOnce(transaction.error ?? new Error('Draft database transaction failed.'));
    transaction.onabort = () => rejectOnce(transaction.error ?? new Error('Draft database transaction was aborted.'));

    let request: IDBRequest<T>;
    try {
      request = operation(transaction.objectStore(DRAFT_STORE_NAME));
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already be inactive.
      }
      rejectOnce(error);
      return;
    }
    request.onsuccess = () => {
      requestResult = request.result;
      requestCompleted = true;
    };
    request.onerror = () => {
      rejectOnce(request.error ?? new Error('Draft database request failed.'));
      try {
        transaction.abort();
      } catch {
        // The browser may have already started aborting the transaction.
      }
    };
  });
}
