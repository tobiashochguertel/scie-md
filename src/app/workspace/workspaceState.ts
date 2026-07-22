import type { DocumentId, DocumentLocator, FileDocumentLocator, SourceRevision } from '../documentIdentity';
import { mergeFileLocatorAliases, sameDocumentLocator } from '../documentIdentity';
import type { DocumentRecord, DocumentRecordAction } from '../documentRecord';
import { assertValidDocumentRecord, documentRecordReducer } from '../documentRecord';

export interface WorkspaceActivationSurface {
  id: string;
  kind: 'hidden-harness' | 'production-tabs';
}

export interface WorkspaceCapabilityState {
  multiDocumentWorkspaceEnabled: boolean;
  activationSurface: WorkspaceActivationSurface | null;
}

export type WorkspaceInvariantCode =
  | 'ACTIVATION_SURFACE_REQUIRED'
  | 'MULTI_DOCUMENT_DISABLED'
  | 'DOCUMENT_NOT_FOUND'
  | 'DUPLICATE_DOCUMENT_ID'
  | 'LOCATOR_COLLISION'
  | 'STALE_REPLACEMENT'
  | 'CLOSE_NOT_REQUESTED'
  | 'CLOSE_AUTHORIZATION_INVALID'
  | 'REORDER_INDEX_INVALID';

export interface WorkspaceInvariantDiagnostic {
  sequence: number;
  code: WorkspaceInvariantCode;
  command: WorkspaceCommand['type'];
  documentId: DocumentId | null;
  message: string;
}

export interface WorkspaceCloseRequest {
  requestId: string;
  documentId: DocumentId;
  sourceRevision: SourceRevision;
  requiresDurabilityDecision: boolean;
}

export interface WorkspaceCloseAuthorization {
  requestId: string;
  documentId: DocumentId;
  sourceRevision: SourceRevision;
  outcome: 'clean' | 'saved' | 'discarded';
}

export interface WorkspaceReplacementAuthorization {
  kind: 'settled-single-document-replacement';
  documentId: DocumentId;
  sourceRevision: SourceRevision;
}

export interface WorkspaceLocatorReservation {
  documentId: DocumentId;
  locator: FileDocumentLocator;
}

export interface WorkspaceState {
  schemaVersion: 1;
  documentsById: Record<DocumentId, DocumentRecord>;
  tabOrder: DocumentId[];
  activeDocumentId: DocumentId | null;
  recentlyActiveDocumentIds: DocumentId[];
  recentlyClosedDocuments: DocumentRecord[];
  pendingCloseRequests: Record<DocumentId, WorkspaceCloseRequest>;
  locatorReservations: WorkspaceLocatorReservation[];
  capability: WorkspaceCapabilityState;
  invariantDiagnostics: WorkspaceInvariantDiagnostic[];
  commandSequence: number;
}

export type WorkspaceCommand =
  | {
      type: 'hydrateRestoredWorkspace';
      documents: DocumentRecord[];
      tabOrder: DocumentId[];
      activeDocumentId: DocumentId | null;
      recentlyActiveDocumentIds: DocumentId[];
    }
  | { type: 'openDocument'; document: DocumentRecord }
  | { type: 'newDocument'; document: DocumentRecord }
  | { type: 'activateDocument'; documentId: DocumentId }
  | { type: 'focusDocumentByLocator'; locator: FileDocumentLocator }
  | { type: 'deactivateDocument'; documentId: DocumentId }
  | { type: 'updateDocument'; documentId: DocumentId; action: DocumentRecordAction }
  | { type: 'replaceDocument'; documentId: DocumentId; document: DocumentRecord }
  | { type: 'replaceActiveDocument'; document: DocumentRecord; authorization: WorkspaceReplacementAuthorization }
  | { type: 'requestClose'; documentId: DocumentId; requestId: string }
  | { type: 'cancelClose'; documentId: DocumentId; requestId: string }
  | { type: 'finalizeRemoveDocument'; authorization: WorkspaceCloseAuthorization }
  | { type: 'reopenDocument'; documentId?: DocumentId; rehydratedDocument?: DocumentRecord }
  | { type: 'reorderDocument'; documentId: DocumentId; toIndex: number }
  | { type: 'closeOthers'; documentId: DocumentId; requests: Record<DocumentId, string> }
  | { type: 'closeRight'; documentId: DocumentId; requests: Record<DocumentId, string> }
  | { type: 'reserveLocator'; documentId: DocumentId; locator: FileDocumentLocator }
  | { type: 'releaseLocatorReservation'; documentId: DocumentId };

