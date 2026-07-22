import type { DocumentFormat } from '@sciemd/core';
import { createWindowTitle, displayNameForPath, type EditorMode } from '../documentState';
import type { DocumentId } from '../documentIdentity';
import { filePathForDocumentRecord } from '../documentRecord';
import { formatCapabilitiesFor, type FormatUiCapabilities } from '../formatCapabilities';
import type { WorkspaceDirtySummary } from './workspaceCloseCoordinator';
import { summarizeWorkspaceDirtyState } from './workspaceCloseCoordinator';
import { selectActiveDocument, type WorkspaceState } from './workspaceState';

export interface ActiveDocumentChromeProjection {
  documentId: DocumentId;
  filePath: string | null;
  displayName: string;
  activeDirty: boolean;
  unsavedCount: number;
  backgroundUnsavedCount: number;
  savingCount: number;
  conflictCount: number;
  aggregateStatus: string | null;
  windowTitle: string;
}

export interface ActiveDocumentProjection {
  documentId: DocumentId;
  format: DocumentFormat;
  mode: EditorMode;
  formatCapabilities: FormatUiCapabilities;
  chrome: ActiveDocumentChromeProjection;
}

export interface WorkspaceShellProjection {
  active: ActiveDocumentProjection;
  dirtySummary: WorkspaceDirtySummary;
}

/** Pure read projection. It may select workspace state but never owns document content. */
export function createWorkspaceShellProjection(
  state: WorkspaceState,
  suppliedSummary?: WorkspaceDirtySummary,
): WorkspaceShellProjection {
  const active = selectActiveDocument(state);
  if (!active) throw new Error('The workspace shell requires an active document projection.');
  const dirtySummary = suppliedSummary ?? summarizeWorkspaceDirtyState(state);
  const filePath = filePathForDocumentRecord(active);
  const activeDirty = active.lifecycle.content === 'dirty';
  const formatCapabilities = formatCapabilitiesFor(active.format, { tomlNativePlanning: true });
  const mode: EditorMode = formatCapabilities.canUseVisualMarkdown || formatCapabilities.canUseStructuredVisualMode
    || formatCapabilities.canUseRecordList || formatCapabilities.canUseTablePreview
    ? active.view.mode
    : 'source';
  const aggregateStatus = aggregateWorkspaceStatus(dirtySummary);
  return {
    active: {
      documentId: active.id,
      format: active.format,
      mode,
      formatCapabilities,
      chrome: {
        documentId: active.id,
        filePath,
        displayName: displayNameForPath(filePath, active.format),
        activeDirty,
        unsavedCount: dirtySummary.dirtyCount,
        backgroundUnsavedCount: dirtySummary.background.dirtyCount,
        savingCount: dirtySummary.savingCount,
        conflictCount: dirtySummary.conflictCount,
        aggregateStatus,
        windowTitle: createWindowTitle({
          filePath,
          format: active.format,
          activeDirty,
          unsavedCount: dirtySummary.dirtyCount,
        }),
      },
    },
    dirtySummary,
  };
}

function aggregateWorkspaceStatus(summary: WorkspaceDirtySummary): string | null {
  const statuses = [
    summary.dirtyCount > 0 ? `${summary.dirtyCount} unsaved` : '',
    summary.savingCount > 0 ? `${summary.savingCount} saving` : '',
    summary.conflictCount > 0 ? `${summary.conflictCount} conflicted` : '',
    summary.recoveryPendingCount > 0 ? `${summary.recoveryPendingCount} recovery pending` : '',
  ].filter(Boolean);
  return statuses.length > 0 ? statuses.join(', ') : null;
}
