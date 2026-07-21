import type { DocumentFormat } from '@sciemd/core';
import {
  migrateWorkspaceManifestV1,
  validateWorkspaceManifestPayload,
  type WorkspaceManifestPayload,
} from './workspaceManifestSchema';

export type PersistenceFamily = 'recoveryDraft' | 'workspaceManifest';
export type PersistenceCommitState = 'pending' | 'committed';
export type PersistenceQuarantineReason =
  | 'invalid-json'
  | 'invalid-shape'
  | 'unknown-family'
  | 'future-version'
  | 'missing-migration'
  | 'checksum-mismatch'
  | 'interrupted-publication';

export interface PersistenceEnvelope<T> {
  family: PersistenceFamily;
  schemaVersion: number;
  generation: number;
  checksum: string;
  commitState: PersistenceCommitState;
  payload: T;
}

export interface RecoveryDraftPayload {
  sourceText: string;
  /** Saved disk baseline retained with dirty recovery, never in the workspace manifest. */
  savedSourceText?: string;
  savedAt: number;
  format: DocumentFormat;
  catalogEntry?: {
    schemaVersion: 1;
    documentId: string;
    sourceRevision: number;
    locator: {
      kind: 'untitled';
      untitledId: string;
    } | {
      kind: 'file';
      displayPath: string;
      comparisonKey: string;
      stableFileId?: string;
      identityConfidence: 'stableFileId' | 'pathOnly';
      aliases: string[];
    };
    mediaType: string;
  };
  baseMetadata?: {
    lastKnownMtimeMs: number;
    lastKnownSizeBytes: number;
    contentHash: string | null;
  };
}

export type WorkspaceManifestPersistenceStub = WorkspaceManifestPayload;

export interface PersistenceQuarantineRecord {
  schemaVersion: 1;
  sourceKey: string;
  familyHint: PersistenceFamily | null;
  reason: PersistenceQuarantineReason;
  quarantinedAt: number;
  raw: string;
}

export type PersistenceDecodeResult<T> =
  | {
      status: 'ready';
      envelope: PersistenceEnvelope<T>;
      migratedFromVersion: number | null;
    }
  | {
      status: 'quarantine';
      reason: PersistenceQuarantineReason;
      raw: string;
    };

interface PersistenceFamilyDefinition<T> {
  currentVersion: number;
  migrate: Readonly<Record<number, (value: unknown, fallback?: unknown) => unknown>>;
  validate: (value: unknown, fallback?: unknown) => T | null;
}

export const RECOVERY_DRAFT_SCHEMA_VERSION = 3;
export const WORKSPACE_MANIFEST_SCHEMA_VERSION = 2;
export const PERSISTENCE_QUARANTINE_PREFIX = 'scie_md.persistence.quarantine.v1.';

export const DEFERRED_PERSISTENCE_FAMILIES = Object.freeze([
  'settings',
  'pathGrants',
] as const);

const definitions: { [K in PersistenceFamily]: PersistenceFamilyDefinition<unknown> } = {
  recoveryDraft: {
    currentVersion: RECOVERY_DRAFT_SCHEMA_VERSION,
    migrate: {
      1: (value, fallback) => {
        const record = asRecord(value);
        if (!record) return value;
        return {
          sourceText: typeof record.sourceText === 'string' ? record.sourceText : record.markdown,
          savedAt: record.savedAt,
          format: record.format ?? fallback,
          baseMetadata: record.baseMetadata,
        };
      },
      2: (value, fallback) => {
        const record = asRecord(value);
        if (!record) return value;
        return {
          sourceText: typeof record.sourceText === 'string' ? record.sourceText : record.markdown,
          savedAt: record.savedAt,
          format: record.format ?? fallback,
          baseMetadata: record.baseMetadata,
        };
      },
    },
    validate: validateRecoveryDraft,
  },
  workspaceManifest: {
    currentVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    migrate: { 1: migrateWorkspaceManifestV1 },
    validate: validateWorkspaceManifest,
  },
};

