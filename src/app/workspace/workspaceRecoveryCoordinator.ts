import type { DocumentId, SourceRevision } from '../documentIdentity';
import type { DocumentRecord } from '../documentRecord';
import {
  checkpointRecoveryEntry,
  checkpointRecoveryEntrySync,
  clearRecoveryCatalogEntry,
  createRecoveryCenterModel,
  RECOVERY_CHECKPOINT_LAG_MS,
  RECOVERY_CHECKPOINT_MAX_LAG_MS,
  type RecoveryCatalogEntry,
  type RecoveryCenterModel,
  type RecoveryCheckpointInput,
} from '../../services/recoveryCatalog';
import { clearFileDraftAsync, clearUntitledDraftAsync } from '../../services/draftRecoveryService';
import type { WorkspaceCommand, WorkspaceState } from './workspaceState';
import { documentPerformance, utf8ByteLength } from '../performance/documentPerformance';
import { sourceSnapshotService } from '../source/sourceSnapshotService';

export type RecoveryLifecycleReason = 'timer' | 'deactivation' | 'visibility-hidden' | 'pagehide' | 'beforeunload' | 'destructive-barrier';

export interface WorkspaceRecoveryBackend {
  checkpoint(input: RecoveryCheckpointInput): Promise<RecoveryCatalogEntry>;
  checkpointSync(input: RecoveryCheckpointInput): RecoveryCatalogEntry;
  clear(documentId: DocumentId, upToSourceRevision: SourceRevision): Promise<boolean>;
  recoveryCenter(): Promise<RecoveryCenterModel>;
}

export interface WorkspaceRecoveryMetrics {
  checkpointCount: number;
  checkpointLagMaxMs: number;
  lastCheckpointLagMs: number | null;
  failedCheckpointCount: number;
  pendingDocumentCount: number;
}

export interface WorkspaceRecoveryCoordinator {
  observe(state: WorkspaceState): void;
  configureEditorFlush(flush: (documentId: DocumentId) => void): void;
  attachLifecycleListeners(): () => void;
  checkpointSync(documentId: DocumentId, reason?: RecoveryLifecycleReason): RecoveryCatalogEntry | null;
  flushDocument(documentId: DocumentId, reason?: RecoveryLifecycleReason): Promise<RecoveryCatalogEntry | null>;
  flushAll(reason?: RecoveryLifecycleReason): Promise<void>;
  clearDocument(documentId: DocumentId, upToSourceRevision: SourceRevision): Promise<boolean>;
  recoveryCenter(): Promise<RecoveryCenterModel>;
  metrics(): WorkspaceRecoveryMetrics;
  destroy(): void;
}

const defaultBackend: WorkspaceRecoveryBackend = {
  checkpoint: async (input) => {
    const entry = await checkpointRecoveryEntry(input);
    if (entry.locator.kind === 'file') await clearFileDraftAsync(entry.locator.displayPath);
    else await clearUntitledDraftAsync();
    return entry;
  },
  checkpointSync: checkpointRecoveryEntrySync,
  clear: clearRecoveryCatalogEntry,
  recoveryCenter: createRecoveryCenterModel,
};