const MAX_RECENTLY_CLOSED = 10;
const MAX_INVARIANT_DIAGNOSTICS = 100;

export function createWorkspaceState(
  initialDocument?: DocumentRecord,
  capability: Partial<WorkspaceCapabilityState> = {},
): WorkspaceState {
  const activationSurface = capability.activationSurface ?? null;
  const multiDocumentWorkspaceEnabled = capability.multiDocumentWorkspaceEnabled ?? false;
  const state: WorkspaceState = {
    schemaVersion: 1,
    documentsById: initialDocument ? { [initialDocument.id]: initialDocument } as Record<DocumentId, DocumentRecord> : {} as Record<DocumentId, DocumentRecord>,
    tabOrder: initialDocument ? [initialDocument.id] : [],
    activeDocumentId: initialDocument?.id ?? null,
    recentlyActiveDocumentIds: initialDocument ? [initialDocument.id] : [],
    recentlyClosedDocuments: [],
    pendingCloseRequests: {} as Record<DocumentId, WorkspaceCloseRequest>,
    locatorReservations: [],
    capability: { multiDocumentWorkspaceEnabled, activationSurface },
    invariantDiagnostics: [],
    commandSequence: 0,
  };
  return assertValidWorkspaceState(state);
}

export function workspaceReducer(current: WorkspaceState, command: WorkspaceCommand): WorkspaceState {
  const state = current;
  let next: WorkspaceState;
  switch (command.type) {
    case 'hydrateRestoredWorkspace':
      next = hydrateRestoredWorkspace(state, command);
      break;
    case 'openDocument':
      next = openDocument(state, command.document, command.type);
      break;
    case 'newDocument':
      next = addDocument(state, command.document, command.type);
      break;
    case 'activateDocument':
      next = activateDocument(state, command.documentId, command.type);
      break;
    case 'focusDocumentByLocator':
      next = focusDocumentByLocator(state, command.locator);
      break;
    case 'deactivateDocument':
      next = state.activeDocumentId === command.documentId ? { ...state, activeDocumentId: null } : state;
      break;
    case 'updateDocument':
      next = updateDocument(state, command.documentId, command.action, command.type);
      break;
    case 'replaceDocument':
      next = replaceDocument(state, command.documentId, command.document, command.type);
      break;
    case 'replaceActiveDocument':
      next = replaceActiveDocument(state, command.document, command.authorization);
      break;
    case 'requestClose':
      next = requestClose(state, command.documentId, command.requestId, command.type);
      break;
    case 'cancelClose': {
      const request = state.pendingCloseRequests[command.documentId];
      if (!request || request.requestId !== command.requestId) next = state;
      else {
        const pendingCloseRequests = { ...state.pendingCloseRequests };
        delete pendingCloseRequests[command.documentId];
        next = { ...state, pendingCloseRequests };
      }
      break;
    }
    case 'finalizeRemoveDocument':
      next = finalizeRemoveDocument(state, command.authorization);
      break;
    case 'reopenDocument':
      next = reopenDocument(state, command.documentId, command.rehydratedDocument);
      break;
    case 'reorderDocument':
      next = reorderDocument(state, command.documentId, command.toIndex);
      break;
    case 'closeOthers':
      next = requestManyClose(state, state.tabOrder.filter((id) => id !== command.documentId), command.requests, command.type);
      break;
    case 'closeRight': {
      const index = state.tabOrder.indexOf(command.documentId);
      next = index < 0
        ? diagnostic(state, command.type, 'DOCUMENT_NOT_FOUND', command.documentId, 'Cannot close documents to the right of a missing document.')
        : requestManyClose(state, state.tabOrder.slice(index + 1), command.requests, command.type);
      break;
    }
    case 'reserveLocator':
      next = reserveLocator(state, command.documentId, command.locator);
      break;
    case 'releaseLocatorReservation':
      next = { ...state, locatorReservations: state.locatorReservations.filter((entry) => entry.documentId !== command.documentId) };
      break;
  }
  return assertValidWorkspaceState(next);
}

