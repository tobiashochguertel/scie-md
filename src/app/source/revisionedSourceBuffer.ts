import type { DocumentId, SourceRevision } from '../documentIdentity';
import { sourceRevision } from '../documentIdentity';

export const SOURCE_BUFFER_SCHEMA_VERSION = 1 as const;
export const SOURCE_CHANGE_LIMITS = Object.freeze({
  maxChanges: 256,
  maxInsertedUtf16: 4 * 1024 * 1024,
  maxGuardUtf16: 64 * 1024,
});

export interface PersistentSourceText {
  readonly segments: readonly string[];
  readonly length: number;
}

export interface SourceCheckpoint {
  readonly revision: SourceRevision;
  readonly text: PersistentSourceText;
}

export interface RevisionedSourceBuffer {
  readonly schemaVersion: typeof SOURCE_BUFFER_SCHEMA_VERSION;
  readonly storageEpoch: number;
  readonly current: SourceCheckpoint;
  readonly saved: SourceCheckpoint;
}

export interface SourceSpanChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  /** A bounded optimistic guard. Omit only when the addressed span exceeds the guard limit. */
  readonly expectedText?: string;
}

export interface SourceChangeSet {
  readonly documentId: DocumentId;
  readonly expectedRevision: SourceRevision;
  readonly changes: readonly SourceSpanChange[];
}

export type SourceChangeRejectionCode =
  | 'document-mismatch'
  | 'stale-revision'
  | 'empty-change-set'
  | 'too-many-changes'
  | 'insert-limit-exceeded'
  | 'invalid-range'
  | 'overlapping-ranges'
  | 'guard-limit-exceeded'
  | 'guard-mismatch';

export type SourceChangeResult =
  | { readonly status: 'accepted'; readonly buffer: RevisionedSourceBuffer; readonly revision: SourceRevision }
  | { readonly status: 'rejected'; readonly code: SourceChangeRejectionCode; readonly revision: SourceRevision };

export interface SourceCompactionCandidate {
  readonly expectedRevision: SourceRevision;
  readonly expectedStorageEpoch: number;
  readonly compactedText: PersistentSourceText;
}

export type SourceBufferDecodeResult =
  | { status: 'ready'; buffer: RevisionedSourceBuffer; migratedFromVersion: 0 | null }
  | { status: 'quarantine'; reason: 'invalid-shape' | 'future-version' };

export function decodeRevisionedSourceBuffer(value: unknown): SourceBufferDecodeResult {
  if (!value || typeof value !== 'object') return { status: 'quarantine', reason: 'invalid-shape' };
  const record = value as Record<string, unknown>;
  if (record.schemaVersion === 0) {
    if (typeof record.sourceText !== 'string' || !(record.savedSourceText === undefined || typeof record.savedSourceText === 'string')) {
      return { status: 'quarantine', reason: 'invalid-shape' };
    }
    return { status: 'ready', buffer: createRevisionedSourceBuffer(record.sourceText, record.savedSourceText ?? record.sourceText), migratedFromVersion: 0 };
  }
  if (typeof record.schemaVersion === 'number' && record.schemaVersion > SOURCE_BUFFER_SCHEMA_VERSION) {
    return { status: 'quarantine', reason: 'future-version' };
  }
  try {
    return { status: 'ready', buffer: assertValidRevisionedSourceBuffer(value as RevisionedSourceBuffer), migratedFromVersion: null };
  } catch {
    return { status: 'quarantine', reason: 'invalid-shape' };
  }
}

export function migrateLegacySourceSnapshot(sourceText: string, savedSourceText = sourceText): RevisionedSourceBuffer {
  return createRevisionedSourceBuffer(sourceText, savedSourceText);
}

export function createRevisionedSourceBuffer(sourceText: string, savedSourceText = sourceText): RevisionedSourceBuffer {
  const initialRevision = sourceRevision(0);
  const current = checkpoint(initialRevision, sourceText);
  const saved = sourceText === savedSourceText ? current : checkpoint(initialRevision, savedSourceText);
  return { schemaVersion: SOURCE_BUFFER_SCHEMA_VERSION, storageEpoch: 0, current, saved };
}

