import type { DocumentFormat } from '@sciemd/core';
import type { AuthorshipMark } from '../markdown/authorship';
import type { DocumentType } from '../services/settingsService';
import type { VisualStyleId } from '../services/visualStyleService';
import type { AutosaveStatus, EditorMode, FileMetadata, SourceEnvelope } from './documentState';
import { createSourceEnvelope, DEFAULT_METADATA } from './documentState';
import type { DocumentId, DocumentLocator, SourceRevision } from './documentIdentity';
import { createDocumentId, createUntitledLocator, fallbackFileLocator, sourceRevision } from './documentIdentity';
import { appendStructuredEditJournalEntry, type StructuredEditJournalEntry } from './structuredEditJournal';
import type { StructuredSurfaceId } from './structuredSurfaceNavigation';
import type { RevisionedSourceBuffer, SourceChangeSet, SourceCompactionCandidate } from './source/revisionedSourceBuffer';
import {
  adoptWholeSource,
  adoptSavedSource,
  applySourceChangeSet,
  assertValidRevisionedSourceBuffer,
  commitSourceCompaction,
  createRevisionedSourceBuffer,
  markSourceSaved,
  migrateLegacySourceSnapshot,
  materializeCurrentSource,
  materializeSavedSource,
  restoreSourceBufferRevisions,
  sourceBufferIsDirty,
} from './source/revisionedSourceBuffer';

export type DocumentContentState = 'clean' | 'dirty';
export type DocumentSaveState = 'idle' | 'queued' | 'saving' | 'failed';
export type DocumentExternalState = 'inSync' | 'changed' | 'missing' | 'renamed' | 'unknown';
export type DocumentAccessState = 'writable' | 'readOnly' | 'permissionLost' | 'cloudUnavailable';
export type DocumentRecoveryState = 'notRequired' | 'pending' | 'current' | 'failed' | 'recoveryOnly';

export interface DocumentSourceState extends SourceEnvelope {
  /** The durable source authority. The string fields are migration projections, not edit authority. */
  buffer: RevisionedSourceBuffer;
  revision: SourceRevision;
  savedRevision: SourceRevision;
  residency:
    | { kind: 'resident'; since: number }
    | { kind: 'coldClean'; since: number; verifiedBaseline: FileMetadata };
}

export interface DocumentLifecycleState {
  content: DocumentContentState;
  save: DocumentSaveState;
  external: DocumentExternalState;
  access: DocumentAccessState;
  recovery: DocumentRecoveryState;
  autosaveStatus: AutosaveStatus;
  lastAutosavedAt: number | null;
}

export interface DocumentPresentationState {
  visualStyle: VisualStyleId | null;
  documentType: DocumentType | null;
}

export interface DocumentViewState {
  mode: EditorMode;
  preferredStructuredSurface: StructuredSurfaceId | null;
  selectedStructuredPath: string | null;
  activeStructuredNavigationTargetKey: string | null;
  explicitJsonSchemaPath: string | null;
  selectedVariableName: string | null;
  authorshipMarks: AuthorshipMark[];
  structuredEditJournal: StructuredEditJournalEntry[];
}

export interface DocumentRecord {
  schemaVersion: 2;
  id: DocumentId;
  locator: DocumentLocator;
  format: DocumentFormat;
  source: DocumentSourceState;
  fileBaseline: FileMetadata;
  observedExternal: FileMetadata | null;
  lifecycle: DocumentLifecycleState;
  presentation: DocumentPresentationState;
  view: DocumentViewState;
}