function hydrateRestoredWorkspace(
  state: WorkspaceState,
  command: Extract<WorkspaceCommand, { type: 'hydrateRestoredWorkspace' }>,
): WorkspaceState {
  if (command.documents.length > 1 && (!state.capability.multiDocumentWorkspaceEnabled || !state.capability.activationSurface)) {
    return diagnostic(state, command.type, 'ACTIVATION_SURFACE_REQUIRED', null, 'Restoring multiple documents requires the enabled capability and a registered activation surface.');
  }
  const documentsById = {} as Record<DocumentId, DocumentRecord>;
  for (const document of command.documents) {
    assertValidDocumentRecord(document);
    if (documentsById[document.id]) return diagnostic(state, command.type, 'DUPLICATE_DOCUMENT_ID', document.id, 'Restore contains a duplicate DocumentId.');
    if (Object.values(documentsById).some((existing) => sameDocumentLocator(existing.locator, document.locator))) {
      return diagnostic(state, command.type, 'LOCATOR_COLLISION', document.id, 'Restore contains two owners for one locator.');
    }
    documentsById[document.id] = document;
  }
  const ids = Object.keys(documentsById) as DocumentId[];
  if (command.tabOrder.length !== ids.length || new Set(command.tabOrder).size !== ids.length || !ids.every((id) => command.tabOrder.includes(id))) {
    throw new Error('Restored tab order must contain every restored document exactly once.');
  }
  if (command.recentlyActiveDocumentIds.length !== ids.length || new Set(command.recentlyActiveDocumentIds).size !== ids.length || !ids.every((id) => command.recentlyActiveDocumentIds.includes(id))) {
    throw new Error('Restored MRU order must contain every restored document exactly once.');
  }
  if (command.activeDocumentId && !documentsById[command.activeDocumentId]) throw new Error('Restored active document must exist.');
  return {
    ...state,
    documentsById,
    tabOrder: command.tabOrder.slice(),
    activeDocumentId: command.activeDocumentId,
    recentlyActiveDocumentIds: command.recentlyActiveDocumentIds.slice(),
    recentlyClosedDocuments: [],
    pendingCloseRequests: {} as Record<DocumentId, WorkspaceCloseRequest>,
    locatorReservations: [],
  };
}

export function selectActiveDocument(state: WorkspaceState): DocumentRecord | null {
  return state.activeDocumentId ? state.documentsById[state.activeDocumentId] ?? null : null;
}

export function selectDocumentByLocator(state: WorkspaceState, locator: DocumentLocator): DocumentRecord | null {
  for (const documentId of state.tabOrder) {
    const document = state.documentsById[documentId];
    if (document && sameDocumentLocator(document.locator, locator)) return document;
  }
  return null;
}

export function createWorkspaceLocatorIndex(state: WorkspaceState): ReadonlyMap<string, DocumentId> {
  const index = new Map<string, DocumentId>();
  for (const documentId of state.tabOrder) {
    const locator = state.documentsById[documentId]?.locator;
    if (!locator) continue;
    if (locator.kind === 'untitled') {
      index.set(`untitled:${locator.untitledId}`, documentId);
      continue;
    }
    index.set(`path:${locator.comparisonKey}`, documentId);
    if (locator.stableFileId) index.set(`stable:${locator.stableFileId}`, documentId);
  }
  return index;
}

