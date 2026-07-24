import { DEFAULT_METADATA, readSourceEnvelope, type FileMetadata, type ReadTextFileResponse } from '../documentState';
import { assertValidDocumentRecord, createDocumentRecord, type DocumentRecord } from '../documentRecord';
import { sourceRevision, type DocumentId, type DocumentLocator } from '../documentIdentity';
import { normalizeDocumentHostError, type DocumentHostErrorCode } from '../host/documentHostError';
import type { RecoveryCatalogEntry } from '../../services/recoveryCatalog';
import { defaultManifestView, type WorkspaceManifestDocument, type WorkspaceManifestPayload } from '../../services/persistence';
import type { WorkspaceCapabilityState } from './workspaceState';
import { restoreSourceBufferRevisions } from '../source/revisionedSourceBuffer';
import { normalizeVisualStyleId } from '../../services/visualStyleService';

export type WorkspaceStartupWinner =
  | { kind: 'explicit-launch'; path: string }
  | { kind: 'recovery'; documentId: string }
  | { kind: 'manifest'; documentId: string }
  | { kind: 'orphan-untitled-recovery'; documentId: string }
  | { kind: 'orphan-recovery'; documentId: string }
  | { kind: 'welcome' };

export type WorkspaceRestoreIssue =
  | 'missing-recovery'
  | 'stale-recovery-reference'
  | 'missing-file'
  | 'moved-file'
  | 'permission-lost'
  | 'cloud-unavailable'
  | 'read-failed';

export interface WorkspaceRestoreOutcome {
  documentId: string | null;
  status: 'restored-clean' | 'restored-recovery' | 'action-required' | 'preserved-capability-gated' | 'corrupt-manifest-entry';
  issues: WorkspaceRestoreIssue[];
  instantiated: boolean;
  path: string | null;
  detail: string | null;
}

export interface WorkspaceRestoreResult {
  winner: WorkspaceStartupWinner;
  records: DocumentRecord[];
  tabOrder: DocumentId[];
  activeDocumentId: DocumentId | null;
  recentlyActiveDocumentIds: DocumentId[];
  outcomes: WorkspaceRestoreOutcome[];
  preservedManifest: WorkspaceManifestPayload | null;
  hydrationOrder: string[];
}

export interface RestoreWorkspaceOptions {
  manifest: WorkspaceManifestPayload | null;
  recoveryEntries: readonly RecoveryCatalogEntry[];
  capability: WorkspaceCapabilityState;
  readFile: (path: string) => Promise<ReadTextFileResponse>;
  explicitLaunchPath?: string | null;
  maxConcurrentHydrations?: number;
}

export function selectWorkspaceStartupWinner({
  explicitLaunchPath,
  manifest,
  recoveryEntries,
}: Pick<RestoreWorkspaceOptions, 'explicitLaunchPath' | 'manifest' | 'recoveryEntries'>): WorkspaceStartupWinner {
  if (explicitLaunchPath?.trim()) return { kind: 'explicit-launch', path: explicitLaunchPath.trim() };
  const recoveryById = new Map(recoveryEntries.map((entry) => [entry.documentId, entry]));
  const validRecoveryIds = new Set((manifest?.documents ?? []).flatMap((document) => {
    const recovery = document.recoveryReference ? recoveryById.get(document.documentId as DocumentId) : null;
    return recovery && document.recoveryReference?.generation === recovery.generation ? [document.documentId] : [];
  }));
  if (manifest?.activeDocumentId && validRecoveryIds.has(manifest.activeDocumentId)) {
    return { kind: 'recovery', documentId: manifest.activeDocumentId };
  }
  const firstDirty = manifest?.tabOrder.find((id) => validRecoveryIds.has(id));
  if (firstDirty) return { kind: 'recovery', documentId: firstDirty };
  if (manifest?.activeDocumentId) return { kind: 'manifest', documentId: manifest.activeDocumentId };
  const orphanUntitled = recoveryEntries.find((entry) => (
    entry.locator.kind === 'untitled' && !manifest?.documents.some((document) => document.documentId === entry.documentId)
  ));
  if (orphanUntitled) return { kind: 'orphan-untitled-recovery', documentId: orphanUntitled.documentId };
  const orphanFile = recoveryEntries.find((entry) => (
    entry.locator.kind === 'file' && !manifest?.documents.some((document) => document.documentId === entry.documentId)
  ));
  return orphanFile ? { kind: 'orphan-recovery', documentId: orphanFile.documentId } : { kind: 'welcome' };
}

