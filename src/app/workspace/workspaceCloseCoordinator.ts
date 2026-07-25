import type { DocumentId, SourceRevision } from '../documentIdentity';
import type { DocumentRecord } from '../documentRecord';
import type { WorkspaceManifestCoordinator } from './workspaceManifestCoordinator';
import type { WorkspaceRecoveryCoordinator } from './workspaceRecoveryCoordinator';
import type { WorkspaceSaveCoordinator } from './workspaceSaveCoordinator';
import { workspaceReducer, type WorkspaceCloseAuthorization, type WorkspaceCommand, type WorkspaceState } from './workspaceState';

export type WorkspaceCloseScope =
  | { kind: 'document'; documentId: DocumentId }
  | { kind: 'others'; documentId: DocumentId }
  | { kind: 'right'; documentId: DocumentId }
  | { kind: 'all' }
  | { kind: 'quit' };

export type WorkspaceCloseAction = 'save-selected' | 'discard-selected' | 'review-conflicts' | 'retry' | 'cancel';
export type WorkspaceCloseStatus = 'closed' | 'decision-required' | 'partial-failure' | 'cancelled' | 'busy';

export interface WorkspaceDirtySummary {
  totalDocuments: number;
  dirtyCount: number;
  savingCount: number;
  conflictCount: number;
  accessBlockedCount: number;
  recoveryPendingCount: number;
  protectedCount: number;
  active: {
    dirty: boolean;
    saving: boolean;
    conflict: boolean;
    accessBlocked: boolean;
    recoveryPending: boolean;
  } | null;
  background: {
    dirtyCount: number;
    savingCount: number;
    conflictCount: number;
    accessBlockedCount: number;
    recoveryPendingCount: number;
  };
  requiresProtection: boolean;
}

export interface WorkspaceCloseTarget {
  documentId: DocumentId;
  sourceRevision: SourceRevision;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  accessBlocked: boolean;
  recoveryPending: boolean;
}

export interface WorkspaceCloseDecisionModel {
  transactionId: string;
  scope: WorkspaceCloseScope;
  targets: readonly WorkspaceCloseTarget[];
  unresolvedDocumentIds: readonly DocumentId[];
  failedDocumentIds: readonly DocumentId[];
  summary: WorkspaceDirtySummary;
  actions: readonly WorkspaceCloseAction[];
}

export interface WorkspaceCloseResult {
  status: WorkspaceCloseStatus;
  decision: WorkspaceCloseDecisionModel | null;
}

export interface WorkspaceCloseTraceEvent {
  transactionId: string;
  type: 'begin' | 'editor-flushed' | 'recovery-settled' | 'decision-required' | 'saved' | 'discarded' | 'failed' | 'cancelled' | 'manifest-published' | 'document-removed' | 'window-destroyed';
  documentId?: DocumentId;
}

export interface WorkspaceCloseCoordinator {
  summary(): WorkspaceDirtySummary;
  begin(scope: WorkspaceCloseScope, destroyWindow?: () => Promise<void>): Promise<WorkspaceCloseResult>;
  decide(transactionId: string, action: WorkspaceCloseAction, documentIds?: readonly DocumentId[]): Promise<WorkspaceCloseResult>;
  pendingDecision(): WorkspaceCloseDecisionModel | null;
  configureEditorFlush(flush: (documentId: DocumentId) => void): void;
  trace(): readonly WorkspaceCloseTraceEvent[];
}

interface CloseTransaction {
  id: string;
  scope: WorkspaceCloseScope;
  targets: WorkspaceCloseTarget[];
  unresolved: Set<DocumentId>;
  failed: Set<DocumentId>;
  lastAction: Map<DocumentId, 'save-selected' | 'discard-selected'>;
  settledAuthorizations: Map<DocumentId, WorkspaceCloseAuthorization>;
  destroyWindow?: () => Promise<void>;
}