export type DocumentRecordAction =
  | { type: 'replace'; record: DocumentRecord }
  | { type: 'sourceChanged'; sourceText: string | ((current: string) => string) }
  | { type: 'guardedWholeSourceAdopted'; expectedRevision: SourceRevision; sourceText: string }
  | { type: 'sourceChangeSetApplied'; changeSet: SourceChangeSet }
  | { type: 'structuredMutationCommitted'; changeSet: SourceChangeSet; sourceText: string; journalEntry: StructuredEditJournalEntry }
  | { type: 'sourceProjectionMaterialized'; revision: SourceRevision; sourceText: string; savedSourceText?: string }
  | { type: 'sourceCompactionCommitted'; candidate: SourceCompactionCandidate }
  | { type: 'sourceTransitionedColdClean'; expectedRevision: SourceRevision; transitionedAt: number }
  | { type: 'coldSourceRehydrated'; expectedRevision: SourceRevision; sourceText: string; fileBaseline: FileMetadata; rehydratedAt: number }
  | { type: 'savedBaselineChanged'; savedSourceText: string | ((current: string) => string) }
  | { type: 'locatorChanged'; locator: DocumentLocator }
  | { type: 'filePathChanged'; filePath: string | null | ((current: string | null) => string | null) }
  | { type: 'formatChanged'; format: DocumentFormat }
  | { type: 'fileBaselineChanged'; fileBaseline: FileMetadata | ((current: FileMetadata) => FileMetadata) }
  | { type: 'observedExternalChanged'; observedExternal: FileMetadata | null }
  | {
      type: 'externalObservationChanged';
      external: DocumentExternalState;
      access: DocumentAccessState;
      observedExternal: FileMetadata | null;
      autosaveStatus?: AutosaveStatus;
    }
  | { type: 'externalDiskAdopted'; sourceText: string; fileBaseline: FileMetadata }
  | { type: 'modeChanged'; mode: EditorMode | ((current: EditorMode) => EditorMode) }
  | { type: 'autosaveStatusChanged'; autosaveStatus: AutosaveStatus | ((current: AutosaveStatus) => AutosaveStatus) }
  | { type: 'lastAutosavedAtChanged'; lastAutosavedAt: number | null | ((current: number | null) => number | null) }
  | { type: 'externalConflictChanged'; externalConflict: boolean | ((current: boolean) => boolean) }
  | { type: 'accessChanged'; access: DocumentAccessState }
  | { type: 'recoveryChanged'; recovery: DocumentRecoveryState }
  | { type: 'presentationChanged'; presentation: Partial<DocumentPresentationState> | ((current: DocumentPresentationState) => Partial<DocumentPresentationState>) }
  | { type: 'viewChanged'; view: Partial<DocumentViewState> | ((current: DocumentViewState) => Partial<DocumentViewState>) };

export function createDocumentRecord(input: {
  id?: DocumentId;
  locator?: DocumentLocator;
  format?: DocumentFormat;
  sourceText?: string;
  savedSourceText?: string;
  fileBaseline?: FileMetadata;
  mode?: EditorMode;
  autosaveStatus?: AutosaveStatus;
  presentation?: Partial<DocumentPresentationState>;
  view?: Partial<DocumentViewState>;
  residentSince?: number;
} = {}): DocumentRecord {
  const sourceText = input.sourceText ?? '';
  const savedSourceText = input.savedSourceText ?? sourceText;
  const fileBaseline = input.fileBaseline ?? DEFAULT_METADATA;
  const autosaveStatus = input.autosaveStatus ?? 'idle';
  const record: DocumentRecord = {
    schemaVersion: 2,
    id: input.id ?? createDocumentId(),
    locator: input.locator ?? createUntitledLocator(),
    format: input.format ?? 'markdown',
    source: {
      ...createSourceEnvelope(sourceText, savedSourceText, fileBaseline),
      buffer: migrateLegacySourceSnapshot(sourceText, savedSourceText),
      revision: sourceRevision(0),
      savedRevision: sourceRevision(0),
      residency: { kind: 'resident', since: input.residentSince ?? Date.now() },
    },
    fileBaseline,
    observedExternal: null,
    lifecycle: {
      content: sourceText === savedSourceText ? 'clean' : 'dirty',
      save: saveStateForAutosaveStatus(autosaveStatus),
      external: 'inSync',
      access: accessStateForMetadata(fileBaseline),
      recovery: sourceText === savedSourceText ? 'notRequired' : 'pending',
      autosaveStatus,
      lastAutosavedAt: null,
    },
    presentation: {
      visualStyle: input.presentation?.visualStyle ?? null,
      documentType: input.presentation?.documentType ?? null,
    },
    view: {
      mode: input.mode ?? 'visual',
      preferredStructuredSurface: null,
      selectedStructuredPath: '$',
      activeStructuredNavigationTargetKey: null,
      explicitJsonSchemaPath: null,
      selectedVariableName: null,
      authorshipMarks: [],
      structuredEditJournal: [],
      ...input.view,
    },
  };
  return assertValidDocumentRecord(record);
}