export async function restoreWorkspace(options: RestoreWorkspaceOptions): Promise<WorkspaceRestoreResult> {
  const winner = selectWorkspaceStartupWinner(options);
  if (winner.kind === 'explicit-launch') {
    return emptyResult(winner, options.manifest);
  }
  const manifestDocuments = options.manifest?.documents ?? [];
  const manifestIds = new Set(manifestDocuments.map((entry) => entry.documentId));
  const orphanDocuments = options.recoveryEntries
    .filter((entry) => !manifestIds.has(entry.documentId))
    .map(manifestDocumentForRecovery);
  const outcomes: WorkspaceRestoreOutcome[] = [];
  const candidates = deduplicateCandidates([...manifestDocuments, ...orphanDocuments], outcomes);
  const winnerId = winner.kind === 'welcome' ? null : winner.documentId;
  const ordered = winnerId
    ? [...candidates.filter((entry) => entry.documentId === winnerId), ...candidates.filter((entry) => entry.documentId !== winnerId)]
    : candidates;
  const recoveryById = new Map(options.recoveryEntries.map((entry) => [entry.documentId, entry]));
  const hydrationOrder: string[] = [];
  const hydrated = new Map<string, Awaited<ReturnType<typeof hydrateDocument>>>();
  if (ordered[0]) {
    hydrationOrder.push(ordered[0].documentId);
    hydrated.set(ordered[0].documentId, await hydrateDocument(ordered[0], recoveryById.get(ordered[0].documentId as DocumentId), options.readFile));
  }
  const allowMany = options.capability.multiDocumentWorkspaceEnabled && Boolean(options.capability.activationSurface);
  if (allowMany) {
    const rest = ordered.slice(1);
    const concurrency = Math.max(1, options.maxConcurrentHydrations ?? 2);
    for (let index = 0; index < rest.length; index += concurrency) {
      const batch = rest.slice(index, index + concurrency);
      batch.forEach((entry) => hydrationOrder.push(entry.documentId));
      const results = await Promise.all(batch.map((entry) => hydrateDocument(entry, recoveryById.get(entry.documentId as DocumentId), options.readFile)));
      results.forEach((result, offset) => hydrated.set(batch[offset].documentId, result));
    }
  } else if (ordered.length > 1 && !isUsable(hydrated.get(ordered[0].documentId))) {
    for (const entry of ordered.slice(1)) {
      hydrationOrder.push(entry.documentId);
      const result = await hydrateDocument(entry, recoveryById.get(entry.documentId as DocumentId), options.readFile);
      hydrated.set(entry.documentId, result);
      if (isUsable(result)) break;
    }
  }
  const preferred = winnerId ? hydrated.get(winnerId) : null;
  const selected = isUsable(preferred)
    ? preferred!
    : Array.from(hydrated.values()).find(isUsable) ?? Array.from(hydrated.values())[0] ?? null;
  const instantiatedIds = new Set<string>();
  if (allowMany) hydrated.forEach((_value, id) => instantiatedIds.add(id));
  else if (selected) instantiatedIds.add(selected.record.id);
  const records = ordered.flatMap((entry) => instantiatedIds.has(entry.documentId) && hydrated.has(entry.documentId)
    ? [hydrated.get(entry.documentId)!.record]
    : []);
  const tabOrder = ordered.map((entry) => entry.documentId as DocumentId).filter((id) => instantiatedIds.has(id));
  const activeDocumentId = selected && instantiatedIds.has(selected.record.id) ? selected.record.id : tabOrder[0] ?? null;
  const manifestRecent = options.manifest?.recentlyActiveDocumentIds ?? [];
  const recentlyActiveDocumentIds = [activeDocumentId, ...manifestRecent, ...tabOrder]
    .filter((id): id is DocumentId => Boolean(id) && instantiatedIds.has(id as string))
    .filter((id, index, values) => values.indexOf(id) === index);
  for (const invalid of options.manifest?.invalidEntries ?? []) {
    outcomes.push({ documentId: invalid.documentId, status: 'corrupt-manifest-entry', issues: [], instantiated: false, path: null, detail: 'The manifest entry was preserved as an isolated invalid record.' });
  }
  for (const entry of ordered) {
    const result = hydrated.get(entry.documentId);
    if (result) outcomes.push({ ...result.outcome, instantiated: instantiatedIds.has(entry.documentId) });
    else outcomes.push({ documentId: entry.documentId, status: 'preserved-capability-gated', issues: [], instantiated: false, path: entry.locator.kind === 'file' ? entry.locator.displayPath : null, detail: 'Preserved until a workspace activation surface is available.' });
  }
  return { winner, records, tabOrder, activeDocumentId, recentlyActiveDocumentIds, outcomes, preservedManifest: options.manifest, hydrationOrder };
}

function deduplicateCandidates(
  candidates: WorkspaceManifestDocument[],
  outcomes: WorkspaceRestoreOutcome[],
): WorkspaceManifestDocument[] {
  const result: WorkspaceManifestDocument[] = [];
  const identities = new Set<string>();
  for (const candidate of candidates) {
    const locatorKey = candidate.locator.kind === 'untitled'
      ? `untitled:${candidate.locator.untitledId}`
      : `file:${candidate.locator.stableFileId ?? candidate.locator.comparisonKey}`;
    if (identities.has(locatorKey)) {
      outcomes.push({
        documentId: candidate.documentId,
        status: 'corrupt-manifest-entry',
        issues: [],
        instantiated: false,
        path: candidate.locator.kind === 'file' ? candidate.locator.displayPath : null,
        detail: 'A duplicate document locator was isolated instead of creating a second clean-source owner.',
      });
      continue;
    }
    identities.add(locatorKey);
    result.push(candidate);
  }
  return result;
}