class CloseAuthorizationDriftError extends Error {
  constructor(readonly documentIds: readonly DocumentId[]) {
    super('A document changed while close durability was being published.');
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const ACTIONS: readonly WorkspaceCloseAction[] = ['save-selected', 'discard-selected', 'review-conflicts', 'retry', 'cancel'];

export function summarizeWorkspaceDirtyState(state: WorkspaceState): WorkspaceDirtySummary {
  const statuses = state.tabOrder.map((id) => statusFor(state.documentsById[id])).filter((value): value is ReturnType<typeof statusFor> & {} => Boolean(value));
  const activeStatus = state.activeDocumentId ? statusFor(state.documentsById[state.activeDocumentId]) : null;
  const count = (key: 'dirty' | 'saving' | 'conflict' | 'accessBlocked' | 'recoveryPending') => statuses.filter((entry) => entry[key]).length;
  const background = statuses.filter((entry) => entry.documentId !== state.activeDocumentId);
  const backgroundCount = (key: 'dirty' | 'saving' | 'conflict' | 'accessBlocked' | 'recoveryPending') => background.filter((entry) => entry[key]).length;
  const protectedCount = statuses.filter(isProtected).length;
  return {
    totalDocuments: statuses.length,
    dirtyCount: count('dirty'),
    savingCount: count('saving'),
    conflictCount: count('conflict'),
    accessBlockedCount: count('accessBlocked'),
    recoveryPendingCount: count('recoveryPending'),
    protectedCount,
    active: activeStatus ? {
      dirty: activeStatus.dirty,
      saving: activeStatus.saving,
      conflict: activeStatus.conflict,
      accessBlocked: activeStatus.accessBlocked,
      recoveryPending: activeStatus.recoveryPending,
    } : null,
    background: {
      dirtyCount: backgroundCount('dirty'),
      savingCount: backgroundCount('saving'),
      conflictCount: backgroundCount('conflict'),
      accessBlockedCount: backgroundCount('accessBlocked'),
      recoveryPendingCount: backgroundCount('recoveryPending'),
    },
    requiresProtection: protectedCount > 0,
  };
}

export function createWorkspaceCloseCoordinator(
  getState: () => WorkspaceState,
  dispatch: (command: WorkspaceCommand) => WorkspaceState,
  saves: WorkspaceSaveCoordinator,
  recovery: WorkspaceRecoveryCoordinator,
  manifest: WorkspaceManifestCoordinator,
  options: { timeoutMs?: number } = {},
): WorkspaceCloseCoordinator {
  let sequence = 0;
  let editorFlush: ((documentId: DocumentId) => void) | null = null;
  let pending: CloseTransaction | null = null;
  let running = false;
  const events: WorkspaceCloseTraceEvent[] = [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const record = (transactionId: string, type: WorkspaceCloseTraceEvent['type'], documentId?: DocumentId) => events.push({ transactionId, type, ...(documentId ? { documentId } : {}) });

  const model = (transaction: CloseTransaction): WorkspaceCloseDecisionModel => ({
    transactionId: transaction.id,
    scope: transaction.scope,
    targets: transaction.targets,
    unresolvedDocumentIds: transaction.targets.map((target) => target.documentId).filter((id) => transaction.unresolved.has(id)),
    failedDocumentIds: transaction.targets.map((target) => target.documentId).filter((id) => transaction.failed.has(id)),
    summary: summarizeWorkspaceDirtyState(getState()),
    actions: ACTIONS,
  });

  const publishAndFinalize = async (
    transaction: CloseTransaction,
    authorizations: WorkspaceCloseAuthorization[],
    removeDocuments: boolean,
  ) => {
    let projected = getState();
    if (removeDocuments) {
      for (const authorization of authorizations) projected = workspaceReducer(projected, { type: 'finalizeRemoveDocument', authorization });
    }
    const before = manifest.metrics();
    const generation = await withTimeout(manifest.flushState(projected, true, true), timeoutMs);
    const after = manifest.metrics();
    if (!after.active || generation === null || after.failedPublicationCount > before.failedPublicationCount) {
      throw new Error('Workspace manifest publication did not complete.');
    }
    const staleDocumentIds = authorizations
      .filter((authorization) => !closeAuthorizationStillCurrent(getState(), authorization))
      .map((authorization) => authorization.documentId);
    if (staleDocumentIds.length > 0) throw new CloseAuthorizationDriftError(staleDocumentIds);
    record(transaction.id, 'manifest-published');
    if (!removeDocuments) return;
    for (const authorization of authorizations) {
      const next = dispatch({ type: 'finalizeRemoveDocument', authorization });
      if (next.documentsById[authorization.documentId]) {
        throw new CloseAuthorizationDriftError([authorization.documentId]);
      }
      record(transaction.id, 'document-removed', authorization.documentId);
    }
  };

  const finish = async (transaction: CloseTransaction, authorizations: WorkspaceCloseAuthorization[]): Promise<WorkspaceCloseResult> => {
    const publicationAuthorizations = transaction.scope.kind === 'quit'
      ? [...transaction.settledAuthorizations.values(), ...authorizations]
      : authorizations;
    try {
      await publishAndFinalize(transaction, publicationAuthorizations, transaction.scope.kind !== 'quit');
    } catch (error) {
      const failedIds = error instanceof CloseAuthorizationDriftError
        ? error.documentIds
        : authorizations.map((authorization) => authorization.documentId);
      for (const documentId of failedIds) {
        editorFlush?.(documentId);
        const current = getState().documentsById[documentId];
        if (current) {
          try {
            await withTimeout(recovery.flushDocument(documentId, 'destructive-barrier'), timeoutMs);
          } catch {
            // The transaction remains blocked and retryable below.
          }
          const refreshed = statusFor(getState().documentsById[documentId]);
          if (refreshed) {
            const targetIndex = transaction.targets.findIndex((target) => target.documentId === documentId);
            if (targetIndex >= 0) transaction.targets[targetIndex] = refreshed;
            dispatch({ type: 'requestClose', documentId, requestId: transaction.id });
          }
        }
        transaction.settledAuthorizations.delete(documentId);
        transaction.failed.add(documentId);
        transaction.unresolved.add(documentId);
        record(transaction.id, 'failed', documentId);
      }
      if (error instanceof CloseAuthorizationDriftError) {
        try {
          await withTimeout(manifest.flushState(getState(), true, true), timeoutMs);
        } catch {
          // A failed refresh leaves the close transaction blocked; recovery was
          // attempted above and the window/document is deliberately retained.
        }
      }
      pending = transaction;
      return { status: 'partial-failure', decision: model(transaction) };
    }
    for (const authorization of authorizations) {
      transaction.settledAuthorizations.set(authorization.documentId, authorization);
    }
    if (transaction.unresolved.size > 0) {
      pending = transaction;
      return { status: transaction.failed.size ? 'partial-failure' : 'decision-required', decision: model(transaction) };
    }
    const finalAuthorizations = transaction.scope.kind === 'quit'
      ? Array.from(transaction.settledAuthorizations.values())
      : authorizations;
    const clearedDiscarded = new Set<DocumentId>();
    await Promise.all(finalAuthorizations.map(async (authorization) => {
      if (authorization.outcome === 'clean') return;
      try {
        const cleared = await withTimeout(
          recovery.clearDocument(authorization.documentId, authorization.sourceRevision),
          timeoutMs,
        );
        if (cleared && authorization.outcome === 'discarded') {
          clearedDiscarded.add(authorization.documentId);
        }
      } catch {
        // Once the manifest is durable, retaining a stale recovery snapshot is
        // safer than reopening or rolling back an already-finalized close.
      }
    }));
    if (transaction.scope.kind === 'quit' && transaction.destroyWindow) {
      try {
        await withTimeout(transaction.destroyWindow(), timeoutMs);
        record(transaction.id, 'window-destroyed');
      } catch {
        for (const documentId of clearedDiscarded) {
          try {
            await withTimeout(recovery.restoreDocument(documentId), timeoutMs);
          } catch {
            // The close remains unresolved and retryable; recovery restoration
            // failure is surfaced through the transaction's failed targets.
          }
        }
        for (const authorization of finalAuthorizations) {
          transaction.failed.add(authorization.documentId);
          transaction.unresolved.add(authorization.documentId);
          record(transaction.id, 'failed', authorization.documentId);
        }
        pending = transaction;
        return { status: 'partial-failure', decision: model(transaction) };
      }
    }
    pending = null;
    return { status: 'closed', decision: null };
  };

  const settle = async (transaction: CloseTransaction, action: 'save-selected' | 'discard-selected', selected: readonly DocumentId[]) => {
    const authorizations: WorkspaceCloseAuthorization[] = [];
    for (const documentId of selected) {
      if (!transaction.unresolved.has(documentId)) continue;
      let target = transaction.targets.find((entry) => entry.documentId === documentId);
      if (!target) {
        transaction.failed.add(documentId);
        record(transaction.id, 'failed', documentId);
        continue;
      }
      if (target.saving || saves.queuedFor(documentId) > 0) {
        const expectedRevision = target.sourceRevision;
        saves.cancelAutosave(documentId);
        let laneSettled = true;
        try {
          await withTimeout(saves.awaitIdle(documentId), timeoutMs);
        } catch {
          laneSettled = false;
        }
        const refreshed = statusFor(getState().documentsById[documentId]);
        if (refreshed) {
          const targetIndex = transaction.targets.findIndex((entry) => entry.documentId === documentId);
          if (targetIndex >= 0) transaction.targets[targetIndex] = refreshed;
          dispatch({ type: 'requestClose', documentId, requestId: transaction.id });
        }
        if (
          !laneSettled
          || !refreshed
          || refreshed.sourceRevision !== expectedRevision
          || refreshed.saving
          || saves.queuedFor(documentId) > 0
        ) {
          transaction.failed.add(documentId);
          transaction.unresolved.add(documentId);
          record(transaction.id, 'failed', documentId);
          continue;
        }
        target = refreshed;
      }
      const current = getState().documentsById[documentId];
      if (!target || !current || current.source.revision !== target.sourceRevision) {
        transaction.failed.add(documentId);
        record(transaction.id, 'failed', documentId);
        continue;
      }
      transaction.lastAction.set(documentId, action);
      try {
        if (action === 'save-selected') {
          const saved = await withTimeout(saves.saveDocument(documentId), timeoutMs);
          const afterSave = getState().documentsById[documentId];
          if (!saved || !afterSave || afterSave.lifecycle.content !== 'clean') throw new Error('Document save did not settle cleanly.');
          authorizations.push(authorizationFor(transaction, target, 'saved'));
          record(transaction.id, 'saved', documentId);
        } else {
          authorizations.push(authorizationFor(transaction, target, 'discarded'));
          record(transaction.id, 'discarded', documentId);
        }
        transaction.unresolved.delete(documentId);
        transaction.failed.delete(documentId);
      } catch {
        transaction.failed.add(documentId);
        record(transaction.id, 'failed', documentId);
      }
    }
    return finish(transaction, authorizations);
  };

  return {
    summary: () => summarizeWorkspaceDirtyState(getState()),
    configureEditorFlush: (flush) => { editorFlush = flush; },
    trace: () => events.slice(),
    pendingDecision: () => pending ? model(pending) : null,
    async begin(scope, destroyWindow) {
      if (running || pending) return { status: 'busy', decision: pending ? model(pending) : null };
      running = true;
      const id = `close:${++sequence}`;
      record(id, 'begin');
      try {
        const documentIds = targetsFor(getState(), scope);
        for (const documentId of documentIds) {
          editorFlush?.(documentId);
          record(id, 'editor-flushed', documentId);
        }
        const targets = documentIds.map((documentId) => statusFor(getState().documentsById[documentId])).filter((value): value is WorkspaceCloseTarget => Boolean(value));
        const transaction: CloseTransaction = {
          id,
          scope,
          targets,
          unresolved: new Set(),
          failed: new Set(),
          lastAction: new Map(),
          settledAuthorizations: new Map(),
          destroyWindow,
        };
        const cleanAuthorizations: WorkspaceCloseAuthorization[] = [];
        for (const target of targets) {
          dispatch({ type: 'requestClose', documentId: target.documentId, requestId: id });
          if (target.dirty || target.recoveryPending) {
            try {
              await withTimeout(recovery.flushDocument(target.documentId, 'destructive-barrier'), timeoutMs);
              record(id, 'recovery-settled', target.documentId);
            } catch {
              transaction.failed.add(target.documentId);
            }
          } else {
            // Clean documents have no recoverable source delta. Their prior
            // catalog cleanup is best-effort and must not gate tab or window
            // responsiveness.
            record(id, 'recovery-settled', target.documentId);
          }
          if (isProtected(target) || transaction.failed.has(target.documentId)) transaction.unresolved.add(target.documentId);
          else cleanAuthorizations.push(authorizationFor(transaction, target, 'clean'));
        }
        if (transaction.unresolved.size > 0) {
          pending = transaction;
          record(id, 'decision-required');
          return { status: transaction.failed.size ? 'partial-failure' : 'decision-required', decision: model(transaction) };
        }
        return await finish(transaction, cleanAuthorizations);
      } finally {
        running = false;
      }
    },
    async decide(transactionId, action, documentIds) {
      const transaction = pending;
      if (!transaction || transaction.id !== transactionId || running) return { status: 'busy', decision: transaction ? model(transaction) : null };
      if (action === 'cancel') {
        for (const target of transaction.targets) dispatch({ type: 'cancelClose', documentId: target.documentId, requestId: transaction.id });
        record(transaction.id, 'cancelled');
        pending = null;
        return { status: 'cancelled', decision: null };
      }
      if (action === 'review-conflicts') return { status: 'decision-required', decision: model(transaction) };
      const selected = (documentIds ?? Array.from(transaction.unresolved)).filter((id) => transaction.unresolved.has(id));
      const resolvedAction = action === 'retry' ? null : action;
      running = true;
      try {
        if (resolvedAction) return await settle(transaction, resolvedAction, selected);
        let result: WorkspaceCloseResult = { status: 'decision-required', decision: model(transaction) };
        for (const documentId of selected) {
          const previous = transaction.lastAction.get(documentId);
          if (previous) result = await settle(transaction, previous, [documentId]);
        }
        return result;
      } finally {
        running = false;
      }
    },
  };
}

function statusFor(document: DocumentRecord | undefined): WorkspaceCloseTarget | null {
  if (!document) return null;
  return {
    documentId: document.id,
    sourceRevision: document.source.revision,
    dirty: document.lifecycle.content === 'dirty',
    saving: document.lifecycle.autosaveStatus === 'pending' || document.lifecycle.autosaveStatus === 'saving',
    conflict: document.lifecycle.external !== 'inSync',
    accessBlocked: document.lifecycle.access !== 'writable',
    recoveryPending: document.lifecycle.recovery !== 'notRequired' && document.lifecycle.recovery !== 'current',
  };
}

function isProtected(target: WorkspaceCloseTarget): boolean {
  return target.dirty || target.saving || target.conflict || target.accessBlocked || target.recoveryPending;
}

function targetsFor(state: WorkspaceState, scope: WorkspaceCloseScope): DocumentId[] {
  if (scope.kind === 'document') return state.documentsById[scope.documentId] ? [scope.documentId] : [];
  if (scope.kind === 'others') return state.tabOrder.filter((id) => id !== scope.documentId);
  if (scope.kind === 'right') {
    const index = state.tabOrder.indexOf(scope.documentId);
    return index < 0 ? [] : state.tabOrder.slice(index + 1);
  }
  return state.tabOrder.slice();
}

function authorizationFor(transaction: CloseTransaction, target: WorkspaceCloseTarget, outcome: WorkspaceCloseAuthorization['outcome']): WorkspaceCloseAuthorization {
  return { requestId: transaction.id, documentId: target.documentId, sourceRevision: target.sourceRevision, outcome };
}

function closeAuthorizationStillCurrent(state: WorkspaceState, authorization: WorkspaceCloseAuthorization): boolean {
  const request = state.pendingCloseRequests[authorization.documentId];
  const document = state.documentsById[authorization.documentId];
  if (!request || !document) return false;
  return request.requestId === authorization.requestId
    && request.sourceRevision === authorization.sourceRevision
    && document.source.revision === authorization.sourceRevision
    && (!request.requiresDurabilityDecision
      || authorization.outcome === 'discarded'
      || (authorization.outcome === 'saved' && document.lifecycle.content === 'clean'))
    && (request.requiresDurabilityDecision
      || authorization.outcome !== 'discarded'
      || document.lifecycle.content === 'clean');
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Close durability operation timed out.')), timeoutMs);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