export function assertValidWorkspaceState(state: WorkspaceState): WorkspaceState {
  if (state.schemaVersion !== 1) throw new Error(`Unsupported WorkspaceState schema version: ${String(state.schemaVersion)}.`);
  const documentIds = Object.keys(state.documentsById) as DocumentId[];
  assertUniqueAndComplete('tabOrder', state.tabOrder, documentIds);
  assertUniqueAndComplete('recentlyActiveDocumentIds', state.recentlyActiveDocumentIds, documentIds);
  if (state.activeDocumentId && !state.documentsById[state.activeDocumentId]) throw new Error('The active document must exist in documentsById.');
  if (state.activeDocumentId && state.documentsById[state.activeDocumentId].source.residency.kind !== 'resident') {
    throw new Error('The active document must own resident source.');
  }
  if (documentIds.length > 1 && (!state.capability.multiDocumentWorkspaceEnabled || !state.capability.activationSurface)) {
    throw new Error('Multiple documents require the enabled capability and a registered activation surface.');
  }
  for (const documentId of documentIds) {
    const document = assertValidDocumentRecord(state.documentsById[documentId]);
    if (document.id !== documentId) throw new Error('A workspace document key must match DocumentRecord.id.');
  }
  for (let left = 0; left < documentIds.length; left += 1) {
    for (let right = left + 1; right < documentIds.length; right += 1) {
      if (sameDocumentLocator(state.documentsById[documentIds[left]].locator, state.documentsById[documentIds[right]].locator)) {
        throw new Error('Workspace document locators must be unique.');
      }
    }
  }
  for (const [documentId, request] of Object.entries(state.pendingCloseRequests) as [DocumentId, WorkspaceCloseRequest][]) {
    if (!state.documentsById[documentId] || request.documentId !== documentId) throw new Error('Close requests must target an open document.');
  }
  for (const reservation of state.locatorReservations) {
    if (!state.documentsById[reservation.documentId]) throw new Error('Locator reservations must target an open document.');
    const collision = findLocatorOwner(state, reservation.locator, reservation.documentId);
    if (collision) throw new Error('A locator reservation cannot collide with another document.');
  }
  for (let left = 0; left < state.locatorReservations.length; left += 1) {
    for (let right = left + 1; right < state.locatorReservations.length; right += 1) {
      if (sameDocumentLocator(state.locatorReservations[left].locator, state.locatorReservations[right].locator)) {
        throw new Error('Workspace locator reservations must be unique.');
      }
    }
  }
  return state;
}

function openDocument(state: WorkspaceState, document: DocumentRecord, command: WorkspaceCommand['type']): WorkspaceState {
  const existing = selectDocumentByLocator(state, document.locator);
  if (!existing) return addDocument(state, document, command);
  let focused = state;
  if (existing.locator.kind === 'file' && document.locator.kind === 'file') {
    focused = replaceDocumentRecord(focused, {
      ...existing,
      locator: mergeFileLocatorAliases(existing.locator, document.locator),
    });
  }
  return activateDocument(focused, existing.id, command);
}

function addDocument(state: WorkspaceState, document: DocumentRecord, command: WorkspaceCommand['type']): WorkspaceState {
  assertValidDocumentRecord(document);
  if (state.documentsById[document.id]) {
    return diagnostic(state, command, 'DUPLICATE_DOCUMENT_ID', document.id, 'The workspace already contains this DocumentId.');
  }
  const locatorOwner = findLocatorOwner(state, document.locator, document.id);
  if (locatorOwner) return activateDocument(state, locatorOwner, command);
  const reservationOwner = findReservationOwner(state, document.locator, document.id);
  if (reservationOwner) return diagnostic(state, command, 'LOCATOR_COLLISION', document.id, 'The document locator is reserved by another document.');
  if (state.tabOrder.length > 0 && !state.capability.multiDocumentWorkspaceEnabled) {
    return diagnostic(state, command, 'MULTI_DOCUMENT_DISABLED', document.id, 'A second document is disabled in single-document compatibility mode.');
  }
  if (state.tabOrder.length > 0 && !state.capability.activationSurface) {
    return diagnostic(state, command, 'ACTIVATION_SURFACE_REQUIRED', document.id, 'A second document requires a registered activation surface.');
  }
  const documentsById = { ...state.documentsById, [document.id]: document } as Record<DocumentId, DocumentRecord>;
  return {
    ...state,
    documentsById,
    tabOrder: [...state.tabOrder, document.id],
    activeDocumentId: document.id,
    recentlyActiveDocumentIds: moveToFront(state.recentlyActiveDocumentIds, document.id),
  };
}