export function documentRecordReducer(current: DocumentRecord, action: DocumentRecordAction): DocumentRecord {
  if (action.type === 'replace') return assertValidDocumentRecord(action.record);
  if (current.source.residency.kind === 'coldClean' && sourceMutationRequiresResidentAuthority(action)) return current;
  let next = current;
  switch (action.type) {
    case 'sourceChanged': {
      const currentSourceText = documentCurrentSourceText(current);
      const sourceText = resolveUpdate(action.sourceText, currentSourceText);
      if (sourceText === currentSourceText) return current;
      const buffer = adoptWholeSource(current.source.buffer, sourceText);
      const revision = buffer.current.revision;
      next = {
        ...current,
        source: {
          ...current.source,
          buffer,
          sourceText,
          revision,
          ...fidelityFields(current.fileBaseline, sourceText, current.source.savedSourceText),
        },
        lifecycle: {
          ...current.lifecycle,
          content: sourceBufferIsDirty(buffer) ? 'dirty' : 'clean',
          recovery: sourceBufferIsDirty(buffer) ? 'pending' : 'notRequired',
        },
      };
      break;
    }
    case 'guardedWholeSourceAdopted': {
      if (action.expectedRevision !== current.source.revision) return current;
      const sourceText = action.sourceText;
      const currentSourceText = documentCurrentSourceText(current);
      if (sourceText === currentSourceText) return current;
      const buffer = adoptWholeSource(current.source.buffer, sourceText);
      const dirty = sourceBufferIsDirty(buffer);
      next = {
        ...current,
        source: { ...current.source, buffer, sourceText, revision: buffer.current.revision },
        lifecycle: { ...current.lifecycle, content: dirty ? 'dirty' : 'clean', recovery: dirty ? 'pending' : 'notRequired' },
      };
      break;
    }
    case 'sourceChangeSetApplied': {
      const result = applySourceChangeSet(current.id, current.source.buffer, action.changeSet);
      if (result.status === 'rejected') return current;
      const dirty = sourceBufferIsDirty(result.buffer);
      next = {
        ...current,
        source: { ...current.source, buffer: result.buffer, revision: result.revision },
        lifecycle: { ...current.lifecycle, content: dirty ? 'dirty' : 'clean', recovery: dirty ? 'pending' : 'notRequired' },
      };
      break;
    }
    case 'structuredMutationCommitted': {
      const result = applySourceChangeSet(current.id, current.source.buffer, action.changeSet);
      if (result.status === 'rejected') return current;
      const dirty = sourceBufferIsDirty(result.buffer);
      next = {
        ...current,
        source: { ...current.source, buffer: result.buffer, sourceText: action.sourceText, revision: result.revision },
        lifecycle: { ...current.lifecycle, content: dirty ? 'dirty' : 'clean', recovery: dirty ? 'pending' : 'notRequired' },
        view: { ...current.view, structuredEditJournal: appendStructuredEditJournalEntry(current.view.structuredEditJournal, action.journalEntry) },
      };
      break;
    }
    case 'sourceProjectionMaterialized': {
      if (action.revision !== current.source.revision) return current;
      next = {
        ...current,
        source: {
          ...current.source,
          sourceText: action.sourceText,
          ...(action.savedSourceText !== undefined ? { savedSourceText: action.savedSourceText } : {}),
        },
      };
      break;
    }
    case 'sourceCompactionCommitted': {
      const buffer = commitSourceCompaction(current.source.buffer, action.candidate);
      if (!buffer) return current;
      next = { ...current, source: { ...current.source, buffer } };
      break;
    }
    case 'sourceTransitionedColdClean': {
      if (action.expectedRevision !== current.source.revision || !documentEligibleForColdClean(current)) return current;
      const placeholder = restoreSourceBufferRevisions(
        createRevisionedSourceBuffer('', ''),
        current.source.revision,
        current.source.savedRevision,
      );
      next = {
        ...current,
        source: {
          ...createSourceEnvelope('', '', current.fileBaseline),
          buffer: placeholder,
          revision: current.source.revision,
          savedRevision: current.source.savedRevision,
          residency: { kind: 'coldClean', since: action.transitionedAt, verifiedBaseline: { ...current.fileBaseline } },
        },
      };
      break;
    }
    case 'coldSourceRehydrated': {
      if (current.source.residency.kind !== 'coldClean' || action.expectedRevision !== current.source.revision) return current;
      const buffer = restoreSourceBufferRevisions(
        createRevisionedSourceBuffer(action.sourceText, action.sourceText),
        current.source.revision,
        current.source.savedRevision,
      );
      next = {
        ...current,
        source: {
          ...createSourceEnvelope(action.sourceText, action.sourceText, action.fileBaseline),
          buffer,
          revision: current.source.revision,
          savedRevision: current.source.savedRevision,
          residency: { kind: 'resident', since: action.rehydratedAt },
        },
        fileBaseline: action.fileBaseline,
        observedExternal: null,
        lifecycle: {
          ...current.lifecycle,
          external: 'inSync',
          access: accessStateForMetadata(action.fileBaseline),
        },
      };
      break;
    }
    case 'savedBaselineChanged': {
      const currentSavedSourceText = documentSavedSourceText(current);
      const savedSourceText = resolveUpdate(action.savedSourceText, currentSavedSourceText);
      if (savedSourceText === currentSavedSourceText) return current;
      const currentText = documentCurrentSourceText(current);
      const buffer = savedSourceText === currentText
        ? markSourceSaved(current.source.buffer)
        : adoptSavedSource(current.source.buffer, savedSourceText);
      next = {
        ...current,
        source: {
          ...current.source,
          buffer,
          ...(savedSourceText === currentText ? { sourceText: currentText } : {}),
          savedSourceText,
          savedRevision: buffer.saved.revision,
        },
        lifecycle: {
          ...current.lifecycle,
          content: sourceBufferIsDirty(buffer) ? 'dirty' : 'clean',
          recovery: sourceBufferIsDirty(buffer) ? 'pending' : 'notRequired',
        },
      };
      break;
    }
    case 'locatorChanged':
      if (action.locator === current.locator) return current;
      next = { ...current, locator: action.locator };
      break;
    case 'filePathChanged': {
      const currentPath = filePathForDocumentRecord(current);
      const filePath = resolveUpdate(action.filePath, currentPath);
      next = {
        ...current,
        locator: filePath ? fallbackFileLocator(filePath) : createUntitledLocator(),
      };
      break;
    }
    case 'formatChanged':
      if (action.format === current.format) return current;
      next = { ...current, format: action.format };
      break;
    case 'fileBaselineChanged': {
      if (current.source.residency.kind === 'coldClean') return current;
      const fileBaseline = resolveUpdate(action.fileBaseline, current.fileBaseline);
      if (fileBaseline === current.fileBaseline) return current;
      next = {
        ...current,
        fileBaseline,
        source: { ...current.source, ...fidelityFields(fileBaseline, documentCurrentSourceText(current), documentSavedSourceText(current)) },
        lifecycle: { ...current.lifecycle, access: accessStateForMetadata(fileBaseline) },
      };
      break;
    }
    case 'observedExternalChanged': next = { ...current, observedExternal: action.observedExternal }; break;
    case 'externalObservationChanged':
      next = {
        ...current,
        observedExternal: action.observedExternal,
        lifecycle: {
          ...current.lifecycle,
          external: action.external,
          access: action.access,
          ...(action.autosaveStatus ? {
            autosaveStatus: action.autosaveStatus,
            save: saveStateForAutosaveStatus(action.autosaveStatus),
          } : {}),
        },
      };
      break;
    case 'externalDiskAdopted': {
      const buffer = adoptWholeSource(current.source.buffer, action.sourceText, { markSaved: true });
      const revision = buffer.current.revision;
      next = {
        ...current,
        source: {
          ...createSourceEnvelope(action.sourceText, action.sourceText, action.fileBaseline),
          buffer,
          revision,
          savedRevision: revision,
          residency: { kind: 'resident', since: Date.now() },
        },
        fileBaseline: action.fileBaseline,
        observedExternal: null,
        lifecycle: {
          ...current.lifecycle,
          content: 'clean',
          save: 'idle',
          external: 'inSync',
          access: accessStateForMetadata(action.fileBaseline),
          recovery: 'notRequired',
          autosaveStatus: 'saved',
          lastAutosavedAt: null,
        },
      };
      break;
    }
    case 'modeChanged': {
      const mode = resolveUpdate(action.mode, current.view.mode);
      if (mode === current.view.mode) return current;
      next = { ...current, view: { ...current.view, mode } };
      break;
    }
    case 'autosaveStatusChanged': {
      const autosaveStatus = resolveUpdate(action.autosaveStatus, current.lifecycle.autosaveStatus);
      if (autosaveStatus === current.lifecycle.autosaveStatus) return current;
      next = {
        ...current,
        lifecycle: {
          ...current.lifecycle,
          autosaveStatus,
          save: saveStateForAutosaveStatus(autosaveStatus),
        },
      };
      break;
    }
    case 'lastAutosavedAtChanged': {
      const lastAutosavedAt = resolveUpdate(action.lastAutosavedAt, current.lifecycle.lastAutosavedAt);
      if (lastAutosavedAt === current.lifecycle.lastAutosavedAt) return current;
      next = { ...current, lifecycle: { ...current.lifecycle, lastAutosavedAt } };
      break;
    }
    case 'externalConflictChanged': {
      const externalConflict = resolveUpdate(action.externalConflict, current.lifecycle.external === 'changed');
      if (externalConflict === (current.lifecycle.external === 'changed')) return current;
      next = { ...current, lifecycle: { ...current.lifecycle, external: externalConflict ? 'changed' : 'inSync' } };
      break;
    }
    case 'accessChanged': next = { ...current, lifecycle: { ...current.lifecycle, access: action.access } }; break;
    case 'recoveryChanged': next = { ...current, lifecycle: { ...current.lifecycle, recovery: action.recovery } }; break;
    case 'presentationChanged': next = { ...current, presentation: { ...current.presentation, ...resolvePatch(action.presentation, current.presentation) } }; break;
    case 'viewChanged': next = { ...current, view: { ...current.view, ...resolvePatch(action.view, current.view) } }; break;
  }
  return assertValidDocumentRecord(next);
}

