import type { DocumentFormat } from '@sciemd/core';
import { displayNameForPath } from '../documentState';
import type { DocumentId } from '../documentIdentity';
import { filePathForDocumentRecord } from '../documentRecord';
import type { WorkspaceCapabilityState, WorkspaceState } from './workspaceState';

export const PRODUCTION_WORKSPACE_ACTIVATION_SURFACE = { id: 'desktop-workspace-tabs', kind: 'production-tabs' } as const;
export const PRODUCTION_WORKSPACE_CAPABILITY: WorkspaceCapabilityState = {
  multiDocumentWorkspaceEnabled: true,
  activationSurface: PRODUCTION_WORKSPACE_ACTIVATION_SURFACE,
};

/** Frozen from the Round 5 release fixture: warm activation p95 was 24.6 ms (limit 100 ms). */
export const WORKSPACE_TAB_ACTIVATION_POLICY = { kind: 'automatic', warmActivationP95Ms: 24.6, limitMs: 100 } as const;

export type TabFormatIconId = 'markdown' | 'braces' | 'rows' | 'markup' | 'text';
export type TabVisualStateKind = 'danger' | 'blocked' | 'progress' | 'dirty' | 'readonly' | 'ready';

export interface TabPresentation {
  fileName: string;
  visibleFileName: string;
  qualifier: string | null;
  formatLabel: string;
  formatIconId: TabFormatIconId;
  visualState: { kind: TabVisualStateKind; label: string };
  accessibleStates: readonly string[];
  accessibleName: string;
  tooltip: string;
}

export interface WorkspaceTabModel extends TabPresentation {
  documentId: DocumentId;
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
  const fileNames = state.tabOrder.map((id) => {
    const document = state.documentsById[id];
    return displayNameForPath(filePathForDocumentRecord(document), document.format);
  });
  const groups = new Map<string, number[]>();
  fileNames.forEach((name, index) => groups.set(name.toLocaleLowerCase(), [...(groups.get(name.toLocaleLowerCase()) ?? []), index]));

  const tabs = state.tabOrder.map((documentId, index): WorkspaceTabModel => {
    const document = state.documentsById[documentId];
    const fileName = fileNames[index];
    const peers = groups.get(fileName.toLocaleLowerCase()) ?? [];
    const qualifier = peers.length > 1 ? shortestUniqueQualifier(state, peers, index) : null;
    const accessibleStates = lifecycleStates(document);
    const visualState = primaryVisualState(document, accessibleStates);
    const active = documentId === activeDocumentId;
    const formatLabel = document.format === 'plainText' ? 'Text' : document.format.toUpperCase();
    const fullTitle = qualifier ? `${fileName} — ${qualifier}` : fileName;
    const stateText = accessibleStates.length ? accessibleStates.join(', ') : 'Ready';
    return {
      documentId,
      fileName,
      visibleFileName: middleEllipsis(fileName),
      qualifier,
      formatLabel,
      formatIconId: iconForFormat(document.format),
      visualState,
      accessibleStates,
      accessibleName: `${fullTitle}, ${formatLabel}, ${active ? 'active, ' : ''}${stateText}, tab ${index + 1} of ${state.tabOrder.length}`,
      tooltip: `${fullTitle}\n${formatLabel} · ${stateText}`,
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

export function workspaceTabId(documentId: DocumentId): string { return `workspace-tab-${encodeURIComponent(documentId)}`; }
export function workspaceTabPanelId(documentId: DocumentId): string { return `workspace-panel-${encodeURIComponent(documentId)}`; }

export function middleEllipsis(name: string, maxLength = 28): string {
  if (name.length <= maxLength) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 9 ? name.slice(dot) : '';
  const stem = extension ? name.slice(0, dot) : name;
  const suffixLength = Math.max(5, Math.min(10, stem.length - 1));
  const prefixLength = Math.max(5, maxLength - extension.length - suffixLength - 1);
  return `${stem.slice(0, prefixLength)}…${stem.slice(-suffixLength)}${extension}`;
}

function shortestUniqueQualifier(state: WorkspaceState, peers: number[], index: number): string {
  const segments = parentSegments(state, index);
  if (!segments.length) return `Untitled ${index + 1}`;
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const candidate = segments.slice(-depth).join('/');
    const unique = peers.every((peer) => peer === index || parentSegments(state, peer).slice(-depth).join('/').toLocaleLowerCase() !== candidate.toLocaleLowerCase());
    if (unique) return candidate;
  }
  return `${segments.join('/')} · ${index + 1}`;
}

function parentSegments(state: WorkspaceState, index: number): string[] {
  const document = state.documentsById[state.tabOrder[index]];
  if (document.locator.kind === 'untitled') return [];
  return document.locator.displayPath.replace(/\\/g, '/').split('/').filter(Boolean).slice(0, -1);
}

function iconForFormat(format: DocumentFormat): TabFormatIconId {
  if (format === 'markdown') return 'markdown';
  if (format === 'json' || format === 'jsonl') return 'braces';
  if (format === 'csv' || format === 'tsv') return 'rows';
  if (format === 'xml' || format === 'yaml' || format === 'toml') return 'markup';
  return 'text';
}

function lifecycleStates(document: WorkspaceState['documentsById'][DocumentId]): string[] {
  const states: string[] = [];
  if (document.lifecycle.content === 'dirty') states.push('Unsaved');
  if (document.lifecycle.save === 'queued') states.push('Save queued');
  if (document.lifecycle.save === 'saving') states.push('Saving');
  if (document.lifecycle.save === 'failed') states.push('Save failed');
  if (document.lifecycle.recovery === 'pending') states.push('Recovery pending');
  if (document.lifecycle.recovery === 'failed') states.push('Recovery failed');
  if (document.lifecycle.recovery === 'recoveryOnly') states.push('Recovery only');
  if (document.lifecycle.external === 'changed') states.push('Changed on disk');
  if (document.lifecycle.external === 'missing') states.push('Missing on disk');
  if (document.lifecycle.external === 'renamed') states.push('Renamed on disk');
  if (document.lifecycle.external === 'unknown') states.push('Disk state unknown');
  if (document.lifecycle.access === 'readOnly') states.push('Read only');
  if (document.lifecycle.access === 'permissionLost') states.push('Permission lost');
  if (document.lifecycle.access === 'cloudUnavailable') states.push('Cloud unavailable');
  return states;
}

function primaryVisualState(document: WorkspaceState['documentsById'][DocumentId], states: string[]): TabPresentation['visualState'] {
  if (document.lifecycle.save === 'failed' || document.lifecycle.recovery === 'failed' || document.lifecycle.external === 'changed') return { kind: 'danger', label: states.find((s) => /failed|Changed/.test(s)) ?? 'Attention required' };
  if (document.lifecycle.external === 'missing' || document.lifecycle.external === 'unknown' || document.lifecycle.access === 'permissionLost' || document.lifecycle.access === 'cloudUnavailable' || document.lifecycle.recovery === 'recoveryOnly') return { kind: 'blocked', label: states.find((s) => /Missing|unknown|Permission|Cloud|Recovery only/.test(s)) ?? 'Unavailable' };
  if (document.lifecycle.save === 'saving' || document.lifecycle.save === 'queued' || document.lifecycle.recovery === 'pending') return { kind: 'progress', label: states.find((s) => /Saving|queued|pending/.test(s)) ?? 'In progress' };
  if (document.lifecycle.content === 'dirty') return { kind: 'dirty', label: 'Unsaved' };
  if (document.lifecycle.access === 'readOnly') return { kind: 'readonly', label: 'Read only' };
  return { kind: 'ready', label: 'Ready' };
}
