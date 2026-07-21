import type { DocumentId, DocumentLocator } from '../app/documentIdentity';
import { sameDocumentLocator } from '../app/documentIdentity';
import type { WorkspaceState } from '../app/workspace/workspaceState';
import type { RecoveryCatalogEntry, RecoveryCenterModel } from './recoveryCatalog';
import {
  createPersistenceEnvelope,
  decodeWorkspaceManifest,
  encodePersistenceEnvelope,
  nextPersistenceGeneration,
  quarantinePersistenceValue,
  type WorkspaceManifestDocument,
  type WorkspaceManifestPayload,
  type WorkspaceManifestRecoveryReference,
} from './persistence';

export const WORKSPACE_MANIFEST_STORAGE_KEY = 'scie_md.workspaceManifest.v2.current';
const WORKSPACE_MANIFEST_PREVIOUS_KEY = 'scie_md.workspaceManifest.v2.previous';
const WORKSPACE_MANIFEST_PENDING_KEY = 'scie_md.workspaceManifest.v2.pending';
let memoryCurrent: string | null = null;
let memoryPrevious: string | null = null;

export interface WorkspaceManifestLoadResult {
  manifest: WorkspaceManifestPayload | null;
  generation: number | null;
  recoveredFromPrevious: boolean;
  migratedFromVersion: number | null;
  quarantinedReasons: string[];
}

export interface WorkspaceRecoveryOrchestrationModel {
  schemaVersion: 1;
  manifestDocumentIds: string[];
  referencedRecoveryDocumentIds: string[];
  orphanRecoveryDocumentIds: string[];
  staleRecoveryReferenceDocumentIds: string[];
  missingRecoveryDocumentIds: string[];
  quotaState: RecoveryCenterModel['quotaState'];
}

export async function saveWorkspaceManifest(
  manifest: WorkspaceManifestPayload,
  options: { requireDurableStorage?: boolean } = {},
): Promise<number> {
  const previousRaw = hasLocalStorage() ? safeGet(WORKSPACE_MANIFEST_STORAGE_KEY) : memoryCurrent;
  const generation = nextPersistenceGeneration(previousRaw, 'workspaceManifest');
  const pending = encodePersistenceEnvelope(createPersistenceEnvelope('workspaceManifest', manifest, generation, 'pending'));
  const committed = encodePersistenceEnvelope(createPersistenceEnvelope('workspaceManifest', manifest, generation));
  memoryPrevious = memoryCurrent;
  memoryCurrent = committed;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(WORKSPACE_MANIFEST_PENDING_KEY, pending);
      const current = localStorage.getItem(WORKSPACE_MANIFEST_STORAGE_KEY);
      if (current) localStorage.setItem(WORKSPACE_MANIFEST_PREVIOUS_KEY, current);
      localStorage.setItem(WORKSPACE_MANIFEST_STORAGE_KEY, committed);
      localStorage.removeItem(WORKSPACE_MANIFEST_PENDING_KEY);
    } catch (error) {
      console.warn('Workspace manifest storage is unavailable; the in-memory generation remains current.', error);
      if (options.requireDurableStorage) throw error;
    }
  } else if (options.requireDurableStorage) {
    throw new Error('Durable workspace manifest storage is unavailable.');
  }
  return generation;
}

export async function loadWorkspaceManifest(): Promise<WorkspaceManifestLoadResult> {
  const quarantinedReasons: string[] = [];
  const pending = safeGet(WORKSPACE_MANIFEST_PENDING_KEY);
  if (pending) {
    const decoded = decodeWorkspaceManifest(pending);
    const reason = decoded.status === 'quarantine' ? decoded.reason : 'interrupted-publication';
    quarantineManifest(WORKSPACE_MANIFEST_PENDING_KEY, pending, reason);
    quarantinedReasons.push(reason);
  }
  const candidates = [
    { raw: hasLocalStorage() ? safeGet(WORKSPACE_MANIFEST_STORAGE_KEY) : memoryCurrent, previous: false, key: WORKSPACE_MANIFEST_STORAGE_KEY },
    { raw: hasLocalStorage() ? safeGet(WORKSPACE_MANIFEST_PREVIOUS_KEY) : memoryPrevious, previous: true, key: WORKSPACE_MANIFEST_PREVIOUS_KEY },
  ];
  for (const candidate of candidates) {
    if (!candidate.raw) continue;
    const decoded = decodeWorkspaceManifest(candidate.raw);
    if (decoded.status === 'quarantine') {
      quarantineManifest(candidate.key, candidate.raw, decoded.reason);
      quarantinedReasons.push(decoded.reason);
      continue;
    }
    if (decoded.migratedFromVersion !== null) await saveWorkspaceManifest(decoded.envelope.payload);
    return {
      manifest: decoded.envelope.payload,
      generation: decoded.envelope.generation,
      recoveredFromPrevious: candidate.previous,
      migratedFromVersion: decoded.migratedFromVersion,
      quarantinedReasons,
    };
  }
  return { manifest: null, generation: null, recoveredFromPrevious: false, migratedFromVersion: null, quarantinedReasons };
}