export function replaceDocumentRecordSession(current: DocumentRecord, input: {
  id: DocumentId;
  locator: DocumentLocator;
  format: DocumentFormat;
  sourceText: string;
  savedSourceText: string;
  fileBaseline: FileMetadata;
  mode: EditorMode;
  autosaveStatus: AutosaveStatus;
  lastAutosavedAt?: number | null;
  externalConflict?: boolean;
  presentation?: Partial<DocumentPresentationState>;
}): DocumentRecord {
  const record = createDocumentRecord({
    ...input,
    view: { mode: input.mode },
    presentation: input.presentation,
  });
  return {
    ...record,
    lifecycle: {
      ...record.lifecycle,
      lastAutosavedAt: input.lastAutosavedAt ?? null,
      external: input.externalConflict ? 'changed' : 'inSync',
    },
  };
}

export function assertValidDocumentRecord(record: DocumentRecord): DocumentRecord {
  if (record.schemaVersion !== 2) throw new Error(`Unsupported DocumentRecord schema version: ${String(record.schemaVersion)}.`);
  assertValidRevisionedSourceBuffer(record.source.buffer);
  if (record.source.savedRevision > record.source.revision) throw new Error('Saved revision cannot exceed source revision.');
  if (record.source.revision !== record.source.buffer.current.revision || record.source.savedRevision !== record.source.buffer.saved.revision) {
    throw new Error('Document source revisions disagree with the revisioned source buffer.');
  }
  const expectedContent = sourceBufferIsDirty(record.source.buffer) ? 'dirty' : 'clean';
  if (record.lifecycle.content !== expectedContent) throw new Error('Document content lifecycle disagrees with its source baseline.');
  if (record.lifecycle.content === 'clean' && record.lifecycle.recovery === 'pending') {
    throw new Error('A clean document cannot require a pending recovery checkpoint.');
  }
  if (record.locator.kind === 'file' && record.locator.displayPath.trim() === '') throw new Error('File locators require a display path.');
  if (!record.source.residency || !Number.isFinite(record.source.residency.since) || record.source.residency.since < 0) {
    throw new Error('Document source residency requires a valid transition time.');
  }
  if (record.source.residency.kind === 'coldClean') {
    if (record.locator.kind !== 'file' || record.lifecycle.content !== 'clean') throw new Error('Only clean file-backed documents may be cold.');
    if (record.source.buffer.current.text.length !== 0 || record.source.buffer.saved.text.length !== 0
      || record.source.sourceText !== '' || record.source.savedSourceText !== '') {
      throw new Error('A cold-clean document cannot retain authoritative source bytes.');
    }
    if (!sameFileBaseline(record.source.residency.verifiedBaseline, record.fileBaseline)) {
      throw new Error('Cold-clean verified baseline must match the document file baseline.');
    }
  }
  return record;
}