function activateDocument(state: WorkspaceState, documentId: DocumentId, command: WorkspaceCommand['type']): WorkspaceState {
  if (!state.documentsById[documentId]) return diagnostic(state, command, 'DOCUMENT_NOT_FOUND', documentId, 'Cannot activate a missing document.');
  return {
    ...state,
    activeDocumentId: documentId,
    recentlyActiveDocumentIds: moveToFront(state.recentlyActiveDocumentIds, documentId),
  };
}

function focusDocumentByLocator(state: WorkspaceState, locator: FileDocumentLocator): WorkspaceState {
  const existing = selectDocumentByLocator(state, locator);
  if (!existing) return state;
  let next = state;
  if (existing.locator.kind === 'file') next = replaceDocumentRecord(next, { ...existing, locator: mergeFileLocatorAliases(existing.locator, locator) });
  return activateDocument(next, existing.id, 'focusDocumentByLocator');
}

function updateDocument(state: WorkspaceState, documentId: DocumentId, action: DocumentRecordAction, command: WorkspaceCommand['type']): WorkspaceState {
  const current = state.documentsById[documentId];
  if (!current) return diagnostic(state, command, 'DOCUMENT_NOT_FOUND', documentId, 'Cannot update a missing document.');
  const document = documentRecordReducer(current, action);
  if (document === current) return state;
  return replaceDocument(state, documentId, document, command);
}

function replaceDocument(state: WorkspaceState, documentId: DocumentId, document: DocumentRecord, command: WorkspaceCommand['type']): WorkspaceState {
  if (!state.documentsById[documentId]) return diagnostic(state, command, 'DOCUMENT_NOT_FOUND', documentId, 'Cannot replace a missing document.');
  if (document.id !== documentId) return diagnostic(state, command, 'DUPLICATE_DOCUMENT_ID', document.id, 'replaceDocument cannot change DocumentId.');
  const collision = findLocatorOwner(state, document.locator, documentId);
  const reservationOwner = findReservationOwner(state, document.locator, documentId);
  if (collision || reservationOwner) return diagnostic(state, command, 'LOCATOR_COLLISION', documentId, 'The replacement locator is owned or reserved by another document.');
  return {
    ...replaceDocumentRecord(state, document),
    locatorReservations: state.locatorReservations.filter((entry) => entry.documentId !== documentId),
  };
}

function replaceActiveDocument(
  state: WorkspaceState,
  document: DocumentRecord,
  authorization: WorkspaceReplacementAuthorization,
): WorkspaceState {
  const active = selectActiveDocument(state);
  if (!active || active.id !== authorization.documentId || active.source.revision !== authorization.sourceRevision) {
    return diagnostic(state, 'replaceActiveDocument', 'STALE_REPLACEMENT', authorization.documentId, 'The settled replacement no longer matches the active document revision.');
  }
  if (document.id !== active.id && state.documentsById[document.id]) {
    return diagnostic(state, 'replaceActiveDocument', 'DUPLICATE_DOCUMENT_ID', document.id, 'The replacement DocumentId is already open.');
  }
  const collision = findLocatorOwner(state, document.locator, active.id);
  const reservationOwner = findReservationOwner(state, document.locator, active.id);
  if (collision || reservationOwner) return diagnostic(state, 'replaceActiveDocument', 'LOCATOR_COLLISION', document.id, 'The replacement locator is owned or reserved by another document.');
  const documentsById = { ...state.documentsById };
  delete documentsById[active.id];
  documentsById[document.id] = document;
  const replaceId = (ids: DocumentId[]) => unique(ids.map((id) => id === active.id ? document.id : id));
  const pendingCloseRequests = { ...state.pendingCloseRequests };
  delete pendingCloseRequests[active.id];
  return {
    ...state,
    documentsById,
    tabOrder: replaceId(state.tabOrder),
    activeDocumentId: document.id,
    recentlyActiveDocumentIds: moveToFront(replaceId(state.recentlyActiveDocumentIds), document.id),
    pendingCloseRequests,
    locatorReservations: state.locatorReservations.filter((entry) => entry.documentId !== active.id),
  };
}

