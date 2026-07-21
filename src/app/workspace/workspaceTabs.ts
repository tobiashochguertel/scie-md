import { displayNameForPath } from '../documentState';
import type { DocumentId } from '../documentIdentity';
import { filePathForDocumentRecord } from '../documentRecord';
import type { WorkspaceCapabilityState, WorkspaceState } from './workspaceState';

export const PRODUCTION_WORKSPACE_ACTIVATION_SURFACE = {
  id: 'desktop-workspace-tabs',
  kind: 'production-tabs',
} as const;

/** The desktop flag and its reachable activation surface are one atomic capability value. */
export const PRODUCTION_WORKSPACE_CAPABILITY: WorkspaceCapabilityState = {
  multiDocumentWorkspaceEnabled: true,
  activationSurface: PRODUCTION_WORKSPACE_ACTIVATION_SURFACE,
};

export interface WorkspaceTabModel {
  documentId: DocumentId;
  label: string;
  accessibleName: string;
  formatLabel: string;
  statuses: readonly string[];
  active: boolean;
  index: number;
  count: number;
  canMoveLeft: boolean;
  canMoveRight: boolean;
}

export interface WorkspaceTabsModel {
  tabs: readonly WorkspaceTabModel[];
  activeDocumentId: DocumentId;
  mruDocumentId: DocumentId | null;
  recentlyClosedCount: number;
}

export function createWorkspaceTabsModel(state: WorkspaceState): WorkspaceTabsModel {
  const activeDocumentId = state.activeDocumentId;
  if (!activeDocumentId) throw new Error('The production tab surface requires one active document.');
  const baseNames = state.tabOrder.map((id) => {
    const document = state.documentsById[id];
    return displayNameForPath(filePathForDocumentRecord(document), document.format);
  });
  const duplicateCounts = new Map<string, number>();
  for (const name of baseNames) duplicateCounts.set(name.toLocaleLowerCase(), (duplicateCounts.get(name.toLocaleLowerCase()) ?? 0) + 1);

  const tabs = state.tabOrder.map((documentId, index): WorkspaceTabModel => {
    const document = state.documentsById[documentId];
    const baseName = baseNames[index];
    const duplicate = (duplicateCounts.get(baseName.toLocaleLowerCase()) ?? 0) > 1;
    const label = duplicate ? `${baseName} — ${duplicateQualifier(state, documentId, index)}` : baseName;
    const statuses = lifecycleStatuses(document);
    const active = documentId === activeDocumentId;
    const stateText = [active ? 'active' : null, ...statuses].filter(Boolean).join(', ');
    return {
      documentId,
      label,
      accessibleName: `${label}, ${document.format.toUpperCase()}, ${stateText || 'ready'}, tab ${index + 1} of ${state.tabOrder.length}`,
      formatLabel: document.format === 'plainText' ? 'Text' : document.format.toUpperCase(),
      statuses,
      active,
      index,
      count: state.tabOrder.length,
      canMoveLeft: index > 0,
      canMoveRight: index < state.tabOrder.length - 1,
    };
  });
  const mruDocumentId = state.recentlyActiveDocumentIds.find((id) => id !== activeDocumentId) ?? null;
  return { tabs, activeDocumentId, mruDocumentId, recentlyClosedCount: state.recentlyClosedDocuments.length };
}

export function workspaceTabId(documentId: DocumentId): string {
  return `workspace-tab-${encodeURIComponent(documentId)}`;
}

export function workspaceTabPanelId(documentId: DocumentId): string {
  return `workspace-panel-${encodeURIComponent(documentId)}`;
}

function duplicateQualifier(state: WorkspaceState, documentId: DocumentId, index: number): string {
  const document = state.documentsById[documentId];
  if (document.locator.kind === 'untitled') return `Untitled ${index + 1}`;
  const normalized = document.locator.displayPath.replace(/\\/g, '/');
  const parent = normalized.split('/').filter(Boolean).slice(0, -1).join('/');
  return parent || `File ${index + 1}`;
}

function lifecycleStatuses(document: WorkspaceState['documentsById'][DocumentId]): string[] {
  const statuses: string[] = [];
  if (document.lifecycle.content === 'dirty') statuses.push('Unsaved');
  if (document.lifecycle.save === 'queued') statuses.push('Save queued');
  if (document.lifecycle.save === 'saving') statuses.push('Saving');
  if (document.lifecycle.save === 'failed') statuses.push('Save failed');
  if (document.lifecycle.recovery === 'pending') statuses.push('Recovery pending');
  if (document.lifecycle.recovery === 'failed') statuses.push('Recovery failed');
  if (document.lifecycle.recovery === 'recoveryOnly') statuses.push('Recovery only');
  if (document.lifecycle.external === 'changed') statuses.push('Changed on disk');
  if (document.lifecycle.external === 'missing') statuses.push('Missing on disk');
  if (document.lifecycle.external === 'renamed') statuses.push('Renamed on disk');
  if (document.lifecycle.external === 'unknown') statuses.push('Disk state unknown');
  if (document.lifecycle.access === 'readOnly') statuses.push('Read only');
  if (document.lifecycle.access === 'permissionLost') statuses.push('Permission lost');
  if (document.lifecycle.access === 'cloudUnavailable') statuses.push('Cloud unavailable');
  return statuses;
}
