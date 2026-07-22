import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocumentId, createUntitledLocator, fallbackFileLocator, sourceRevision } from '../documentIdentity';
import { createDocumentRecord } from '../documentRecord';
import type { RecoveryCatalogEntry, RecoveryCheckpointInput } from '../../services/recoveryCatalog';
import { createWorkspaceState } from './workspaceState';
import { createWorkspaceStore } from './workspaceStore';
import { createHiddenWorkspaceHarness } from './hiddenWorkspaceHarness';
import type { WorkspaceRecoveryBackend } from './workspaceRecoveryCoordinator';
import { loadUntitledDraft, resetDraftRecoveryForTests, saveUntitledDraft } from '../../services/draftRecoveryService';
import { loadRecoveryCatalog, resetRecoveryCatalogForTests } from '../../services/recoveryCatalog';
import { sourceSnapshotService } from '../source/sourceSnapshotService';

describe('WorkspaceRecoveryCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetDraftRecoveryForTests();
    resetRecoveryCatalogForTests();
    sourceSnapshotService.resetForTests();
  });
  afterEach(() => vi.useRealTimers());

  it('checkpoints several heterogeneous documents simultaneously, including dirty empty source', async () => {
    const backend = fakeBackend();
    const first = dirtyRecord('markdown', '# first', '# saved', fallbackFileLocator('C:\\Lab\\first.md'));
    const second = dirtyRecord('json', '{"second":true}', '{}', createUntitledLocator());
    const third = dirtyRecord('plainText', '', 'deleted', createUntitledLocator());
    const store = createHiddenWorkspaceHarness(first, { backend });
    store.dispatch({ type: 'newDocument', document: second });
    store.dispatch({ type: 'newDocument', document: third });
    store.recovery.configureEditorFlush(() => undefined);

    await store.recovery.flushAll('destructive-barrier');

    expect(backend.checkpoints).toHaveLength(3);
    expect(backend.checkpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: first.id, format: 'markdown', sourceText: '# first' }),
      expect.objectContaining({ documentId: second.id, format: 'json', sourceText: '{"second":true}' }),
      expect.objectContaining({ documentId: third.id, format: 'plainText', sourceText: '' }),
    ]));
    for (const documentId of [first.id, second.id, third.id]) {
      expect(store.getState().documentsById[documentId].lifecycle.recovery).toBe('current');
    }
  });

  it('meets the 600 ms checkpoint budget and prioritizes a dirty document after deactivation', async () => {
    let clock = 10_000;
    const backend = fakeBackend();
    const first = dirtyRecord('markdown', '# first', '# saved', fallbackFileLocator('C:\\Lab\\first.md'));
    const second = createDocumentRecord({ sourceText: '{}', savedSourceText: '{}', format: 'json', locator: fallbackFileLocator('C:\\Lab\\second.json') });
    const store = createWorkspaceStore(createWorkspaceState(first, capability()), { backend, now: () => clock });
    store.dispatch({ type: 'newDocument', document: second });
    store.dispatch({ type: 'activateDocument', documentId: first.id });
    store.recovery.configureEditorFlush(() => undefined);

    clock += 99;
    await vi.advanceTimersByTimeAsync(99);
    expect(backend.checkpoints).toHaveLength(0);
    store.dispatch({ type: 'activateDocument', documentId: second.id });
    clock += 100;
    await vi.advanceTimersByTimeAsync(100);

    expect(backend.checkpoints).toHaveLength(1);
    expect(backend.checkpoints[0].documentId).toBe(first.id);
    expect(store.recovery.metrics()).toMatchObject({ checkpointCount: 1, checkpointLagMaxMs: 199, failedCheckpointCount: 0 });
  });

  it('measures the ordinary dirty checkpoint at the declared 600 ms lag', async () => {
    let clock = 20_000;
    const backend = fakeBackend();
    const document = dirtyRecord('markdown', '# dirty', '# saved', createUntitledLocator());
    const store = createWorkspaceStore(createWorkspaceState(document, capability()), { backend, now: () => clock });
    store.recovery.configureEditorFlush(() => undefined);

    clock += 599;
    await vi.advanceTimersByTimeAsync(599);
    expect(backend.checkpoints).toHaveLength(0);
    clock += 1;
    await vi.advanceTimersByTimeAsync(1);

    expect(backend.checkpoints).toHaveLength(1);
    expect(store.recovery.metrics()).toMatchObject({ checkpointCount: 1, checkpointLagMaxMs: 600, lastCheckpointLagMs: 600 });
  });

  it('coalesces concurrent checkpoint barriers for the same revision', async () => {
    const backend = fakeBackend();
    let release!: () => void;
    const checkpointReady = new Promise<void>((resolve) => { release = resolve; });
    backend.checkpoint.mockImplementationOnce(async (input) => {
      backend.checkpoints.push(input);
      await checkpointReady;
      return entryFor(input, 1);
    });
    const document = dirtyRecord('markdown', '# dirty', '# saved', createUntitledLocator());
    const store = createWorkspaceStore(createWorkspaceState(document, capability()), { backend });
    store.recovery.configureEditorFlush(() => undefined);

    const first = store.recovery.flushDocument(document.id, 'deactivation');
    const second = store.recovery.flushDocument(document.id, 'destructive-barrier');
    const third = store.recovery.flushDocument(document.id, 'visibility-hidden');
    await Promise.resolve();
    expect(backend.checkpoint).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second, third]);
    expect(backend.checkpoint).toHaveBeenCalledTimes(1);
    expect(store.getState().documentsById[document.id].lifecycle.recovery).toBe('current');
  });

  it('registers one lifecycle listener set and abrupt unload synchronously targets every dirty record', () => {
    const backend = fakeBackend();
    const first = dirtyRecord('markdown', '# first', '# saved', createUntitledLocator());
    const second = dirtyRecord('json', '{}', '{"saved":true}', createUntitledLocator());
    const store = createWorkspaceStore(createWorkspaceState(first, capability()), { backend });
    store.dispatch({ type: 'newDocument', document: second });
    store.recovery.configureEditorFlush(() => undefined);
    const windowSpy = vi.spyOn(window, 'addEventListener');
    const documentSpy = vi.spyOn(document, 'addEventListener');

    const detach = store.recovery.attachLifecycleListeners();
    store.recovery.attachLifecycleListeners();
    window.dispatchEvent(new Event('beforeunload'));

    expect(windowSpy.mock.calls.filter(([name]) => name === 'pagehide')).toHaveLength(1);
    expect(windowSpy.mock.calls.filter(([name]) => name === 'beforeunload')).toHaveLength(1);
    expect(documentSpy.mock.calls.filter(([name]) => name === 'visibilitychange')).toHaveLength(1);
    expect(backend.syncCheckpoints.map((entry) => entry.documentId)).toEqual(expect.arrayContaining([first.id, second.id]));
    detach();
    windowSpy.mockRestore();
    documentSpy.mockRestore();
  });

  it('repeats a destructive barrier until the latest revision has committed', async () => {
    const backend = fakeBackend();
    let releaseFirst: () => void = () => undefined;
    backend.checkpoint = vi.fn(async (input) => {
      backend.checkpoints.push(input);
      if (backend.checkpoints.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return entryFor(input, backend.checkpoints.length);
    });
    const document = dirtyRecord('plainText', 'revision one', 'saved', createUntitledLocator());
    const store = createWorkspaceStore(createWorkspaceState(document, capability()), { backend });
    store.recovery.configureEditorFlush(() => undefined);

    const barrier = store.recovery.flushDocument(document.id, 'destructive-barrier');
    await Promise.resolve();
    store.dispatch({ type: 'updateDocument', documentId: document.id, action: { type: 'sourceChanged', sourceText: 'revision two' } });
    releaseFirst();
    const committed = await barrier;

    expect(backend.checkpoints).toHaveLength(2);
    expect(committed?.sourceText).toBe('revision two');
    expect(committed?.sourceRevision).toBe(store.getState().documentsById[document.id].source.revision);
  });

  it('checkpoints the buffer authority after an incremental edit and releases leases when the backend fails', async () => {
    const backend = fakeBackend();
    backend.checkpoint.mockImplementationOnce(async (input) => {
      backend.checkpoints.push(input);
      throw new Error('storage failed');
    });
    const document = createDocumentRecord({ sourceText: 'saved', mode: 'source' });
    const store = createWorkspaceStore(createWorkspaceState(document, capability()), { backend });
    store.recovery.configureEditorFlush(() => undefined);
    store.dispatch({
      type: 'updateDocument', documentId: document.id,
      action: {
        type: 'sourceChangeSetApplied',
        changeSet: { documentId: document.id, expectedRevision: sourceRevision(0), changes: [{ from: 0, to: 5, insert: 'draft', expectedText: 'saved' }] },
      },
    });
    await expect(store.recovery.flushDocument(document.id)).rejects.toThrow('storage failed');
    expect(backend.checkpoints[0]).toMatchObject({ sourceText: 'draft', savedSourceText: 'saved', sourceRevision: 1 });
    expect(sourceSnapshotService.metrics().activeLeaseCount).toBe(0);
  });

  it('awaits current-revision recovery before a destructive workspace removal', async () => {
    const backend = fakeBackend();
    const document = dirtyRecord('markdown', '# dirty', '# saved', createUntitledLocator());
    const store = createWorkspaceStore(createWorkspaceState(document, capability()), { backend });
    store.recovery.configureEditorFlush(() => undefined);
    store.manifest.activate();

    const begun = await store.close.begin({ kind: 'document', documentId: document.id });
    await store.close.decide(begun.decision!.transactionId, 'discard-selected');

    expect(backend.checkpoints.at(-1)).toMatchObject({ documentId: document.id, sourceRevision: document.source.revision });
    expect(store.getState().documentsById[document.id]).toBeUndefined();
  });

  it('migrates the released singleton recovery key only after the addressed catalog checkpoint commits', async () => {
    saveUntitledDraft('legacy dirty source', 1000, 'plainText');
    const document = dirtyRecord('plainText', 'legacy dirty source', '', createUntitledLocator());
    const store = createWorkspaceStore(createWorkspaceState(document, capability()));
    store.recovery.configureEditorFlush(() => undefined);

    await store.recovery.flushDocument(document.id, 'destructive-barrier');

    expect((await loadRecoveryCatalog()).find((entry) => entry.documentId === document.id)).toMatchObject({
      sourceText: 'legacy dirty source',
      format: 'plainText',
    });
    expect(loadUntitledDraft(1500)).toBeNull();
  });
});