function requestClose(state: WorkspaceState, documentId: DocumentId, requestId: string, command: WorkspaceCommand['type']): WorkspaceState {
  const document = state.documentsById[documentId];
  if (!document) return diagnostic(state, command, 'DOCUMENT_NOT_FOUND', documentId, 'Cannot request close for a missing document.');
  return {
    ...state,
    pendingCloseRequests: {
      ...state.pendingCloseRequests,
      [documentId]: {
        requestId,
        documentId,
        sourceRevision: document.source.revision,
        requiresDurabilityDecision: document.lifecycle.content === 'dirty',
      },
    } as Record<DocumentId, WorkspaceCloseRequest>,
  };
}

function finalizeRemoveDocument(state: WorkspaceState, authorization: WorkspaceCloseAuthorization): WorkspaceState {
  const request = state.pendingCloseRequests[authorization.documentId];
  const document = state.documentsById[authorization.documentId];
  if (!request || !document) {
    return diagnostic(state, 'finalizeRemoveDocument', 'CLOSE_NOT_REQUESTED', authorization.documentId, 'A document can be removed only after requestClose.');
  }
  const authorizationMatches = request.requestId === authorization.requestId
    && request.sourceRevision === authorization.sourceRevision
    && document.source.revision === authorization.sourceRevision
    && (!request.requiresDurabilityDecision || authorization.outcome === 'discarded' || (authorization.outcome === 'saved' && document.lifecycle.content === 'clean'))
    && (request.requiresDurabilityDecision || authorization.outcome !== 'discarded' || document.lifecycle.content === 'clean');
  if (!authorizationMatches) {
    return diagnostic(state, 'finalizeRemoveDocument', 'CLOSE_AUTHORIZATION_INVALID', authorization.documentId, 'Close authorization does not match the requested document revision and durability outcome.');
  }
  return removeDocument(state, authorization.documentId);
}

function removeDocument(state: WorkspaceState, documentId: DocumentId): WorkspaceState {
  const document = state.documentsById[documentId];
  if (!document) return state;
  const removedIndex = state.tabOrder.indexOf(documentId);
  const tabOrder = state.tabOrder.filter((id) => id !== documentId);
  const documentsById = { ...state.documentsById };
  delete documentsById[documentId];
  const pendingCloseRequests = { ...state.pendingCloseRequests };
  delete pendingCloseRequests[documentId];
  const activeDocumentId = state.activeDocumentId === documentId
    ? tabOrder[Math.min(Math.max(removedIndex, 0), Math.max(tabOrder.length - 1, 0))] ?? null
    : state.activeDocumentId;
  const recentlyActiveDocumentIds = state.recentlyActiveDocumentIds.filter((id) => id !== documentId);
  if (activeDocumentId && !recentlyActiveDocumentIds.includes(activeDocumentId)) recentlyActiveDocumentIds.unshift(activeDocumentId);
  return {
    ...state,
    documentsById,
    tabOrder,
    activeDocumentId,
    recentlyActiveDocumentIds,
    recentlyClosedDocuments: [document, ...state.recentlyClosedDocuments.filter((entry) => entry.id !== documentId)].slice(0, MAX_RECENTLY_CLOSED),
    pendingCloseRequests,
    locatorReservations: state.locatorReservations.filter((entry) => entry.documentId !== documentId),
  };
}

function reopenDocument(state: WorkspaceState, requestedId?: DocumentId, rehydratedDocument?: DocumentRecord): WorkspaceState {
  const closed = requestedId
    ? state.recentlyClosedDocuments.find((entry) => entry.id === requestedId)
    : state.recentlyClosedDocuments[0];
  if (!closed) return diagnostic(state, 'reopenDocument', 'DOCUMENT_NOT_FOUND', requestedId ?? null, 'No matching recently closed document is available.');
  const document = rehydratedDocument ?? closed;
  if (document.id !== closed.id || !sameDocumentLocator(document.locator, closed.locator)) {
    return diagnostic(state, 'reopenDocument', 'STALE_REPLACEMENT', closed.id, 'Reopened source does not match the recently closed document.');
  }
  const reopened = addDocument(state, document, 'reopenDocument');
  if (!reopened.documentsById[document.id]) return reopened;
  return { ...reopened, recentlyClosedDocuments: reopened.recentlyClosedDocuments.filter((entry) => entry.id !== document.id) };
}

