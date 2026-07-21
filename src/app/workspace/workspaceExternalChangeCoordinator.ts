import type { DocumentHost } from '../host/documentHost';
import { normalizeDocumentHostError } from '../host/documentHostError';
import { fallbackFileLocator, sameDocumentLocator, type DocumentId, type DocumentLocator } from '../documentIdentity';
import type { DocumentAccessState, DocumentExternalState, DocumentRecord } from '../documentRecord';
import { metadataChanged, readSourceEnvelope, type FileMetadata, type ReadTextFileResponse } from '../documentState';
import { fileWatchRetryDelayMs, type FileWatchChangeEvent } from '../../services/fileWatchService';
import type { WorkspaceCommand, WorkspaceState } from './workspaceState';
import type { WorkspaceRecoveryCoordinator } from './workspaceRecoveryCoordinator';
import type { WorkspaceSaveCoordinator } from './workspaceSaveCoordinator';

export type WorkspaceExternalNotificationKind = 'changed' | 'missing' | 'renamed' | 'permissionLost' | 'readOnly' | 'cloudUnavailable' | 'fallback';

export interface WorkspaceExternalNotification {
  documentId: DocumentId;
  kind: WorkspaceExternalNotificationKind;
  path: string;
  observedAt: number;
  acknowledged: boolean;
  detail: string | null;
}

export interface WorkspaceExternalChangeEvent {
  documentId: DocumentId;
  type: 'synced' | 'conflict' | 'access' | 'fallback';
  path: string;
  sourceText?: string;
  metadata?: FileMetadata;
  detail?: string;
}

export interface WorkspaceExternalChangeCoordinator {
  configure(host: Pick<DocumentHost, 'file' | 'watcher'>, readCurrentSource?: (documentId: DocumentId) => string | null): void;
  observe(state: WorkspaceState): void;
  checkDocument(documentId: DocumentId): Promise<void>;
  checkAll(): Promise<void>;
  compareDocument(documentId: DocumentId): Promise<ReadTextFileResponse | null>;
  reloadFromDisk(documentId: DocumentId): Promise<boolean>;
  keepLocal(documentId: DocumentId): void;
  overwrite(documentId: DocumentId): Promise<string | false>;
  recordSelfSave(documentId: DocumentId, metadata: FileMetadata): void;
  notifications(): readonly WorkspaceExternalNotification[];
  subscribe(listener: (event: WorkspaceExternalChangeEvent) => void): () => void;
  metrics(): { listenerCount: number; pollerCount: number; registeredLocatorCount: number; checkCount: number; coalescedEventCount: number };
  destroy(): void;
}

const WATCH_SCOPE = 'workspace:open-documents';
const POLL_INTERVAL_MS = 30_000;
const EVENT_COALESCE_MS = 50;
const SELF_SAVE_ECHO_WINDOW_MS = 5_000;

