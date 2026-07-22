import type { Dispatch, SetStateAction } from 'react';
import type { EditorMode, FileMetadata, ReadTextFileResponse } from '../documentState';
import { readSourceEnvelope } from '../documentState';
import type { DocumentFormat } from '@sciemd/core';
import type { DocumentOpenPhase } from '../documentOpenStatus';
import type { DocumentHost } from '../host/documentHost';
import { normalizeDocumentHostError } from '../host/documentHost';
import type { ConfirmState } from '../hooks/useDialogs';
import type { PersistedSettings } from '../../services/settingsService';
import {
  displayNameForPath,
  documentOpenStatusClearDelay,
  shouldShowImmediatePreparingOverlay,
} from './controller';
import {
  loadFileDraftWithTimeout,
  recordDocumentOpenDiagnostic,
  withTimeout,
} from './openEffects';
import { resolveFileLocator } from '../documentIdentity';
import type { FileDocumentLocator } from '../documentIdentity';
import type { WorkspaceIngressOrigin } from '../workspace/workspaceIngressCoordinator';
import {
  documentPerformance,
  sourceDisplayClass,
  utf8ByteLength,
  type OpenOperationId,
} from '../performance/documentPerformance';
import type { DocumentId } from '../documentIdentity';

export interface OpenDocumentOptions {
  preferredMode?: EditorMode;
  externalLaunch?: boolean;
  draftRestore?: 'prompt' | 'auto' | 'skip';
  skipDirtySettlement?: boolean;
  ingressOrigin?: WorkspaceIngressOrigin;
}

export interface DocumentOpenTimeouts {
  fileReadMs: number;
  draftRestoreMs: number;
}

export const DEFAULT_DOCUMENT_OPEN_TIMEOUTS: DocumentOpenTimeouts = {
  fileReadMs: 20_000,
  draftRestoreMs: 1_500,
};

export type CommitOpenedDocument = (
  path: string | null,
  sourceText: string,
  metadata: FileMetadata,
  preferredMode?: EditorMode,
  savedSourceText?: string,
  format?: DocumentFormat,
) => boolean | void;