export function applySourceChangeSet(
  documentId: DocumentId,
  buffer: RevisionedSourceBuffer,
  changeSet: SourceChangeSet,
): SourceChangeResult {
  if (changeSet.documentId !== documentId) return reject(buffer, 'document-mismatch');
  if (changeSet.expectedRevision !== buffer.current.revision) return reject(buffer, 'stale-revision');
  if (changeSet.changes.length === 0) return reject(buffer, 'empty-change-set');
  if (changeSet.changes.length > SOURCE_CHANGE_LIMITS.maxChanges) return reject(buffer, 'too-many-changes');
  let insertedLength = 0;
  let previousTo = 0;
  for (const [index, change] of changeSet.changes.entries()) {
    insertedLength += change.insert.length;
    if (insertedLength > SOURCE_CHANGE_LIMITS.maxInsertedUtf16) return reject(buffer, 'insert-limit-exceeded');
    if (!Number.isSafeInteger(change.from) || !Number.isSafeInteger(change.to)
      || change.from < 0 || change.to < change.from || change.to > buffer.current.text.length) {
      return reject(buffer, 'invalid-range');
    }
    if (index > 0 && change.from < previousTo) return reject(buffer, 'overlapping-ranges');
    previousTo = change.to;
    if (change.expectedText !== undefined) {
      if (change.expectedText.length > SOURCE_CHANGE_LIMITS.maxGuardUtf16) return reject(buffer, 'guard-limit-exceeded');
      if (!rangeEquals(buffer.current.text, change.from, change.to, change.expectedText)) return reject(buffer, 'guard-mismatch');
    }
  }
  const text = applyChanges(buffer.current.text, changeSet.changes);
  const revision = sourceRevision(buffer.current.revision + 1);
  return {
    status: 'accepted',
    revision,
    buffer: { ...buffer, current: { revision, text } },
  };
}

export function adoptWholeSource(
  buffer: RevisionedSourceBuffer,
  sourceText: string,
  options: { markSaved?: boolean } = {},
): RevisionedSourceBuffer {
  if (persistentSourceEqualsString(buffer.current.text, sourceText)) {
    return options.markSaved ? markSourceSaved(buffer) : buffer;
  }
  const revision = sourceRevision(buffer.current.revision + 1);
  const current = checkpoint(revision, sourceText);
  return { ...buffer, current, ...(options.markSaved ? { saved: current } : {}) };
}

export function markSourceSaved(buffer: RevisionedSourceBuffer): RevisionedSourceBuffer {
  if (buffer.saved === buffer.current) return buffer;
  return { ...buffer, saved: buffer.current };
}

export function restoreSourceBufferRevisions(
  buffer: RevisionedSourceBuffer,
  currentRevision: SourceRevision,
  savedRevision: SourceRevision,
): RevisionedSourceBuffer {
  if (savedRevision > currentRevision) throw new Error('Saved source revision cannot exceed the restored current revision.');
  return {
    ...buffer,
    current: { ...buffer.current, revision: currentRevision },
    saved: { ...buffer.saved, revision: savedRevision },
  };
}

export function adoptSavedSource(buffer: RevisionedSourceBuffer, savedSourceText: string): RevisionedSourceBuffer {
  if (persistentSourceEqualsString(buffer.current.text, savedSourceText)) return markSourceSaved(buffer);
  if (persistentSourceEqualsString(buffer.saved.text, savedSourceText)) return buffer;
  return { ...buffer, saved: checkpoint(buffer.saved.revision, savedSourceText) };
}

export function sourceBufferIsDirty(buffer: RevisionedSourceBuffer): boolean {
  return !persistentSourceEquals(buffer.current.text, buffer.saved.text);
}

export function materializePersistentSource(text: PersistentSourceText): string {
  return text.segments.length === 1 ? (text.segments[0] ?? '') : text.segments.join('');
}

export function materializeCurrentSource(buffer: RevisionedSourceBuffer): string {
  return materializePersistentSource(buffer.current.text);
}

export function materializeSavedSource(buffer: RevisionedSourceBuffer): string {
  return materializePersistentSource(buffer.saved.text);
}

export function prepareSourceCompaction(buffer: RevisionedSourceBuffer): SourceCompactionCandidate {
  return {
    expectedRevision: buffer.current.revision,
    expectedStorageEpoch: buffer.storageEpoch,
    compactedText: persistentText(materializeCurrentSource(buffer)),
  };
}

export function commitSourceCompaction(
  buffer: RevisionedSourceBuffer,
  candidate: SourceCompactionCandidate,
): RevisionedSourceBuffer | null {
  if (buffer.current.revision !== candidate.expectedRevision || buffer.storageEpoch !== candidate.expectedStorageEpoch) return null;
  if (!persistentSourceEquals(buffer.current.text, candidate.compactedText)) return null;
  const saved = persistentSourceEquals(buffer.saved.text, buffer.current.text)
    ? { revision: buffer.saved.revision, text: candidate.compactedText }
    : buffer.saved;
  return {
    ...buffer,
    storageEpoch: buffer.storageEpoch + 1,
    current: { revision: buffer.current.revision, text: candidate.compactedText },
    saved,
  };
}