function capability() {
  return {
    multiDocumentWorkspaceEnabled: true,
    activationSurface: { id: 'recovery-test', kind: 'hidden-harness' as const },
  };
}

function dirtyRecord(
  format: 'markdown' | 'json' | 'plainText',
  sourceText: string,
  savedSourceText: string,
  locator: ReturnType<typeof createUntitledLocator> | ReturnType<typeof fallbackFileLocator>,
) {
  return createDocumentRecord({ id: createDocumentId(), locator, format, sourceText, savedSourceText });
}

function fakeBackend(): WorkspaceRecoveryBackend & {
  checkpoints: RecoveryCheckpointInput[];
  syncCheckpoints: RecoveryCheckpointInput[];
  checkpoint: ReturnType<typeof vi.fn<(input: RecoveryCheckpointInput) => Promise<RecoveryCatalogEntry>>>;
} {
  const checkpoints: RecoveryCheckpointInput[] = [];
  const syncCheckpoints: RecoveryCheckpointInput[] = [];
  return {
    checkpoints,
    syncCheckpoints,
    checkpoint: vi.fn(async (input) => {
      checkpoints.push(input);
      return entryFor(input, checkpoints.length);
    }),
    checkpointSync: (input) => {
      syncCheckpoints.push(input);
      return entryFor(input, syncCheckpoints.length);
    },
    clear: vi.fn().mockResolvedValue(true),
    recoveryCenter: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      entries: [],
      totalBytes: 0,
      softQuotaBytes: 1,
      quotaState: 'within-budget',
      pruningPolicy: 'never-delete-current-dirty-entry',
    }),
  };
}

function entryFor(input: RecoveryCheckpointInput, generation: number): RecoveryCatalogEntry {
  return {
    schemaVersion: 1,
    documentId: input.documentId,
    sourceRevision: input.sourceRevision,
    locator: input.locator,
    sourceText: input.sourceText,
    format: input.format,
    mediaType: input.format === 'json' ? 'application/json' : 'text/plain',
    savedAt: input.savedAt ?? Date.now(),
    generation,
  };
}