export function createWorkspaceManifestPayload(
  state: WorkspaceState,
  recoveryEntries: readonly RecoveryCatalogEntry[],
  preservedManifest: WorkspaceManifestPayload | null = null,
  savedAt = Date.now(),
): WorkspaceManifestPayload {
  const recoveryByDocument = new Map(recoveryEntries.map((entry) => [entry.documentId, entry]));
  const currentDocuments = state.tabOrder.map((documentId) => {
    const record = state.documentsById[documentId];
    const recovery = recoveryByDocument.get(documentId);
    const recoveryReference = record.lifecycle.content === 'dirty' && recovery
      ? referenceFor(recovery)
      : null;
    return {
      documentId,
      locator: cloneLocator(record.locator),
      format: record.format,
      view: structuredCloneSafe(record.view),
      presentation: structuredCloneSafe(record.presentation),
      recoveryReference,
    } satisfies WorkspaceManifestDocument;
  });
  const currentIds = new Set<string>(currentDocuments.map((entry) => entry.documentId));
  const preservedDocuments = (preservedManifest?.documents ?? []).filter((entry) => (
    !currentIds.has(entry.documentId)
    && !currentDocuments.some((current) => sameDocumentLocator(current.locator as DocumentLocator, entry.locator as DocumentLocator))
  ));
  const documents = [...currentDocuments, ...preservedDocuments];
  const byId = new Set<string>(documents.map((entry) => entry.documentId));
  const preservedOrder = preservedManifest?.tabOrder.filter((id) => byId.has(id) && !currentIds.has(id)) ?? [];
  const tabOrder = [...state.tabOrder, ...preservedOrder];
  for (const document of documents) if (!tabOrder.includes(document.documentId)) tabOrder.push(document.documentId);
  const recent = [...state.recentlyActiveDocumentIds, ...(preservedManifest?.recentlyActiveDocumentIds ?? [])]
    .filter((id, index, values) => byId.has(id) && values.indexOf(id) === index);
  for (const id of tabOrder) if (!recent.includes(id)) recent.push(id);
  const recoveryReferences = documents.flatMap((entry) => entry.recoveryReference ? [entry.recoveryReference] : []);
  return {
    tabOrder,
    activeDocumentId: state.activeDocumentId ?? preservedManifest?.activeDocumentId ?? null,
    recentlyActiveDocumentIds: recent,
    documents,
    recoveryReferences,
    invalidEntries: preservedManifest?.invalidEntries.slice() ?? [],
    savedAt,
  };
}

export function createWorkspaceRecoveryOrchestrationModel(
  manifest: WorkspaceManifestPayload | null,
  recoveryEntries: readonly RecoveryCatalogEntry[],
  recoveryCenter: RecoveryCenterModel,
): WorkspaceRecoveryOrchestrationModel {
  const references = manifest?.recoveryReferences ?? [];
  const recoveryById = new Map(recoveryEntries.map((entry) => [entry.documentId, entry]));
  const referencedIds = new Set(references.map((entry) => entry.id));
  return {
    schemaVersion: 1,
    manifestDocumentIds: manifest?.tabOrder.slice() ?? [],
    referencedRecoveryDocumentIds: references
      .filter((reference) => recoveryById.get(reference.id as DocumentId)?.generation === reference.generation)
      .map((reference) => reference.id),
    orphanRecoveryDocumentIds: recoveryEntries.filter((entry) => !referencedIds.has(entry.documentId)).map((entry) => entry.documentId),
    staleRecoveryReferenceDocumentIds: references
      .filter((reference) => recoveryById.has(reference.id as DocumentId) && recoveryById.get(reference.id as DocumentId)?.generation !== reference.generation)
      .map((reference) => reference.id),
    missingRecoveryDocumentIds: references.filter((reference) => !recoveryById.has(reference.id as DocumentId)).map((reference) => reference.id),
    quotaState: recoveryCenter.quotaState,
  };
}

export function resetWorkspaceManifestForTests(): void {
  memoryCurrent = null;
  memoryPrevious = null;
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(WORKSPACE_MANIFEST_STORAGE_KEY);
    localStorage.removeItem(WORKSPACE_MANIFEST_PREVIOUS_KEY);
    localStorage.removeItem(WORKSPACE_MANIFEST_PENDING_KEY);
  }
}

function referenceFor(entry: RecoveryCatalogEntry): WorkspaceManifestRecoveryReference {
  return { id: entry.documentId, generation: entry.generation, sourceRevision: entry.sourceRevision };
}

function cloneLocator(locator: DocumentLocator): WorkspaceManifestDocument['locator'] {
  return locator.kind === 'untitled'
    ? { kind: 'untitled', untitledId: locator.untitledId }
    : { ...locator, aliases: locator.aliases.slice() };
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function quarantineManifest(key: string, raw: string, reason: Parameters<typeof quarantinePersistenceValue>[3]): void {
  if (typeof localStorage !== 'undefined') quarantinePersistenceValue(localStorage, key, raw, reason, 'workspaceManifest');
  if (key === WORKSPACE_MANIFEST_STORAGE_KEY) memoryCurrent = null;
  if (key === WORKSPACE_MANIFEST_PREVIOUS_KEY) memoryPrevious = null;
}

function safeGet(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function hasLocalStorage(): boolean {
  return typeof localStorage !== 'undefined';
}
