import { beforeEach, describe, expect, it } from 'vitest';
import { createDocumentId, sourceRevision } from '../documentIdentity';
import { applySourceChangeSet, createRevisionedSourceBuffer } from './revisionedSourceBuffer';
import { sourceSnapshotService } from './sourceSnapshotService';

describe('sourceSnapshotService', () => {
  beforeEach(() => sourceSnapshotService.resetForTests());

  it('materializes a revision once across concurrent and later leases and releases idempotently', () => {
    const documentId = createDocumentId();
    const checkpoint = createRevisionedSourceBuffer('large source').current;
    const first = sourceSnapshotService.lease(documentId, checkpoint, 'save');
    const second = sourceSnapshotService.lease(documentId, checkpoint, 'recovery');
    expect(first.sourceText).toBe('large source');
    expect(second.sourceText).toBe(first.sourceText);
    expect(sourceSnapshotService.metrics()).toMatchObject({ materializationCount: 1, activeLeaseCount: 2 });
    first.release(); first.release(); second.release();
    const third = sourceSnapshotService.lease(documentId, checkpoint, 'analysis');
    expect(sourceSnapshotService.metrics()).toMatchObject({ materializationCount: 1, activeLeaseCount: 1, releaseCount: 2 });
    third.release();
  });

  it('addresses current and saved checkpoints independently even when their revision numbers match', () => {
    const documentId = createDocumentId();
    const buffer = createRevisionedSourceBuffer('dirty', 'saved');
    const current = sourceSnapshotService.lease(documentId, buffer.current, 'recovery');
    const saved = sourceSnapshotService.lease(documentId, buffer.saved, 'recovery', 'saved');
    expect(current.sourceText).toBe('dirty');
    expect(saved.sourceText).toBe('saved');
    current.release(); saved.release();
  });

  it.each([1, 5, 10, 24])('keeps a one-character edit bounded for a %d MiB source until a named snapshot lease', (mib) => {
    const documentId = createDocumentId();
    const sourceText = 'a'.repeat(mib * 1024 * 1024);
    const buffer = createRevisionedSourceBuffer(sourceText);
    const at = Math.floor(sourceText.length / 2);
    const result = applySourceChangeSet(documentId, buffer, {
      documentId,
      expectedRevision: sourceRevision(0),
      changes: [{ from: at, to: at + 1, insert: 'b', expectedText: 'a' }],
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.buffer.current.text.length).toBe(sourceText.length);
    expect(result.buffer.current.text.segments.length).toBe(3);
    expect(sourceSnapshotService.metrics().materializationCount).toBe(0);
    const lease = sourceSnapshotService.lease(documentId, result.buffer.current, 'save');
    expect(lease.sourceText.at(at)).toBe('b');
    expect(sourceSnapshotService.metrics().materializationCount).toBe(1);
    lease.release();
  });

  it('fails the document release barrier while any addressed lease is active', () => {
    const documentId = createDocumentId();
    const checkpoint = createRevisionedSourceBuffer('resident').current;
    const lease = sourceSnapshotService.lease(documentId, checkpoint, 'analysis');
    expect(sourceSnapshotService.releaseDocument(documentId)).toBe(false);
    lease.release();
    expect(sourceSnapshotService.releaseDocument(documentId)).toBe(true);
    expect(sourceSnapshotService.lease(documentId, checkpoint, 'analysis').sourceText).toBe('resident');
    expect(sourceSnapshotService.metrics().materializationCount).toBe(2);
  });
});
