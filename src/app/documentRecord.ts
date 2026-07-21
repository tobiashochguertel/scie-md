import type { DocumentFormat } from '@sciemd/core';
import type { AuthorshipMark } from '../markdown/authorship';
import type { DocumentType } from '../services/settingsService';
import type { VisualStyleId } from '../services/visualStyleService';
import type { AutosaveStatus, EditorMode, FileMetadata, SourceEnvelope } from './documentState';
import { createSourceEnvelope, DEFAULT_METADATA } from './documentState';
import type { DocumentId, DocumentLocator, SourceRevision } from './documentIdentity';
import { createDocumentId, createUntitledLocator, fallbackFileLocator, sourceRevision } from './documentIdentity';
import type { StructuredEditJournalEntry } from './structuredEditJournal';
import type { StructuredSurfaceId } from './structuredSurfaceNavigation';

export type DocumentContentState = 'clean' | 'dirty';
export type DocumentSaveState = 'idle' | 'queued' | 'saving' | 'failed';
export type DocumentExternalState = 'inSync' | 'changed' | 'missing' | 'renamed' | 'unknown';
export type DocumentAccessState = 'writable' | 'readOnly' | 'permissionLost' | 'cloudUnavailable';
export type DocumentRecoveryState = 'notRequired' | 'pending' | 'current' | 'failed' | 'recoveryOnly';

export interface DocumentSourceState extends SourceEnvelope {
  revision: SourceRevision;
  savedRevision: SourceRevision;
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
  schemaVersion: 1;
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
} = {}): DocumentRecord {
  const sourceText = input.sourceText ?? '';
  const savedSourceText = input.savedSourceText ?? sourceText;
  const fileBaseline = input.fileBaseline ?? DEFAULT_METADATA;
  const autosaveStatus = input.autosaveStatus ?? 'idle';
  const record: DocumentRecord = {
    schemaVersion: 1,
    id: input.id ?? createDocumentId(),
    locator: input.locator ?? createUntitledLocator(),
    format: input.format ?? 'markdown',
    source: {
      ...createSourceEnvelope(sourceText, savedSourceText, fileBaseline),
      revision: sourceRevision(0),
      savedRevision: sourceRevision(0),
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
  let next = current;
  switch (action.type) {
    case 'sourceChanged': {
      const sourceText = resolveUpdate(action.sourceText, current.source.sourceText);
      if (sourceText === current.source.sourceText) return current;
      const revision = sourceRevision(current.source.revision + 1);
      next = {
        ...current,
        source: {
          ...current.source,
          sourceText,
          revision,
          ...fidelityFields(current.fileBaseline, sourceText, current.source.savedSourceText),
        },
        lifecycle: {
          ...current.lifecycle,
          content: sourceText === current.source.savedSourceText ? 'clean' : 'dirty',
          recovery: sourceText === current.source.savedSourceText ? 'notRequired' : 'pending',
        },
      };
      break;
    }
    case 'savedBaselineChanged': {
      const savedSourceText = resolveUpdate(action.savedSourceText, current.source.savedSourceText);
      if (savedSourceText === current.source.savedSourceText) return current;
      next = {
        ...current,
        source: {
          ...current.source,
          savedSourceText,
          savedRevision: savedSourceText === current.source.sourceText
            ? current.source.revision
            : current.source.savedRevision,
        },
        lifecycle: {
          ...current.lifecycle,
          content: current.source.sourceText === savedSourceText ? 'clean' : 'dirty',
          recovery: current.source.sourceText === savedSourceText ? 'notRequired' : 'pending',
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
      const fileBaseline = resolveUpdate(action.fileBaseline, current.fileBaseline);
      if (fileBaseline === current.fileBaseline) return current;
      next = {
        ...current,
        fileBaseline,
        source: { ...current.source, ...fidelityFields(fileBaseline, current.source.sourceText, current.source.savedSourceText) },
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
      const revision = sourceRevision(current.source.revision + 1);
      next = {
        ...current,
        source: {
          ...createSourceEnvelope(action.sourceText, action.sourceText, action.fileBaseline),
          revision,
          savedRevision: revision,
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
  if (record.schemaVersion !== 1) throw new Error(`Unsupported DocumentRecord schema version: ${String(record.schemaVersion)}.`);
  if (record.source.savedRevision > record.source.revision) throw new Error('Saved revision cannot exceed source revision.');
  const expectedContent = record.source.sourceText === record.source.savedSourceText ? 'clean' : 'dirty';
  if (record.lifecycle.content !== expectedContent) throw new Error('Document content lifecycle disagrees with its source baseline.');
  if (record.lifecycle.content === 'clean' && record.lifecycle.recovery === 'pending') {
    throw new Error('A clean document cannot require a pending recovery checkpoint.');
  }
  if (record.locator.kind === 'file' && record.locator.displayPath.trim() === '') throw new Error('File locators require a display path.');
  return record;
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
