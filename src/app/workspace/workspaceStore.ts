import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { DocumentRecord } from '../documentRecord';
import { createDocumentEffectCoordinator, type DocumentEffectCoordinator } from '../effects/documentEffectCoordinator';
import { createWorkspaceSaveCoordinator, type WorkspaceSaveCoordinator } from './workspaceSaveCoordinator';
import {
  createWorkspaceRecoveryCoordinator,
  type WorkspaceRecoveryBackend,
  type WorkspaceRecoveryCoordinator,
} from './workspaceRecoveryCoordinator';
import { createWorkspaceManifestCoordinator, type WorkspaceManifestCoordinator } from './workspaceManifestCoordinator';
import { createWorkspaceExternalChangeCoordinator, type WorkspaceExternalChangeCoordinator } from './workspaceExternalChangeCoordinator';
import { createWorkspaceCloseCoordinator, type WorkspaceCloseCoordinator } from './workspaceCloseCoordinator';
import { createWorkspaceIngressCoordinator, type WorkspaceIngressCoordinator } from './workspaceIngressCoordinator';
import {
  createWorkspaceState,
  selectActiveDocument,
  workspaceReducer,
  type WorkspaceCapabilityState,
  type WorkspaceCommand,
  type WorkspaceState,
} from './workspaceState';

export interface WorkspaceStore {
  getState: () => WorkspaceState;
  dispatch: (command: WorkspaceCommand) => WorkspaceState;
  subscribe: (listener: () => void) => () => void;
  effects: DocumentEffectCoordinator;
  saves: WorkspaceSaveCoordinator;
  recovery: WorkspaceRecoveryCoordinator;
  manifest: WorkspaceManifestCoordinator;
  externalChanges: WorkspaceExternalChangeCoordinator;
  close: WorkspaceCloseCoordinator;
  ingress: WorkspaceIngressCoordinator;
}

export function createWorkspaceStore(
  initialState: WorkspaceState,
  recoveryOptions: { backend?: WorkspaceRecoveryBackend; now?: () => number; closeTimeoutMs?: number } = {},
): WorkspaceStore {
  let state = initialState;
  const listeners = new Set<() => void>();
  const effects = createDocumentEffectCoordinator((documentId) => state.documentsById[documentId]?.source.revision ?? null);
  const saves = createWorkspaceSaveCoordinator(
    (documentId) => state.documentsById[documentId] ?? null,
    (documentId, mutation) => {
      const current = state.documentsById[documentId];
      return current ? mutation(current) : undefined;
    },
  );
  let recovery: WorkspaceRecoveryCoordinator;
  let manifest: WorkspaceManifestCoordinator;
  let externalChanges: WorkspaceExternalChangeCoordinator;
  let close: WorkspaceCloseCoordinator;
  let ingress: WorkspaceIngressCoordinator;
  const store: WorkspaceStore = {
    getState: () => state,
    dispatch: (command) => {
      const next = workspaceReducer(state, command);
      if (next !== state) {
        state = next;
        recovery.observe(state);
        manifest.observe(state);
        externalChanges.observe(state);
        for (const listener of listeners) listener();
      }
      return state;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    effects,
    saves,
    get recovery() { return recovery; },
    get manifest() { return manifest; },
    get externalChanges() { return externalChanges; },
    get close() { return close; },
    get ingress() { return ingress; },
  };
  recovery = createWorkspaceRecoveryCoordinator(store.getState, store.dispatch, recoveryOptions.backend, recoveryOptions.now);
  externalChanges = createWorkspaceExternalChangeCoordinator(store.getState, store.dispatch, saves, recovery, recoveryOptions.now);
  manifest = createWorkspaceManifestCoordinator(store.getState, recovery, recoveryOptions.now);
  close = createWorkspaceCloseCoordinator(store.getState, store.dispatch, saves, recovery, manifest, { timeoutMs: recoveryOptions.closeTimeoutMs });
  ingress = createWorkspaceIngressCoordinator(store.getState, store.dispatch);
  recovery.observe(state);
  externalChanges.observe(state);
  return store;
}

export function useWorkspaceStore(
  initialDocument: DocumentRecord,
  capability: Partial<WorkspaceCapabilityState> = {},
) {
  const storeRef = useRef<WorkspaceStore | null>(null);
  if (!storeRef.current) storeRef.current = createWorkspaceStore(createWorkspaceState(initialDocument, capability));
  const store = storeRef.current;
  useEffect(() => () => {
    store.recovery.destroy();
    store.manifest.destroy();
    store.externalChanges.destroy();
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const activeDocument = selectActiveDocument(state);
  if (!activeDocument) throw new Error('The single-document compatibility projection requires one active document.');
  return { store, state, activeDocument };
}
