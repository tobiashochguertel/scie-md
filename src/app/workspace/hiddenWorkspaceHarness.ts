import { createDocumentRecord, type DocumentRecord } from '../documentRecord';
import { createWorkspaceState } from './workspaceState';
import { createWorkspaceStore } from './workspaceStore';

export const HIDDEN_WORKSPACE_ACTIVATION_SURFACE = {
  id: 'round-7-hidden-workspace-harness',
  kind: 'hidden-harness',
} as const;

export function createHiddenWorkspaceHarness(
  initialDocument: DocumentRecord = createDocumentRecord(),
  recoveryOptions: Parameters<typeof createWorkspaceStore>[1] = {},
) {
  return createWorkspaceStore(createWorkspaceState(initialDocument, {
    multiDocumentWorkspaceEnabled: true,
    activationSurface: HIDDEN_WORKSPACE_ACTIVATION_SURFACE,
  }), recoveryOptions);
}