export function createWorkspaceRecoveryCoordinator(
  getState: () => WorkspaceState,
  dispatch: (command: WorkspaceCommand) => WorkspaceState,
  backend: WorkspaceRecoveryBackend = defaultBackend,
  now: () => number = Date.now,
): WorkspaceRecoveryCoordinator {
  const timers = new Map<DocumentId, { timer: ReturnType<typeof setTimeout>; firstPendingAt: number; dueAt: number }>();
  const pendingSince = new Map<DocumentId, number>();
  const inFlight = new Map<DocumentId, Promise<RecoveryCatalogEntry | null>>();
  const clearedRevisions = new Map<DocumentId, SourceRevision>();
  let previousActiveId: DocumentId | null = getState().activeDocumentId;
  let flushEditor: ((documentId: DocumentId) => void) | null = null;
  let detachLifecycle: (() => void) | null = null;
  let enabled = false;
  let checkpointCount = 0;
  let checkpointLagMaxMs = 0;
  let lastCheckpointLagMs: number | null = null;
  let failedCheckpointCount = 0;

  const schedule = (documentId: DocumentId, delayMs = RECOVERY_CHECKPOINT_LAG_MS) => {
    const record = getState().documentsById[documentId];
    if (!record || record.lifecycle.content !== 'dirty' || record.lifecycle.recovery === 'current') return;
    if (inFlight.has(documentId)) return;
    const currentTime = now();
    const existing = timers.get(documentId);
    const firstPendingAt = existing?.firstPendingAt ?? currentTime;
    if (!pendingSince.has(documentId)) pendingSince.set(documentId, firstPendingAt);
    const dueAt = Math.min(currentTime + delayMs, firstPendingAt + RECOVERY_CHECKPOINT_MAX_LAG_MS);
    if (existing && existing.dueAt <= dueAt) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      timers.delete(documentId);
      void flushDocument(documentId, delayMs < RECOVERY_CHECKPOINT_LAG_MS ? 'deactivation' : 'timer');
    }, Math.max(0, dueAt - currentTime));
    timers.set(documentId, { timer, firstPendingAt, dueAt });
  };

  const observe = (state: WorkspaceState) => {
    if (!enabled) {
      previousActiveId = state.activeDocumentId;
      return;
    }
    if (previousActiveId && previousActiveId !== state.activeDocumentId) schedule(previousActiveId, 100);
    previousActiveId = state.activeDocumentId;
    for (const documentId of state.tabOrder) {
      const record = state.documentsById[documentId];
      if (record.lifecycle.content === 'dirty' && record.lifecycle.recovery !== 'current') {
        schedule(documentId);
      } else if (record.lifecycle.content === 'clean') {
        cancelTimer(documentId);
        const cleared = clearedRevisions.get(documentId);
        if (cleared === undefined || cleared < record.source.revision) {
          clearedRevisions.set(documentId, record.source.revision);
          void backend.clear(documentId, record.source.revision);
        }
      }
    }
    for (const documentId of Array.from(timers.keys())) {
      if (!state.documentsById[documentId]) cancelTimer(documentId);
    }
  };

  const checkpointSync = (documentId: DocumentId, _reason: RecoveryLifecycleReason = 'beforeunload'): RecoveryCatalogEntry | null => {
    flushEditor?.(documentId);
    const record = getState().documentsById[documentId];
    if (!record || record.lifecycle.content !== 'dirty') return null;
    const started = monotonicNow();
    const leased = leasedInputForRecord(record, now());
    let entry: RecoveryCatalogEntry;
    try {
      entry = backend.checkpointSync(leased.input);
      recordRecoverySnapshot(documentId, leased.input.sourceText, monotonicNow() - started, 'recovery-checkpoint-sync');
    } finally {
      leased.release();
    }
    markCurrentIfUnchanged(documentId, entry.sourceRevision);
    recordCheckpoint(documentId);
    return entry;
  };

  const flushDocument = async (
    documentId: DocumentId,
    _reason: RecoveryLifecycleReason = 'destructive-barrier',
  ): Promise<RecoveryCatalogEntry | null> => {
    cancelTimer(documentId);
    const existing = inFlight.get(documentId);
    if (existing) return existing;
    const operation = (async (): Promise<RecoveryCatalogEntry | null> => {
      for (;;) {
        flushEditor?.(documentId);
        const record = getState().documentsById[documentId];
        if (!record) return null;
        if (record.lifecycle.content !== 'dirty') {
          await backend.clear(documentId, record.source.revision);
          clearedRevisions.set(documentId, record.source.revision);
          return null;
        }
        try {
          const started = monotonicNow();
          const leased = leasedInputForRecord(record, now());
          let entry: RecoveryCatalogEntry;
          try {
            entry = await backend.checkpoint(leased.input);
            recordRecoverySnapshot(documentId, leased.input.sourceText, monotonicNow() - started, 'recovery-checkpoint');
          } finally {
            leased.release();
          }
          recordCheckpoint(documentId);
          const current = getState().documentsById[documentId];
          if (!current) return entry;
          if (current.source.revision === entry.sourceRevision) {
            markCurrentIfUnchanged(documentId, entry.sourceRevision);
            return entry;
          }
        } catch (error) {
          failedCheckpointCount += 1;
          const current = getState().documentsById[documentId];
          if (current) dispatch({ type: 'updateDocument', documentId, action: { type: 'recoveryChanged', recovery: 'failed' } });
          throw error;
        }
      }
    })();
    inFlight.set(documentId, operation);
    try {
      return await operation;
    } finally {
      if (inFlight.get(documentId) === operation) inFlight.delete(documentId);
    }
  };

  const flushAll = async (reason: RecoveryLifecycleReason = 'destructive-barrier') => {
    const documentIds = getState().tabOrder.slice();
    await Promise.all(documentIds.map((documentId) => flushDocument(documentId, reason)));
  };

  const clearDocument = async (documentId: DocumentId, upToSourceRevision: SourceRevision) => {
    cancelTimer(documentId);
    const cleared = await backend.clear(documentId, upToSourceRevision);
    if (cleared) {
      clearedRevisions.set(documentId, upToSourceRevision);
      pendingSince.delete(documentId);
    }
    return cleared;
  };

  const attachLifecycleListeners = () => {
    enabled = true;
    if (detachLifecycle || typeof window === 'undefined' || typeof document === 'undefined') return detachLifecycle ?? (() => undefined);
    const visibility = () => {
      if (document.visibilityState === 'hidden') void flushAll('visibility-hidden');
    };
    const pagehide = () => flushAllSync('pagehide');
    const beforeunload = () => flushAllSync('beforeunload');
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('beforeunload', beforeunload);
    detachLifecycle = () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('beforeunload', beforeunload);
      detachLifecycle = null;
    };
    return detachLifecycle;
  };

  const flushAllSync = (reason: RecoveryLifecycleReason) => {
    for (const documentId of getState().tabOrder) checkpointSync(documentId, reason);
    void flushAll(reason);
  };

  const cancelTimer = (documentId: DocumentId) => {
    const scheduled = timers.get(documentId);
    if (!scheduled) return;
    clearTimeout(scheduled.timer);
    timers.delete(documentId);
  };

  const markCurrentIfUnchanged = (documentId: DocumentId, revision: SourceRevision) => {
    const current = getState().documentsById[documentId];
    if (current?.source.revision !== revision || current.lifecycle.recovery === 'current') return;
    dispatch({ type: 'updateDocument', documentId, action: { type: 'recoveryChanged', recovery: 'current' } });
  };

  const recordCheckpoint = (documentId: DocumentId) => {
    const lag = Math.max(0, now() - (pendingSince.get(documentId) ?? now()));
    pendingSince.delete(documentId);
    checkpointCount += 1;
    lastCheckpointLagMs = lag;
    checkpointLagMaxMs = Math.max(checkpointLagMaxMs, lag);
  };

  return {
    observe,
    configureEditorFlush: (flush) => { enabled = true; flushEditor = flush; observe(getState()); },
    attachLifecycleListeners,
    checkpointSync,
    flushDocument,
    flushAll,
    clearDocument,
    recoveryCenter: backend.recoveryCenter,
    metrics: () => ({
      checkpointCount,
      checkpointLagMaxMs,
      lastCheckpointLagMs,
      failedCheckpointCount,
      pendingDocumentCount: timers.size + inFlight.size,
    }),
    destroy: () => {
      detachLifecycle?.();
      for (const documentId of Array.from(timers.keys())) cancelTimer(documentId);
      flushEditor = null;
    },
  };
}

function leasedInputForRecord(record: DocumentRecord, savedAt: number): { input: RecoveryCheckpointInput; release(): void } {
  const current = sourceSnapshotService.lease(record.id, record.source.buffer.current, 'recovery');
  const saved = sourceSnapshotService.lease(record.id, record.source.buffer.saved, 'recovery', 'saved');
  return {
    input: {
    documentId: record.id,
    sourceRevision: record.source.revision,
    locator: record.locator,
    sourceText: current.sourceText,
    savedSourceText: saved.sourceText,
    format: record.format,
    savedAt,
    baseMetadata: record.locator.kind === 'file' ? record.fileBaseline : null,
    },
    release: () => { current.release(); saved.release(); },
  };
}

function recordRecoverySnapshot(documentId: DocumentId, sourceText: string, durationMs: number, phase: string): void {
  documentPerformance.trace({
    name: 'whole-source-materialization',
    documentId,
    durationMs,
    materializedBytes: utf8ByteLength(sourceText),
    phase,
  });
}

function monotonicNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}