export function assertValidRevisionedSourceBuffer(buffer: RevisionedSourceBuffer): RevisionedSourceBuffer {
  if (buffer.schemaVersion !== SOURCE_BUFFER_SCHEMA_VERSION) throw new Error(`Unsupported source buffer schema version: ${String(buffer.schemaVersion)}.`);
  if (!Number.isSafeInteger(buffer.storageEpoch) || buffer.storageEpoch < 0) throw new Error('Source buffer storage epoch must be a non-negative safe integer.');
  if (buffer.saved.revision > buffer.current.revision) throw new Error('Saved source revision cannot exceed current revision.');
  for (const candidate of [buffer.current.text, buffer.saved.text]) {
    if (!Number.isSafeInteger(candidate.length) || candidate.length < 0) throw new Error('Source checkpoint length is invalid.');
    if (candidate.segments.some((segment) => typeof segment !== 'string')) throw new Error('Source checkpoint segments must be strings.');
    if (candidate.segments.reduce((sum, segment) => sum + segment.length, 0) !== candidate.length) throw new Error('Source checkpoint length disagrees with its segments.');
  }
  return buffer;
}

function checkpoint(revision: SourceRevision, sourceText: string): SourceCheckpoint {
  return { revision, text: persistentText(sourceText) };
}

function persistentText(sourceText: string): PersistentSourceText {
  return { segments: sourceText.length === 0 ? [] : [sourceText], length: sourceText.length };
}

function reject(buffer: RevisionedSourceBuffer, code: SourceChangeRejectionCode): SourceChangeResult {
  return { status: 'rejected', code, revision: buffer.current.revision };
}

function applyChanges(text: PersistentSourceText, changes: readonly SourceSpanChange[]): PersistentSourceText {
  const segments: string[] = [];
  let cursor = 0;
  for (const change of changes) {
    appendRange(text, cursor, change.from, segments);
    if (change.insert.length > 0) segments.push(change.insert);
    cursor = change.to;
  }
  appendRange(text, cursor, text.length, segments);
  const normalized = segments.filter((segment) => segment.length > 0);
  const length = text.length + changes.reduce((delta, change) => delta + change.insert.length - (change.to - change.from), 0);
  return { segments: normalized, length };
}

function appendRange(text: PersistentSourceText, from: number, to: number, output: string[]): void {
  if (from === to) return;
  let position = 0;
  for (const segment of text.segments) {
    const end = position + segment.length;
    if (end <= from) { position = end; continue; }
    if (position >= to) break;
    const localFrom = Math.max(0, from - position);
    const localTo = Math.min(segment.length, to - position);
    const slice = localFrom === 0 && localTo === segment.length ? segment : segment.slice(localFrom, localTo);
    if (slice.length > 0) output.push(slice);
    position = end;
  }
}

function rangeEquals(text: PersistentSourceText, from: number, to: number, expected: string): boolean {
  if (to - from !== expected.length) return false;
  let expectedOffset = 0;
  let position = 0;
  for (const segment of text.segments) {
    const end = position + segment.length;
    if (end <= from) { position = end; continue; }
    if (position >= to) break;
    const localFrom = Math.max(0, from - position);
    const localTo = Math.min(segment.length, to - position);
    const slice = segment.slice(localFrom, localTo);
    if (expected.slice(expectedOffset, expectedOffset + slice.length) !== slice) return false;
    expectedOffset += slice.length;
    position = end;
  }
  return expectedOffset === expected.length;
}

function persistentSourceEqualsString(text: PersistentSourceText, sourceText: string): boolean {
  return text.length === sourceText.length && rangeEquals(text, 0, text.length, sourceText);
}

function persistentSourceEquals(left: PersistentSourceText, right: PersistentSourceText): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  let leftSegment = 0; let rightSegment = 0; let leftOffset = 0; let rightOffset = 0;
  while (leftSegment < left.segments.length && rightSegment < right.segments.length) {
    const a = left.segments[leftSegment] ?? '';
    const b = right.segments[rightSegment] ?? '';
    const size = Math.min(a.length - leftOffset, b.length - rightOffset);
    if (a.slice(leftOffset, leftOffset + size) !== b.slice(rightOffset, rightOffset + size)) return false;
    leftOffset += size; rightOffset += size;
    if (leftOffset === a.length) { leftSegment += 1; leftOffset = 0; }
    if (rightOffset === b.length) { rightSegment += 1; rightOffset = 0; }
  }
  return leftSegment === left.segments.length && rightSegment === right.segments.length;
}
