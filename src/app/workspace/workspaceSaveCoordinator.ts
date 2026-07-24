import type { DocumentId, DocumentLocator, SourceRevision } from '../documentIdentity';
import { sameDocumentLocator } from '../documentIdentity';
import type { DocumentRecord } from '../documentRecord';
import type { FileMetadata } from '../documentState';

export type SaveRequestKind = 'manual' | 'autosave';
export type SaveOperationId = string & { readonly __saveOperationId: unique symbol };

export interface SaveOperationToken {
  documentId: DocumentId;
  operationId: SaveOperationId;
  sourceRevision: SourceRevision;
  locator: DocumentLocator;
  metadataBaseline: FileMetadata;
  kind: SaveRequestKind;
}

export interface SaveCoordinatorDiagnostic {
  sequence: number;
  code: 'TARGET_MISSING' | 'LOCATOR_STALE' | 'REVISION_REGRESSED' | 'TASK_FAILED';
  documentId: DocumentId;
  operationId: SaveOperationId;
  sourceRevision: SourceRevision;
  currentSourceRevision: SourceRevision | null;
}

export interface WorkspaceSaveCoordinator {
  begin(documentId: DocumentId, kind: SaveRequestKind): SaveOperationToken | null;
  isOriginCurrent(token: SaveOperationToken): boolean;
  refreshLocator(token: SaveOperationToken): SaveOperationToken | null;
  commitOrigin<T>(token: SaveOperationToken, mutation: (current: DocumentRecord) => T): { accepted: boolean; value?: T };
  enqueue<T>(token: SaveOperationToken, task: () => Promise<T>): Promise<T>;
  scheduleNativeWrite<T>(token: SaveOperationToken, task: () => Promise<T>): Promise<T>;
  queuedFor(documentId: DocumentId): number;
  awaitIdle(documentId: DocumentId): Promise<void>;
  totalQueued(): number;
  subscribe(listener: () => void): () => void;
  scheduleAutosave(input: WorkspaceAutosaveCandidate): void;
  cancelAutosave(documentId: DocumentId): void;
  flushAutosave(documentId: DocumentId): Promise<string | false | true>;
  registerActor(documentId: DocumentId, actor: WorkspaceSaveActor): void;
  saveDocument(documentId: DocumentId, options?: WorkspaceSaveActorOptions): Promise<string | false>;
  saveAll(documentIds: readonly DocumentId[]): Promise<ReadonlyMap<DocumentId, string | false>>;
  diagnostics(): readonly SaveCoordinatorDiagnostic[];
}

export interface WorkspaceSaveActorOptions {
  autosave?: boolean;
  forceSaveAs?: boolean;
  forceOverwrite?: boolean;
}

export interface WorkspaceSaveActor {
  save(options?: WorkspaceSaveActorOptions): Promise<string | false>;
}

export interface WorkspaceAutosaveCandidate {
  documentId: DocumentId;
  sourceRevision: SourceRevision;
  eligible: boolean;
  blocked: boolean;
  delayMs: number;
  maxWaitMs: number;
  save: () => Promise<string | false>;
  setStatus: (status: 'idle' | 'pending' | 'paused' | 'error') => void;
}

interface AutosaveRuntime {
  candidate: WorkspaceAutosaveCandidate;
  timer: ReturnType<typeof setTimeout> | null;
  firstPendingAt: number;
  inFlight: Promise<string | false> | null;
  rerun: boolean;
}

interface NativeWriteRequest<T> {
  token: SaveOperationToken;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const MAX_DIAGNOSTICS = 100;

export function createWorkspaceSaveCoordinator(
  getDocument: (documentId: DocumentId) => DocumentRecord | null,
  mutateDocument: <T>(documentId: DocumentId, mutation: (current: DocumentRecord) => T) => T | undefined,
): WorkspaceSaveCoordinator {
  const lanes = new Map<DocumentId, Promise<unknown>>();
  const queueDepth = new Map<DocumentId, number>();
  const listeners = new Set<() => void>();
  const manualWrites: NativeWriteRequest<unknown>[] = [];
  const autosaveWrites: NativeWriteRequest<unknown>[] = [];
  const diagnostics: SaveCoordinatorDiagnostic[] = [];
  const autosaves = new Map<DocumentId, AutosaveRuntime>();
  const actors = new Map<DocumentId, WorkspaceSaveActor>();
  let operationSequence = 0;
  let diagnosticSequence = 0;
  let nativeWriteRunning = false;

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const record = (code: SaveCoordinatorDiagnostic['code'], token: SaveOperationToken) => {
    const current = getDocument(token.documentId);
    diagnostics.push({
      sequence: ++diagnosticSequence,
      code,
      documentId: token.documentId,
      operationId: token.operationId,
      sourceRevision: token.sourceRevision,
      currentSourceRevision: current?.source.revision ?? null,
    });
    if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS);
  };
  const validate = (token: SaveOperationToken): DocumentRecord | null => {
    const current = getDocument(token.documentId);
    if (!current) {
      record('TARGET_MISSING', token);
      return null;
    }
    if (!sameDocumentLocator(current.locator, token.locator)) {
      record('LOCATOR_STALE', token);
      return null;
    }
    if (current.source.revision < token.sourceRevision) {
      record('REVISION_REGRESSED', token);
      return null;
    }
    return current;
  };
  const pumpWrites = () => {
    if (nativeWriteRunning) return;
    const request = manualWrites.shift() ?? autosaveWrites.shift();
    if (!request) return;
    nativeWriteRunning = true;
    const write = validate(request.token)
      ? request.task()
      : Promise.reject(new Error('Save origin changed before the native write lease was acquired.'));
    void write.then(request.resolve, request.reject).finally(() => {
      nativeWriteRunning = false;
      pumpWrites();
    });
  };
  const runAutosave = async (documentId: DocumentId): Promise<string | false> => {
    const runtime = autosaves.get(documentId);
    if (!runtime) return false;
    if (runtime.inFlight) {
      runtime.rerun = true;
      return runtime.inFlight;
    }
    const task = (async () => {
      let result: string | false = false;
      do {
        runtime.rerun = false;
        result = await runtime.candidate.save();
      } while (runtime.rerun && runtime.candidate.eligible && !runtime.candidate.blocked);
      return result;
    })();
    runtime.inFlight = task;
    try {
      return await task;
    } finally {
      if (runtime.inFlight === task) {
        runtime.inFlight = null;
        runtime.firstPendingAt = Date.now();
      }
    }
  };