function emptyResult(winner: WorkspaceStartupWinner, manifest: WorkspaceManifestPayload | null): WorkspaceRestoreResult {
  return { winner, records: [], tabOrder: [], activeDocumentId: null, recentlyActiveDocumentIds: [], outcomes: [], preservedManifest: manifest, hydrationOrder: [] };
}

async function hydrateDocument(
  manifest: WorkspaceManifestDocument,
  recovery: RecoveryCatalogEntry | undefined,
  readFile: (path: string) => Promise<ReadTextFileResponse>,
) {
  const issues: WorkspaceRestoreIssue[] = [];
  const reference = manifest.recoveryReference;
  const currentRecovery = reference && recovery?.generation === reference.generation && recovery.sourceRevision === reference.sourceRevision
    ? recovery
    : undefined;
  if (reference && !recovery) issues.push('missing-recovery');
  else if (reference && !currentRecovery) issues.push('stale-recovery-reference');
  let diskSource = '';
  let metadata: FileMetadata = currentRecovery?.baseMetadata
    ? { ...DEFAULT_METADATA, ...currentRecovery.baseMetadata }
    : DEFAULT_METADATA;
  let errorCode: DocumentHostErrorCode | null = null;
  let detail: string | null = null;
  if (manifest.locator.kind === 'file') {
    try {
      const response = await readFile(manifest.locator.displayPath);
      diskSource = readSourceEnvelope(response).sourceText;
      metadata = response.metadata;
    } catch (error) {
      const normalized = normalizeDocumentHostError(error);
      errorCode = normalized.code;
      detail = normalized.message;
      issues.push(issueForHostCode(normalized.code, manifest.locator));
    }
  }
  const sourceText = currentRecovery?.sourceText ?? diskSource;
  const savedSourceText = currentRecovery ? currentRecovery.savedSourceText ?? diskSource : sourceText;
  const revision = currentRecovery?.sourceRevision ?? sourceRevision(0);
  const created = createDocumentRecord({
    id: manifest.documentId as DocumentId,
    locator: manifest.locator as DocumentLocator,
    format: manifest.format,
    sourceText,
    savedSourceText,
    fileBaseline: metadata,
    mode: manifest.view.mode,
    presentation: {
      ...manifest.presentation,
      visualStyle: normalizeVisualStyleId(manifest.presentation.visualStyle),
    } as DocumentRecord['presentation'],
    view: manifest.view as DocumentRecord['view'],
  });
  const savedRevision = sourceText === savedSourceText ? revision : sourceRevision(Math.max(0, revision - 1));
  const record = assertValidDocumentRecord({
    ...created,
    source: { ...created.source, buffer: restoreSourceBufferRevisions(created.source.buffer, revision, savedRevision), revision, savedRevision },
    lifecycle: {
      ...created.lifecycle,
      external: errorCode === 'NOT_FOUND' ? 'missing' : errorCode ? 'unknown' : 'inSync',
      access: errorCode === 'PERMISSION_DENIED' ? 'permissionLost' : errorCode === 'CLOUD_UNAVAILABLE' ? 'cloudUnavailable' : created.lifecycle.access,
      recovery: currentRecovery ? 'current' : created.lifecycle.recovery,
      ...(reference && !currentRecovery ? { recovery: 'failed' as const } : {}),
    },
  });
  const restoredFromRecovery = Boolean(currentRecovery);
  const actionRequired = (Boolean(errorCode) || Boolean(reference && !currentRecovery)) && !restoredFromRecovery;
  return {
    record,
    outcome: {
      documentId: manifest.documentId,
      status: actionRequired ? 'action-required' as const : restoredFromRecovery ? 'restored-recovery' as const : 'restored-clean' as const,
      issues,
      instantiated: false,
      path: manifest.locator.kind === 'file' ? manifest.locator.displayPath : null,
      detail,
    },
  };
}

function manifestDocumentForRecovery(entry: RecoveryCatalogEntry): WorkspaceManifestDocument {
  return {
    documentId: entry.documentId,
    locator: entry.locator.kind === 'untitled'
      ? { kind: 'untitled', untitledId: entry.locator.untitledId }
      : { ...entry.locator, aliases: entry.locator.aliases.slice() },
    format: entry.format,
    view: defaultManifestView(),
    presentation: { visualStyle: null, documentType: null },
    recoveryReference: { id: entry.documentId, generation: entry.generation, sourceRevision: entry.sourceRevision },
  };
}

function issueForHostCode(code: DocumentHostErrorCode, locator: WorkspaceManifestDocument['locator']): WorkspaceRestoreIssue {
  if (code === 'NOT_FOUND') return locator.kind === 'file' && locator.stableFileId ? 'moved-file' : 'missing-file';
  if (code === 'PERMISSION_DENIED') return 'permission-lost';
  if (code === 'CLOUD_UNAVAILABLE') return 'cloud-unavailable';
  return 'read-failed';
}

function isUsable(value: Awaited<ReturnType<typeof hydrateDocument>> | null | undefined): boolean {
  return Boolean(value && (value.outcome.status !== 'action-required' || value.record.lifecycle.recovery === 'current'));
}
