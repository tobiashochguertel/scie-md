import { describe, expect, it } from 'vitest';
import { createDocumentId, sourceRevision } from '../documentIdentity';
import {
  adoptWholeSource,
  applySourceChangeSet,
  commitSourceCompaction,
  createRevisionedSourceBuffer,
  decodeRevisionedSourceBuffer,
  markSourceSaved,
  materializeCurrentSource,
  materializeSavedSource,
  prepareSourceCompaction,
  sourceBufferIsDirty,
} from './revisionedSourceBuffer';

describe('revisionedSourceBuffer', () => {
  it('applies guarded ordered spans atomically and preserves the saved checkpoint', () => {
    const documentId = createDocumentId();
    const initial = createRevisionedSourceBuffer('alpha beta gamma');
    const result = applySourceChangeSet(documentId, initial, {
      documentId,
      expectedRevision: sourceRevision(0),
      changes: [
        { from: 0, to: 5, insert: 'ALPHA', expectedText: 'alpha' },
        { from: 11, to: 16, insert: 'GAMMA', expectedText: 'gamma' },
      ],
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(materializeCurrentSource(result.buffer)).toBe('ALPHA beta GAMMA');
    expect(materializeSavedSource(result.buffer)).toBe('alpha beta gamma');
    expect(result.buffer.current.text.segments).toContain(' beta ');
    expect(sourceBufferIsDirty(result.buffer)).toBe(true);
  });

  it.each([
    ['stale-revision', { revision: sourceRevision(1), changes: [{ from: 0, to: 1, insert: 'A', expectedText: 'a' }] }],
    ['overlapping-ranges', { revision: sourceRevision(0), changes: [{ from: 0, to: 2, insert: '' }, { from: 1, to: 3, insert: '' }] }],
    ['invalid-range', { revision: sourceRevision(0), changes: [{ from: 0, to: 99, insert: '' }] }],
    ['guard-mismatch', { revision: sourceRevision(0), changes: [{ from: 0, to: 1, insert: 'A', expectedText: 'z' }] }],
  ] as const)('rejects %s without partially changing the buffer', (code, fixture) => {
    const documentId = createDocumentId();
    const initial = createRevisionedSourceBuffer('abc');
    const result = applySourceChangeSet(documentId, initial, {
      documentId,
      expectedRevision: fixture.revision,
      changes: fixture.changes,
    });
    expect(result).toMatchObject({ status: 'rejected', code, revision: 0 });
    expect(materializeCurrentSource(initial)).toBe('abc');
  });

  it('becomes clean when edits semantically return to the saved source', () => {
    const documentId = createDocumentId();
    const initial = createRevisionedSourceBuffer('saved');
    const dirty = applySourceChangeSet(documentId, initial, {
      documentId, expectedRevision: sourceRevision(0), changes: [{ from: 0, to: 5, insert: 'draft', expectedText: 'saved' }],
    });
    if (dirty.status !== 'accepted') throw new Error('expected accepted edit');
    const clean = applySourceChangeSet(documentId, dirty.buffer, {
      documentId, expectedRevision: sourceRevision(1), changes: [{ from: 0, to: 5, insert: 'saved', expectedText: 'draft' }],
    });
    if (clean.status !== 'accepted') throw new Error('expected accepted undo');
    expect(sourceBufferIsDirty(clean.buffer)).toBe(false);
    expect(clean.buffer.saved.revision).toBe(0);
  });

  it('advances the saved checkpoint only when explicitly committed', () => {
    const dirty = adoptWholeSource(createRevisionedSourceBuffer('saved'), 'draft');
    expect(materializeSavedSource(dirty)).toBe('saved');
    const saved = markSourceSaved(dirty);
    expect(saved.saved).toBe(saved.current);
    expect(sourceBufferIsDirty(saved)).toBe(false);
  });

  it('atomically swaps a matching compaction candidate without changing revision or saved content', () => {
    const documentId = createDocumentId();
    const result = applySourceChangeSet(documentId, createRevisionedSourceBuffer('abc'), {
      documentId, expectedRevision: sourceRevision(0), changes: [{ from: 1, to: 2, insert: 'B', expectedText: 'b' }],
    });
    if (result.status !== 'accepted') throw new Error('expected accepted edit');
    const candidate = prepareSourceCompaction(result.buffer);
    const compacted = commitSourceCompaction(result.buffer, candidate);
    expect(compacted).not.toBeNull();
    expect(compacted?.current.revision).toBe(result.buffer.current.revision);
    expect(compacted?.storageEpoch).toBe(1);
    expect(materializeSavedSource(compacted!)).toBe('abc');
    expect(commitSourceCompaction(adoptWholeSource(result.buffer, 'newer'), candidate)).toBeNull();
  });

  it('migrates predecessor snapshots and quarantines future or corrupt buffers', () => {
    const migrated = decodeRevisionedSourceBuffer({ schemaVersion: 0, sourceText: 'draft', savedSourceText: 'saved' });
    expect(migrated.status).toBe('ready');
    if (migrated.status === 'ready') {
      expect(migrated.migratedFromVersion).toBe(0);
      expect(materializeCurrentSource(migrated.buffer)).toBe('draft');
      expect(materializeSavedSource(migrated.buffer)).toBe('saved');
    }
    expect(decodeRevisionedSourceBuffer({ schemaVersion: 99 })).toEqual({ status: 'quarantine', reason: 'future-version' });
    expect(decodeRevisionedSourceBuffer({ schemaVersion: 1, storageEpoch: 0, current: { revision: 0, text: { segments: ['x'], length: 9 } } }))
      .toEqual({ status: 'quarantine', reason: 'invalid-shape' });
  });
});