export interface OpenDocumentForSessionInput {
  explicitPath?: string;
  options?: OpenDocumentOptions;
  host: DocumentHost;
  confirmText: (state: ConfirmState) => Promise<boolean>;
  pushToast: (text: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
  setSettings: Dispatch<SetStateAction<PersistedSettings>>;
  isLatestOpenRequest: () => boolean;
  settleDirtyDocumentBeforeReplace: () => Promise<boolean>;
  preserveDirtyDraftBeforeExternalOpen: () => void;
  showDocumentOpenStatus: (path: string, phase: DocumentOpenPhase, options?: { immediate?: boolean }) => number;
  clearDocumentOpenStatus: (token: number, delayMs?: number) => void;
  commitOpenedDocument: CommitOpenedDocument;
  getCommittedDocumentId?: () => DocumentId | null;
  readSignal?: AbortSignal;
  /** Returns true when the workspace focused an already-open owner. */
  onResolvedLocator?: (locator: FileDocumentLocator) => boolean | DocumentId | Promise<boolean | DocumentId>;
  timeouts?: DocumentOpenTimeouts;
}

export async function openDocumentForSession({
  explicitPath,
  options = {},
  host,
  confirmText,
  pushToast,
  setSettings,
  isLatestOpenRequest,
  settleDirtyDocumentBeforeReplace,
  preserveDirtyDraftBeforeExternalOpen,
  showDocumentOpenStatus,
  clearDocumentOpenStatus,
  commitOpenedDocument,
  getCommittedDocumentId,
  readSignal,
  onResolvedLocator,
  timeouts = DEFAULT_DOCUMENT_OPEN_TIMEOUTS,
}: OpenDocumentForSessionInput): Promise<boolean> {
  const operationId = documentPerformance.beginOpenSafe(sourceDisplayClass(explicitPath));
  let selectedPath = explicitPath ?? null;
  let openStatusToken: number | null = null;
  let committedDocument = false;
  let failed = false;
  const nativeReadController = new AbortController();
  const cancelFromCaller = () => nativeReadController.abort();
  readSignal?.addEventListener('abort', cancelFromCaller, { once: true });

  const commitWithTrace: CommitOpenedDocument = (...args) => {
    const started = rendererNow();
    const result = commitOpenedDocument(...args);
    documentPerformance.trace({
      name: 'aggregate-commit',
      operationId,
      durationMs: rendererNow() - started,
      byteCount: utf8ByteLength(args[1]),
    });
    if (result !== false) {
      const committedId = getCommittedDocumentId?.() ?? null;
      if (committedId) documentPerformance.associate(operationId, committedId);
    }
    return result;
  };

  const showOpeningPhase = (phase: DocumentOpenPhase, phaseOptions: { immediate?: boolean } = {}) => {
    if (!selectedPath || !isLatestOpenRequest()) return;
    openStatusToken = showDocumentOpenStatus(selectedPath, phase, phaseOptions);
  };
  const clearOpeningStatus = (delayMs = 0) => {
    if (openStatusToken === null) return;
    clearDocumentOpenStatus(openStatusToken, delayMs);
    openStatusToken = null;
  };
  const settleReplacement = async () => {
    if (options.skipDirtySettlement) return true;
    if (options.externalLaunch) {
      preserveDirtyDraftBeforeExternalOpen();
      return settleDirtyDocumentBeforeReplace();
    }
    return settleDirtyDocumentBeforeReplace();
  };

  try {
    if (!explicitPath && !(await settleReplacement())) return false;
    if (!isLatestOpenRequest()) return false;

    selectedPath = explicitPath ?? (await host.dialog.pickDocumentFile());
    if (!selectedPath) return false;
    if (!isLatestOpenRequest()) return false;

    const locatorStarted = rendererNow();
    const resolvedLocator = await resolveFileLocator(host.identity, selectedPath);
    documentPerformance.trace({
      name: 'locator-resolved',
      operationId,
      durationMs: rendererNow() - locatorStarted,
      displayClass: sourceDisplayClass(selectedPath),
    });
    const resolvedExisting = await onResolvedLocator?.(resolvedLocator);
    if (resolvedExisting) {
      if (typeof resolvedExisting === 'string') documentPerformance.associate(operationId, resolvedExisting);
      committedDocument = true;
      recordDocumentOpenDiagnostic(host.recovery, 'document-open-duplicate-skipped', 'Focused the existing workspace document.', selectedPath);
      return true;
    }

    if (explicitPath && !(await settleReplacement())) return false;
    if (!isLatestOpenRequest()) return false;

    recordDocumentOpenDiagnostic(host.recovery, 'document-open-selected', 'Document open path selected.', selectedPath);
    showOpeningPhase('reading');

    const recoveryStarted = rendererNow();
    const recoveryPromise = options.draftRestore === 'skip'
      ? Promise.resolve(null)
      : loadFileDraftWithTimeout(host.recovery, selectedPath, timeouts.draftRestoreMs);
    const readStarted = rendererNow();
    const response = await withTimeout(
      host.file.readTextFileForEdit(selectedPath, {
        operationId,
        signal: nativeReadController.signal,
        onEarlyMetadata: (metadata) => {
          if (shouldShowImmediatePreparingOverlay(metadata.lastKnownSizeBytes)) {
            showOpeningPhase('reading', { immediate: true });
          }
        },
        onNativeCancellation: (result) => {
          documentPerformance.trace({
            name: 'native-read',
            operationId,
            phase: result.stopped ? 'cancel-stop' : 'cancel-bound-exceeded',
            durationMs: result.stopMs,
          });
        },
      }),
      timeouts.fileReadMs,
      `Reading ${displayNameForPath(selectedPath)} took too long.`,
      () => nativeReadController.abort(),
    );
    const diskSourceText = readSourceEnvelope(response).sourceText;
    const invokeWallMs = rendererNow() - readStarted;
    const byteCount = response.nativeTimings?.byteCount ?? utf8ByteLength(diskSourceText);
    documentPerformance.trace({
      name: 'ipc-read',
      operationId,
      durationMs: invokeWallMs,
      byteCount,
      phase: response.nativeTimings
        ? `invoke-wall-residual:${Math.max(0, invokeWallMs - response.nativeTimings.totalMs).toFixed(3)}ms`
        : 'host-total',
    });
    documentPerformance.trace({
      name: 'byte-acquisition',
      operationId,
      acquisitionReason: 'open',
      byteCount,
    });
    recordNativeTimings(operationId, response.nativeTimings);

    recordDocumentOpenDiagnostic(
      host.recovery,
      'document-open-read-complete',
      'Document file read completed.',
      selectedPath,
      diskSourceText,
    );
    if (!isLatestOpenRequest()) return false;

    const draft = await recoveryPromise;
    documentPerformance.trace({
      name: 'recovery-draft',
      operationId,
      durationMs: rendererNow() - recoveryStarted,
      phase: options.draftRestore === 'skip' ? 'not-applicable' : draft ? 'found' : 'missing',
    });
    if (draft) documentPerformance.trace({
      name: 'byte-acquisition',
      operationId,
      acquisitionReason: 'recovery',
      byteCount: utf8ByteLength(draft.sourceText ?? draft.markdown),
      phase: 'recovery-draft-read',
    });
    if (!isLatestOpenRequest()) return false;

    if (draft && draft.markdown !== diskSourceText && host.recovery.shouldOfferFileDraftRestore(draft, response.metadata)) {
      if (options.draftRestore === 'auto') {
        showOpeningPhase('restoring', { immediate: true });
        if (!isLatestOpenRequest()) return false;
        if (commitWithTrace(selectedPath, draft.markdown, response.metadata, options.preferredMode, diskSourceText, draft.format) === false) return false;
        committedDocument = true;
        pushToast('Restored unsaved file draft.', 'warning');
        return true;
      }

      clearOpeningStatus();
      const restoreDraft = await confirmText({
        title: 'Restore unsaved file draft?',
        message: 'ScieMD found unsaved edits for this file from a previous session. Restore that draft instead of the disk version?',
        okLabel: 'Restore draft',
        cancelLabel: 'Open disk version',
      });
      if (!isLatestOpenRequest()) return false;

      if (restoreDraft) {
        showOpeningPhase('restoring', { immediate: true });
        if (!isLatestOpenRequest()) return false;
        if (commitWithTrace(selectedPath, draft.markdown, response.metadata, options.preferredMode ?? 'visual', diskSourceText, draft.format) === false) return false;
        committedDocument = true;
        pushToast('Restored unsaved file draft.', 'warning');
        return true;
      }
      host.recovery.clearFileDraft(selectedPath);
    } else if (draft && draft.markdown !== diskSourceText) {
      pushToast('An older recovery draft exists, but the disk file changed after it. Opened the disk version and kept the draft.', 'warning');
    }

    const immediatePreparingOverlay = shouldShowImmediatePreparingOverlay(response.metadata.lastKnownSizeBytes);
    showOpeningPhase('preparing', { immediate: immediatePreparingOverlay });
    if (immediatePreparingOverlay) await waitForDocumentOpenPaint();
    if (!isLatestOpenRequest()) return false;

    if (commitWithTrace(selectedPath, diskSourceText, response.metadata, options.preferredMode) === false) return false;
    committedDocument = true;
    recordDocumentOpenDiagnostic(
      host.recovery,
      'document-open-committed',
      'Document committed.',
      selectedPath,
      diskSourceText,
    );
    return true;
  } catch (error) {
    failed = true;
    const hostError = normalizeDocumentHostError(error);
    documentPerformance.trace({
      name: 'open-failed',
      operationId,
      phase: `${hostError.code}${hostError.phase ? `:${hostError.phase}` : ''}`,
    });
    if (!isLatestOpenRequest()) return false;
    console.error(error);
    const message = hostError.message;
    if (selectedPath && hostError.code !== 'PERMISSION_DENIED') {
      setSettings(host.settings.forgetRecentFile(selectedPath));
    }
    recordDocumentOpenDiagnostic(
      host.recovery,
      'document-open-failed',
      message || 'Document open failed.',
      selectedPath,
    );
    pushToast(hostError.code === 'PERMISSION_DENIED' ? 'Use Open or Files to grant access to this document again.' : message || 'Open failed.', 'error');
    return false;
  } finally {
    nativeReadController.abort();
    readSignal?.removeEventListener('abort', cancelFromCaller);
    if (!committedDocument && !failed) documentPerformance.trace({ name: 'open-cancelled', operationId });
    clearOpeningStatus(documentOpenStatusClearDelay(committedDocument));
  }
}

function recordNativeTimings(
  operationId: OpenOperationId,
  timings: ReadTextFileResponse['nativeTimings'],
): void {
  if (!timings) {
    documentPerformance.trace({ name: 'native-read', operationId, phase: 'not-applicable' });
    return;
  }
  const phases = [
    ['permission-cloud-grant', timings.permissionCloudGrantMs],
    ['stat', timings.statMs],
    ['read', timings.readMs],
    ['decode-fidelity', timings.decodeFidelityMs],
    ['hash', timings.hashMs],
    ['image-grant-discovery', timings.imageGrantDiscoveryMs],
    ['total', timings.totalMs],
  ] as const;
  for (const [phase, durationMs] of phases) {
    documentPerformance.trace({ name: 'native-read', operationId, phase, durationMs });
  }
}

function rendererNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

async function waitForDocumentOpenPaint(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