export function documentCurrentSourceText(record: DocumentRecord): string {
  if (record.source.residency.kind !== 'resident') throw new Error('Cold-clean source must be reacquired before materialization.');
  return materializeCurrentSource(record.source.buffer);
}

export function documentSavedSourceText(record: DocumentRecord): string {
  if (record.source.residency.kind !== 'resident') throw new Error('Cold-clean source must be reacquired before materialization.');
  return materializeSavedSource(record.source.buffer);
}

export function documentEligibleForColdClean(record: DocumentRecord): boolean {
  return record.source.residency.kind === 'resident'
    && record.locator.kind === 'file'
    && record.lifecycle.content === 'clean'
    && record.lifecycle.save === 'idle'
    && record.lifecycle.external === 'inSync'
    && (record.lifecycle.access === 'writable' || record.lifecycle.access === 'readOnly')
    && record.lifecycle.recovery !== 'recoveryOnly'
    && record.lifecycle.recovery !== 'pending'
    && Boolean(record.fileBaseline.contentHash ?? record.fileBaseline.originalByteHash);
}

export function documentSourceResidentWeight(record: DocumentRecord): number {
  if (record.source.residency.kind !== 'resident') return 0;
  const current = record.source.buffer.current.text.length;
  const saved = record.source.buffer.saved.text === record.source.buffer.current.text ? 0 : record.source.buffer.saved.text.length;
  return (current + saved) * 2 + 64 * 1024;
}

