import { loadRecoveryCatalog } from '../../services/recoveryCatalog';
import {
  createWorkspaceManifestPayload,
  saveWorkspaceManifest,
} from '../../services/workspaceManifestService';
import type { WorkspaceManifestPayload } from '../../services/persistence';
import type { WorkspaceState } from './workspaceState';
import type { WorkspaceRecoveryCoordinator } from './workspaceRecoveryCoordinator';

export interface WorkspaceManifestCoordinator {
  activate(preservedManifest?: WorkspaceManifestPayload | null): void;
  observe(state: WorkspaceState): void;
  flush(): Promise<number | null>;
  flushState(state: WorkspaceState, requireDurableStorage?: boolean, recoveryAlreadySettled?: boolean): Promise<number | null>;
  preservedManifest(): WorkspaceManifestPayload | null;
  metrics(): { publicationCount: number; failedPublicationCount: number; pending: boolean; active: boolean };
  destroy(): void;
}

const MANIFEST_DEBOUNCE_MS = 250;

export function createWorkspaceManifestCoordinator(
  getState: () => WorkspaceState,
  recovery: WorkspaceRecoveryCoordinator,
  now: () => number = Date.now,
): WorkspaceManifestCoordinator {
  let enabled = false;
  let preserved: WorkspaceManifestPayload | null = null;
  let preservedDocumentIds = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<number | null> | null = null;
  let publicationCount = 0;
  let failedPublicationCount = 0;

  const schedule = () => {
    if (!enabled || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, MANIFEST_DEBOUNCE_MS);
  };

  const flushState = async (
    state: WorkspaceState,
    requireDurableStorage = false,
    recoveryAlreadySettled = false,
  ): Promise<number | null> => {
    if (!enabled) return null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) await pending;
    const operation = (async () => {
      try {
        if (!recoveryAlreadySettled) await recovery.flushAll('destructive-barrier');
        // Browser persistence is the primary writer. Native snapshots are a
        // startup fallback and must not make every manifest publication scan
        // the native recovery directory.
        const recoveryEntries = await loadRecoveryCatalog({ includeNative: false });
        const manifest = createWorkspaceManifestPayload(state, recoveryEntries, preserved, now(), preservedDocumentIds);
        const generation = await saveWorkspaceManifest(manifest, { requireDurableStorage });
        const currentIds = new Set<string>(state.tabOrder);
        preservedDocumentIds = new Set(manifest.documents
          .filter((entry) => preservedDocumentIds.has(entry.documentId) && !currentIds.has(entry.documentId))
          .map((entry) => entry.documentId));
        preserved = manifest;
        publicationCount += 1;
        return generation;
      } catch (error) {
        failedPublicationCount += 1;
        console.warn('Workspace manifest publication failed after recovery checkpointing.', error);
        return null;
      }
    })();
    pending = operation;
    try {
      return await operation;
    } finally {
      if (pending === operation) pending = null;
    }
  };

  const flush = () => flushState(getState());

  return {
    activate: (manifest = null) => {
      preserved = manifest;
      const currentIds = new Set<string>(getState().tabOrder);
      preservedDocumentIds = new Set((manifest?.documents ?? [])
        .filter((entry) => !currentIds.has(entry.documentId))
        .map((entry) => entry.documentId));
      enabled = true;
      schedule();
    },
    observe: () => schedule(),
    flush,
    flushState,
    preservedManifest: () => preserved,
    metrics: () => ({ publicationCount, failedPublicationCount, pending: Boolean(timer || pending), active: enabled }),
    destroy: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      enabled = false;
    },
  };
}
