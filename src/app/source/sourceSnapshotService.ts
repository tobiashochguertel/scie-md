import type { DocumentId, SourceRevision } from '../documentIdentity';
import type { SourceCheckpoint } from './revisionedSourceBuffer';
import { materializePersistentSource } from './revisionedSourceBuffer';

export type SourceSnapshotReason = 'save' | 'recovery' | 'external-conflict-base' | 'analysis' | 'visual-fallback' | 'reconciliation';

export interface SourceSnapshotLease {
  readonly documentId: DocumentId;
  readonly revision: SourceRevision;
  readonly sourceText: string;
  release(): void;
}
export type SourceSnapshotAddress = 'current' | 'saved';

export interface SourceSnapshotMetrics {
  materializationCount: number;
  activeLeaseCount: number;
  releaseCount: number;
  materializedUtf16: number;
  reasons: Readonly<Record<SourceSnapshotReason, number>>;
}

interface SnapshotEntry {
  sourceText: string;
  leases: number;
}

const entries = new Map<string, SnapshotEntry>();
let materializationCount = 0;
let activeLeaseCount = 0;
let releaseCount = 0;
let materializedUtf16 = 0;
const reasons = new Map<SourceSnapshotReason, number>();

export const sourceSnapshotService = {
  lease(documentId: DocumentId, checkpoint: SourceCheckpoint, reason: SourceSnapshotReason, address: SourceSnapshotAddress = 'current'): SourceSnapshotLease {
    const key = `${documentId}:${address}:${checkpoint.revision}`;
    let entry = entries.get(key);
    if (!entry) {
      const sourceText = materializePersistentSource(checkpoint.text);
      entry = { sourceText, leases: 0 };
      entries.set(key, entry);
      materializationCount += 1;
      materializedUtf16 += sourceText.length;
    }
    entry.leases += 1;
    activeLeaseCount += 1;
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    let released = false;
    return {
      documentId,
      revision: checkpoint.revision,
      sourceText: entry.sourceText,
      release: () => {
        if (released) return;
        released = true;
        entry!.leases = Math.max(0, entry!.leases - 1);
        activeLeaseCount = Math.max(0, activeLeaseCount - 1);
        releaseCount += 1;
      },
    };
  },
  evictDocument(documentId: DocumentId, keepRevision?: SourceRevision): void {
    const prefix = `${documentId}:`;
    for (const [key, entry] of entries) {
      if (!key.startsWith(`${prefix}current:`) || entry.leases > 0 || key === `${documentId}:current:${keepRevision}`) continue;
      entries.delete(key);
    }
  },
  evictSaved(documentId: DocumentId, keepRevision?: SourceRevision): void {
    const prefix = `${documentId}:saved:`;
    for (const [key, entry] of entries) {
      if (!key.startsWith(prefix) || entry.leases > 0 || key === `${prefix}${keepRevision}`) continue;
      entries.delete(key);
    }
  },
  releaseDocument(documentId: DocumentId): boolean {
    const prefix = `${documentId}:`;
    for (const [key, entry] of entries) {
      if (key.startsWith(prefix) && entry.leases > 0) return false;
    }
    for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
    return true;
  },
  metrics(): SourceSnapshotMetrics {
    const reasonCounts = Object.fromEntries(reasons) as Record<SourceSnapshotReason, number>;
    return { materializationCount, activeLeaseCount, releaseCount, materializedUtf16, reasons: reasonCounts };
  },
  resetForTests(): void {
    entries.clear(); materializationCount = 0; activeLeaseCount = 0; releaseCount = 0; materializedUtf16 = 0; reasons.clear();
  },
};
