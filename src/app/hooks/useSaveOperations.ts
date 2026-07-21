import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AutosaveStatus, FileMetadata, SourceFidelityLossReason } from '../documentState';
import {
  assessSourceWriteFidelity,
  DEFAULT_METADATA,
  metadataChanged,
  metadataForUtf8Conversion,
  untitledNameForFormat,
} from '../documentState';
import { BACKUP_INTERVAL_MS, markAutosaveBackupCreated, shouldCreateAutosaveBackup } from '../../services/autosaveService';
import type { PersistedSettings } from '../../services/settingsService';
import type { ConfirmState } from './useDialogs';
import { parseFrontmatter } from '@sciemd/core';
import type { DocumentFormat } from '@sciemd/core';
import { commitVisualEditorReadResult, documentEditorGateway } from '../documentEditorGateway';
import { canonicalComparisonKey, createDocumentId } from '../documentIdentity';
import type { DocumentId, FileDocumentLocator } from '../documentIdentity';
import type { DocumentHost } from '../host/documentHost';
import type { WorkspaceStore } from '../workspace/workspaceStore';
import type { WorkspaceRecoveryCoordinator } from '../workspace/workspaceRecoveryCoordinator';
import { filePathForDocumentRecord } from '../documentRecord';
import type { DocumentRecordAction } from '../documentRecord';
import { normalizeDocumentHostError } from '../host/documentHost';
import { inferDocumentFormat } from '../documentSession/controller';
import {
  DEFAULT_STRUCTURED_SAVE_POLICY,
  formatStructuredSaveConfirmation,
  type StructuredSavePolicy,
} from '../structuredSavePolicy';

export interface VisualRoundTripWriteContext {
  autosave: boolean;
  forceSaveAs: boolean;
  forceOverwrite: boolean;
  reason: 'save';
}

export interface SaveCurrentOptions {
  autosave?: boolean;
  forceSaveAs?: boolean;
  forceOverwrite?: boolean;
  structuredSavePolicyOverride?: StructuredSavePolicy;
}