export function createPersistenceEnvelope<T>(
  family: PersistenceFamily,
  payload: T,
  generation: number,
  commitState: PersistenceCommitState = 'committed',
): PersistenceEnvelope<T> {
  const schemaVersion = definitions[family].currentVersion;
  const unsigned = { family, schemaVersion, generation, payload };
  return {
    family,
    schemaVersion,
    generation,
    checksum: sha256Hex(stableStringify(unsigned)),
    commitState,
    payload,
  };
}

export function encodePersistenceEnvelope<T>(envelope: PersistenceEnvelope<T>): string {
  return JSON.stringify(envelope);
}

export function decodeRecoveryDraft(
  rawValue: string | unknown,
  fallbackFormat: DocumentFormat,
): PersistenceDecodeResult<RecoveryDraftPayload> {
  return decodePersistenceValue('recoveryDraft', rawValue, fallbackFormat) as PersistenceDecodeResult<RecoveryDraftPayload>;
}

export function decodeWorkspaceManifest(
  rawValue: string | unknown,
): PersistenceDecodeResult<WorkspaceManifestPersistenceStub> {
  return decodePersistenceValue('workspaceManifest', rawValue) as PersistenceDecodeResult<WorkspaceManifestPersistenceStub>;
}

export function nextPersistenceGeneration(rawValue: string | unknown, family: PersistenceFamily): number {
  const parsed = parseRaw(rawValue);
  const record = parsed.ok ? asRecord(parsed.value) : null;
  return record?.family === family && isPositiveInteger(record.generation)
    ? record.generation + 1
    : 1;
}

export function quarantinePersistenceValue(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  sourceKey: string,
  raw: string,
  reason: PersistenceQuarantineReason,
  familyHint: PersistenceFamily | null,
  quarantinedAt = Date.now(),
): string | null {
  const quarantineKey = `${PERSISTENCE_QUARANTINE_PREFIX}${sha256Hex(`${sourceKey}\0${raw}`)}`;
  const record: PersistenceQuarantineRecord = {
    schemaVersion: 1,
    sourceKey,
    familyHint,
    reason,
    quarantinedAt,
    raw,
  };
  try {
    if (!storage.getItem(quarantineKey)) storage.setItem(quarantineKey, JSON.stringify(record));
    if (storage.getItem(quarantineKey)) storage.removeItem(sourceKey);
    return quarantineKey;
  } catch {
    return null;
  }
}

export interface PersistenceReference {
  id: string;
  generation: number;
}

export interface PersistenceTombstone extends PersistenceReference {
  deletedAt: number;
}

export interface RecoveryFirstPublication<TManifest> {
  commitRecovery: () => Promise<PersistenceReference>;
  commitManifestReference: (reference: PersistenceReference) => Promise<TManifest>;
}

export async function publishRecoveryBeforeManifest<TManifest>(
  publication: RecoveryFirstPublication<TManifest>,
): Promise<TManifest> {
  const reference = await publication.commitRecovery();
  return publication.commitManifestReference(reference);
}

