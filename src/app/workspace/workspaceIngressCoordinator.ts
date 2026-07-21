import type { DocumentId } from '../documentIdentity';
import type { DocumentRecord } from '../documentRecord';
import { selectDocumentByLocator, type WorkspaceCommand, type WorkspaceReplacementAuthorization, type WorkspaceState } from './workspaceState';

export type WorkspaceIngressOrigin = 'picker' | 'explorer' | 'drop' | 'new' | 'template' | 'recent' | 'startup' | 'single-instance' | 'protocol';
export type WorkspaceIngressKind = 'open' | 'new';

export interface WorkspaceIngressDiagnostic {
  sequence: number;
  code: 'DEFERRED_ACTIVATION_SURFACE_REQUIRED' | 'TASK_FAILED';
  origin: WorkspaceIngressOrigin;
  documentId: DocumentId | null;
}

export interface WorkspaceIngressRouteRequest {
  origin: WorkspaceIngressOrigin;
  kind: WorkspaceIngressKind;
  document: DocumentRecord;
  replacementAuthorization: WorkspaceReplacementAuthorization;
  beforeActivate?: () => void;
}

export interface WorkspaceIngressRouteResult {
  status: 'added' | 'focused' | 'replaced' | 'deferred' | 'rejected';
  documentId: DocumentId | null;
}

export interface DeferredWorkspaceIngress {
  origin: WorkspaceIngressOrigin;
  kind: WorkspaceIngressKind;
  document: DocumentRecord;
}

export interface WorkspaceIngressCoordinator {
  enqueue<T>(origin: WorkspaceIngressOrigin, task: () => Promise<T>): Promise<T>;
  route(request: WorkspaceIngressRouteRequest): WorkspaceIngressRouteResult;
  deferred(): readonly DeferredWorkspaceIngress[];
  diagnostics(): readonly WorkspaceIngressDiagnostic[];
  pendingTaskCount(): number;
}

const MAX_DIAGNOSTICS = 100;

/** Sole command router for every prepared document entering the workspace. */
export function createWorkspaceIngressCoordinator(
  getState: () => WorkspaceState,
  dispatch: (command: WorkspaceCommand) => WorkspaceState,
): WorkspaceIngressCoordinator {
  let lane: Promise<unknown> = Promise.resolve();
  let pendingTasks = 0;
  let diagnosticSequence = 0;
  const deferredRequests: DeferredWorkspaceIngress[] = [];
  const diagnosticEntries: WorkspaceIngressDiagnostic[] = [];
  const record = (code: WorkspaceIngressDiagnostic['code'], origin: WorkspaceIngressOrigin, documentId: DocumentId | null) => {
    diagnosticEntries.push({ sequence: ++diagnosticSequence, code, origin, documentId });
    if (diagnosticEntries.length > MAX_DIAGNOSTICS) diagnosticEntries.splice(0, diagnosticEntries.length - MAX_DIAGNOSTICS);
  };

  return {
    enqueue(origin, task) {
      pendingTasks += 1;
      const operation = lane.then(task, task).catch((error) => {
        record('TASK_FAILED', origin, null);
        throw error;
      }).finally(() => { pendingTasks = Math.max(0, pendingTasks - 1); });
      lane = operation.catch(() => undefined);
      return operation;
    },
    route(request) {
      const state = getState();
      const existing = request.document.locator.kind === 'file'
        ? selectDocumentByLocator(state, request.document.locator)
        : null;
      if (existing) {
        request.beforeActivate?.();
        const next = dispatch({ type: 'focusDocumentByLocator', locator: request.document.locator as Extract<DocumentRecord['locator'], { kind: 'file' }> });
        return { status: next.activeDocumentId === existing.id ? 'focused' : 'rejected', documentId: next.activeDocumentId };
      }
      if (state.tabOrder.length === 0) {
        request.beforeActivate?.();
        const next = dispatch({ type: request.kind === 'open' ? 'openDocument' : 'newDocument', document: request.document });
        return { status: next.activeDocumentId === request.document.id ? 'added' : 'rejected', documentId: next.activeDocumentId };
      }
      if (state.capability.multiDocumentWorkspaceEnabled && !state.capability.activationSurface) {
        deferredRequests.push({ origin: request.origin, kind: request.kind, document: request.document });
        dispatch({ type: request.kind === 'open' ? 'openDocument' : 'newDocument', document: request.document });
        record('DEFERRED_ACTIVATION_SURFACE_REQUIRED', request.origin, request.document.id);
        return { status: 'deferred', documentId: null };
      }
      request.beforeActivate?.();
      if (state.capability.multiDocumentWorkspaceEnabled && state.capability.activationSurface) {
        const next = dispatch({ type: request.kind === 'open' ? 'openDocument' : 'newDocument', document: request.document });
        return { status: next.activeDocumentId === request.document.id ? 'added' : 'rejected', documentId: next.activeDocumentId };
      }
      const next = dispatch({ type: 'replaceActiveDocument', document: request.document, authorization: request.replacementAuthorization });
      return { status: next.activeDocumentId === request.document.id ? 'replaced' : 'rejected', documentId: next.activeDocumentId };
    },
    deferred: () => deferredRequests.slice(),
    diagnostics: () => diagnosticEntries.slice(),
    pendingTaskCount: () => pendingTasks,
  };
}