interface SaveOperationsParams {
  documentId?: DocumentId;
  workspaceStore?: WorkspaceStore;
  recoveryCoordinator?: WorkspaceRecoveryCoordinator;
  reserveSaveLocator?: (path: string, documentId?: DocumentId) => Promise<FileDocumentLocator | null>;
  commitSavedLocator?: (path: string, documentId?: DocumentId) => Promise<boolean>;
  filePath: string | null;
  fileMetadata: FileMetadata;
  format: DocumentFormat;
  sourceText: string;
  /** @deprecated Use sourceText at generic save boundaries. */
  markdown?: string;
  /** @deprecated Round 10 save ownership is document/revision/locator based. */
  getDocumentIdentityVersion?: () => number;
  setFilePath: (path: string) => void;
  setFormat: (format: DocumentFormat) => void;
  setFileMetadata: (metadata: FileMetadata) => void;
  setLastSavedSourceText: (sourceText: string) => void;
  /** @deprecated Use setLastSavedSourceText at generic save boundaries. */
  setLastSavedMarkdown?: (markdown: string) => void;
  setAutosaveStatus: (status: AutosaveStatus) => void;
  setLastAutosavedAt: (timestamp: number | null) => void;
  setExternalConflict: (conflict: boolean) => void;
  setSettings: Dispatch<SetStateAction<PersistedSettings>>;
  commitSourceTextEdit: (sourceText: string) => void;
  /** @deprecated Use commitSourceTextEdit at generic save boundaries. */
  commitMarkdownEdit?: (markdown: string) => void;
  confirmVisualRoundTripWrite?: (sourceText: string, context: VisualRoundTripWriteContext) => Promise<boolean>;
  structuredSavePolicyRef?: { current: StructuredSavePolicy };
  confirmText: (state: ConfirmState) => Promise<boolean>;
  pushToast: (text: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
  host: DocumentHost;
}

export function useSaveOperations({
  documentId,
  workspaceStore,
  recoveryCoordinator,
  reserveSaveLocator,
  commitSavedLocator,
  filePath,
  fileMetadata,
  format,
  sourceText,
  markdown,
  setFilePath,
  setFormat,
  setFileMetadata,
  setLastSavedSourceText,
  setLastSavedMarkdown,
  setAutosaveStatus,
  setLastAutosavedAt,
  setExternalConflict,
  setSettings,
  commitSourceTextEdit,
  commitMarkdownEdit,
  confirmVisualRoundTripWrite,
  structuredSavePolicyRef,
  confirmText,
  pushToast,
  host,
}: SaveOperationsParams) {
  const fallbackDocumentIdRef = useRef<DocumentId>(documentId ?? createDocumentId());
  const effectiveDocumentId = documentId ?? fallbackDocumentIdRef.current;
  const canonicalSourceText = sourceText ?? markdown ?? '';
  const commitCanonicalSourceTextEdit = commitSourceTextEdit ?? commitMarkdownEdit ?? (() => undefined);
  const setLastSavedCanonicalSourceText = setLastSavedSourceText ?? setLastSavedMarkdown ?? (() => undefined);
  const backupSchedulesRef = useRef(new Map<DocumentId, { sessionBackupDone: boolean; lastBackupAtMs: number }>());
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const saveQueueDepthRef = useRef(0);
  const filePathRef = useRef(filePath);
  const fileMetadataRef = useRef(fileMetadata);
  const formatRef = useRef(format);
  const sourceTextRef = useRef(canonicalSourceText);
  const [saveQueueDepth, setSaveQueueDepth] = useState(0);

  useEffect(() => {
    filePathRef.current = filePath;
  }, [filePath]);

  useEffect(() => {
    fileMetadataRef.current = fileMetadata;
  }, [fileMetadata]);

  useEffect(() => {
    formatRef.current = format;
  }, [format]);

  useEffect(() => {
    sourceTextRef.current = canonicalSourceText;
  }, [canonicalSourceText]);

  useEffect(() => {
    if (!workspaceStore) return undefined;
    const syncDepth = () => setSaveQueueDepth(workspaceStore.saves.queuedFor(effectiveDocumentId));
    syncDepth();
    return workspaceStore.saves.subscribe(syncDepth);
  }, [effectiveDocumentId, workspaceStore]);

  const updateSaveQueueDepth = useCallback((delta: number) => {
    saveQueueDepthRef.current = Math.max(0, saveQueueDepthRef.current + delta);
    setSaveQueueDepth(saveQueueDepthRef.current);
  }, []);

  const resetBackupSession = useCallback(() => {
    backupSchedulesRef.current.set(effectiveDocumentId, { sessionBackupDone: false, lastBackupAtMs: 0 });
  }, [effectiveDocumentId]);

  const saveCurrent = useCallback(async (options: SaveCurrentOptions = {}) => {
    const requestedOptions = {
      autosave: options.autosave ?? false,
      forceSaveAs: options.forceSaveAs ?? false,
      forceOverwrite: options.forceOverwrite ?? false,
    };
    const workspaceDocument = workspaceStore?.getState().documentsById[effectiveDocumentId] ?? null;
    if (workspaceStore && !workspaceDocument) return false;
    const liveFormat = workspaceDocument?.format ?? formatRef.current;
    const visualState = liveFormat === 'markdown' ? documentEditorGateway.flush(effectiveDocumentId) : null;
    const outputSourceText = visualState?.markdown ?? workspaceDocument?.source.sourceText ?? sourceTextRef.current;
    const visualWriteAllowed = visualState
      ? await confirmVisualRoundTripWrite?.(outputSourceText, {
        ...requestedOptions,
        reason: 'save',
      })
      : true;
    if (visualWriteAllowed === false) return false;
    const flushedSourceText = commitVisualEditorReadResult(visualState, (nextSourceText) => {
      if (workspaceStore) {
        workspaceStore.dispatch({ type: 'updateDocument', documentId: effectiveDocumentId, action: { type: 'sourceChanged', sourceText: nextSourceText } });
      } else {
        commitCanonicalSourceTextEdit(nextSourceText);
      }
    });
    sourceTextRef.current = flushedSourceText ?? outputSourceText;
    const origin = workspaceStore?.getState().documentsById[effectiveDocumentId] ?? null;
    const saveToken = workspaceStore?.saves.begin(effectiveDocumentId, requestedOptions.autosave ? 'autosave' : 'manual') ?? null;
    const snapshot = {
      ...requestedOptions,
      sourcePath: origin ? filePathForDocumentRecord(origin) : filePathRef.current,
      sourceMetadata: origin?.fileBaseline ?? fileMetadataRef.current,
      sourceFormat: origin?.format ?? formatRef.current,
      sourceText: origin?.source.sourceText ?? sourceTextRef.current,
      sourceRevision: origin?.source.revision ?? null,
      sourceLocator: origin?.locator ?? null,
    };
    const backupSchedule = backupSchedulesRef.current.get(effectiveDocumentId) ?? { sessionBackupDone: false, lastBackupAtMs: 0 };
    backupSchedulesRef.current.set(effectiveDocumentId, backupSchedule);
    const isSnapshotCurrent = () => (
      workspaceStore && saveToken
        ? workspaceStore.saves.isOriginCurrent(saveToken)
        : filePathRef.current === snapshot.sourcePath
    );
    const isDecisionCurrent = () => {
      if (!isSnapshotCurrent()) return false;
      if (!workspaceStore || !saveToken) return sourceTextRef.current === snapshot.sourceText;
      const current = workspaceStore.getState().documentsById[saveToken.documentId];
      return current?.source.revision === saveToken.sourceRevision && current.source.sourceText === snapshot.sourceText;
    };
    const updateOrigin = (action: DocumentRecordAction) => {
      if (workspaceStore) {
        workspaceStore.dispatch({ type: 'updateDocument', documentId: effectiveDocumentId, action });
        return;
      }
      switch (action.type) {
        case 'filePathChanged': setFilePath(typeof action.filePath === 'function' ? action.filePath(filePathRef.current) ?? '' : action.filePath ?? ''); break;
        case 'formatChanged': setFormat(action.format); break;
        case 'fileBaselineChanged': setFileMetadata(typeof action.fileBaseline === 'function' ? action.fileBaseline(fileMetadataRef.current) : action.fileBaseline); break;
        case 'savedBaselineChanged': setLastSavedCanonicalSourceText(typeof action.savedSourceText === 'function' ? action.savedSourceText('') : action.savedSourceText); break;
        case 'autosaveStatusChanged': setAutosaveStatus(typeof action.autosaveStatus === 'function' ? action.autosaveStatus('idle') : action.autosaveStatus); break;
        case 'lastAutosavedAtChanged': setLastAutosavedAt(typeof action.lastAutosavedAt === 'function' ? action.lastAutosavedAt(null) : action.lastAutosavedAt); break;
        case 'externalConflictChanged': setExternalConflict(typeof action.externalConflict === 'function' ? action.externalConflict(false) : action.externalConflict); break;
        default: break;
      }
    };
    const setOriginAutosaveStatus = (status: AutosaveStatus) => updateOrigin({ type: 'autosaveStatusChanged', autosaveStatus: status });
    const setOriginExternalConflict = (conflict: boolean) => updateOrigin({ type: 'externalConflictChanged', externalConflict: conflict });
    const recordSaveDiagnostic = (eventType: string, message: string, documentPath = snapshot.sourcePath) => {
      void host.recovery.appendDiagnosticsEvent({
        eventType,
        message,
        documentPath,
        sourceTextBytes: byteLength(snapshot.sourceText),
      });
    };
    const preserveRecovery = (fallbackPath = snapshot.sourcePath, metadata = snapshot.sourceMetadata) => {
      if (recoveryCoordinator) {
        recoveryCoordinator.checkpointSync(effectiveDocumentId, 'destructive-barrier');
      } else if (fallbackPath) {
        host.recovery.saveFileDraft(fallbackPath, snapshot.sourceText, Date.now(), metadata, snapshot.sourceFormat);
      }
    };
    const structuredSavePolicy = options.structuredSavePolicyOverride ?? structuredSavePolicyRef?.current ?? DEFAULT_STRUCTURED_SAVE_POLICY;
    if (structuredSavePolicy.autosaveBlocked && snapshot.autosave) {
      preserveRecovery();
      recordSaveDiagnostic(
        'autosave-structured-parser-invalid',
        structuredSavePolicy.reason ?? 'Autosave paused because the structured source has parser errors.',
      );
      if (isSnapshotCurrent()) setOriginAutosaveStatus('paused');
      return false;
    }
    if (structuredSavePolicy.manualSaveRequiresConfirmation && !snapshot.autosave) {
      const shouldSaveInvalidSource = await confirmText(formatStructuredSaveConfirmation(structuredSavePolicy));
      if (!shouldSaveInvalidSource) {
        preserveRecovery();
        if (isSnapshotCurrent()) setOriginAutosaveStatus('paused');
        return false;
      }
    }

    const runSave = async (): Promise<string | false> => {
      if (!isSnapshotCurrent()) return false;
      let targetPath: string | null = null;
      try {
        targetPath = snapshot.forceSaveAs || !snapshot.sourcePath
          ? await host.dialog.pickSavePath(suggestedDocumentSavePath(
              snapshot.sourceText,
              snapshot.sourcePath,
              snapshot.sourceFormat,
            ), snapshot.sourceFormat)
          : snapshot.sourcePath;
      } catch (error) {
        recordSaveDiagnostic('save-dialog-failed', saveErrorMessage(error, 'Could not open the Save As dialog.'), targetPath);
        if (isSnapshotCurrent()) {
          console.error(error);
          setOriginAutosaveStatus('error');
          pushToast(error instanceof Error ? error.message : 'Could not open the Save As dialog.', 'error');
        }
        return false;
      }
      if (!targetPath) return false;
      if (!isSnapshotCurrent()) return false;

      if (reserveSaveLocator && !(await reserveSaveLocator(targetPath, effectiveDocumentId))) {
        preserveRecovery(targetPath);
        setOriginAutosaveStatus('error');
        return false;
      }

      setOriginAutosaveStatus('saving');

      const latestSourceMetadata = () => (
        workspaceStore
          ? workspaceStore.getState().documentsById[effectiveDocumentId]?.fileBaseline ?? snapshot.sourceMetadata
          : targetPath === snapshot.sourcePath && filePathRef.current === snapshot.sourcePath
            ? fileMetadataRef.current
            : snapshot.sourceMetadata
      );
      let metadataForWrite = targetPath === snapshot.sourcePath ? latestSourceMetadata() : DEFAULT_METADATA;
      let existingMetadata: FileMetadata | null = null;
      let externalBackupCreated = false;
      let forceOverwriteConfirmed = false;
      let promisedBackupRequired = false;
      let backupWarning = false;
      let sourceTargetWasMissing = false;
      const tryCreateBackupSnapshot = async (label: string): Promise<boolean> => {
        try {
          await host.file.createBackupSnapshot(targetPath, label);
          return true;
        } catch (backupError) {
          backupWarning = true;
          console.warn(`Backup snapshot (${label}) could not be created.`, backupError);
          return false;
        }
      };
      const confirmForceOverwrite = async () => {
        if (!snapshot.forceOverwrite || forceOverwriteConfirmed) return true;
        const overwrite = await confirmText({
          title: 'Overwrite disk version?',
          message: 'This writes your current ScieMD document over the changed disk file. A backup of the disk version will be created first.',
          okLabel: 'Overwrite',
          cancelLabel: 'Cancel',
        });
        forceOverwriteConfirmed = overwrite;
        promisedBackupRequired = overwrite;
        return overwrite;
      };
      const failClosedForPromisedBackup = () => {
        preserveRecovery(targetPath);
        recordSaveDiagnostic(
          'save-required-backup-failed',
          'The overwrite was canceled because the promised backup could not be created.',
          targetPath,
        );
        if (isSnapshotCurrent()) {
          setOriginAutosaveStatus('error');
          pushToast('Overwrite canceled because ScieMD could not create the promised backup. Your recovery draft was preserved.', 'error');
        }
        return false as const;
      };
      const fidelityApprovalStillCurrent = () => (
        isDecisionCurrent()
        && (workspaceStore || targetPath !== snapshot.sourcePath || filePathRef.current === snapshot.sourcePath)
      );
      const preserveFidelityBlockedDraft = (eventType: string, message: string, status: AutosaveStatus = 'paused') => {
        preserveRecovery(targetPath);
        recordSaveDiagnostic(eventType, message, targetPath);
        if (isSnapshotCurrent()) setOriginAutosaveStatus(status);
      };
      const reviewFidelity = async (
        proposedMetadata: FileMetadata,
        nativeMessage?: string,
      ): Promise<FileMetadata | null> => {
        const assessment = assessSourceWriteFidelity(snapshot.sourceText, proposedMetadata);
        const reasons = assessment.lossReasons;
        if (reasons.length === 0 && !nativeMessage) return proposedMetadata;

        const message = fidelityReviewMessage(reasons, nativeMessage);
        if (snapshot.autosave) {
          preserveFidelityBlockedDraft('autosave-fidelity-review-required', message);
          if (isSnapshotCurrent()) {
            pushToast('Autosave paused because this file requires a fidelity decision. Your draft was preserved.', 'warning');
          }
          return null;
        }

        const approved = await confirmText({
          title: 'Review file fidelity before saving',
          message,
          okLabel: reasons.includes('encoding-unrepresentable') || nativeMessage ? 'Save as UTF-8' : 'Save with normalized endings',
          cancelLabel: 'Cancel',
        });
        if (!approved) {
          preserveFidelityBlockedDraft('save-fidelity-review-declined', message);
          return null;
        }
        if (!fidelityApprovalStillCurrent()) {
          preserveFidelityBlockedDraft(
            'save-fidelity-approval-stale',
            'The fidelity approval was discarded because the document, source revision, or locator changed.',
          );
          return null;
        }
        recordSaveDiagnostic('save-fidelity-review-approved', message, targetPath);
        return reasons.includes('encoding-unrepresentable') || nativeMessage
          ? metadataForUtf8Conversion(proposedMetadata)
          : proposedMetadata;
      };

      try {
        const preliminaryMetadata = await host.file.statFile(targetPath, { contentHash: false });
        if (isCloudPlaceholderMetadata(preliminaryMetadata)) {
          preserveRecovery(targetPath);
          if (isSnapshotCurrent()) {
            setOriginAutosaveStatus('error');
            pushToast(
              snapshot.autosave
                ? 'Autosave paused: this file is cloud-only. Download or pin it locally, then save again.'
                : 'This file is cloud-only. Download or pin it locally before saving so ScieMD does not block on cloud rehydration.',
              'warning',
            );
          }
          return false;
        }
        existingMetadata = await host.file.statFile(targetPath, { contentHash: true });
        if (targetPath !== snapshot.sourcePath) metadataForWrite = existingMetadata;
      } catch (error) {
        const hostError = normalizeDocumentHostError(error);
        if (targetPath !== snapshot.sourcePath && hostError.code === 'NOT_FOUND') {
          existingMetadata = null;
        } else if (targetPath === snapshot.sourcePath && snapshot.forceOverwrite && hostError.code === 'NOT_FOUND') {
          existingMetadata = null;
          metadataForWrite = latestSourceMetadata();
          sourceTargetWasMissing = true;
        } else {
          recordSaveDiagnostic(
            snapshot.autosave ? 'autosave-verify-failed' : 'save-verify-failed',
            saveErrorMessage(error, 'Could not verify the disk file before saving.'),
            targetPath,
          );
          preserveRecovery(targetPath);
          if (isSnapshotCurrent()) {
            setOriginAutosaveStatus('error');
            pushToast(
              snapshot.autosave
                ? 'Autosave paused: ScieMD could not verify the disk file before saving. Your in-memory draft was preserved.'
                : `Could not verify the disk file before saving: ${error instanceof Error ? error.message : String(error)}`,
              'error',
            );
          }
          return false;
        }
      }
      if (!isSnapshotCurrent()) return false;

      if (targetPath !== snapshot.sourcePath && existingMetadata && !snapshot.autosave) {
        const replace = await confirmText({
          title: `Replace existing ${documentKindLabel(snapshot.sourceFormat)} file?`,
          message: 'The selected Save As target already exists. Replace it with this ScieMD document? A backup of the target file will be created first.',
          okLabel: 'Replace',
          cancelLabel: 'Cancel',
        });
        if (!replace) {
          if (isSnapshotCurrent()) setOriginAutosaveStatus(snapshot.sourcePath ? 'pending' : 'idle');
          return false;
        }
        promisedBackupRequired = true;
      }

      if (targetPath === snapshot.sourcePath && existingMetadata && metadataChanged(snapshot.sourceMetadata, existingMetadata)) {
        recordSaveDiagnostic(
          snapshot.autosave ? 'autosave-external-change-detected' : 'save-external-change-detected',
          'The disk file changed before ScieMD could save the current document.',
          targetPath,
        );
        preserveRecovery(targetPath);
        if (isSnapshotCurrent()) {
          setOriginAutosaveStatus('conflict');
          setOriginExternalConflict(true);
        }
        if (snapshot.autosave) return false;
        if (snapshot.forceOverwrite) {
          if (!(await confirmForceOverwrite())) return false;
        } else {
          const overwrite = await confirmText({
            title: 'External change detected',
            message: 'This file changed outside ScieMD. Overwrite the disk version? A backup of the disk version will be created first.',
            okLabel: 'Overwrite',
            cancelLabel: 'Cancel',
          });
          if (!overwrite) return false;
          promisedBackupRequired = true;
        }
        externalBackupCreated = await tryCreateBackupSnapshot('external');
        if (!externalBackupCreated) return failClosedForPromisedBackup();
        metadataForWrite = existingMetadata;
      }

      try {
        if (targetPath === snapshot.sourcePath) {
          const preWriteMetadata = await host.file.statFile(targetPath, { contentHash: true }).catch(() => null);
          if (preWriteMetadata && metadataChanged(metadataForWrite, preWriteMetadata)) {
            existingMetadata = preWriteMetadata;
            metadataForWrite = preWriteMetadata;
            externalBackupCreated = false;
            if (!snapshot.forceOverwrite) {
              recordSaveDiagnostic(
                snapshot.autosave ? 'autosave-prewrite-conflict' : 'save-prewrite-conflict',
                'The disk file changed just before ScieMD could write the current document.',
                targetPath,
              );
              preserveRecovery(targetPath);
              if (isSnapshotCurrent()) {
                setOriginAutosaveStatus('conflict');
                setOriginExternalConflict(true);
                pushToast(
                  snapshot.autosave
                    ? 'Autosave paused: the file changed on disk just before saving. Your in-memory draft was preserved.'
                    : 'External change detected just before saving. Review disk changes or use Save Anyway.',
                  'warning',
                );
              }
              return false;
            }
            if (!(await confirmForceOverwrite())) return false;
          }
        }
        if (!isSnapshotCurrent()) return false;

        if (reserveSaveLocator && !(await reserveSaveLocator(targetPath, effectiveDocumentId))) {
          preserveRecovery(targetPath);
          setOriginAutosaveStatus('error');
          return false;
        }

        const reviewedMetadata = await reviewFidelity(metadataForWrite);
        if (!reviewedMetadata) return false;
        metadataForWrite = reviewedMetadata;
        if (!fidelityApprovalStillCurrent()) return false;

        if (existingMetadata) {
          if (!snapshot.autosave && !externalBackupCreated) {
            const manualBackupCreated = await tryCreateBackupSnapshot('manual');
            if (promisedBackupRequired && !manualBackupCreated) return failClosedForPromisedBackup();
          } else if (snapshot.autosave && shouldCreateAutosaveBackup(backupSchedule, Date.now(), BACKUP_INTERVAL_MS)) {
            if (await tryCreateBackupSnapshot('autosave')) {
              backupSchedulesRef.current.set(effectiveDocumentId, markAutosaveBackupCreated(backupSchedule, Date.now()));
            }
          }
        }

        const expectedMetadata = targetPath === snapshot.sourcePath
          ? (sourceTargetWasMissing ? null : existingMetadata ?? snapshot.sourceMetadata)
          : existingMetadata;
        let nextMetadata: FileMetadata;
        try {
          const write = () => host.file.writeTextFileAtomic(targetPath, snapshot.sourceText, metadataForWrite, expectedMetadata);
          nextMetadata = workspaceStore && saveToken
            ? await workspaceStore.saves.scheduleNativeWrite(saveToken, write)
            : await write();
        } catch (writeError) {
          const hostError = normalizeDocumentHostError(writeError);
          if (hostError.code !== 'LOSSY_WRITE_REQUIRED') throw writeError;
          const retryMetadata = await reviewFidelity(metadataForWrite, hostError.message);
          if (!retryMetadata || !fidelityApprovalStillCurrent()) return false;
          const retry = () => host.file.writeTextFileAtomic(targetPath, snapshot.sourceText, retryMetadata, expectedMetadata);
          nextMetadata = workspaceStore && saveToken
            ? await workspaceStore.saves.scheduleNativeWrite(saveToken, retry)
            : await retry();
        }
        if (workspaceStore) workspaceStore.externalChanges.recordSelfSave(effectiveDocumentId, nextMetadata);
        if (!isSnapshotCurrent()) return false;
        if (commitSavedLocator && !(await commitSavedLocator(targetPath, effectiveDocumentId))) {
          preserveRecovery(targetPath, nextMetadata);
          setOriginAutosaveStatus('error');
          return false;
        }
        const nextFormat = inferDocumentFormat(targetPath, snapshot.sourceFormat);
        const savedAt = Date.now();
        if (workspaceStore && saveToken) {
          const current = workspaceStore.getState().documentsById[effectiveDocumentId];
          const committedPath = current ? filePathForDocumentRecord(current) : null;
          if (!committedPath || canonicalComparisonKey(committedPath) !== canonicalComparisonKey(targetPath)) return false;
          const resultToken = workspaceStore.saves.refreshLocator(saveToken);
          const committed = resultToken && workspaceStore.saves.commitOrigin(resultToken, () => {
            workspaceStore.dispatch({ type: 'updateDocument', documentId: effectiveDocumentId, action: { type: 'formatChanged', format: nextFormat } });
            workspaceStore.dispatch({ type: 'updateDocument', documentId: effectiveDocumentId, action: { type: 'fileBaselineChanged', fileBaseline: nextMetadata } });
            workspaceStore.dispatch({ type: 'updateDocument', documentId: effectiveDocumentId, action: { type: 'savedBaselineChanged', savedSourceText: snapshot.sourceText } });
            workspaceStore.dispatch({ type: 'updateDocument', documentId: effectiveDocumentId, action: { type: 'autosaveStatusChanged', autosaveStatus: 'saved' } });
            workspaceStore.dispatch({ type: 'updateDocument', documentId: effectiveDocumentId, action: { type: 'lastAutosavedAtChanged', lastAutosavedAt: savedAt } });
            workspaceStore.dispatch({ type: 'updateDocument', documentId: effectiveDocumentId, action: { type: 'externalConflictChanged', externalConflict: false } });
          }).accepted;
          if (!committed) {
            preserveRecovery(targetPath, nextMetadata);
            return false;
          }
        } else {
          filePathRef.current = targetPath;
          fileMetadataRef.current = nextMetadata;
          formatRef.current = nextFormat;
          setFilePath(targetPath);
          setFormat(nextFormat);
          setFileMetadata(nextMetadata);
          setLastSavedCanonicalSourceText(snapshot.sourceText);
          setOriginAutosaveStatus('saved');
          setLastAutosavedAt(savedAt);
          setOriginExternalConflict(false);
        }
        setSettings(host.settings.rememberRecentFile(targetPath));
        if (recoveryCoordinator && snapshot.sourceRevision !== null) {
          await recoveryCoordinator.clearDocument(effectiveDocumentId, snapshot.sourceRevision);
        } else {
          host.recovery.clearFileDraft(targetPath);
          if (snapshot.sourcePath && snapshot.sourcePath !== targetPath) host.recovery.clearFileDraft(snapshot.sourcePath);
        }
        if (!snapshot.autosave) {
          pushToast(
            backupWarning ? 'Document saved, but backup snapshot could not be created.' : 'Saved',
            backupWarning ? 'warning' : 'success',
          );
        }
        return targetPath;
      } catch (error) {
        console.error(error);
        const hostError = normalizeDocumentHostError(error);
        if (hostError.code === 'FILE_CHANGED') {
          recordSaveDiagnostic(
            snapshot.autosave ? 'autosave-write-conflict' : 'save-write-conflict',
            saveErrorMessage(error, 'The file changed on disk before ScieMD could save.'),
            targetPath,
          );
          preserveRecovery();
          if (isSnapshotCurrent()) {
            setOriginAutosaveStatus('conflict');
            setOriginExternalConflict(true);
            pushToast(
              snapshot.autosave
                ? 'Autosave paused: the file changed on disk. Your in-memory draft was preserved for recovery.'
                : 'External change detected. Reload, Save As, or use Save Anyway after reviewing the disk version.',
              'warning',
            );
          }
          return false;
        }
        if (hostError.code === 'LOSSY_WRITE_REQUIRED') {
          recordSaveDiagnostic(
            snapshot.autosave ? 'autosave-lossy-write-blocked' : 'save-lossy-write-blocked',
            hostError.message,
            targetPath,
          );
          preserveRecovery();
          if (isSnapshotCurrent()) {
            setOriginAutosaveStatus('error');
            pushToast('Save blocked because the current encoding cannot represent all document characters. Your draft was preserved.', 'error');
          }
          return false;
        }
        recordSaveDiagnostic(
          snapshot.autosave ? 'autosave-failed' : 'save-failed',
          saveErrorMessage(error, 'Save failed.'),
          targetPath,
        );
        preserveRecovery();
        if (isSnapshotCurrent()) {
          setOriginAutosaveStatus('error');
          pushToast(
            snapshot.autosave
              ? `Autosave failed: ${error instanceof Error ? error.message : 'Save failed.'}`
              : error instanceof Error ? error.message : 'Save failed.',
            'error',
          );
        }
        return false;
      }
    };

    if (!saveToken && workspaceStore) return false;
    if (!workspaceStore) updateSaveQueueDepth(1);
    const queuedSave: Promise<string | false> = workspaceStore && saveToken
      ? workspaceStore.saves.enqueue(saveToken, runSave)
      : saveQueueRef.current.then(runSave, runSave);
    const handledSave: Promise<string | false> = queuedSave.catch((error): false => {
      console.error('Save queue chain error:', error);
      recordSaveDiagnostic('save-queue-failed', saveErrorMessage(error, 'Save queue failed before the document could be written.'));
      if (isSnapshotCurrent()) {
        setOriginAutosaveStatus('error');
        pushToast(error instanceof Error ? error.message : 'Save queue failed before the document could be written.', 'error');
      }
      return false;
    });
    if (!workspaceStore) saveQueueRef.current = handledSave.finally(() => updateSaveQueueDepth(-1));
    return handledSave;
  }, [commitCanonicalSourceTextEdit, commitSavedLocator, confirmText, confirmVisualRoundTripWrite, effectiveDocumentId, host, pushToast, recoveryCoordinator, reserveSaveLocator, setAutosaveStatus, setExternalConflict, setFileMetadata, setFilePath, setFormat, setLastAutosavedAt, setLastSavedCanonicalSourceText, setSettings, structuredSavePolicyRef, updateSaveQueueDepth, workspaceStore]);

  const actorStructuredSavePolicy = structuredSavePolicyRef?.current;
  useEffect(() => {
    if (!workspaceStore) return;
    workspaceStore.saves.registerActor(effectiveDocumentId, {
      save: (options) => saveCurrent({ ...options, structuredSavePolicyOverride: actorStructuredSavePolicy }),
    });
  }, [actorStructuredSavePolicy, effectiveDocumentId, saveCurrent, workspaceStore]);

  const ensureDocumentPathForAssets = useCallback(async (originatingDocumentId = effectiveDocumentId) => {
    if (originatingDocumentId !== effectiveDocumentId) return null;
    const originRecord = workspaceStore?.getState().documentsById[originatingDocumentId];
    const originPath = originRecord ? filePathForDocumentRecord(originRecord) : filePath;
    if (originPath) return originPath;
    const savedPath = await saveCurrent({ forceSaveAs: true });
    return typeof savedPath === 'string' ? savedPath : null;
  }, [effectiveDocumentId, filePath, saveCurrent, workspaceStore]);

  return { saveCurrent, ensureDocumentPathForAssets, resetBackupSession, saveQueueDepth };
}

function isCloudPlaceholderMetadata(metadata: FileMetadata | null): boolean {
  return metadata?.cloudState === 'cloud-placeholder' || metadata?.cloudState === 'cloud-recall-on-open';
}

export function suggestedMarkdownSavePath(markdown: string, sourcePath: string | null): string {
  if (sourcePath) return sourcePath;
  const title = documentTitleForFilename(markdown);
  if (!title) return untitledNameForFormat('markdown');
  return `${slugifyFilename(title)}.md`;
}

export function suggestedDocumentSavePath(
  sourceText: string,
  sourcePath: string | null,
  format: DocumentFormat,
): string {
  if (sourcePath) return sourcePath;
  if (format === 'markdown') return suggestedMarkdownSavePath(sourceText, sourcePath);
  return untitledNameForFormat(format);
}

function documentKindLabel(format: DocumentFormat): string {
  switch (format) {
    case 'json':
      return 'JSON';
    case 'jsonl':
      return 'JSON Lines';
    case 'yaml':
      return 'YAML';
    case 'toml':
      return 'TOML';
    case 'xml':
      return 'XML';
    case 'csv':
      return 'CSV';
    case 'tsv':
      return 'TSV';
    case 'plainText':
      return 'text';
    case 'markdown':
      return 'Markdown';
  }
}

function documentTitleForFilename(markdown: string): string | null {
  const frontmatter = parseFrontmatter(markdown);
  const title = typeof frontmatter.data.title === 'string' ? frontmatter.data.title.trim() : '';
  if (title) return title;
  const rawTitle = frontmatter.raw.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() ?? '';
  if (rawTitle) return rawTitle.replace(/^["']|["']$/g, '').trim();
  const heading = markdown.match(/^#{1,6}\s+(.+?)\s*#*\s*$/m)?.[1]?.trim() ?? '';
  return heading || null;
}

function slugifyFilename(value: string): string {
  const cleaned = value
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
  const slug = cleaned
    .replace(/[^\p{L}\p{N}._ -]+/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[ .-]+|[ .-]+$/g, '');
  return slug || 'Untitled';
}

function saveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

function fidelityReviewMessage(
  reasons: readonly SourceFidelityLossReason[],
  nativeMessage?: string,
): string {
  const details: string[] = [];
  if (reasons.includes('mixed-line-endings-without-map')) {
    details.push('The original file uses mixed line endings, and ScieMD has no per-line reconstruction map. Saving will use the detected dominant line ending throughout.');
  }
  if (reasons.includes('decode-replacement')) {
    details.push('The original byte stream required replacement characters while decoding; saving will make that decoded text authoritative.');
  }
  if (reasons.includes('encoding-unrepresentable') || nativeMessage) {
    details.push('The current encoding cannot represent all document characters. Approval converts the saved file to UTF-8 without a BOM.');
  }
  if (nativeMessage) details.push(`Native file check: ${nativeMessage}`);
  return details.join(' ');
}

function byteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  return unescape(encodeURIComponent(value)).length;
}