export function applyPersistenceTombstone(
  tombstones: readonly PersistenceTombstone[],
  next: PersistenceTombstone,
): PersistenceTombstone[] {
  const current = tombstones.find((entry) => entry.id === next.id);
  if (current && current.generation >= next.generation) return tombstones.slice();
  return [...tombstones.filter((entry) => entry.id !== next.id), next]
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function reconcilePersistencePublication(
  entries: readonly PersistenceReference[],
  references: readonly PersistenceReference[],
  tombstones: readonly PersistenceTombstone[],
): {
  liveEntries: PersistenceReference[];
  orphanEntries: PersistenceReference[];
  staleReferences: PersistenceReference[];
} {
  const tombstoneById = new Map(tombstones.map((entry) => [entry.id, entry]));
  const liveEntries = entries.filter((entry) => (tombstoneById.get(entry.id)?.generation ?? -1) < entry.generation);
  const liveById = new Map(liveEntries.map((entry) => [entry.id, entry]));
  const referenceKeys = new Set(references.map(referenceKey));
  return {
    liveEntries,
    orphanEntries: liveEntries.filter((entry) => !referenceKeys.has(referenceKey(entry))),
    staleReferences: references.filter((reference) => liveById.get(reference.id)?.generation !== reference.generation),
  };
}

function decodePersistenceValue(
  family: PersistenceFamily,
  rawValue: string | unknown,
  fallback?: unknown,
): PersistenceDecodeResult<unknown> {
  const parsed = parseRaw(rawValue);
  if (!parsed.ok) return { status: 'quarantine', reason: 'invalid-json', raw: parsed.raw };
  const record = asRecord(parsed.value);
  if (!record) return { status: 'quarantine', reason: 'invalid-shape', raw: parsed.raw };
  const definition = definitions[family];

  if ('family' in record || 'commitState' in record || 'checksum' in record || 'payload' in record) {
    if (record.family !== family) return { status: 'quarantine', reason: 'unknown-family', raw: parsed.raw };
    if (!isPositiveInteger(record.schemaVersion) || !isPositiveInteger(record.generation)) {
      return { status: 'quarantine', reason: 'invalid-shape', raw: parsed.raw };
    }
    if (record.schemaVersion > definition.currentVersion) {
      return { status: 'quarantine', reason: 'future-version', raw: parsed.raw };
    }
    if (record.commitState !== 'committed') {
      return { status: 'quarantine', reason: 'interrupted-publication', raw: parsed.raw };
    }
    const expectedChecksum = sha256Hex(stableStringify({
      family,
      schemaVersion: record.schemaVersion,
      generation: record.generation,
      payload: record.payload,
    }));
    if (typeof record.checksum !== 'string' || record.checksum !== expectedChecksum) {
      return { status: 'quarantine', reason: 'checksum-mismatch', raw: parsed.raw };
    }
    return migrateAndValidate(
      family,
      record.payload,
      record.schemaVersion,
      record.generation,
      fallback,
      parsed.raw,
    );
  }

  const legacyVersion = isPositiveInteger(record.schemaVersion) ? record.schemaVersion : 1;
  if (legacyVersion > definition.currentVersion) {
    return { status: 'quarantine', reason: 'future-version', raw: parsed.raw };
  }
  return migrateAndValidate(family, record, legacyVersion, 1, fallback, parsed.raw);
}

function migrateAndValidate(
  family: PersistenceFamily,
  initialValue: unknown,
  initialVersion: number,
  generation: number,
  fallback: unknown,
  raw: string,
): PersistenceDecodeResult<unknown> {
  const definition = definitions[family];
  let value = initialValue;
  let version = initialVersion;
  while (version < definition.currentVersion) {
    const migrator = definition.migrate[version];
    if (!migrator) return { status: 'quarantine', reason: 'missing-migration', raw };
    value = migrator(value, fallback);
    version += 1;
  }
  const payload = definition.validate(value, fallback);
  if (!payload) return { status: 'quarantine', reason: 'invalid-shape', raw };
  return {
    status: 'ready',
    envelope: createPersistenceEnvelope(family, payload, generation),
    migratedFromVersion: initialVersion === definition.currentVersion ? null : initialVersion,
  };
}

function validateRecoveryDraft(value: unknown, fallback: unknown): RecoveryDraftPayload | null {
  const record = asRecord(value);
  if (!record) return null;
  const sourceText = typeof record.sourceText === 'string' ? record.sourceText : record.markdown;
  const format = isDocumentFormat(record.format) ? record.format : isDocumentFormat(fallback) ? fallback : null;
  if (typeof sourceText !== 'string' || typeof record.savedAt !== 'number' || !Number.isFinite(record.savedAt) || !format) return null;
  const baseMetadata = validateBaseMetadata(record.baseMetadata);
  const catalogEntry = validateRecoveryCatalogEntry(record.catalogEntry);
  const payload: RecoveryDraftPayload = { sourceText, savedAt: record.savedAt, format };
  if (typeof record.savedSourceText === 'string') payload.savedSourceText = record.savedSourceText;
  if (baseMetadata) payload.baseMetadata = baseMetadata;
  if (catalogEntry) payload.catalogEntry = catalogEntry;
  return payload;
}

function validateRecoveryCatalogEntry(value: unknown): RecoveryDraftPayload['catalogEntry'] | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== 1 || typeof record.documentId !== 'string' || record.documentId.length === 0) return undefined;
  if (!Number.isSafeInteger(record.sourceRevision) || (record.sourceRevision as number) < 0 || typeof record.mediaType !== 'string') return undefined;
  const locator = asRecord(record.locator);
  if (!locator) return undefined;
  if (locator.kind === 'untitled' && typeof locator.untitledId === 'string') {
    return {
      schemaVersion: 1,
      documentId: record.documentId,
      sourceRevision: record.sourceRevision as number,
      locator: { kind: 'untitled', untitledId: locator.untitledId },
      mediaType: record.mediaType,
    };
  }
  if (
    locator.kind !== 'file'
    || typeof locator.displayPath !== 'string'
    || typeof locator.comparisonKey !== 'string'
    || !(locator.identityConfidence === 'stableFileId' || locator.identityConfidence === 'pathOnly')
    || !Array.isArray(locator.aliases)
    || !locator.aliases.every((entry) => typeof entry === 'string')
    || !(locator.stableFileId === undefined || typeof locator.stableFileId === 'string')
  ) return undefined;
  return {
    schemaVersion: 1,
    documentId: record.documentId,
    sourceRevision: record.sourceRevision as number,
    locator: {
      kind: 'file',
      displayPath: locator.displayPath,
      comparisonKey: locator.comparisonKey,
      ...(typeof locator.stableFileId === 'string' ? { stableFileId: locator.stableFileId } : {}),
      identityConfidence: locator.identityConfidence,
      aliases: locator.aliases.slice() as string[],
    },
    mediaType: record.mediaType,
  };
}