function reorderDocument(state: WorkspaceState, documentId: DocumentId, toIndex: number): WorkspaceState {
  const fromIndex = state.tabOrder.indexOf(documentId);
  if (fromIndex < 0) return diagnostic(state, 'reorderDocument', 'DOCUMENT_NOT_FOUND', documentId, 'Cannot reorder a missing document.');
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= state.tabOrder.length) {
    return diagnostic(state, 'reorderDocument', 'REORDER_INDEX_INVALID', documentId, 'The requested tab-order index is outside the workspace.');
  }
  const tabOrder = [...state.tabOrder];
  tabOrder.splice(fromIndex, 1);
  tabOrder.splice(toIndex, 0, documentId);
  return { ...state, tabOrder };
}

function requestManyClose(
  state: WorkspaceState,
  documentIds: DocumentId[],
  requests: Record<DocumentId, string>,
  command: WorkspaceCommand['type'],
): WorkspaceState {
  let next = state;
  for (const documentId of documentIds) {
    const requestId = requests[documentId];
    if (!requestId) continue;
    next = requestClose(next, documentId, requestId, command);
  }
  return next;
}

function reserveLocator(state: WorkspaceState, documentId: DocumentId, locator: FileDocumentLocator): WorkspaceState {
  if (!state.documentsById[documentId]) return diagnostic(state, 'reserveLocator', 'DOCUMENT_NOT_FOUND', documentId, 'Cannot reserve a locator for a missing document.');
  const owner = findLocatorOwner(state, locator, documentId);
  const reservationOwner = state.locatorReservations.find((entry) => entry.documentId !== documentId && sameDocumentLocator(entry.locator, locator))?.documentId;
  if (owner || reservationOwner) {
    return diagnostic(state, 'reserveLocator', 'LOCATOR_COLLISION', documentId, 'The Save As locator is already owned or reserved by another document.');
  }
  return {
    ...state,
    locatorReservations: [
      ...state.locatorReservations.filter((entry) => entry.documentId !== documentId),
      { documentId, locator },
    ],
  };
}

function replaceDocumentRecord(state: WorkspaceState, document: DocumentRecord): WorkspaceState {
  return {
    ...state,
    documentsById: { ...state.documentsById, [document.id]: document } as Record<DocumentId, DocumentRecord>,
  };
}

function findLocatorOwner(state: WorkspaceState, locator: DocumentLocator, excluding: DocumentId): DocumentId | null {
  for (const documentId of state.tabOrder) {
    if (documentId !== excluding && sameDocumentLocator(state.documentsById[documentId].locator, locator)) return documentId;
  }
  return null;
}

function findReservationOwner(state: WorkspaceState, locator: DocumentLocator, excluding: DocumentId): DocumentId | null {
  return state.locatorReservations.find((entry) => entry.documentId !== excluding && sameDocumentLocator(entry.locator, locator))?.documentId ?? null;
}

function diagnostic(
  state: WorkspaceState,
  command: WorkspaceCommand['type'],
  code: WorkspaceInvariantCode,
  documentId: DocumentId | null,
  message: string,
): WorkspaceState {
  return {
    ...state,
    commandSequence: state.commandSequence + 1,
    invariantDiagnostics: [...state.invariantDiagnostics, { sequence: state.commandSequence + 1, code, command, documentId, message }]
      .slice(-MAX_INVARIANT_DIAGNOSTICS),
  };
}

function moveToFront(ids: DocumentId[], documentId: DocumentId): DocumentId[] {
  return [documentId, ...ids.filter((id) => id !== documentId)];
}

function unique(ids: DocumentId[]): DocumentId[] {
  return [...new Set(ids)];
}

function assertUniqueAndComplete(label: string, actual: DocumentId[], expected: DocumentId[]): void {
  if (new Set(actual).size !== actual.length) throw new Error(`${label} must not contain duplicate DocumentIds.`);
  if (actual.length !== expected.length || expected.some((id) => !actual.includes(id))) {
    throw new Error(`${label} must contain every workspace DocumentId exactly once.`);
  }
}