export function createWorkspaceExternalChangeCoordinator(
  getState: () => WorkspaceState,
  dispatch: (command: WorkspaceCommand) => WorkspaceState,
  saves: WorkspaceSaveCoordinator,
  recovery: WorkspaceRecoveryCoordinator,
  now: () => number = Date.now,
): WorkspaceExternalChangeCoordinator {
  let host: Pick<DocumentHost, 'file' | 'watcher'> | null = null;
  let readCurrentSource: ((documentId: DocumentId) => string | null) | null = null;
  let disposed = false;
  let unlisten: (() => void) | null = null;
  let listenerPending: Promise<void> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let failureCount = 0;
  let desiredWatchKey = '';
  let registeredLocatorCount = 0;
  let checkCount = 0;
  let coalescedEventCount = 0;
  const queuedChecks = new Set<DocumentId>();
  const inFlight = new Map<DocumentId, Promise<void>>();
  const rerun = new Set<DocumentId>();
  const listeners = new Set<(event: WorkspaceExternalChangeEvent) => void>();
  const notificationByDocument = new Map<DocumentId, WorkspaceExternalNotification>();
  const selfSaveEchoes = new Map<DocumentId, { metadata: FileMetadata; expiresAt: number }>();

  const emit = (event: WorkspaceExternalChangeEvent) => {
    for (const listener of listeners) listener(event);
  };
  const savedDocuments = () => Object.values(getState().documentsById).filter((record) => record.locator.kind === 'file');
  const paths = () => savedDocuments().map((record) => record.locator.kind === 'file' ? record.locator.displayPath : '').filter(Boolean);
  const setNotification = (record: DocumentRecord, kind: WorkspaceExternalNotificationKind, detail: string | null) => {
    if (record.locator.kind !== 'file') return;
    notificationByDocument.set(record.id, {
      documentId: record.id,
      kind,
      path: record.locator.displayPath,
      observedAt: now(),
      acknowledged: false,
      detail,
    });
  };
  const clearNotification = (documentId: DocumentId) => notificationByDocument.delete(documentId);
  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };
  const startPolling = (detail: string) => {
    if (!pollTimer) pollTimer = setInterval(() => void checkAll(), POLL_INTERVAL_MS);
    for (const record of savedDocuments()) {
      if (!notificationByDocument.has(record.id)) setNotification(record, 'fallback', detail);
      if (record.locator.kind === 'file') emit({ documentId: record.id, type: 'fallback', path: record.locator.displayPath, detail });
    }
  };
  const scheduleRetry = () => {
    if (retryTimer || disposed || !host) return;
    failureCount += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void registerDesiredPaths();
    }, fileWatchRetryDelayMs(failureCount));
  };
  const attachListener = async () => {
    if (!host || unlisten || listenerPending || disposed) return;
    listenerPending = (async () => {
      try {
        const dispose = await host!.watcher.listenFileWatchChanges(routeNativeEvent);
        if (disposed) dispose();
        else unlisten = dispose;
      } catch (error) {
        startPolling(errorMessage(error));
        scheduleRetry();
      }
    })().finally(() => { listenerPending = null; });
    await listenerPending;
  };
  const registerDesiredPaths = async () => {
    if (!host || disposed) return;
    await attachListener();
    const currentPaths = paths();
    registeredLocatorCount = currentPaths.length;
    try {
      const active = currentPaths.length > 0
        ? await host.watcher.updateWatchedFiles(WATCH_SCOPE, currentPaths)
        : await host.watcher.clearWatchedFiles(WATCH_SCOPE);
      if (disposed) return;
      if (active || currentPaths.length === 0) {
        failureCount = 0;
        stopPolling();
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        for (const [documentId, notification] of notificationByDocument) {
          if (notification.kind === 'fallback') notificationByDocument.delete(documentId);
        }
      } else {
        startPolling('Native file watching is unavailable; workspace polling is active.');
        scheduleRetry();
      }
    } catch (error) {
      startPolling(errorMessage(error));
      scheduleRetry();
    }
  };
  const routeNativeEvent = (event: FileWatchChangeEvent) => {
    const records = savedDocuments();
    const targets = event.paths.length === 0
      ? records
      : records.filter((record) => event.paths.some((path) => sameDocumentLocator(record.locator, fallbackFileLocator(path))));
    for (const record of targets) queuedChecks.add(record.id);
    if (!coalesceTimer && queuedChecks.size > 0) {
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        const ids = Array.from(queuedChecks);
        queuedChecks.clear();
        coalescedEventCount += 1;
        ids.forEach((id) => void checkDocument(id));
      }, EVENT_COALESCE_MS);
    }
  };
  const transition = (
    record: DocumentRecord,
    external: DocumentExternalState,
    access: DocumentAccessState,
    observedExternal: FileMetadata | null,
    notification: WorkspaceExternalNotificationKind | null,
    detail: string | null = null,
  ) => {
    dispatch({
      type: 'updateDocument',
      documentId: record.id,
      action: {
        type: 'externalObservationChanged',
        external,
        access,
        observedExternal,
        ...(external === 'changed' ? { autosaveStatus: 'conflict' as const } : {}),
      },
    });
    if (notification) setNotification(record, notification, detail);
    else clearNotification(record.id);
  };
  const classifyFailure = (record: DocumentRecord, error: unknown) => {
    const normalized = normalizeDocumentHostError(error);
    if (record.locator.kind !== 'file') return;
    if (normalized.code === 'NOT_FOUND') {
      const renamed = Boolean(record.locator.stableFileId);
      transition(record, renamed ? 'renamed' : 'missing', record.lifecycle.access, null, renamed ? 'renamed' : 'missing', normalized.message);
      emit({ documentId: record.id, type: 'access', path: record.locator.displayPath, detail: normalized.message });
      return;
    }
    if (normalized.code === 'PERMISSION_DENIED') {
      transition(record, 'unknown', 'permissionLost', null, 'permissionLost', normalized.message);
    } else if (normalized.code === 'CLOUD_UNAVAILABLE') {
      transition(record, 'unknown', 'cloudUnavailable', null, 'cloudUnavailable', normalized.message);
    } else {
      transition(record, 'unknown', record.lifecycle.access, null, 'fallback', normalized.message);
    }
    emit({ documentId: record.id, type: 'access', path: record.locator.displayPath, detail: normalized.message });
  };
  const runCheck = async (documentId: DocumentId) => {
    const configured = host;
    const record = getState().documentsById[documentId];
    if (!configured || !record || record.locator.kind !== 'file' || record.fileBaseline.lastKnownMtimeMs === 0) return;
    checkCount += 1;
    try {
      let metadata = await configured.file.statFile(record.locator.displayPath, { contentHash: false });
      const current = getState().documentsById[documentId];
      if (!current || !sameDocumentLocator(current.locator, record.locator)) return;
      if (metadata.cloudState === 'cloud-placeholder' || metadata.cloudState === 'cloud-recall-on-open') {
        transition(current, 'unknown', 'cloudUnavailable', metadata, 'cloudUnavailable', 'The file is a cloud placeholder and is not currently available.');
        emit({ documentId, type: 'access', path: record.locator.displayPath, metadata, detail: 'cloud-unavailable' });
        return;
      }
      const access: DocumentAccessState = metadata.readOnly ? 'readOnly' : 'writable';
      if (!metadataChanged(current.fileBaseline, metadata) && current.fileBaseline.contentHash) {
        metadata = await configured.file.statFile(record.locator.displayPath, { contentHash: true });
      }
      const echo = selfSaveEchoes.get(documentId);
      if (echo && echo.expiresAt >= now() && !metadataChanged(echo.metadata, metadata)) {
        selfSaveEchoes.delete(documentId);
        transition(current, 'inSync', access, null, null);
        emit({ documentId, type: 'synced', path: record.locator.displayPath, sourceText: current.source.sourceText, metadata });
        return;
      }
      if (!metadataChanged(current.fileBaseline, metadata)) {
        if (current.lifecycle.access !== access) transition(current, current.lifecycle.external, access, current.observedExternal, access === 'readOnly' ? 'readOnly' : null);
        return;
      }
      const disk = await configured.file.readTextFile(record.locator.displayPath);
      const diskSource = readSourceEnvelope(disk).sourceText;
      const latest = getState().documentsById[documentId];
      if (!latest || !sameDocumentLocator(latest.locator, record.locator)) return;
      const currentSource = readCurrentSource?.(documentId) ?? latest.source.sourceText;
      if (diskSource === currentSource) {
        dispatch({ type: 'updateDocument', documentId, action: { type: 'externalDiskAdopted', sourceText: diskSource, fileBaseline: disk.metadata } });
        clearNotification(documentId);
        emit({ documentId, type: 'synced', path: record.locator.displayPath, sourceText: diskSource, metadata: disk.metadata });
      } else if (diskSource === latest.source.savedSourceText) {
        dispatch({ type: 'updateDocument', documentId, action: { type: 'fileBaselineChanged', fileBaseline: disk.metadata } });
        transition(latest, 'inSync', access, null, null);
        emit({ documentId, type: 'synced', path: record.locator.displayPath, sourceText: diskSource, metadata: disk.metadata });
      } else {
        transition(latest, 'changed', access, disk.metadata, 'changed');
        emit({ documentId, type: 'conflict', path: record.locator.displayPath, sourceText: diskSource, metadata: disk.metadata });
      }
    } catch (error) {
      const latest = getState().documentsById[documentId];
      if (latest) classifyFailure(latest, error);
    }
  };
  const checkDocument = async (documentId: DocumentId) => {
    const existing = inFlight.get(documentId);
    if (existing) {
      rerun.add(documentId);
      return existing;
    }
    const task = (async () => {
      do {
        rerun.delete(documentId);
        await runCheck(documentId);
      } while (rerun.has(documentId));
    })().finally(() => inFlight.delete(documentId));
    inFlight.set(documentId, task);
    return task;
  };
  const checkAll = async () => {
    await Promise.all(savedDocuments().map((record) => checkDocument(record.id)));
  };
  const compareDocument = async (documentId: DocumentId): Promise<ReadTextFileResponse | null> => {
    const record = getState().documentsById[documentId];
    if (!host || !record || record.locator.kind !== 'file') return null;
    return host.file.readTextFile(record.locator.displayPath);
  };

  return {
    configure(nextHost, nextReadCurrentSource) {
      host = nextHost;
      readCurrentSource = nextReadCurrentSource ?? null;
      void registerDesiredPaths();
    },
    observe(state) {
      const nextKey = state.tabOrder.flatMap((id) => {
        const locator = state.documentsById[id]?.locator;
        return locator?.kind === 'file' ? [locator.stableFileId ?? locator.comparisonKey] : [];
      }).sort().join('\n');
      for (const id of Array.from(notificationByDocument.keys())) if (!state.documentsById[id]) notificationByDocument.delete(id);
      if (nextKey !== desiredWatchKey) {
        desiredWatchKey = nextKey;
        if (host) void registerDesiredPaths();
      }
    },
    checkDocument,
    checkAll,
    compareDocument,
    async reloadFromDisk(documentId) {
      const record = getState().documentsById[documentId];
      if (!record) return false;
      let disk: ReadTextFileResponse | null;
      try {
        disk = await compareDocument(documentId);
      } catch (error) {
        classifyFailure(record, error);
        return false;
      }
      if (!disk) return false;
      dispatch({ type: 'updateDocument', documentId, action: { type: 'externalDiskAdopted', sourceText: readSourceEnvelope(disk).sourceText, fileBaseline: disk.metadata } });
      await recovery.clearDocument(documentId, getState().documentsById[documentId]?.source.revision ?? record.source.revision);
      clearNotification(documentId);
      return true;
    },
    keepLocal(documentId) {
      const notification = notificationByDocument.get(documentId);
      if (notification) notificationByDocument.set(documentId, { ...notification, acknowledged: true });
    },
    overwrite: (documentId) => saves.saveDocument(documentId, { forceOverwrite: true }),
    recordSelfSave(documentId, metadata) {
      selfSaveEchoes.set(documentId, { metadata, expiresAt: now() + SELF_SAVE_ECHO_WINDOW_MS });
    },
    notifications: () => Array.from(notificationByDocument.values()).sort((a, b) => a.observedAt - b.observedAt),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    metrics: () => ({ listenerCount: unlisten ? 1 : 0, pollerCount: pollTimer ? 1 : 0, registeredLocatorCount, checkCount, coalescedEventCount }),
    destroy() {
      disposed = true;
      unlisten?.();
      unlisten = null;
      if (pollTimer) clearInterval(pollTimer);
      if (retryTimer) clearTimeout(retryTimer);
      if (coalesceTimer) clearTimeout(coalesceTimer);
      pollTimer = null;
      retryTimer = null;
      coalesceTimer = null;
      if (host) void host.watcher.clearWatchedFiles(WATCH_SCOPE).catch(() => undefined);
      listeners.clear();
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