  return {
    begin(documentId, kind) {
      const document = getDocument(documentId);
      if (!document) return null;
      return {
        documentId,
        operationId: `save:${kind}:${++operationSequence}` as SaveOperationId,
        sourceRevision: document.source.revision,
        locator: document.locator,
        metadataBaseline: document.fileBaseline,
        kind,
      };
    },
    isOriginCurrent(token) {
      return validate(token) !== null;
    },
    refreshLocator(token) {
      const current = getDocument(token.documentId);
      if (!current || current.source.revision < token.sourceRevision) return null;
      return { ...token, locator: current.locator };
    },
    commitOrigin(token, mutation) {
      if (!validate(token)) return { accepted: false };
      const value = mutateDocument(token.documentId, mutation);
      return { accepted: true, value };
    },
    enqueue(token, task) {
      queueDepth.set(token.documentId, (queueDepth.get(token.documentId) ?? 0) + 1);
      notify();
      const previous = lanes.get(token.documentId) ?? Promise.resolve();
      const queued = previous.then(task, task);
      const settled = queued.catch((error) => {
        record('TASK_FAILED', token);
        throw error;
      }).finally(() => {
        const nextDepth = Math.max(0, (queueDepth.get(token.documentId) ?? 1) - 1);
        if (nextDepth === 0) queueDepth.delete(token.documentId);
        else queueDepth.set(token.documentId, nextDepth);
        if (lanes.get(token.documentId) === settled) lanes.delete(token.documentId);
        notify();
      });
      lanes.set(token.documentId, settled);
      return settled;
    },
    scheduleNativeWrite(token, task) {
      return new Promise((resolve, reject) => {
        const request: NativeWriteRequest<unknown> = { token, task, resolve: resolve as (value: unknown) => void, reject };
        (token.kind === 'manual' ? manualWrites : autosaveWrites).push(request);
        pumpWrites();
      });
    },
    queuedFor: (documentId) => queueDepth.get(documentId) ?? 0,
    async awaitIdle(documentId) {
      for (;;) {
        const lane = lanes.get(documentId);
        if (!lane) return;
        await lane.catch(() => undefined);
      }
    },
    totalQueued: () => Array.from(queueDepth.values()).reduce((total, count) => total + count, 0),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    scheduleAutosave(candidate) {
      const previous = autosaves.get(candidate.documentId);
      if (previous?.timer) clearTimeout(previous.timer);
      const runtime: AutosaveRuntime = previous ?? {
        candidate,
        timer: null,
        firstPendingAt: Date.now(),
        inFlight: null,
        rerun: false,
      };
      runtime.candidate = candidate;
      runtime.timer = null;
      autosaves.set(candidate.documentId, runtime);
      if (!candidate.eligible) {
        candidate.setStatus(candidate.blocked ? 'paused' : 'idle');
        return;
      }
      candidate.setStatus('pending');
      const elapsed = Date.now() - runtime.firstPendingAt;
      const delay = Math.min(candidate.delayMs, Math.max(0, candidate.maxWaitMs - elapsed));
      runtime.timer = setTimeout(() => {
        runtime.timer = null;
        void runAutosave(candidate.documentId).catch(() => candidate.setStatus('error'));
      }, delay);
    },
    cancelAutosave(documentId) {
      const runtime = autosaves.get(documentId);
      if (runtime?.timer) clearTimeout(runtime.timer);
      if (runtime) runtime.timer = null;
    },
    async flushAutosave(documentId) {
      const runtime = autosaves.get(documentId);
      if (!runtime) return true;
      if (runtime.timer) clearTimeout(runtime.timer);
      runtime.timer = null;
      if (!runtime.candidate.eligible || runtime.candidate.blocked) return false;
      return runAutosave(documentId);
    },
    registerActor(documentId, actor) {
      actors.set(documentId, actor);
    },
    saveDocument(documentId, options) {
      return actors.get(documentId)?.save(options) ?? Promise.resolve(false);
    },
    async saveAll(documentIds) {
      const results = new Map<DocumentId, string | false>();
      for (const documentId of documentIds) {
        results.set(documentId, await (actors.get(documentId)?.save() ?? Promise.resolve(false)));
      }
      return results;
    },
    diagnostics: () => diagnostics.slice(),
  };
}
