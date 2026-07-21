import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriRuntime } from '../runtime';
import type { WorkspaceCloseAction, WorkspaceCloseDecisionModel, WorkspaceCloseResult, WorkspaceCloseScope } from '../workspace/workspaceCloseCoordinator';
import type { WorkspaceStore } from '../workspace/workspaceStore';

interface UseWindowCloseGuardOptions {
  workspaceStore: WorkspaceStore;
  onCloseRequested: () => void;
}

export function useWindowCloseGuard({ workspaceStore, onCloseRequested }: UseWindowCloseGuardOptions) {
  const [closeDecision, setCloseDecision] = useState<WorkspaceCloseDecisionModel | null>(null);
  const allowCloseRef = useRef(false);
  const onCloseRequestedRef = useRef(onCloseRequested);

  useEffect(() => { onCloseRequestedRef.current = onCloseRequested; }, [onCloseRequested]);

  const destroyWindow = useCallback(async () => {
    allowCloseRef.current = true;
    try {
      if (isTauriRuntime()) await getCurrentWindow().close();
      else window.close();
    } finally {
      window.setTimeout(() => { allowCloseRef.current = false; }, 1000);
    }
  }, []);

  const adoptResult = useCallback((result: WorkspaceCloseResult) => {
    setCloseDecision(result.decision);
    return result;
  }, []);

  const closeWindow = useCallback(async () => {
    onCloseRequestedRef.current();
    return adoptResult(await workspaceStore.close.begin({ kind: 'quit' }, destroyWindow));
  }, [adoptResult, destroyWindow, workspaceStore]);

  const requestWorkspaceClose = useCallback(async (scope: WorkspaceCloseScope) => {
    onCloseRequestedRef.current();
    return adoptResult(await workspaceStore.close.begin(scope));
  }, [adoptResult, workspaceStore]);

  const resolveClose = useCallback(async (action: WorkspaceCloseAction) => {
    const decision = workspaceStore.close.pendingDecision();
    if (!decision) return null;
    return adoptResult(await workspaceStore.close.decide(decision.transactionId, action, decision.unresolvedDocumentIds));
  }, [adoptResult, workspaceStore]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!workspaceStore.close.summary().requiresProtection) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [workspaceStore]);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested((event) => {
      if (allowCloseRef.current) return;
      event.preventDefault();
      void closeWindow();
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch((error) => console.warn('Window close guard listener could not be registered.', error));
    return () => { disposed = true; unlisten?.(); };
  }, [closeWindow]);

  return {
    closeDialogOpen: closeDecision !== null,
    closeDecision,
    closeSummary: workspaceStore.close.summary(),
    closeWindow,
    requestWorkspaceClose,
    resolveClose,
  };
}