function validateWorkspaceManifest(value: unknown): WorkspaceManifestPersistenceStub | null {
  return validateWorkspaceManifestPayload(value);
}

function validateBaseMetadata(value: unknown): RecoveryDraftPayload['baseMetadata'] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (
    typeof record.lastKnownMtimeMs !== 'number'
    || typeof record.lastKnownSizeBytes !== 'number'
    || !(typeof record.contentHash === 'string' || record.contentHash === null)
  ) return undefined;
  return {
    lastKnownMtimeMs: record.lastKnownMtimeMs,
    lastKnownSizeBytes: record.lastKnownSizeBytes,
    contentHash: record.contentHash,
  };
}

function parseRaw(rawValue: string | unknown): { ok: true; value: unknown; raw: string } | { ok: false; raw: string } {
  if (typeof rawValue !== 'string') {
    return { ok: true, value: rawValue, raw: JSON.stringify(rawValue) ?? String(rawValue) };
  }
  try {
    return { ok: true, value: JSON.parse(rawValue), raw: rawValue };
  } catch {
    return { ok: false, raw: rawValue };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
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

function referenceKey(reference: PersistenceReference): string {
  return `${reference.id}:${reference.generation}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value.normalize('NFC'));
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
  let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = add32(words[index - 16], s0, words[index - 7], s1);
    }
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4; let f = h5; let g = h6; let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = add32(h, s1, ch, SHA256_K[index], words[index]);
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = add32(s0, maj);
      h = g; g = f; f = e; e = add32(d, temp1); d = c; c = b; b = a; a = add32(temp1, temp2);
    }
    h0 = add32(h0, a); h1 = add32(h1, b); h2 = add32(h2, c); h3 = add32(h3, d);
    h4 = add32(h4, e); h5 = add32(h5, f); h6 = add32(h6, g); h7 = add32(h7, h);
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((part) => part.toString(16).padStart(8, '0')).join('');
}

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

function add32(...values: number[]): number {
  return values.reduce((sum, value) => (sum + value) >>> 0, 0);
}

const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
