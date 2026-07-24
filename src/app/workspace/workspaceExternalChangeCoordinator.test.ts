import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocumentRecord, documentRecordReducer } from '../documentRecord';
import { createHostReadResponse, DEFAULT_METADATA, type FileMetadata, type ReadTextFileResponse } from '../documentState';
import { fallbackFileLocator, sourceRevision, type DocumentId } from '../documentIdentity';
import { DocumentHostError } from '../host/documentHostError';
import type { DocumentHost } from '../host/documentHost';
import { documentEditorGateway } from '../documentEditorGateway';
import { createWorkspaceState } from './workspaceState';
import { createWorkspaceStore, type WorkspaceStore } from './workspaceStore';

type ExternalHost = Pick<DocumentHost, 'file' | 'watcher'>;
const baseline = metadata({ lastKnownMtimeMs: 1000, lastKnownSizeBytes: 4, contentHash: 'base' });

describe('workspace external-change coordinator', () => {
  let store: WorkspaceStore;
  let host: ExternalHost;
  let firstId: DocumentId;
  let secondId: DocumentId;
  let emitNative: ((event: { paths: string[]; kind: string; changedAtMs: number }) => void) | null;

  beforeEach(() => {
    emitNative = null;
    const first = createDocumentRecord({ locator: fallbackFileLocator('C:\\Lab\\first.md'), sourceText: 'one\n', fileBaseline: baseline });
    const second = createDocumentRecord({ locator: fallbackFileLocator('C:\\Lab\\second.md'), sourceText: 'two\n', fileBaseline: baseline });
    firstId = first.id;
    secondId = second.id;
    store = createWorkspaceStore(createWorkspaceState(first, {
      multiDocumentWorkspaceEnabled: true,
      activationSurface: { id: 'external-tests', kind: 'hidden-harness' },
    }));
    store.dispatch({ type: 'openDocument', document: second });
    host = createHost();
  });

  afterEach(() => {
    store.externalChanges.destroy();
    store.recovery.destroy();
    store.manifest.destroy();
    vi.useRealTimers();
  });

  it('registers the restored locator union once and owns one native listener', async () => {
    store.externalChanges.configure(host);
    await flushAsync();
    expect(host.watcher.listenFileWatchChanges).toHaveBeenCalledTimes(1);
    expect(host.watcher.updateWatchedFiles).toHaveBeenLastCalledWith('workspace:open-documents', [
      'C:\\Lab\\first.md',
      'C:\\Lab\\second.md',
    ]);
    expect(store.externalChanges.metrics()).toMatchObject({ listenerCount: 1, pollerCount: 0, registeredLocatorCount: 2 });
  });

  it('routes alias bursts to one addressed inactive document and never mutates its neighbor', async () => {
    vi.useFakeTimers();
    store.externalChanges.configure(host);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(host.file.statFile).mockImplementation(async (path, options) => path.endsWith('second.md')
      ? metadata({ lastKnownMtimeMs: 2000, lastKnownSizeBytes: 8, contentHash: options?.contentHash ? 'disk' : null })
      : baseline);
    vi.mocked(host.file.readTextFile).mockImplementation(async (path) => read(path.endsWith('second.md') ? 'disk two\n' : 'one\n', metadata({ lastKnownMtimeMs: 2000, contentHash: 'disk' })));

    emitNative?.({ paths: ['\\\\?\\c:\\lab\\SECOND.md'], kind: 'Modify', changedAtMs: 1 });
    emitNative?.({ paths: ['C:\\LAB\\second.md'], kind: 'Modify', changedAtMs: 2 });
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState().documentsById[secondId].lifecycle.external).toBe('changed');
    expect(store.getState().documentsById[firstId].lifecycle.external).toBe('inSync');
    expect(store.externalChanges.metrics().coalescedEventCount).toBe(1);
    expect(store.externalChanges.notifications()).toEqual([
      expect.objectContaining({ documentId: secondId, kind: 'changed', acknowledged: false }),
    ]);
  });

  it.each([
    ['missing', new DocumentHostError('NOT_FOUND', 'missing'), 'missing', 'writable'],
    ['permission', new DocumentHostError('PERMISSION_DENIED', 'denied'), 'unknown', 'permissionLost'],
    ['cloud failure', new DocumentHostError('CLOUD_UNAVAILABLE', 'cloud'), 'unknown', 'cloudUnavailable'],
  ] as const)('keeps %s failure distinct', async (_name, error, external, access) => {
    vi.mocked(host.file.statFile).mockRejectedValue(error);
    store.externalChanges.configure(host);
    await store.externalChanges.checkDocument(firstId);
    expect(store.getState().documentsById[firstId].lifecycle).toMatchObject({ external, access });
  });

  it('distinguishes stable-ID rename suspicion and filesystem read-only state', async () => {
    const current = store.getState().documentsById[firstId];
    store.dispatch({ type: 'updateDocument', documentId: firstId, action: { type: 'locatorChanged', locator: {
      ...current.locator as Extract<typeof current.locator, { kind: 'file' }>,
      stableFileId: 'volume:42',
      identityConfidence: 'stableFileId',
    } } });
    store.externalChanges.configure(host);
    vi.mocked(host.file.statFile).mockRejectedValueOnce(new DocumentHostError('NOT_FOUND', 'moved'));
    await store.externalChanges.checkDocument(firstId);
    expect(store.getState().documentsById[firstId].lifecycle.external).toBe('renamed');

    vi.mocked(host.file.statFile).mockResolvedValue(metadata({ ...baseline, readOnly: true }));
    await store.externalChanges.checkDocument(secondId);
    expect(store.getState().documentsById[secondId].lifecycle.access).toBe('readOnly');
  });

  it('suppresses correlated self-save echoes while preserving edits made after the saved snapshot', async () => {
    const dirty = documentRecordReducer(store.getState().documentsById[firstId], { type: 'sourceChanged', sourceText: 'later local edit\n' });
    store.dispatch({ type: 'replaceDocument', documentId: firstId, document: dirty });
    const savedMetadata = metadata({ lastKnownMtimeMs: 2000, lastKnownSizeBytes: 4, contentHash: 'self' });
    store.externalChanges.recordSelfSave(firstId, savedMetadata);
    vi.mocked(host.file.statFile).mockResolvedValue(savedMetadata);
    store.externalChanges.configure(host);
    await store.externalChanges.checkDocument(firstId);
    expect(store.getState().documentsById[firstId].lifecycle).toMatchObject({ external: 'inSync', content: 'dirty' });
    expect(host.file.readTextFile).not.toHaveBeenCalled();
  });

  it('compares disk against the incrementally edited buffer rather than the stale string projection', async () => {
    store.dispatch({
      type: 'updateDocument', documentId: firstId,
      action: { type: 'sourceChangeSetApplied', changeSet: { documentId: firstId, expectedRevision: sourceRevision(0), changes: [{ from: 0, to: 3, insert: 'ONE', expectedText: 'one' }] } },
    });
    vi.mocked(host.file.statFile).mockResolvedValue(metadata({ lastKnownMtimeMs: 2000, lastKnownSizeBytes: 4, contentHash: 'disk' }));
    vi.mocked(host.file.readTextFile).mockResolvedValue(read('ONE\n', metadata({ lastKnownMtimeMs: 2000, lastKnownSizeBytes: 4, contentHash: 'disk' })));
    store.externalChanges.configure(host);
    await store.externalChanges.checkDocument(firstId);
    expect(store.getState().documentsById[firstId].lifecycle).toMatchObject({ external: 'inSync', content: 'clean' });
  });

  it('does not clear a live editor whose pending source is newer than the workspace buffer', async () => {
    const clearRuntime = vi.spyOn(documentEditorGateway, 'clearRuntime');
    vi.mocked(host.file.statFile).mockResolvedValue(metadata({
      lastKnownMtimeMs: 2000,
      lastKnownSizeBytes: 4,
      contentHash: 'disk',
    }));
    vi.mocked(host.file.readTextFile).mockResolvedValue(read('one\n', metadata({
      lastKnownMtimeMs: 2000,
      lastKnownSizeBytes: 4,
      contentHash: 'disk',
    })));
    store.externalChanges.configure(host, (documentId) => (
      documentId === firstId ? 'pending visual edit\n' : null
    ));

    await store.externalChanges.checkDocument(firstId);

    expect(clearRuntime).not.toHaveBeenCalledWith(firstId);
    expect(store.getState().documentsById[firstId].source.sourceText).toBe('one\n');
    expect(store.getState().documentsById[firstId].lifecycle).toMatchObject({
      external: 'inSync',
      content: 'clean',
    });
  });

  it('centralizes fallback polling and recovers native registration without creating per-document pollers', async () => {
    vi.useFakeTimers();
    vi.mocked(host.watcher.updateWatchedFiles).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(host.file.statFile).mockResolvedValue(baseline);
    store.externalChanges.configure(host);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.externalChanges.metrics().pollerCount).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.watcher.updateWatchedFiles).toHaveBeenCalledTimes(2);
    expect(store.externalChanges.metrics().pollerCount).toBe(0);
  });

  it('exposes targeted compare, keep-local, reload, and overwrite commands', async () => {
    store.externalChanges.configure(host);
    vi.mocked(host.file.statFile).mockResolvedValue(metadata({ lastKnownMtimeMs: 2000, contentHash: 'disk' }));
    vi.mocked(host.file.readTextFile).mockResolvedValue(read('disk\n', metadata({ lastKnownMtimeMs: 2000, contentHash: 'disk' })));
    await store.externalChanges.checkDocument(secondId);
    store.externalChanges.keepLocal(secondId);
    expect(store.externalChanges.notifications()).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: secondId, acknowledged: true }),
    ]));
    expect((await store.externalChanges.compareDocument(secondId))?.sourceText).toBe('disk\n');
    expect(await store.externalChanges.reloadFromDisk(secondId)).toBe(true);
    expect(store.getState().documentsById[secondId].source).toMatchObject({ sourceText: 'disk\n', savedSourceText: 'disk\n' });

    const actor = { save: vi.fn(async () => 'C:\\Lab\\second.md') };
    store.saves.registerActor(secondId, actor);
    await expect(store.externalChanges.overwrite(secondId)).resolves.toBe('C:\\Lab\\second.md');
    expect(actor.save).toHaveBeenCalledWith({ forceOverwrite: true });
  });

  function createHost(): ExternalHost {
    return {
      file: {
        readTextFile: vi.fn(async () => read('one\n', baseline)),
        readTextFileForEdit: vi.fn(async () => read('one\n', baseline)),
        statFile: vi.fn(async () => baseline),
        writeTextFileAtomic: vi.fn(),
        createBackupSnapshot: vi.fn(),
      },
      watcher: {
        listenFileWatchChanges: vi.fn(async (handler) => { emitNative = handler; return () => undefined; }),
        updateWatchedFiles: vi.fn(async () => true),
        clearWatchedFiles: vi.fn(async () => true),
      },
    };
  }
});

function metadata(patch: Partial<FileMetadata> = {}): FileMetadata {
  return { ...DEFAULT_METADATA, ...patch };
}

function read(content: string, fileMetadata: FileMetadata): ReadTextFileResponse {
  return createHostReadResponse(content, fileMetadata);
}

async function flushAsync() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  }
}
