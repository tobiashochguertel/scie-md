import type { DocumentId } from '../documentIdentity';
import type { RevisionedSourceBuffer, SourceCompactionCandidate } from './revisionedSourceBuffer';
import { prepareSourceCompaction } from './revisionedSourceBuffer';

export const SOURCE_COMPACTION_SEGMENT_THRESHOLD = 128;

interface CompactionRequest {
  documentId: DocumentId;
  read(): RevisionedSourceBuffer | null;
  commit(candidate: SourceCompactionCandidate): void;
}

const scheduled = new Map<DocumentId, ReturnType<typeof setTimeout>>();

export const sourceBufferCompactionScheduler = {
  schedule(request: CompactionRequest): boolean {
    const current = request.read();
    if (!current || current.current.text.segments.length < SOURCE_COMPACTION_SEGMENT_THRESHOLD || scheduled.has(request.documentId)) return false;
    const timer = setTimeout(() => {
      scheduled.delete(request.documentId);
      const buffer = request.read();
      if (!buffer || buffer.current.text.segments.length < SOURCE_COMPACTION_SEGMENT_THRESHOLD) return;
      request.commit(prepareSourceCompaction(buffer));
    }, 0);
    scheduled.set(request.documentId, timer);
    return true;
  },
  cancel(documentId: DocumentId): void {
    const timer = scheduled.get(documentId);
    if (timer) clearTimeout(timer);
    scheduled.delete(documentId);
  },
  resetForTests(): void {
    for (const timer of scheduled.values()) clearTimeout(timer);
    scheduled.clear();
  },
};
