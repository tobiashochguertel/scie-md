import { useCallback, useEffect, useRef } from 'react';
import type { AutosaveStatus } from '../documentState';
import { AUTOSAVE_DELAY_MS, AUTOSAVE_MAX_WAIT_MS, shouldScheduleAutosave } from '../../services/autosaveService';
import type { DocumentId, SourceRevision } from '../documentIdentity';
import type { WorkspaceSaveCoordinator } from '../workspace/workspaceSaveCoordinator';
import type { StructuredSavePolicy } from '../structuredSavePolicy';
import type { SaveCurrentOptions } from './useSaveOperations';

interface UseAutosaveTimerOptions {
  documentId?: DocumentId;
  sourceRevision?: SourceRevision;
  saveCoordinator?: WorkspaceSaveCoordinator;
  filePath: string | null;
  sourceText: string;
  dirty: boolean;
  externalConflict: boolean;
  autosaveBlocked?: boolean;
  structuredSavePolicy?: StructuredSavePolicy;
  saveCurrent: (options?: SaveCurrentOptions) => Promise<string | false>;
  setAutosaveStatus: (status: AutosaveStatus) => void;
}

export function useAutosaveTimer({
  documentId,
  sourceRevision,
  saveCoordinator,
  filePath,
  sourceText,
  dirty,
  externalConflict,
  autosaveBlocked = false,
  structuredSavePolicy,
  saveCurrent,
  setAutosaveStatus,
}: UseAutosaveTimerOptions) {
  const timerRef = useRef<number | null>(null);
  const savingRef = useRef<Promise<string | false> | null>(null);
  const rerunAfterSaveRef = useRef(false);
  const latestStateRef = useRef({ filePath, dirty, externalConflict, autosaveBlocked });
  const firstPendingAtRef = useRef<number | null>(null);

  latestStateRef.current = { filePath, dirty, externalConflict, autosaveBlocked };

  const cancelAutosave = useCallback(() => {
    if (saveCoordinator && documentId) {
      saveCoordinator.cancelAutosave(documentId);
      return;
    }
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [documentId, saveCoordinator]);

  const resetPendingWindow = useCallback(() => {
    firstPendingAtRef.current = null;
  }, []);

  const runAutosave = useCallback(async () => {
    if (savingRef.current) {
      rerunAfterSaveRef.current = true;
      return savingRef.current;
    }

    const saveTask = (async () => {
      let result: string | false = false;
      do {
        rerunAfterSaveRef.current = false;
        result = await saveCurrent({ autosave: true });
      } while (
        rerunAfterSaveRef.current
        && !latestStateRef.current.autosaveBlocked
        && shouldScheduleAutosave({
          filePath: latestStateRef.current.filePath,
          dirty: latestStateRef.current.dirty,
          conflictDetected: latestStateRef.current.externalConflict,
        })
      );
      return result;
    })();

    savingRef.current = saveTask;
    try {
      return await saveTask;
    } finally {
      if (savingRef.current === saveTask) {
        savingRef.current = null;
        resetPendingWindow();
      }
    }
  }, [resetPendingWindow, saveCurrent]);

  const flushAutosave = useCallback(async () => {
    if (saveCoordinator && documentId) return saveCoordinator.flushAutosave(documentId);
    cancelAutosave();
    if (filePath && dirty && !autosaveBlocked) {
      return runAutosave();
    }
    if (filePath && dirty && autosaveBlocked) return false;
    resetPendingWindow();
    return true;
  }, [autosaveBlocked, cancelAutosave, dirty, documentId, filePath, resetPendingWindow, runAutosave, saveCoordinator]);

  const scheduleAutosave = useCallback(() => {
    if (saveCoordinator && documentId && sourceRevision !== undefined) {
      const eligible = shouldScheduleAutosave({ filePath, dirty, conflictDetected: externalConflict }) && !autosaveBlocked;
      saveCoordinator.scheduleAutosave({
        documentId,
        sourceRevision,
        eligible,
        blocked: dirty && (autosaveBlocked || externalConflict || !filePath),
        delayMs: AUTOSAVE_DELAY_MS,
        maxWaitMs: AUTOSAVE_MAX_WAIT_MS,
        save: () => saveCurrent(structuredSavePolicy
          ? { autosave: true, structuredSavePolicyOverride: structuredSavePolicy }
          : { autosave: true }),
        setStatus: setAutosaveStatus,
      });
      return;
    }
    cancelAutosave();

    if (!filePath) {
      resetPendingWindow();
      setAutosaveStatus('idle');
      return;
    }

    if (!shouldScheduleAutosave({ filePath, dirty, conflictDetected: externalConflict })) {
      resetPendingWindow();
      return;
    }

    setAutosaveStatus('pending');
    if (autosaveBlocked) {
      setAutosaveStatus('paused');
      return;
    }

    const now = Date.now();
    firstPendingAtRef.current ??= now;
    const elapsed = now - firstPendingAtRef.current;
    const maxWaitRemaining = Math.max(0, AUTOSAVE_MAX_WAIT_MS - elapsed);
    const delay = Math.min(AUTOSAVE_DELAY_MS, maxWaitRemaining);

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void runAutosave().catch((error) => {
        console.warn('Autosave task failed before it could report status.', error);
        resetPendingWindow();
        setAutosaveStatus('error');
      });
    }, delay);
  }, [
    autosaveBlocked,
    cancelAutosave,
    dirty,
    documentId,
    externalConflict,
    filePath,
    resetPendingWindow,
    runAutosave,
    saveCoordinator,
    saveCurrent,
    setAutosaveStatus,
    sourceRevision,
    structuredSavePolicy,
  ]);

  const resumeAutosave = useCallback(() => {
    scheduleAutosave();
  }, [scheduleAutosave]);

  useEffect(() => {
    scheduleAutosave();

    return saveCoordinator ? undefined : cancelAutosave;
  }, [cancelAutosave, saveCoordinator, scheduleAutosave, sourceText]);

  return { cancelAutosave, flushAutosave, resumeAutosave };
}
