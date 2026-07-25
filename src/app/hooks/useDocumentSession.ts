import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AutosaveStatus, EditorMode, FileMetadata } from '../documentState';
import { DEFAULT_METADATA } from '../documentState';
import { createDocumentOpenStatus } from '../documentOpenStatus';
import type { DocumentOpenPhase, DocumentOpenStatus } from '../documentOpenStatus';
import {
  buildOpenedDocumentTransition,
  buildReviewedDiskMergeTransition,
  buildUntitledDraftRestoreTransition,
  decideLaunchDuplicate,
  decideUntitledDraftRestore,
  inferDocumentFormat,
  nextDirtyReplacementStep,
} from '../documentSession/controller';
import type { DocumentSessionState } from '../documentSession/controller';
import {
  recordDocumentOpenDiagnostic,
  withTimeout,
} from '../documentSession/openEffects';
import { openDocumentForSession } from '../documentSession/openDocument';
import type { OpenDocumentOptions } from '../documentSession/openDocument';
import { useAutosaveTimer } from './useAutosaveTimer';
import { useDocumentValidator } from './useDocumentValidator';
import { useExternalChangeDetection } from './useExternalChangeDetection';
import { useLayerTwoDocument } from './useLayerTwoDocument';
import { useSaveOperations } from './useSaveOperations';
import { useWindowCloseGuard } from './useWindowCloseGuard';
import type { PersistedSettings } from '../../services/settingsService';
import { normalizeVisualStyleId } from '../../services/visualStyleService';
import { createScienfyTemplate, preferredTemplateMode, templateDefinitionFor, templateFormat } from '../../domain/document/templates';
import type { ScienfyTemplateId } from '../../domain/document/templates';
import { formatFromPath, safeParseScienfyDocument, type StructuredMutationPlan } from '@sciemd/core';
import { SOURCE_ONLY_FILE_BYTES } from '../../markdown/supportedMarkdown';
import { detectVisualRoundTripRisks } from '../../markdown/visualRoundTripSafety';
import { commitVisualEditorReadResult, documentEditorGateway } from '../documentEditorGateway';
import {
  createDocumentId,
  createUntitledLocator,
  canonicalComparisonKey,
  fallbackFileLocator,
  mergeFileLocatorAliases,
  resolveFileLocator,
  sameDocumentLocator,
} from '../documentIdentity';
import type { SourceChangeResult, SourceChangeSet } from '../source/revisionedSourceBuffer';
import { applySourceChangeSet } from '../source/revisionedSourceBuffer';
import { sourceSnapshotService } from '../source/sourceSnapshotService';
import { sourceBufferCompactionScheduler } from '../source/sourceBufferCompactionScheduler';
import type { DocumentId, DocumentLocator, FileDocumentLocator } from '../documentIdentity';
import {
  recordDocumentEdit,
  redoDocumentHistory,
  undoDocumentHistory,
} from '../../markdown/documentHistory';
import type { ConfirmState } from './useDialogs';
import { isTauriRuntime } from '../runtime';
import type { DocumentHost } from '../host/documentHost';
import { desktopDocumentHost } from '../host/desktopDocumentHost';
import type { StartupOpenFailureKind, StartupOpenFailureState } from '../startupOpenFailure';
import { createStartupOpenFailure, startupOpenDiagnosticEvent } from '../startupOpenFailure';
import type { DocumentFormat } from '@sciemd/core';
import {
  createDocumentRecord,
  documentEligibleForColdClean,
  documentCurrentSourceText,
  documentRecordReducer,
  filePathForDocumentRecord,
  replaceDocumentRecordSession,
} from '../documentRecord';
import type { DocumentPresentationState, DocumentRecordAction, DocumentViewState } from '../documentRecord';
import type { StructuredEditJournalEntry } from '../structuredEditJournal';
import { selectActiveDocument, selectDocumentByLocator } from '../workspace/workspaceState';
import type { WorkspaceCapabilityState } from '../workspace/workspaceState';
import { useWorkspaceStore } from '../workspace/workspaceStore';
import type { WorkspaceCloseScope } from '../workspace/workspaceCloseCoordinator';
import { restoreWorkspace, type WorkspaceRestoreOutcome, type WorkspaceRestoreResult } from '../workspace/workspaceRestore';
import { createRecoveryCenterModel, loadRecoveryCatalog } from '../../services/recoveryCatalog';
import { createWorkspaceRecoveryOrchestrationModel, loadWorkspaceManifest, type WorkspaceRecoveryOrchestrationModel } from '../../services/workspaceManifestService';
import type { WorkspaceIngressOrigin } from '../workspace/workspaceIngressCoordinator';
import { documentPerformance } from '../performance/documentPerformance';
import { documentRuntimeRegistry } from '../runtime/documentRuntimeRegistry';
import { documentAnalysisRuntime } from '../runtime/documentAnalysisRuntime';
import {
  planDocumentSourceResidency,
  type DocumentSourceResidencyBudgets,
} from '../runtime/documentSourceResidency';
import {
  DEFAULT_STRUCTURED_SAVE_POLICY,
  structuredSavePolicyEquals,
  type StructuredSavePolicy,
} from '../structuredSavePolicy';

