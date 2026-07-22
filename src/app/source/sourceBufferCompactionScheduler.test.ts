import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentId } from '../documentIdentity';
import { createRevisionedSourceBuffer } from './revisionedSourceBuffer';
import { SOURCE_COMPACTION_SEGMENT_THRESHOLD, sourceBufferCompactionScheduler } from './sourceBufferCompactionScheduler';

describe('sourceBufferCompactionScheduler', () => {
  afterEach(() => { sourceBufferCompactionScheduler.resetForTests(); vi.useRealTimers(); });

  it('coalesces eligible off-side compaction and leaves the primary writer to commit the candidate', () => {
    vi.useFakeTimers();
    const documentId = createDocumentId();
    const initial = createRevisionedSourceBuffer('x'.repeat(SOURCE_COMPACTION_SEGMENT_THRESHOLD));
    const buffer = {
      ...initial,
      current: {
        ...initial.current,
        text: { segments: Array.from({ length: SOURCE_COMPACTION_SEGMENT_THRESHOLD }, () => 'x'), length: SOURCE_COMPACTION_SEGMENT_THRESHOLD },
      },
    };
    const commit = vi.fn();
    expect(sourceBufferCompactionScheduler.schedule({ documentId, read: () => buffer, commit })).toBe(true);
    expect(sourceBufferCompactionScheduler.schedule({ documentId, read: () => buffer, commit })).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 0, expectedStorageEpoch: 0 });
  });
});