function sourceMutationRequiresResidentAuthority(action: DocumentRecordAction): boolean {
  return action.type === 'sourceChanged'
    || action.type === 'guardedWholeSourceAdopted'
    || action.type === 'sourceChangeSetApplied'
    || action.type === 'sourceProjectionMaterialized'
    || action.type === 'sourceCompactionCommitted'
    || action.type === 'savedBaselineChanged';
}

function sameFileBaseline(left: FileMetadata, right: FileMetadata): boolean {
  return left.lastKnownMtimeMs === right.lastKnownMtimeMs
    && left.lastKnownSizeBytes === right.lastKnownSizeBytes
    && left.contentHash === right.contentHash
    && left.originalByteHash === right.originalByteHash;
}

export function filePathForDocumentRecord(record: DocumentRecord): string | null {
  return record.locator.kind === 'file' ? record.locator.displayPath : null;
}

export function withDocumentFilePath(record: DocumentRecord, filePath: string | null): DocumentRecord {
  return documentRecordReducer(record, {
    type: 'locatorChanged',
    locator: filePath ? fallbackFileLocator(filePath) : createUntitledLocator(),
  });
}

function fidelityFields(metadata: FileMetadata, sourceText: string, savedSourceText: string): Omit<SourceEnvelope, 'sourceText' | 'savedSourceText'> {
  const { sourceText: _sourceText, savedSourceText: _savedSourceText, ...fields } = createSourceEnvelope(sourceText, savedSourceText, metadata);
  return fields;
}

function saveStateForAutosaveStatus(status: AutosaveStatus): DocumentSaveState {
  if (status === 'pending' || status === 'paused') return 'queued';
  if (status === 'saving') return 'saving';
  if (status === 'error' || status === 'conflict') return 'failed';
  return 'idle';
}

function accessStateForMetadata(metadata: FileMetadata): DocumentAccessState {
  if (metadata.cloudState === 'cloud-placeholder') return 'cloudUnavailable';
  if (metadata.readOnly) return 'readOnly';
  return 'writable';
}

function resolveUpdate<T>(value: T | ((current: T) => T), current: T): T {
  return typeof value === 'function' ? (value as (current: T) => T)(current) : value;
}

function resolvePatch<T>(value: Partial<T> | ((current: T) => Partial<T>), current: T): Partial<T> {
  return typeof value === 'function' ? (value as (current: T) => Partial<T>)(current) : value;
}