interface DocumentSessionParams {
  initialSourceText?: string;
  /** @deprecated Use initialSourceText at generic document/session boundaries. */
  initialMarkdown?: string;
  setSettings: Dispatch<SetStateAction<PersistedSettings>>;
  onDocumentReplaced?: () => void;
  onOpenedFilePath?: (path: string) => void;
  confirmText: (state: ConfirmState) => Promise<boolean>;
  pushToast: (text: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
  host?: DocumentHost;
  workspaceCapability?: Partial<WorkspaceCapabilityState>;
  sourceResidencyBudgets?: Readonly<DocumentSourceResidencyBudgets>;
}

interface CommitOpenedDocumentOptions {
  preserveStartupOpenFailure?: boolean;
  ingressOrigin?: WorkspaceIngressOrigin;
  targetDocumentId?: DocumentId;
}

interface VisualRoundTripWriteRequest {
  autosave?: boolean;
  reason: 'save' | 'mode-switch-to-visual';
}

const DOCUMENT_OPEN_STATUS_DELAY_MS = 650;
const STARTUP_PATH_TIMEOUT_MS = 5_000;
const LAUNCH_DUPLICATE_SUPPRESSION_MS = 3_000;

export function useDocumentSession({
  initialSourceText,
  initialMarkdown,
  setSettings,
  onDocumentReplaced,
  onOpenedFilePath,
  confirmText,
  pushToast,
  host = desktopDocumentHost,
  workspaceCapability = {},
  sourceResidencyBudgets,
}: DocumentSessionParams) {
  const initialDocumentSourceText = initialSourceText ?? initialMarkdown ?? '';
  const initialDocumentRecordRef = useRef<ReturnType<typeof createDocumentRecord> | null>(null);
  if (!initialDocumentRecordRef.current) initialDocumentRecordRef.current = createDocumentRecord({ sourceText: initialDocumentSourceText });
  const { store: workspaceStore, state: workspaceState, activeDocument: documentRecord } = useWorkspaceStore(initialDocumentRecordRef.current, workspaceCapability);
  useEffect(() => {
    workspaceStore.externalChanges.configure(
      host,
      (targetDocumentId) => documentEditorGateway.read(targetDocumentId)?.markdown ?? null,
    );
  }, [host, workspaceStore]);
  const dispatchDocumentRecord = useCallback((action: DocumentRecordAction) => {
    const activeDocument = selectActiveDocument(workspaceStore.getState());
    if (!activeDocument) throw new Error('Cannot update document state without an active workspace document.');
    workspaceStore.dispatch({ type: 'updateDocument', documentId: activeDocument.id, action });
  }, [workspaceStore]);
  const documentId = documentRecord.id;
  const documentIdRef = useRef<DocumentId>(documentId);
  const documentLocator = documentRecord.locator;
  const documentLocatorRef = useRef<DocumentLocator>(documentLocator);
  const pendingOpenedLocatorRef = useRef<FileDocumentLocator | null>(null);
  const loadedWorkspaceManifestRef = useRef<Awaited<ReturnType<typeof loadWorkspaceManifest>>['manifest']>(null);
  const draftRestoreCheckedRef = useRef(false);
  const sourceText = documentRecord.source.sourceText;
  const setSourceText: Dispatch<SetStateAction<string>> = useCallback((next) => {
    dispatchDocumentRecord({ type: 'sourceChanged', sourceText: next });
  }, []);
  const sourceTextRef = useRef(initialDocumentSourceText);
  const editorEditGroupTimerRef = useRef<number | null>(null);
  const initialOpenCheckedRef = useRef(false);
  const lastSavedSourceText = documentRecord.source.savedSourceText;
  const setLastSavedSourceText: Dispatch<SetStateAction<string>> = useCallback((next) => {
    dispatchDocumentRecord({ type: 'savedBaselineChanged', savedSourceText: next });
  }, []);
  const markdown = sourceText;
  const lastSavedMarkdown = lastSavedSourceText;
  const format = documentRecord.format;
  const setFormatState = useCallback((nextFormat: DocumentFormat) => {
    dispatchDocumentRecord({ type: 'formatChanged', format: nextFormat });
  }, []);
  const formatRef = useRef<DocumentFormat>('markdown');
  const filePath = filePathForDocumentRecord(documentRecord);
  const setFilePath: Dispatch<SetStateAction<string | null>> = useCallback((next) => {
    const active = selectActiveDocument(workspaceStore.getState());
    const currentPath = active ? filePathForDocumentRecord(active) : null;
    const resolved = typeof next === 'function' ? next(currentPath) : next;
    if (resolved && active?.locator.kind === 'file') {
      const requestedKey = canonicalComparisonKey(resolved);
      const knownPaths = [active.locator.displayPath, ...active.locator.aliases];
      if (knownPaths.some((path) => canonicalComparisonKey(path) === requestedKey)) return;
    }
    dispatchDocumentRecord({ type: 'filePathChanged', filePath: resolved });
  }, [dispatchDocumentRecord, workspaceStore]);
  const activeFilePathRef = useRef<string | null>(null);
  const fileMetadata = documentRecord.fileBaseline;
  const setFileMetadata: Dispatch<SetStateAction<FileMetadata>> = useCallback((next) => {
    dispatchDocumentRecord({ type: 'fileBaselineChanged', fileBaseline: next });
  }, []);
  const mode = documentRecord.view.mode;
  const setMode: Dispatch<SetStateAction<EditorMode>> = useCallback((next) => {
    dispatchDocumentRecord({ type: 'modeChanged', mode: next });
  }, []);
  const autosaveStatus = documentRecord.lifecycle.autosaveStatus;
  const setAutosaveStatus: Dispatch<SetStateAction<AutosaveStatus>> = useCallback((next) => {
    dispatchDocumentRecord({ type: 'autosaveStatusChanged', autosaveStatus: next });
  }, []);
  const lastAutosavedAt = documentRecord.lifecycle.lastAutosavedAt;
  const setLastAutosavedAt: Dispatch<SetStateAction<number | null>> = useCallback((next) => {
    dispatchDocumentRecord({ type: 'lastAutosavedAtChanged', lastAutosavedAt: next });
  }, []);
  const [structuredSavePolicy, setStructuredSavePolicyState] = useState<StructuredSavePolicy>(DEFAULT_STRUCTURED_SAVE_POLICY);
  const structuredSavePolicyRef = useRef<StructuredSavePolicy>(DEFAULT_STRUCTURED_SAVE_POLICY);
  const externalConflict = documentRecord.lifecycle.external === 'changed';
  const setExternalConflict: Dispatch<SetStateAction<boolean>> = useCallback((next) => {
    dispatchDocumentRecord({ type: 'externalConflictChanged', externalConflict: next });
  }, []);
  const setAuthorshipMarks: Dispatch<SetStateAction<DocumentViewState['authorshipMarks']>> = useCallback((next) => {
    dispatchDocumentRecord({
      type: 'viewChanged',
      view: (current) => ({
        authorshipMarks: typeof next === 'function' ? next(current.authorshipMarks) : next,
      }),
    });
  }, []);
  const updateDocumentView = useCallback((view: Partial<DocumentViewState> | ((current: DocumentViewState) => Partial<DocumentViewState>)) => {
    dispatchDocumentRecord({ type: 'viewChanged', view });
  }, []);
  const updateDocumentPresentation = useCallback((presentation: Partial<DocumentPresentationState> | ((current: DocumentPresentationState) => Partial<DocumentPresentationState>)) => {
    dispatchDocumentRecord({ type: 'presentationChanged', presentation });
  }, []);
  const [startupDocumentOpenPending, setStartupDocumentOpenPending] = useState(() => isTauriRuntime());
  const [startupDocumentOpenFailure, setStartupDocumentOpenFailure] = useState<StartupOpenFailureState | null>(null);
  const [workspaceRestoreOutcomes, setWorkspaceRestoreOutcomes] = useState<WorkspaceRestoreOutcome[]>([]);
  const [workspaceRecoveryOrchestration, setWorkspaceRecoveryOrchestration] = useState<WorkspaceRecoveryOrchestrationModel | null>(null);
  const startupDocumentOpenFailed = startupDocumentOpenFailure !== null;
  const [documentOpenStatus, setDocumentOpenStatus] = useState<DocumentOpenStatus | null>(null);
  const documentOpenStatusTokenRef = useRef(0);
  const documentOpenStatusShowTimerRef = useRef<number | null>(null);
  const documentOpenStatusClearTimerRef = useRef<number | null>(null);
  const documentOpenStatusVisibleRef = useRef(false);
  const openReadAbortControllerRef = useRef<AbortController | null>(null);
  const startupDocumentOpenSettledRef = useRef(!isTauriRuntime());
  const singleInstanceListenerReadyRef = useRef(false);
  const pendingLaunchDrainInFlightRef = useRef<Promise<readonly string[]> | null>(null);
  const launchOpenInFlightKeysRef = useRef(new Set<string>());
  const lastLaunchOpenRef = useRef<{ path: string; pathKey: string; openedAt: number } | null>(null);
  const lastDraftWarningRef = useRef('');
  const untitledDraftRestoreAttemptedRef = useRef(false);
  const visualRoundTripAcknowledgementKeyRef = useRef<string | null>(null);
  const sourceResidencyEnforcementRef = useRef<Promise<void> | null>(null);

  const transitionDocumentToColdClean = useCallback(async (targetDocumentId: DocumentId) => {
    const record = workspaceStore.getState().documentsById[targetDocumentId];
    if (!record || !documentEligibleForColdClean(record)) return false;
    const result = await documentRuntimeRegistry.transitionToColdClean({
      documentId: targetDocumentId,
      clean: record.lifecycle.content === 'clean',
      pathBacked: record.locator.kind === 'file',
      saving: record.lifecycle.save !== 'idle',
      conflicted: record.lifecycle.external !== 'inSync',
      recoveryOnly: record.lifecycle.recovery === 'recoveryOnly',
      release: [
        () => { workspaceStore.saves.cancelAutosave(targetDocumentId); },
        () => { workspaceStore.effects.cancelDocument(targetDocumentId); },
        () => { sourceBufferCompactionScheduler.cancel(targetDocumentId); },
        () => {
          if (!documentAnalysisRuntime.releaseDocument(targetDocumentId)) throw new Error('Active analysis lease blocked cold transition.');
        },
        () => {
          if (!sourceSnapshotService.releaseDocument(targetDocumentId)) throw new Error('Active source snapshot lease blocked cold transition.');
        },
        () => { documentEditorGateway.releaseDocument(targetDocumentId); },
      ],
      dropAuthoritativeSource: () => {
        const latest = workspaceStore.getState().documentsById[targetDocumentId];
        if (!latest || latest.source.revision !== record.source.revision || !documentEligibleForColdClean(latest)) {
          throw new Error('Document changed before the cold source transition committed.');
        }
        const next = workspaceStore.dispatch({
          type: 'updateDocument',
          documentId: targetDocumentId,
          action: { type: 'sourceTransitionedColdClean', expectedRevision: record.source.revision, transitionedAt: Date.now() },
        });
        if (next.documentsById[targetDocumentId]?.source.residency.kind !== 'coldClean') {
          throw new Error('Workspace rejected the cold source transition.');
        }
      },
    });
    documentPerformance.trace({
      name: 'cold-transition',
      documentId: targetDocumentId,
      state: record.lifecycle.content,
      cache: result.status === 'cold-clean' ? 'not-applicable' : 'miss',
      phase: result.status === 'cold-clean' ? 'source-released' : result.status === 'failed' ? 'release-failed' : result.reason,
    });
    return result.status === 'cold-clean';
  }, [workspaceStore]);

  const enforceDocumentSourceResidency = useCallback((activeDocumentId: DocumentId | null) => {
    const previous = sourceResidencyEnforcementRef.current ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      for (;;) {
        const plan = planDocumentSourceResidency(
          workspaceStore.getState(),
          activeDocumentId,
          Date.now(),
          sourceResidencyBudgets,
        );
        const candidate = plan.candidates[0];
        if (!candidate) return;
        const transitioned = await transitionDocumentToColdClean(candidate);
        if (!transitioned) return;
      }
    }).finally(() => {
      if (sourceResidencyEnforcementRef.current === operation) sourceResidencyEnforcementRef.current = null;
    });
    sourceResidencyEnforcementRef.current = operation;
    return operation;
  }, [sourceResidencyBudgets, transitionDocumentToColdClean, workspaceStore]);

  const rehydrateColdDocument = useCallback(async (targetDocumentId: DocumentId) => {
    const record = workspaceStore.getState().documentsById[targetDocumentId];
    if (!record) return false;
    if (record.source.residency.kind === 'resident') return true;
    if (record.locator.kind !== 'file') return false;
    try {
      const response = await host.file.readTextFileForEdit(record.locator.displayPath);
      documentPerformance.trace({
        name: 'byte-acquisition',
        documentId: targetDocumentId,
        acquisitionReason: 'coldCleanRehydrate',
        byteCount: response.nativeTimings?.byteCount ?? response.metadata.lastKnownSizeBytes,
        phase: 'baseline-verified-reacquisition',
      });
      if (!sameVerifiedFileBaseline(record.source.residency.verifiedBaseline, response.metadata)) {
        workspaceStore.dispatch({
          type: 'updateDocument',
          documentId: targetDocumentId,
          action: {
            type: 'externalObservationChanged',
            external: 'changed',
            access: response.metadata.readOnly ? 'readOnly' : 'writable',
            observedExternal: response.metadata,
            autosaveStatus: 'conflict',
          },
        });
        pushToast('This cold document changed on disk. Review or reload it before activation.', 'warning');
        return false;
      }
      const next = workspaceStore.dispatch({
        type: 'updateDocument',
        documentId: targetDocumentId,
        action: {
          type: 'coldSourceRehydrated',
          expectedRevision: record.source.revision,
          sourceText: response.sourceText,
          fileBaseline: response.metadata,
          rehydratedAt: Date.now(),
        },
      });
      return next.documentsById[targetDocumentId]?.source.residency.kind === 'resident';
    } catch {
      await workspaceStore.externalChanges.checkDocument(targetDocumentId);
      pushToast('This cold document could not be reacquired. Check its file access and retry.', 'warning');
      return false;
    }
  }, [host.file, pushToast, workspaceStore]);
  const isMarkdownDocument = format === 'markdown';
  const markdownFeatureEligible = isMarkdownDocument
    && fileMetadata.lastKnownSizeBytes <= SOURCE_ONLY_FILE_BYTES;
  const markdownFeatureText = markdownFeatureEligible ? sourceText : '';
  const markdownFeaturePath = markdownFeatureEligible ? filePath : null;
  const analysisTarget = useMemo(() => ({
    documentId,
    effects: workspaceStore.effects,
    sourceRevision: documentRecord.source.revision,
    sourceByteLength: fileMetadata.lastKnownSizeBytes,
    leaseSource: (revision: typeof documentRecord.source.revision) => {
      const current = workspaceStore.getState().documentsById[documentId];
      if (!current || current.source.residency.kind !== 'resident' || current.source.revision !== revision) return null;
      return sourceSnapshotService.lease(documentId, current.source.buffer.current, 'analysis');
    },
  }), [documentId, documentRecord.source.revision, fileMetadata.lastKnownSizeBytes, workspaceStore]);

  const {
    document: layerTwoDocument,
    parsedMarkdown,
    bibliographyLoading,
    documentParsingPending,
    linkedVariableLoading,
    reloadBibliography,
  } = useLayerTwoDocument(analysisTarget, markdownFeatureText, markdownFeaturePath, host);
  const { validation, validateNow, validationPending } = useDocumentValidator(
    analysisTarget,
    markdownFeatureText,
    layerTwoDocument,
    parsedMarkdown,
  );
  const dirty = documentRecord.lifecycle.content === 'dirty';
  const autosaveBlocked = structuredSavePolicy.autosaveBlocked;

  const updateStructuredSavePolicy = useCallback((nextPolicy: StructuredSavePolicy) => {
    structuredSavePolicyRef.current = nextPolicy;
    setStructuredSavePolicyState((currentPolicy) => (
      structuredSavePolicyEquals(currentPolicy, nextPolicy) ? currentPolicy : nextPolicy
    ));
  }, []);

  // This handshake is intentionally mount-scoped. Cancelling it on ordinary
  // callback identity churn can leave Tauri startup permanently pending.
  useEffect(() => {
    sourceTextRef.current = sourceText;
  }, [sourceText]);

  useEffect(() => {
    documentIdRef.current = documentRecord.id;
    documentLocatorRef.current = documentRecord.locator;
    sourceTextRef.current = documentRecord.source.sourceText;
    formatRef.current = documentRecord.format;
    activeFilePathRef.current = filePathForDocumentRecord(documentRecord);
  }, [documentRecord]);

  const adoptLocator = useCallback((owner: DocumentId, locator: DocumentLocator) => {
    const next = workspaceStore.dispatch({ type: 'updateDocument', documentId: owner, action: { type: 'locatorChanged', locator } });
    const adopted = next.documentsById[owner];
    if (!adopted || !sameDocumentLocator(adopted.locator, locator)) return false;
    if (documentIdRef.current === owner) {
      documentLocatorRef.current = locator;
    }
    return true;
  }, [workspaceStore]);

  const adoptRestoredWorkspace = useCallback((result: WorkspaceRestoreResult) => {
    if (result.records.length === 0 || !result.activeDocumentId) return false;
    const previousIds = workspaceStore.getState().tabOrder.slice();
    documentEditorGateway.deactivate(documentIdRef.current, (nextSourceText) => {
      sourceTextRef.current = nextSourceText;
      const current = workspaceStore.getState().documentsById[documentIdRef.current];
      if (current && current.source.sourceText !== nextSourceText) {
        workspaceStore.dispatch({ type: 'updateDocument', documentId: current.id, action: { type: 'sourceChanged', sourceText: nextSourceText } });
      }
    });
    onDocumentReplaced?.();
    const next = workspaceStore.dispatch({
      type: 'hydrateRestoredWorkspace',
      documents: result.records,
      tabOrder: result.tabOrder,
      activeDocumentId: result.activeDocumentId,
      recentlyActiveDocumentIds: result.recentlyActiveDocumentIds,
    });
    const active = selectActiveDocument(next);
    if (!active || active.id !== result.activeDocumentId) return false;
    for (const previousId of previousIds) {
      if (!next.documentsById[previousId]) {
        documentAnalysisRuntime.releaseDocument(previousId);
        documentEditorGateway.releaseDocument(previousId);
      }
    }
    documentIdRef.current = active.id;
    documentLocatorRef.current = active.locator;
    sourceTextRef.current = active.source.sourceText;
    formatRef.current = active.format;
    activeFilePathRef.current = active.locator.kind === 'file' ? active.locator.displayPath : null;
    validateNow(active.format === 'markdown' ? active.source.sourceText : '', active.format === 'markdown' ? active.fileBaseline.lastKnownSizeBytes : 0);
    void enforceDocumentSourceResidency(active.id);
    return true;
  }, [enforceDocumentSourceResidency, onDocumentReplaced, validateNow, workspaceStore]);

  const restorePersistedWorkspaceIfAvailable = useCallback(async (explicitLaunchPath?: string | null) => {
    const [manifestLoad, recoveryEntries] = await Promise.all([
      loadWorkspaceManifest(),
      loadRecoveryCatalog({ includeNative: host === desktopDocumentHost }),
    ]);
    const recoveryCenter = await createRecoveryCenterModel(recoveryEntries);
    const orchestration = createWorkspaceRecoveryOrchestrationModel(manifestLoad.manifest, recoveryEntries, recoveryCenter);
    loadedWorkspaceManifestRef.current = manifestLoad.manifest;
    setWorkspaceRecoveryOrchestration(orchestration);
    const manifestLoadOutcomes: WorkspaceRestoreOutcome[] = manifestLoad.quarantinedReasons.length > 0 ? [{
      documentId: null,
      status: 'corrupt-manifest-entry',
      issues: [],
      instantiated: false,
      path: null,
      detail: `Workspace manifest data was quarantined: ${manifestLoad.quarantinedReasons.join(', ')}.`,
    }] : [];
    if (explicitLaunchPath?.trim()) {
      setWorkspaceRestoreOutcomes(manifestLoadOutcomes);
      workspaceStore.manifest.activate(manifestLoad.manifest);
      return false;
    }
    const restored = await restoreWorkspace({
      manifest: manifestLoad.manifest,
      recoveryEntries,
      capability: workspaceStore.getState().capability,
      readFile: host.file.readTextFileForEdit,
    });
    setWorkspaceRestoreOutcomes([...manifestLoadOutcomes, ...restored.outcomes]);
    const adopted = adoptRestoredWorkspace(restored);
    if (adopted) workspaceStore.manifest.activate(restored.preservedManifest);
    return adopted;
  }, [adoptRestoredWorkspace, host.file.readTextFileForEdit, workspaceStore]);

  const reserveSaveLocator = useCallback(async (path: string, originatingDocumentId = documentIdRef.current): Promise<FileDocumentLocator | null> => {
    const locator = await resolveFileLocator(host.identity, path, { allowMissing: true });
    const owner = originatingDocumentId;
    const next = workspaceStore.dispatch({ type: 'reserveLocator', documentId: owner, locator });
    if (next.locatorReservations.some((entry) => entry.documentId === owner && sameDocumentLocator(entry.locator, locator))) return locator;
    pushToast('Save As blocked because another open document already owns that file.', 'error');
    return null;
  }, [host.identity, pushToast, workspaceStore]);

  const commitSavedLocator = useCallback(async (path: string, originatingDocumentId = documentIdRef.current): Promise<boolean> => {
    const locator = await resolveFileLocator(host.identity, path);
    if (adoptLocator(originatingDocumentId, locator)) return true;
    pushToast('Saving is blocked because the file identity now collides with another open document.', 'error');
    return false;
  }, [adoptLocator, host.identity, pushToast]);

  useEffect(() => {
    activeFilePathRef.current = filePath;
  }, [filePath]);

  const clearEditorEditGroup = useCallback(() => {
    if (editorEditGroupTimerRef.current !== null) {
      window.clearTimeout(editorEditGroupTimerRef.current);
      editorEditGroupTimerRef.current = null;
    }
  }, []);

  const resetDocumentHistory = useCallback((owner: DocumentId = documentIdRef.current) => {
    clearEditorEditGroup();
    documentEditorGateway.clearHistory(owner);
  }, [clearEditorEditGroup]);

  const applyDocumentSessionState = useCallback((
    state: DocumentSessionState,
    presentation: Partial<DocumentPresentationState> = {},
    replacement: { id: DocumentId; locator: DocumentLocator } = { id: documentRecord.id, locator: documentRecord.locator },
  ) => {
    visualRoundTripAcknowledgementKeyRef.current = null;
    const nextSourceText = state.sourceText ?? state.markdown;
    const nextLastSavedSourceText = state.lastSavedSourceText ?? state.lastSavedMarkdown;
    sourceTextRef.current = nextSourceText;
    resetDocumentHistory(replacement.id);
    formatRef.current = state.format;
    activeFilePathRef.current = state.filePath;
    const locator = replacement.locator.kind === 'file' || state.filePath === null
      ? replacement.locator
      : fallbackFileLocator(state.filePath);
    const currentDocument = selectActiveDocument(workspaceStore.getState()) ?? documentRecord;
    const record = replaceDocumentRecordSession(currentDocument, {
        id: replacement.id,
        locator,
        format: state.format,
        sourceText: nextSourceText,
        savedSourceText: nextLastSavedSourceText,
        fileBaseline: state.fileMetadata,
        mode: state.mode,
        autosaveStatus: state.autosaveStatus,
        lastAutosavedAt: state.lastAutosavedAt,
        externalConflict: state.externalConflict,
        presentation,
      });
    const next = workspaceStore.dispatch({
      type: 'replaceActiveDocument',
      document: record,
      authorization: {
        kind: 'settled-single-document-replacement',
        documentId: currentDocument.id,
        sourceRevision: currentDocument.source.revision,
      },
    });
    if (next.activeDocumentId === record.id && currentDocument.id !== record.id) {
      documentAnalysisRuntime.releaseDocument(currentDocument.id);
      documentEditorGateway.releaseDocument(currentDocument.id);
    }
    if (next.activeDocumentId !== record.id) throw new Error('Workspace refused the settled document replacement.');
    documentIdRef.current = record.id;
    documentLocatorRef.current = record.locator;
  }, [documentRecord, resetDocumentHistory, workspaceStore]);

  const showDocumentOpenStatus = useCallback((path: string, phase: DocumentOpenPhase, options: { immediate?: boolean } = {}) => {
    if (documentOpenStatusClearTimerRef.current !== null) {
      window.clearTimeout(documentOpenStatusClearTimerRef.current);
      documentOpenStatusClearTimerRef.current = null;
    }
    if (documentOpenStatusShowTimerRef.current !== null) {
      window.clearTimeout(documentOpenStatusShowTimerRef.current);
      documentOpenStatusShowTimerRef.current = null;
    }
    const token = documentOpenStatusTokenRef.current + 1;
    documentOpenStatusTokenRef.current = token;

    const show = () => {
      if (documentOpenStatusTokenRef.current !== token) return;
      documentOpenStatusShowTimerRef.current = null;
      documentOpenStatusVisibleRef.current = true;
      setDocumentOpenStatus(createDocumentOpenStatus(path, phase));
    };

    if (options.immediate || documentOpenStatusVisibleRef.current) {
      show();
    } else {
      documentOpenStatusShowTimerRef.current = window.setTimeout(show, DOCUMENT_OPEN_STATUS_DELAY_MS);
    }
    return token;
  }, []);

  const clearDocumentOpenStatus = useCallback((token: number, delayMs = 0) => {
    const clear = () => {
      if (documentOpenStatusTokenRef.current === token) {
        if (documentOpenStatusShowTimerRef.current !== null) {
          window.clearTimeout(documentOpenStatusShowTimerRef.current);
          documentOpenStatusShowTimerRef.current = null;
        }
        documentOpenStatusVisibleRef.current = false;
        setDocumentOpenStatus(null);
      }
      if (documentOpenStatusClearTimerRef.current !== null) {
        window.clearTimeout(documentOpenStatusClearTimerRef.current);
        documentOpenStatusClearTimerRef.current = null;
      }
    };
    if (delayMs <= 0) {
      clear();
      return;
    }
    documentOpenStatusClearTimerRef.current = window.setTimeout(clear, delayMs);
  }, []);

  useEffect(() => () => {
    openReadAbortControllerRef.current?.abort();
    if (documentOpenStatusShowTimerRef.current !== null) {
      window.clearTimeout(documentOpenStatusShowTimerRef.current);
    }
    if (documentOpenStatusClearTimerRef.current !== null) {
      window.clearTimeout(documentOpenStatusClearTimerRef.current);
    }
  }, []);

  const commitSourceTextEdit = useCallback((action: SetStateAction<string>) => {
    clearEditorEditGroup();
    setSourceText((current) => {
      const next = typeof action === 'function'
        ? (action as (value: string) => string)(current)
        : action;
      if (next === current) return current;
      recordDocumentEdit(documentEditorGateway.historyFor(documentIdRef.current), current);
      sourceTextRef.current = next;
      return next;
    });
  }, [clearEditorEditGroup]);

  const commitEditorSourceTextEdit = useCallback((next: string) => {
    const current = workspaceStore.getState().documentsById[documentIdRef.current];
    if (!current) return;
    const currentText = documentCurrentSourceText(current);
    if (next === currentText) return;
    if (editorEditGroupTimerRef.current === null) recordDocumentEdit(documentEditorGateway.historyFor(current.id), currentText);
    else window.clearTimeout(editorEditGroupTimerRef.current);
    editorEditGroupTimerRef.current = window.setTimeout(() => { editorEditGroupTimerRef.current = null; }, 1000);
    workspaceStore.dispatch({
      type: 'updateDocument',
      documentId: current.id,
      action: { type: 'guardedWholeSourceAdopted', expectedRevision: current.source.revision, sourceText: next },
    });
    sourceTextRef.current = next;
  }, [workspaceStore]);
  const commitEditorSourceChangeSet = useCallback((changeSet: SourceChangeSet): SourceChangeResult => {
    const current = workspaceStore.getState().documentsById[changeSet.documentId];
    if (!current) return { status: 'rejected', code: 'document-mismatch', revision: changeSet.expectedRevision };
    const next = workspaceStore.dispatchInteractiveSourceChange(changeSet);
    const committed = next.documentsById[current.id];
    if (!committed || committed.source.revision === current.source.revision) {
      return applySourceChangeSet(current.id, current.source.buffer, changeSet);
    }
    const result: SourceChangeResult = {
      status: 'accepted',
      revision: committed.source.revision,
      buffer: committed.source.buffer,
    };
    sourceSnapshotService.evictDocument(current.id, committed.source.revision);
    sourceBufferCompactionScheduler.schedule({
      documentId: current.id,
      read: () => workspaceStore.getState().documentsById[current.id]?.source.buffer ?? null,
      commit: (candidate) => workspaceStore.dispatch({
        type: 'updateDocument', documentId: current.id, action: { type: 'sourceCompactionCommitted', candidate },
      }),
    });
    return result;
  }, [workspaceStore]);
  const commitStructuredMutation = useCallback((plan: StructuredMutationPlan, journalEntry: StructuredEditJournalEntry) => {
    clearEditorEditGroup();
    const current = workspaceStore.getState().documentsById[plan.documentId as DocumentId];
    if (!current) return { status: 'rejected' as const, reason: 'document-mismatch' };
    const currentText = documentCurrentSourceText(current);
    const changeSet: SourceChangeSet = {
      documentId: current.id,
      expectedRevision: current.source.revision,
      changes: plan.patches.map((patch) => ({ from: patch.from, to: patch.to, insert: patch.insert, expectedText: patch.expectedText })),
    };
    const preflight = applySourceChangeSet(current.id, current.source.buffer, changeSet);
    if (preflight.status === 'rejected') return { status: 'rejected' as const, reason: preflight.code };
    recordDocumentEdit(documentEditorGateway.historyFor(current.id), currentText);
    workspaceStore.dispatch({
      type: 'updateDocument', documentId: current.id,
      action: { type: 'structuredMutationCommitted', changeSet, sourceText: plan.transaction.nextSource, journalEntry },
    });
    const committed = workspaceStore.getState().documentsById[current.id];
    if (!committed || committed.source.revision !== preflight.revision) return { status: 'rejected' as const, reason: 'commit-not-acknowledged' };
    sourceTextRef.current = plan.transaction.nextSource;
    sourceSnapshotService.evictDocument(current.id, committed.source.revision);
    return { status: 'accepted' as const, revision: committed.source.revision as number };
  }, [clearEditorEditGroup, workspaceStore]);
  const reconcileEditorSource = useCallback(() => {
    const current = workspaceStore.getState().documentsById[documentIdRef.current];
    if (!current) return { sourceText: sourceTextRef.current, revision: documentRecord.source.revision };
    const lease = sourceSnapshotService.lease(current.id, current.source.buffer.current, 'reconciliation');
    try {
      return { sourceText: lease.sourceText, revision: lease.revision };
    } finally {
      lease.release();
    }
  }, [documentRecord.source.revision, workspaceStore]);
  const commitMarkdownEdit = commitSourceTextEdit;
  const commitEditorMarkdownEdit = commitEditorSourceTextEdit;

  const setDocumentMode = useCallback((action: SetStateAction<EditorMode>) => {
    const current = workspaceStore.getState().documentsById[documentIdRef.current];
    if (!current) return;
    const next = typeof action === 'function' ? (action as (value: EditorMode) => EditorMode)(current.view.mode) : action;
    if (next === 'visual' && current.view.mode !== 'visual') {
      const currentLease = sourceSnapshotService.lease(current.id, current.source.buffer.current, 'visual-fallback');
      const savedLease = sourceSnapshotService.lease(current.id, current.source.buffer.saved, 'visual-fallback', 'saved');
      try {
        workspaceStore.dispatch({
          type: 'updateDocument', documentId: current.id,
          action: { type: 'sourceProjectionMaterialized', revision: current.source.revision, sourceText: currentLease.sourceText, savedSourceText: savedLease.sourceText },
        });
        sourceTextRef.current = currentLease.sourceText;
      } finally {
        currentLease.release(); savedLease.release();
      }
    }
    workspaceStore.dispatch({ type: 'updateDocument', documentId: current.id, action: { type: 'modeChanged', mode: next } });
  }, [workspaceStore]);

  const undoDocumentEdit = useCallback(() => {
    clearEditorEditGroup();
    const current = documentEditorGateway.commit(documentIdRef.current, commitEditorSourceTextEdit) ?? sourceTextRef.current;
    sourceTextRef.current = current;
    const previous = undoDocumentHistory(documentEditorGateway.historyFor(documentIdRef.current), current);
    if (previous === null) return false;
    sourceTextRef.current = previous;
    setSourceText(previous);
    return true;
  }, [clearEditorEditGroup, commitEditorSourceTextEdit]);

  const redoDocumentEdit = useCallback(() => {
    clearEditorEditGroup();
    const current = documentEditorGateway.commit(documentIdRef.current, commitEditorSourceTextEdit) ?? sourceTextRef.current;
    sourceTextRef.current = current;
    const next = redoDocumentHistory(documentEditorGateway.historyFor(documentIdRef.current), current);
    if (next === null) return false;
    sourceTextRef.current = next;
    setSourceText(next);
    return true;
  }, [clearEditorEditGroup, commitEditorSourceTextEdit]);

  const confirmVisualRoundTripWrite = useCallback(async (
    candidateSourceText: string,
    request: VisualRoundTripWriteRequest,
  ) => {
    if (mode !== 'visual' && request.reason !== 'mode-switch-to-visual') return true;
    const issues = detectVisualRoundTripRisks(candidateSourceText);
    if (issues.length === 0) return true;

    const acknowledgementKey = visualRoundTripRiskKey(issues.map((issue) => issue.message));
    if (visualRoundTripAcknowledgementKeyRef.current === acknowledgementKey) return true;
    if (request.autosave) return false;

    const preview = issues
      .slice(0, 3)
      .map((issue) => `- ${issue.message}`)
      .join('\n');
    const moreCount = issues.length - 3;
    const confirmed = await confirmText({
      title: 'Continue with visual formatting changes?',
      message: [
        'Visual mode will normalize some Markdown source formatting when this document is saved or opened visually.',
        '',
        preview,
        moreCount > 0 ? `- ${moreCount} more visual formatting warnings.` : '',
        '',
        'Continue for this session?',
      ].filter(Boolean).join('\n'),
      okLabel: 'Continue',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) {
      pushToast('Visual formatting write canceled.', 'info');
      return false;
    }
    visualRoundTripAcknowledgementKeyRef.current = acknowledgementKey;
    return true;
  }, [confirmText, mode, pushToast]);

  useEffect(() => () => {
    clearEditorEditGroup();
  }, [clearEditorEditGroup]);

  useEffect(() => {
    const handleDraftStorageWarning = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      const message = detail?.message?.trim();
      if (!message || message === lastDraftWarningRef.current) return;
      lastDraftWarningRef.current = message;
      pushToast(message, 'warning');
    };
    window.addEventListener('scienfy:draft-storage-warning', handleDraftStorageWarning);
    return () => window.removeEventListener('scienfy:draft-storage-warning', handleDraftStorageWarning);
  }, [pushToast]);

  useEffect(() => {
    const flushTargetEditor = (targetDocumentId: DocumentId) => {
      if (documentEditorGateway.surface(targetDocumentId) === 'source') return;
      const flushed = documentEditorGateway.flush(targetDocumentId);
      if (!flushed) return;
      const current = workspaceStore.getState().documentsById[targetDocumentId];
      if (!current || current.source.sourceText === flushed.markdown) return;
      workspaceStore.dispatch({
        type: 'updateDocument',
        documentId: targetDocumentId,
        action: { type: 'sourceChanged', sourceText: flushed.markdown },
      });
    };
    workspaceStore.recovery.configureEditorFlush(flushTargetEditor);
    workspaceStore.close.configureEditorFlush(flushTargetEditor);
    return workspaceStore.recovery.attachLifecycleListeners();
  }, [workspaceStore]);

  const restoreUntitledDraftIfAvailable = useCallback(async (isCancelled: () => boolean) => {
    if (untitledDraftRestoreAttemptedRef.current) return;
    untitledDraftRestoreAttemptedRef.current = true;
    const recoveryToken = workspaceStore.effects.begin(documentIdRef.current, 'recovery');
    if (!recoveryToken) return;
    let draft;
    try {
      draft = await host.recovery.loadUntitledDraft();
    } catch (error) {
      if (!workspaceStore.effects.isCurrent(recoveryToken)) return;
      workspaceStore.effects.cancel(recoveryToken);
      throw error;
    }
    if (isCancelled() || !workspaceStore.effects.isCurrent(recoveryToken) || !draft) return;
    const draftSourceText = draft.sourceText ?? draft.markdown;
    if (draftSourceText === initialDocumentSourceText) return;
    const restoreDecision = decideUntitledDraftRestore({
      draftSourceText,
      draftMarkdown: draft.markdown,
      initialSourceText: initialDocumentSourceText,
      initialMarkdown: initialDocumentSourceText,
      draftIsBundledWelcome: host.recovery.isBundledWelcomeMarkdown(draftSourceText),
      initialIsBundledWelcome: host.recovery.isBundledWelcomeMarkdown(initialDocumentSourceText),
    });
    if (restoreDecision.action === 'skip') return;
    if (restoreDecision.action === 'clear-bundled-welcome') {
      void host.recovery.clearUntitledDraftAsync();
      return;
    }
    const restoreBaselinePath = activeFilePathRef.current;
    const restoreBaselineSourceText = sourceTextRef.current;
    const shouldRestore = await confirmText({
      title: 'Restore unsaved draft?',
      message: 'An unsaved draft from the previous session was found. Restore it so it can be reviewed?',
      okLabel: 'Restore',
      cancelLabel: 'Discard',
    });
    if (isCancelled() || !workspaceStore.effects.isCurrent(recoveryToken)) return;
    if (!shouldRestore) {
      workspaceStore.effects.commit(recoveryToken, () => {
        void host.recovery.clearUntitledDraftAsync();
        pushToast('Previous unsaved draft discarded.', 'info');
      });
      return;
    }
    if (activeFilePathRef.current !== restoreBaselinePath || sourceTextRef.current !== restoreBaselineSourceText) {
      pushToast('Previous unsaved draft was kept because another document is now active.', 'warning');
      return;
    }

    const restoredDocumentId = createDocumentId();
    const restoredLocator = createUntitledLocator();
    const transition = buildUntitledDraftRestoreTransition(draftSourceText, initialDocumentSourceText, draft.format);
    workspaceStore.effects.commit(recoveryToken, () => {
      documentEditorGateway.deactivate(documentIdRef.current, commitEditorSourceTextEdit);
      onDocumentReplaced?.();
      applyDocumentSessionState(transition.state, {}, { id: restoredDocumentId, locator: restoredLocator });
      pushToast(transition.toast.text, transition.toast.tone);
    });
  }, [applyDocumentSessionState, commitEditorSourceTextEdit, confirmText, host, initialDocumentSourceText, onDocumentReplaced, pushToast, workspaceStore]);

  useEffect(() => {
    // Desktop startup owns draft restore after launch-path resolution settles.
    if (isTauriRuntime()) return undefined;
    if (draftRestoreCheckedRef.current) return undefined;
    draftRestoreCheckedRef.current = true;
    let cancelled = false;
    void (async () => {
      const restored = await restorePersistedWorkspaceIfAvailable();
      if (!restored) {
        await restoreUntitledDraftIfAvailable(() => cancelled);
        workspaceStore.manifest.activate(loadedWorkspaceManifestRef.current);
      }
    })().catch((error) => {
      console.warn('Draft restore check failed.', error);
      if (!cancelled) pushToast('Could not check the previous unsaved draft.', 'warning');
    });

    return () => {
      cancelled = true;
    };
  }, [pushToast, restorePersistedWorkspaceIfAvailable, restoreUntitledDraftIfAvailable]);

  const { saveCurrent, ensureDocumentPathForAssets, resetBackupSession, saveQueueDepth } = useSaveOperations({
    documentId,
    workspaceStore,
    recoveryCoordinator: workspaceStore.recovery,
    reserveSaveLocator,
    commitSavedLocator,
    filePath,
    fileMetadata,
    format,
    sourceText,
    setFilePath,
    setFormat: (nextFormat) => {
      formatRef.current = nextFormat;
      setFormatState(nextFormat);
    },
    setFileMetadata,
    setLastSavedSourceText,
    setAutosaveStatus,
    setLastAutosavedAt,
    setExternalConflict,
    setSettings,
    commitSourceTextEdit: commitEditorSourceTextEdit,
    confirmVisualRoundTripWrite,
    structuredSavePolicyRef,
    confirmText,
    pushToast,
    host,
  });

  const commitOpenedDocument = useCallback((
    path: string | null,
    openedSourceText: string,
    metadata: FileMetadata,
    preferredMode?: EditorMode,
    savedSourceText = openedSourceText,
    documentFormatOrOptions?: DocumentFormat | CommitOpenedDocumentOptions,
    maybeOptions: CommitOpenedDocumentOptions = {},
  ): DocumentId | null => {
    const documentFormat = typeof documentFormatOrOptions === 'string' ? documentFormatOrOptions : undefined;
    const resolvedLocator = pendingOpenedLocatorRef.current;
    pendingOpenedLocatorRef.current = null;
    const options = typeof documentFormatOrOptions === 'object' ? documentFormatOrOptions : maybeOptions;
    const nextDocumentId = options.targetDocumentId ?? createDocumentId();
    const initialLocator = resolvedLocator ?? (path ? fallbackFileLocator(path) : createUntitledLocator());
    if (!options.preserveStartupOpenFailure) {
      setStartupDocumentOpenFailure(null);
    }
    const nextFormat = documentFormat ?? inferDocumentFormat(path, formatRef.current);
    const parsedDocument = nextFormat !== 'markdown' || metadata.lastKnownSizeBytes > SOURCE_ONLY_FILE_BYTES
      ? undefined
      : safeParseScienfyDocument(openedSourceText);
    const transition = buildOpenedDocumentTransition({
      path,
      sourceText: openedSourceText,
      metadata,
      format: nextFormat,
      preferredMode,
      savedSourceText,
      parsedDocument: parsedDocument
        ? {
            visualStyle: parsedDocument.visualStyle,
            documentType: parsedDocument.documentType,
          }
        : null,
      normalizeVisualStyle: normalizeVisualStyleId,
    });
    const targeted = options.targetDocumentId
      ? workspaceStore.getState().documentsById[options.targetDocumentId]
      : null;
    if (options.targetDocumentId && !targeted) return null;
    if (targeted) {
      const record = replaceDocumentRecordSession(targeted, {
        id: targeted.id,
        locator: targeted.locator,
        format: transition.state.format,
        sourceText: transition.state.sourceText,
        savedSourceText: transition.state.lastSavedSourceText,
        fileBaseline: transition.state.fileMetadata,
        mode: transition.state.mode,
        autosaveStatus: transition.state.autosaveStatus,
        lastAutosavedAt: transition.state.lastAutosavedAt,
        externalConflict: transition.state.externalConflict,
        presentation: transition.presentationPatch,
      });
      workspaceStore.dispatch({ type: 'replaceDocument', documentId: targeted.id, document: record });
      if (workspaceStore.getState().activeDocumentId === targeted.id) {
        sourceTextRef.current = record.source.sourceText;
        formatRef.current = record.format;
        activeFilePathRef.current = filePathForDocumentRecord(record);
      }
      return targeted.id;
    }
    const capability = workspaceStore.getState().capability;
    const shouldDefer = workspaceStore.getState().tabOrder.length > 0
      && capability.multiDocumentWorkspaceEnabled
      && !capability.activationSurface;
    if (!shouldDefer) {
      documentEditorGateway.deactivate(documentIdRef.current, commitEditorSourceTextEdit);
      onDocumentReplaced?.();
    }
    const currentDocument = selectActiveDocument(workspaceStore.getState()) ?? documentRecord;
    const record = replaceDocumentRecordSession(currentDocument, {
      id: nextDocumentId,
      locator: initialLocator,
      format: transition.state.format,
      sourceText: transition.state.sourceText,
      savedSourceText: transition.state.lastSavedSourceText,
      fileBaseline: transition.state.fileMetadata,
      mode: transition.state.mode,
      autosaveStatus: transition.state.autosaveStatus,
      lastAutosavedAt: transition.state.lastAutosavedAt,
      externalConflict: transition.state.externalConflict,
      presentation: transition.presentationPatch,
    });
    const routed = workspaceStore.ingress.route({
      origin: options.ingressOrigin ?? (path ? 'picker' : 'new'),
      kind: path ? 'open' : 'new',
      document: record,
      replacementAuthorization: {
        kind: 'settled-single-document-replacement',
        documentId: currentDocument.id,
        sourceRevision: currentDocument.source.revision,
      },
    });
    if (routed.status === 'deferred') {
      pushToast('The document request was preserved, but another document cannot open until an activation surface is available.', 'warning');
      return null;
    }
    const active = selectActiveDocument(workspaceStore.getState());
    if (!active || routed.status === 'rejected') throw new Error('Workspace refused the prepared document ingress.');
    if (!workspaceStore.getState().documentsById[currentDocument.id]) {
      documentAnalysisRuntime.releaseDocument(currentDocument.id);
      documentEditorGateway.releaseDocument(currentDocument.id);
    }
    if (routed.status !== 'focused') resetDocumentHistory(active.id);
    documentIdRef.current = active.id;
    documentLocatorRef.current = active.locator;
    sourceTextRef.current = active.source.sourceText;
    formatRef.current = active.format;
    activeFilePathRef.current = filePathForDocumentRecord(active);
    validateNow(
      active.format === 'markdown' ? active.source.sourceText : '',
      active.format === 'markdown' ? active.fileBaseline.lastKnownSizeBytes : 0,
      active.format === 'markdown' ? parsedDocument : undefined,
    );
    if (path && !resolvedLocator) {
      void resolveFileLocator(host.identity, path).then((resolvedLocator) => {
        if (!workspaceStore.getState().documentsById[nextDocumentId]) return;
        if (!adoptLocator(nextDocumentId, resolvedLocator)) {
          setAutosaveStatus('error');
          pushToast('This file is already owned by another document. Saving is blocked until the collision is reconciled.', 'error');
        }
      });
    }
    resetBackupSession();
    if (transition.recentFilePath) onOpenedFilePath?.(transition.recentFilePath);

    if (transition.recentFilePath) {
      setSettings(host.settings.rememberRecentFile(transition.recentFilePath));
    }
    void enforceDocumentSourceResidency(active.id);
    return active.id;
  }, [adoptLocator, commitEditorSourceTextEdit, documentRecord, enforceDocumentSourceResidency, host, onDocumentReplaced, onOpenedFilePath, pushToast, resetBackupSession, resetDocumentHistory, setSettings, validateNow, workspaceStore]);

  const recordStartupOpenFailure = useCallback((
    kind: StartupOpenFailureKind,
    path: string | null,
    error?: unknown,
  ) => {
    const failure = createStartupOpenFailure({ kind, path, error });
    setStartupDocumentOpenFailure(failure);
    recordDocumentOpenDiagnostic(
      host.recovery,
      startupOpenDiagnosticEvent(kind),
      failure.detail ? `${failure.message} ${failure.detail}` : failure.message,
      failure.path,
    );
    return failure;
  }, [host.recovery]);

  const recordStartupFallbackCommitted = useCallback((sourceTextForFallback: string) => {
    recordDocumentOpenDiagnostic(
      host.recovery,
      'startup-open-fallback-committed',
      startupDocumentOpenFailure
        ? 'Startup open fallback document committed after a launch failure.'
        : 'Startup fallback document committed after no startup document was provided.',
      startupDocumentOpenFailure?.path ?? null,
      sourceTextForFallback,
    );
  }, [host.recovery, startupDocumentOpenFailure]);

  const adoptReviewedDiskMerge = useCallback((reviewedSourceText: string, diskSourceText: string, diskMetadata: FileMetadata) => {
    const parsedDocument = formatRef.current === 'markdown' ? safeParseScienfyDocument(reviewedSourceText) : undefined;
    validateNow(
      formatRef.current === 'markdown' ? reviewedSourceText : '',
      formatRef.current === 'markdown' ? diskMetadata.lastKnownSizeBytes : 0,
      parsedDocument,
    );
    const transition = buildReviewedDiskMergeTransition(reviewedSourceText, diskSourceText, diskMetadata);
    setSourceText(transition.state.sourceText);
    sourceTextRef.current = transition.state.sourceText;
    resetDocumentHistory();
    setLastSavedSourceText(transition.state.lastSavedSourceText);
    setFileMetadata(transition.state.fileMetadata);
    setAutosaveStatus(transition.state.autosaveStatus);
    setLastAutosavedAt(transition.state.lastAutosavedAt);
    setExternalConflict(transition.state.externalConflict);
  }, [validateNow]);

  const confirmDiscardDirty = useCallback(async () => {
    if (!dirty) return true;
    return confirmText({
      title: 'Discard unsaved changes?',
      message: 'This document has unsaved changes. Discard them and continue?',
      okLabel: 'Discard',
      cancelLabel: 'Cancel',
    });
  }, [confirmText, dirty]);

  useExternalChangeDetection({
    documentId,
    coordinator: workspaceStore.externalChanges,
    onCloudPlaceholder: (message) => pushToast(message, 'warning'),
  });

  const { cancelAutosave, flushAutosave, resumeAutosave } = useAutosaveTimer({
    documentId,
    sourceRevision: documentRecord.source.revision,
    saveCoordinator: workspaceStore.saves,
    filePath,
    sourceText,
    dirty,
    externalConflict,
    autosaveBlocked: autosaveBlocked || documentRecord.lifecycle.access !== 'writable',
    structuredSavePolicy,
    saveCurrent,
    setAutosaveStatus,
  });

  const { closeDialogOpen, closeDecision, closeSummary, closeWindow, requestWorkspaceClose, resolveClose } = useWindowCloseGuard({
    workspaceStore,
    onCloseRequested: cancelAutosave,
  });

  const settleDirtyDocumentBeforeReplace = useCallback(async () => {
    if (workspaceStore.getState().capability.multiDocumentWorkspaceEnabled) return true;
    const step = nextDirtyReplacementStep({ dirty, filePath, externalConflict, autosaveBlocked });
    if (step === 'continue') return true;
    if (step === 'flush-autosave') {
      const saved = await flushAutosave();
      if (saved) return true;
    }
    return confirmDiscardDirty();
  }, [autosaveBlocked, confirmDiscardDirty, dirty, externalConflict, filePath, flushAutosave, workspaceStore]);

  const preserveDirtyDraftBeforeExternalOpen = useCallback(() => {
    if (!dirty) return;
    workspaceStore.recovery.checkpointSync(documentIdRef.current, 'destructive-barrier');
  }, [dirty, workspaceStore]);

  const handleCloseCancel = useCallback(() => {
    void resolveClose('cancel').finally(resumeAutosave);
  }, [resolveClose, resumeAutosave]);

  const deactivateActiveEditor = useCallback(() => {
    const active = selectActiveDocument(workspaceStore.getState());
    if (!active) return;
    documentEditorGateway.deactivate(active.id, (nextSourceText) => {
      const current = workspaceStore.getState().documentsById[active.id];
      if (current && current.source.sourceText !== nextSourceText) {
        workspaceStore.dispatch({ type: 'updateDocument', documentId: active.id, action: { type: 'sourceChanged', sourceText: nextSourceText } });
      }
    });
  }, [workspaceStore]);

  const activateWorkspaceDocument = useCallback(async (targetDocumentId: DocumentId) => {
    const state = workspaceStore.getState();
    let target = state.documentsById[targetDocumentId];
    if (!target) return false;
    if (state.activeDocumentId !== targetDocumentId) {
      if (target.source.residency.kind === 'coldClean' && !await rehydrateColdDocument(targetDocumentId)) return false;
      target = workspaceStore.getState().documentsById[targetDocumentId] ?? target;
      const activationStarted = performance.now();
      const warmHit = documentEditorGateway.hasWarmRuntime(targetDocumentId, target.view.mode);
      documentPerformance.trace({
        name: 'activation-start',
        documentId: targetDocumentId,
        state: target.lifecycle.content,
        surface: target.view.mode,
        cache: warmHit ? 'hit' : 'miss',
      });
      const flushStarted = performance.now();
      deactivateActiveEditor();
      documentPerformance.trace({
        name: 'gateway-flush',
        documentId: targetDocumentId,
        durationMs: performance.now() - flushStarted,
      });
      onDocumentReplaced?.();
      if (!warmHit) {
        const currentLease = sourceSnapshotService.lease(target.id, target.source.buffer.current, 'reconciliation');
        const savedLease = sourceSnapshotService.lease(target.id, target.source.buffer.saved, 'reconciliation', 'saved');
        try {
          workspaceStore.dispatch({
            type: 'updateDocument', documentId: target.id,
            action: { type: 'sourceProjectionMaterialized', revision: target.source.revision, sourceText: currentLease.sourceText, savedSourceText: savedLease.sourceText },
          });
        } finally {
          currentLease.release(); savedLease.release();
        }
      }
      workspaceStore.dispatch({ type: 'activateDocument', documentId: targetDocumentId });
      target = workspaceStore.getState().documentsById[targetDocumentId] ?? target;
      documentPerformance.trace({
        name: 'active-projection',
        documentId: targetDocumentId,
        durationMs: performance.now() - activationStarted,
      });
      void enforceDocumentSourceResidency(targetDocumentId);
    }
    documentIdRef.current = target.id;
    documentLocatorRef.current = target.locator;
    sourceTextRef.current = target.source.sourceText;
    formatRef.current = target.format;
    activeFilePathRef.current = filePathForDocumentRecord(target);
    return true;
  }, [deactivateActiveEditor, enforceDocumentSourceResidency, onDocumentReplaced, rehydrateColdDocument, workspaceStore]);

  const addBlankDocumentBeforeLastClose = useCallback(() => {
    const state = workspaceStore.getState();
    if (state.tabOrder.length !== 1) return;
    deactivateActiveEditor();
    onDocumentReplaced?.();
    workspaceStore.dispatch({ type: 'newDocument', document: createDocumentRecord() });
  }, [deactivateActiveEditor, onDocumentReplaced, workspaceStore]);

  const settleClosedDocumentPresentation = useCallback((previousIds: readonly DocumentId[], previousActiveId: DocumentId | null) => {
    const next = workspaceStore.getState();
    for (const previousId of previousIds) {
      if (!next.documentsById[previousId]) documentEditorGateway.clearRuntime(previousId);
    }
    if (next.activeDocumentId !== previousActiveId) onDocumentReplaced?.();
  }, [onDocumentReplaced, workspaceStore]);

  const closeWorkspaceScope = useCallback(async (scope: WorkspaceCloseScope) => {
    const state = workspaceStore.getState();
    const previousIds = state.tabOrder.slice();
    const previousActiveId = state.activeDocumentId;
    if (scope.kind === 'document' && state.tabOrder.length === 1 && state.documentsById[scope.documentId]?.lifecycle.content === 'clean') {
      addBlankDocumentBeforeLastClose();
    }
    const result = await requestWorkspaceClose(scope);
    settleClosedDocumentPresentation(previousIds, previousActiveId);
    if (result.status === 'partial-failure') pushToast('Some documents could not be closed. They remain open and recoverable.', 'error');
    return result;
  }, [addBlankDocumentBeforeLastClose, pushToast, requestWorkspaceClose, settleClosedDocumentPresentation, workspaceStore]);

  const closeWorkspaceDocument = useCallback((targetDocumentId: DocumentId) => closeWorkspaceScope({ kind: 'document', documentId: targetDocumentId }), [closeWorkspaceScope]);
  const closeOtherWorkspaceDocuments = useCallback((targetDocumentId: DocumentId) => closeWorkspaceScope({ kind: 'others', documentId: targetDocumentId }), [closeWorkspaceScope]);
  const closeWorkspaceDocumentsRight = useCallback((targetDocumentId: DocumentId) => closeWorkspaceScope({ kind: 'right', documentId: targetDocumentId }), [closeWorkspaceScope]);
  const reorderWorkspaceDocument = useCallback((targetDocumentId: DocumentId, toIndex: number) => {
    workspaceStore.dispatch({ type: 'reorderDocument', documentId: targetDocumentId, toIndex });
  }, [workspaceStore]);
  const reopenWorkspaceDocument = useCallback(async () => {
    const state = workspaceStore.getState();
    if (state.recentlyClosedDocuments.length === 0) return;
    const closed = state.recentlyClosedDocuments[0];
    let rehydratedDocument = closed;
    if (closed.source.residency.kind === 'coldClean') {
      if (closed.locator.kind !== 'file') return;
      try {
        const response = await host.file.readTextFileForEdit(closed.locator.displayPath);
        documentPerformance.trace({
          name: 'byte-acquisition', documentId: closed.id, acquisitionReason: 'coldCleanRehydrate',
          byteCount: response.nativeTimings?.byteCount ?? response.metadata.lastKnownSizeBytes, phase: 'reopen-baseline-verified-reacquisition',
        });
        if (!sameVerifiedFileBaseline(closed.source.residency.verifiedBaseline, response.metadata)) {
          pushToast('This recently closed document changed on disk and was not reopened automatically.', 'warning');
          return;
        }
        rehydratedDocument = documentRecordReducer(closed, {
          type: 'coldSourceRehydrated', expectedRevision: closed.source.revision,
          sourceText: response.sourceText, fileBaseline: response.metadata, rehydratedAt: Date.now(),
        });
      } catch {
        pushToast('This recently closed document could not be reacquired.', 'warning');
        return;
      }
    }
    const current = selectActiveDocument(state);
    if (current) deactivateActiveEditor();
    const next = workspaceStore.dispatch({ type: 'reopenDocument', rehydratedDocument });
    const active = selectActiveDocument(next);
    if (active && active.id !== current?.id) {
      onDocumentReplaced?.();
      void enforceDocumentSourceResidency(active.id);
    }
  }, [deactivateActiveEditor, enforceDocumentSourceResidency, host.file, onDocumentReplaced, pushToast, workspaceStore]);
  const saveAllWorkspaceDocuments = useCallback(async () => {
    const ids = workspaceStore.getState().tabOrder.slice();
    const results = await workspaceStore.saves.saveAll(ids);
    const failed = ids.filter((id) => results.get(id) === false);
    pushToast(failed.length === 0 ? `Saved ${ids.length} document${ids.length === 1 ? '' : 's'}.` : `Saved ${ids.length - failed.length} of ${ids.length} documents. Failed documents remain open.`, failed.length ? 'error' : 'success');
    return results;
  }, [pushToast, workspaceStore]);

  const openSingleDocument = useCallback(async (explicitPath?: string, options: OpenDocumentOptions = {}) => {
    if (explicitPath && !formatFromPath(explicitPath)) {
      pushToast('This file type is not supported as a ScieMD document.', 'warning');
      return false;
    }
    const openToken = workspaceStore.effects.begin(documentIdRef.current, 'open');
    if (!openToken) return false;
    openReadAbortControllerRef.current?.abort();
    const readController = new AbortController();
    openReadAbortControllerRef.current = readController;
    let initialCommitAccepted = false;
    let openedDocumentId: DocumentId | null = null;
    pendingOpenedLocatorRef.current = null;
    try {
      return await openDocumentForSession({
      explicitPath,
      options,
      host,
      confirmText,
      pushToast,
      setSettings,
      isLatestOpenRequest: () => workspaceStore.effects.isCurrent(openToken),
      settleDirtyDocumentBeforeReplace,
      preserveDirtyDraftBeforeExternalOpen,
      showDocumentOpenStatus,
      clearDocumentOpenStatus,
      onResolvedLocator: async (locator) => {
        if (!workspaceStore.effects.isCurrent(openToken)) return false;
        const existing = selectDocumentByLocator(workspaceStore.getState(), locator);
        if (existing) {
          if (existing.source.residency.kind === 'coldClean' && !await rehydrateColdDocument(existing.id)) return false;
          const previousId = documentIdRef.current;
          if (previousId !== existing.id) {
            documentEditorGateway.deactivate(previousId, commitEditorSourceTextEdit);
            onDocumentReplaced?.();
          }
          const next = workspaceStore.dispatch({ type: 'focusDocumentByLocator', locator });
          const focused = selectActiveDocument(next);
          if (!focused) return false;
          documentIdRef.current = focused.id;
          documentLocatorRef.current = focused.locator;
          sourceTextRef.current = focused.source.sourceText;
          formatRef.current = focused.format;
          activeFilePathRef.current = filePathForDocumentRecord(focused);
          return focused.id;
        }
        pendingOpenedLocatorRef.current = locator;
        return false;
      },
      commitOpenedDocument: (...args) => {
        if (!initialCommitAccepted) {
          const accepted = workspaceStore.effects.commit(openToken, () => {
            openedDocumentId = commitOpenedDocument(
              args[0], args[1], args[2], args[3], args[4] ?? args[1], args[5],
              { ingressOrigin: options.ingressOrigin ?? (explicitPath ? 'recent' : 'picker') },
            );
            return openedDocumentId !== null;
          }).accepted && openedDocumentId !== null;
          initialCommitAccepted = accepted;
          return accepted;
        }
        return false;
      },
      getCommittedDocumentId: () => openedDocumentId,
      readSignal: readController.signal,
      });
    } finally {
      if (openReadAbortControllerRef.current === readController) {
        openReadAbortControllerRef.current = null;
      }
    }
  }, [clearDocumentOpenStatus, commitEditorSourceTextEdit, commitOpenedDocument, confirmText, host, onDocumentReplaced, preserveDirtyDraftBeforeExternalOpen, pushToast, rehydrateColdDocument, setSettings, settleDirtyDocumentBeforeReplace, showDocumentOpenStatus, workspaceStore]);

  const handleOpen = useCallback(async (explicitPath?: string, options: OpenDocumentOptions = {}) => {
    const origin = options.ingressOrigin ?? (explicitPath ? 'recent' : 'picker');
    const capability = workspaceStore.getState().capability;
    if (!explicitPath && capability.multiDocumentWorkspaceEnabled && capability.activationSurface && host.dialog.pickDocumentFiles) {
      const selectedPaths = await host.dialog.pickDocumentFiles();
      let openedAny = false;
      for (const path of selectedPaths) {
        const opened = await workspaceStore.ingress.enqueue(origin, () => openSingleDocument(path, { ...options, ingressOrigin: origin }));
        openedAny = opened || openedAny;
      }
      return openedAny;
    }
    return workspaceStore.ingress.enqueue(origin, () => openSingleDocument(explicitPath, { ...options, ingressOrigin: origin }));
  }, [host.dialog, openSingleDocument, workspaceStore]);

  const handleExternalOpen = useCallback(async (path: string, ingressOrigin: WorkspaceIngressOrigin = 'single-instance') => {
    const trimmed = path.trim();
    if (!trimmed) return false;
    return handleOpen(trimmed, { preferredMode: 'visual', externalLaunch: true, draftRestore: 'auto', ingressOrigin });
  }, [handleOpen]);

  const openLaunchPathAndClear = useCallback(async (
    path: string,
    options: { markStartupFailure?: boolean; ingressOrigin?: WorkspaceIngressOrigin; pendingAlreadyTaken?: boolean } = {},
  ) => {
    const trimmed = path.trim();
    if (!trimmed) return false;
    const requestedLocator = await resolveFileLocator(host.identity, trimmed);
    const locatorKey = requestedLocator.stableFileId
      ? `stable:${requestedLocator.stableFileId}`
      : requestedLocator.comparisonKey;
    const activeLocator = documentLocatorRef.current;
    if (activeLocator.kind === 'file' && sameDocumentLocator(activeLocator, requestedLocator)) {
      adoptLocator(documentIdRef.current, mergeFileLocatorAliases(activeLocator, requestedLocator));
    }
    const activeLocatorKey = activeLocator.kind === 'file'
      ? (activeLocator.stableFileId ? `stable:${activeLocator.stableFileId}` : activeLocator.comparisonKey)
      : '';
    const launchDecision = decideLaunchDuplicate({
      requestedPath: trimmed,
      activePath: activeFilePathRef.current,
      requestedLocatorKey: locatorKey,
      activeLocatorKey,
      inFlightPathKeys: launchOpenInFlightKeysRef.current,
      lastLaunchOpen: lastLaunchOpenRef.current,
      nowMs: Date.now(),
      duplicateWindowMs: LAUNCH_DUPLICATE_SUPPRESSION_MS,
    });
    if (launchDecision.duplicate) {
      recordDocumentOpenDiagnostic(
        host.recovery,
        'document-open-duplicate-skipped',
        launchDecision.diagnosticMessage,
        launchDecision.path,
      );
      if (!options.pendingAlreadyTaken) {
        await host.launch.clearPendingDocumentOpen(launchDecision.path).catch((error) => {
          console.warn('Could not clear pending document-open event.', error);
        });
      }
      return true;
    }
    try {
      launchOpenInFlightKeysRef.current.add(launchDecision.pathKey);
      const opened = await handleExternalOpen(launchDecision.path, options.ingressOrigin ?? 'single-instance');
      if (opened) {
        lastLaunchOpenRef.current = { path: launchDecision.path, pathKey: launchDecision.pathKey, openedAt: Date.now() };
        if (!options.pendingAlreadyTaken) {
          await host.launch.clearPendingDocumentOpen(launchDecision.path).catch((error) => {
            console.warn('Could not clear pending document-open event.', error);
          });
        }
      } else if (options.markStartupFailure) {
        recordStartupOpenFailure('open-failed', launchDecision.path);
      }
      return opened;
    } catch (error) {
      console.warn('Document launch open failed.', error);
      if (options.markStartupFailure) recordStartupOpenFailure('open-failed', launchDecision.path, error);
      pushToast('Could not open the requested document.', 'error');
      return false;
    } finally {
      launchOpenInFlightKeysRef.current.delete(launchDecision.pathKey);
    }
  }, [adoptLocator, handleExternalOpen, host, pushToast, recordStartupOpenFailure]);

  const drainPendingLaunchPath = useCallback(() => {
    if (pendingLaunchDrainInFlightRef.current) return pendingLaunchDrainInFlightRef.current;
    const operation = (async () => {
      try {
        const openedPaths: string[] = [];
        for (;;) {
          const pendingPath = await host.launch.takePendingDocumentOpen();
          if (!pendingPath?.trim()) return openedPaths;
          const opened = await openLaunchPathAndClear(pendingPath, { ingressOrigin: 'single-instance', pendingAlreadyTaken: true });
          if (opened) openedPaths.push(pendingPath);
        }
      } catch (error) {
        console.warn('Could not check for pending document-open events.', error);
        return [];
      }
    })().finally(() => {
      if (pendingLaunchDrainInFlightRef.current === operation) pendingLaunchDrainInFlightRef.current = null;
    });
    pendingLaunchDrainInFlightRef.current = operation;
    return operation;
  }, [host, openLaunchPathAndClear]);

  const handleReloadFromDisk = useCallback(async () => {
    if (!filePath) return false;
    if (dirty) {
      const reload = await confirmText({
        title: 'Reload disk version?',
        message: 'Reloading discards unsaved local edits in the editor. Recovery drafts are kept until the disk version opens successfully.',
        okLabel: 'Reload',
        cancelLabel: 'Cancel',
      });
      if (!reload) return false;
    }
    const reloaded = await workspaceStore.externalChanges.reloadFromDisk(documentId);
    if (reloaded) {
      resetDocumentHistory();
      pushToast('Reloaded the addressed document from disk.', 'success');
    }
    return reloaded;
  }, [confirmText, dirty, filePath, documentId, pushToast, resetDocumentHistory, workspaceStore]);

  useEffect(() => {
    if (!isTauriRuntime() || initialOpenCheckedRef.current) return undefined;
    initialOpenCheckedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        setStartupDocumentOpenFailure(null);
        const path = await withTimeout(
          host.launch.getInitialDocumentPath(),
          STARTUP_PATH_TIMEOUT_MS,
          'Startup document path lookup took too long.',
        );
        if (cancelled) return;
        if (!path?.trim()) {
          recordDocumentOpenDiagnostic(
            host.recovery,
            'startup-open-no-path',
            'No startup document path was provided.',
          );
          const restored = await restorePersistedWorkspaceIfAvailable();
          if (!restored) {
            await restoreUntitledDraftIfAvailable(() => cancelled);
            workspaceStore.manifest.activate(loadedWorkspaceManifestRef.current);
          }
          return;
        }
        setStartupDocumentOpenPending(true);
        const opened = await openLaunchPathAndClear(path, { markStartupFailure: true, ingressOrigin: 'startup' });
        if (!opened) {
          if (!cancelled) {
            const restored = await restorePersistedWorkspaceIfAvailable();
            if (!restored) {
              await restoreUntitledDraftIfAvailable(() => cancelled);
              workspaceStore.manifest.activate(loadedWorkspaceManifestRef.current);
            }
          }
          return;
        }
        await restorePersistedWorkspaceIfAvailable(path);
        if (!cancelled && !activeFilePathRef.current && sourceTextRef.current === initialDocumentSourceText) {
          await restoreUntitledDraftIfAvailable(() => cancelled);
        }
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          recordStartupOpenFailure('path-lookup-failed', null, error);
          pushToast('Could not open the startup document.', 'error');
          const restored = await restorePersistedWorkspaceIfAvailable();
          if (!restored) {
            await restoreUntitledDraftIfAvailable(() => cancelled);
            workspaceStore.manifest.activate(loadedWorkspaceManifestRef.current);
          }
        }
      } finally {
        startupDocumentOpenSettledRef.current = true;
        if (!cancelled) {
          setStartupDocumentOpenPending(false);
          if (singleInstanceListenerReadyRef.current) {
            void drainPendingLaunchPath();
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void host.launch.listenSingleInstanceOpen((path) => {
      if (!path.trim()) return;
      void drainPendingLaunchPath().then((openedFromQueue) => (
        openedFromQueue.some((queuedPath) => canonicalComparisonKey(queuedPath) === canonicalComparisonKey(path))
          ? true
          : openLaunchPathAndClear(path, { ingressOrigin: 'single-instance' })
      ));
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
      singleInstanceListenerReadyRef.current = true;
      if (startupDocumentOpenSettledRef.current) {
        void drainPendingLaunchPath();
      }
    }).catch((error) => {
      console.warn('Single-instance open listener could not be registered.', error);
    });
    return () => {
      disposed = true;
      singleInstanceListenerReadyRef.current = false;
      unlisten?.();
    };
  }, [drainPendingLaunchPath, host, openLaunchPathAndClear]);

  const retryStartupDocumentOpen = useCallback(async () => {
    const failure = startupDocumentOpenFailure;
    if (!failure) return false;
    recordDocumentOpenDiagnostic(
      host.recovery,
      'startup-open-retry-requested',
      failure.path
        ? 'Retry requested for failed startup document.'
        : 'Retry requested for startup document path lookup.',
      failure.path,
    );
    setStartupDocumentOpenPending(true);
    setStartupDocumentOpenFailure(null);
    try {
      if (failure.path?.trim()) {
        const opened = await openLaunchPathAndClear(failure.path, { markStartupFailure: true });
        if (!opened) await restoreUntitledDraftIfAvailable(() => false);
        return opened;
      }
      const path = await withTimeout(
        host.launch.getInitialDocumentPath(),
        STARTUP_PATH_TIMEOUT_MS,
        'Startup document path lookup took too long.',
      );
      if (!path?.trim()) {
        recordDocumentOpenDiagnostic(
          host.recovery,
          'startup-open-no-path',
          'No startup document path was provided during retry.',
        );
        await restoreUntitledDraftIfAvailable(() => false);
        return false;
      }
      const opened = await openLaunchPathAndClear(path, { markStartupFailure: true });
      if (!opened) await restoreUntitledDraftIfAvailable(() => false);
      return opened;
    } catch (error) {
      recordStartupOpenFailure('path-lookup-failed', null, error);
      pushToast('Could not open the startup document.', 'error');
      await restoreUntitledDraftIfAvailable(() => false);
      return false;
    } finally {
      setStartupDocumentOpenPending(false);
    }
  }, [host, openLaunchPathAndClear, pushToast, recordStartupOpenFailure, restoreUntitledDraftIfAvailable, startupDocumentOpenFailure]);

  const openStartupDocumentFallbackPicker = useCallback(async () => {
    recordDocumentOpenDiagnostic(
      host.recovery,
      'startup-open-picker-requested',
      'Open-file action requested from the startup failure banner.',
      startupDocumentOpenFailure?.path ?? null,
    );
    return handleOpen(undefined, { preferredMode: 'visual' });
  }, [handleOpen, host.recovery, startupDocumentOpenFailure]);

  const dismissStartupDocumentOpenFailure = useCallback(() => {
    recordDocumentOpenDiagnostic(
      host.recovery,
      'startup-open-failure-dismissed',
      'Startup failure banner dismissed.',
      startupDocumentOpenFailure?.path ?? null,
    );
    setStartupDocumentOpenFailure(null);
  }, [host.recovery, startupDocumentOpenFailure]);

  const handleNew = useCallback(async () => {
    try {
      openReadAbortControllerRef.current?.abort();
      const cancellation = workspaceStore.effects.begin(documentIdRef.current, 'open');
      if (cancellation) workspaceStore.effects.cancel(cancellation);
      if (!(await settleDirtyDocumentBeforeReplace())) return;
      const content = createScienfyTemplate('blank-markdown');
      commitOpenedDocument(null, content, DEFAULT_METADATA, 'visual', content, 'markdown', { ingressOrigin: 'new' });
    } catch (error) {
      console.warn('New document command failed.', error);
      pushToast(error instanceof Error ? error.message : 'Could not create a new document.', 'error');
    }
  }, [commitOpenedDocument, pushToast, settleDirtyDocumentBeforeReplace, workspaceStore]);

  const handleNewFromTemplate = useCallback(async (template: ScienfyTemplateId) => {
    try {
      openReadAbortControllerRef.current?.abort();
      const cancellation = workspaceStore.effects.begin(documentIdRef.current, 'open');
      if (cancellation) workspaceStore.effects.cancel(cancellation);
      if (!(await settleDirtyDocumentBeforeReplace())) return;
      const content = createScienfyTemplate(template);
      const format = templateFormat(template);
      const definition = templateDefinitionFor(template);
      commitOpenedDocument(null, content, DEFAULT_METADATA, preferredTemplateMode(template), content, format, { ingressOrigin: 'template' });
      pushToast(`${definition.label} created`, 'success');
    } catch (error) {
      console.warn('New document from template command failed.', error);
      pushToast(error instanceof Error ? error.message : 'Could not create a document from this template.', 'error');
    }
  }, [commitOpenedDocument, pushToast, settleDirtyDocumentBeforeReplace, workspaceStore]);

  const handleCloseSave = useCallback(async () => {
    try {
      const before = workspaceStore.getState();
      const previousIds = before.tabOrder.slice();
      const previousActiveId = before.activeDocumentId;
      const decision = workspaceStore.close.pendingDecision();
      if (decision && decision.scope.kind !== 'quit' && decision.targets.length === workspaceStore.getState().tabOrder.length) {
        addBlankDocumentBeforeLastClose();
      }
      const result = await resolveClose('save-selected');
      settleClosedDocumentPresentation(previousIds, previousActiveId);
      if (result?.status === 'partial-failure') pushToast('Some documents could not be saved. They remain open and recoverable.', 'error');
    } catch (error) {
      console.warn('Save and close command failed.', error);
      pushToast(error instanceof Error ? error.message : 'Could not close the window after saving.', 'error');
    }
  }, [addBlankDocumentBeforeLastClose, pushToast, resolveClose, settleClosedDocumentPresentation, workspaceStore]);

  const handleCloseDiscard = useCallback(async () => {
    try {
      const before = workspaceStore.getState();
      const previousIds = before.tabOrder.slice();
      const previousActiveId = before.activeDocumentId;
      const decision = workspaceStore.close.pendingDecision();
      if (decision && decision.scope.kind !== 'quit' && decision.targets.length === workspaceStore.getState().tabOrder.length) {
        addBlankDocumentBeforeLastClose();
      }
      const result = await resolveClose('discard-selected');
      settleClosedDocumentPresentation(previousIds, previousActiveId);
      if (result?.status === 'partial-failure') pushToast('Some documents could not be discarded durably. They remain open.', 'error');
    } catch (error) {
      console.warn('Discard and close command failed.', error);
      pushToast(error instanceof Error ? error.message : 'Could not close the window.', 'error');
    }
  }, [addBlankDocumentBeforeLastClose, pushToast, resolveClose, settleClosedDocumentPresentation, workspaceStore]);

  return {
    workspaceState,
    workspaceRestoreOutcomes,
    workspaceRecoveryOrchestration,
    workspaceExternalChanges: workspaceStore.externalChanges,
    documentEffects: workspaceStore.effects,
    documentRecord,
    documentId,
    documentLocator,
    sourceText,
    setSourceText,
    commitSourceTextEdit,
    commitEditorSourceTextEdit,
    commitEditorSourceChangeSet,
    commitStructuredMutation,
    reconcileEditorSource,
    markdown,
    setMarkdown: setSourceText,
    commitMarkdownEdit,
    commitEditorMarkdownEdit,
    undoDocumentEdit,
    redoDocumentEdit,
    lastSavedSourceText,
    lastSavedMarkdown,
    format,
    filePath,
    fileMetadata,
    mode,
    setMode: setDocumentMode,
    autosaveStatus,
    structuredSavePolicy,
    updateStructuredSavePolicy,
    lastAutosavedAt,
    saveQueueDepth,
    startupDocumentOpenPending,
    startupDocumentOpenFailed,
    startupDocumentOpenFailure,
    documentOpenStatus,
    externalConflict,
    setAuthorshipMarks,
    updateDocumentView,
    updateDocumentPresentation,
    dirty,
    validation,
    validateNow,
    layerTwoDocument,
    bibliographyLoading,
    documentParsingPending,
    validationPending,
    linkedVariableLoading,
    reloadBibliography,
    closeDialogOpen,
    closeDecision,
    closeSummary,
    closeWindow,
    activateWorkspaceDocument,
    closeWorkspaceDocument,
    closeOtherWorkspaceDocuments,
    closeWorkspaceDocumentsRight,
    reorderWorkspaceDocument,
    reopenWorkspaceDocument,
    saveAllWorkspaceDocuments,
    cancelAutosave,
    resumeAutosave,
    saveCurrent,
    confirmVisualRoundTripWrite,
    ensureDocumentPathForAssets,
    settleDirtyDocumentBeforeReplace,
    commitOpenedDocument,
    adoptReviewedDiskMerge,
    handleOpen,
    handleReloadFromDisk,
    handleNew,
    handleNewFromTemplate,
    retryStartupDocumentOpen,
    openStartupDocumentFallbackPicker,
    dismissStartupDocumentOpenFailure,
    recordStartupFallbackCommitted,
    handleCloseSave,
    handleCloseDiscard,
    handleCloseCancel,
  };
}

function visualRoundTripRiskKey(messages: string[]): string {
  return messages.join('\n');
}

function sameVerifiedFileBaseline(expected: FileMetadata, actual: FileMetadata): boolean {
  if (expected.contentHash && actual.contentHash) return expected.contentHash === actual.contentHash;
  if (expected.originalByteHash && actual.originalByteHash) return expected.originalByteHash === actual.originalByteHash;
  return expected.lastKnownSizeBytes === actual.lastKnownSizeBytes
    && expected.lastKnownMtimeMs === actual.lastKnownMtimeMs;
}
