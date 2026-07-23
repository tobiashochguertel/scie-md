import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocumentRecord, documentRecordReducer } from '../documentRecord';
import type { DocumentId } from '../documentIdentity';
import { createWorkspaceStore } from './workspaceStore';
import { createWorkspaceState, workspaceReducer } from './workspaceState';
import type { WorkspaceRecoveryBackend } from './workspaceRecoveryCoordinator';
import {
  checkpointRecoveryEntry,
  checkpointRecoveryEntrySync,
  clearRecoveryCatalogEntry,
  createRecoveryCenterModel,
  resetRecoveryCatalogForTests,
} from '../../services/recoveryCatalog';
import { resetWorkspaceManifestForTests } from '../../services/workspaceManifestService';

describe('workspace close coordinator', () => {
  beforeEach(() => {
    localStorage.clear();
    resetRecoveryCatalogForTests();
    resetWorkspaceManifestForTests();
  });

  it('summarizes active and background durability state without content', () => {
    const active = createDocumentRecord({ sourceText: 'clean' });
    const background = documentRecordReducer(createDocumentRecord({ sourceText: 'saved' }), { type: 'sourceChanged', sourceText: '' });
    const store = createStore(active, background);
    const summary = store.close.summary();

    expect(summary).toMatchObject({ dirtyCount: 1, protectedCount: 1, requiresProtection: true });
    expect(summary.active?.dirty).toBe(false);
    expect(summary.background.dirtyCount).toBe(1);
    expect(JSON.stringify(summary)).not.toContain('clean');
    expect(JSON.stringify(summary)).not.toContain('saved');
  });

  it('flushes editors before evaluation and destroys the window only after save, recovery, and manifest settlement', async () => {
    const dirty = documentRecordReducer(createDocumentRecord({ sourceText: 'saved' }), { type: 'sourceChanged', sourceText: 'dirty' });
    const events: string[] = [];
    const store = createStore(dirty, undefined, events);
    store.close.configureEditorFlush(() => events.push('editor'));
    store.saves.registerActor(dirty.id, {
      save: async () => {
        events.push('save');
        store.dispatch({ type: 'updateDocument', documentId: dirty.id, action: { type: 'savedBaselineChanged', savedSourceText: 'dirty' } });
        return 'saved';
      },
    });
    const begun = await store.close.begin({ kind: 'quit' }, async () => { events.push('window'); });
    expect(begun.status).toBe('decision-required');

    const result = await store.close.decide(begun.decision!.transactionId, 'save-selected');

    expect(result.status).toBe('closed');
    expect(events[0]).toBe('editor');
    expect(events.indexOf('save')).toBeLessThan(events.indexOf('manifest'));
    expect(events.indexOf('manifest')).toBeLessThan(events.indexOf('window'));
    expect(store.close.trace().map((event) => event.type)).toEqual(expect.arrayContaining([
      'editor-flushed', 'recovery-settled', 'saved', 'manifest-published', 'window-destroyed',
    ]));
  });

  it('keeps failed Save All documents open and recoverable while settling successful siblings', async () => {
    const first = documentRecordReducer(createDocumentRecord({ sourceText: 'a' }), { type: 'sourceChanged', sourceText: 'a1' });
    const second = documentRecordReducer(createDocumentRecord({ sourceText: 'b' }), { type: 'sourceChanged', sourceText: 'b1' });
    const store = createStore(first, second);
    store.saves.registerActor(first.id, { save: async () => false });
    store.saves.registerActor(second.id, {
      save: async () => {
        store.dispatch({ type: 'updateDocument', documentId: second.id, action: { type: 'savedBaselineChanged', savedSourceText: 'b1' } });
        return 'saved';
      },
    });
    const begun = await store.close.begin({ kind: 'all' });
    const result = await store.close.decide(begun.decision!.transactionId, 'save-selected');

    expect(result.status).toBe('partial-failure');
    expect(result.decision?.failedDocumentIds).toEqual([first.id]);
    expect(store.getState().documentsById[first.id]).toBeDefined();
    expect(store.getState().documentsById[second.id]).toBeUndefined();
  });

  it('cancels non-destructively and clears close authorizations', async () => {
    const dirty = documentRecordReducer(createDocumentRecord({ sourceText: 'a' }), { type: 'sourceChanged', sourceText: 'b' });
    const store = createStore(dirty);
    const begun = await store.close.begin({ kind: 'document', documentId: dirty.id });
    const result = await store.close.decide(begun.decision!.transactionId, 'cancel');

    expect(result.status).toBe('cancelled');
    expect(store.getState().documentsById[dirty.id]?.source.sourceText).toBe('b');
    expect(store.getState().pendingCloseRequests[dirty.id]).toBeUndefined();
    expect(store.close.trace().at(-1)?.type).toBe('cancelled');
  });

  it('supports stable selected discard targets including an empty dirty document', async () => {
    const first = documentRecordReducer(createDocumentRecord({ sourceText: 'a' }), { type: 'sourceChanged', sourceText: '' });
    const second = documentRecordReducer(createDocumentRecord({ sourceText: 'b' }), { type: 'sourceChanged', sourceText: 'b1' });
    const store = createStore(first, second);
    const begun = await store.close.begin({ kind: 'all' });
    const partial = await store.close.decide(begun.decision!.transactionId, 'discard-selected', [first.id]);

    expect(partial.status).toBe('decision-required');
    expect(store.getState().documentsById[first.id]).toBeUndefined();
    expect(store.getState().documentsById[second.id]).toBeDefined();
    expect(partial.decision?.unresolvedDocumentIds).toEqual([second.id]);
  });

  it('closes clean documents without blocking on recovery catalog cleanup', async () => {
    const clean = createDocumentRecord({ sourceText: 'clean' });
    const events: string[] = [];
    const store = createStore(clean, undefined, events);
    events.length = 0;

    const result = await store.close.begin({ kind: 'document', documentId: clean.id });

    expect(result.status).toBe('closed');
    expect(events).not.toContain('clear');
    expect(store.getState().documentsById[clean.id]).toBeUndefined();
  });

  it('shares the same transaction API for close-right and close-others scopes', async () => {
    const first = createDocumentRecord({ sourceText: 'first' });
    const second = documentRecordReducer(createDocumentRecord({ sourceText: 'second' }), { type: 'sourceChanged', sourceText: 'second dirty' });
    const store = createStore(first, second);
    const right = await store.close.begin({ kind: 'right', documentId: first.id });
    expect(right.decision?.unresolvedDocumentIds).toEqual([second.id]);
    await store.close.decide(right.decision!.transactionId, 'cancel');
    const others = await store.close.begin({ kind: 'others', documentId: first.id });
    expect(others.decision?.unresolvedDocumentIds).toEqual([second.id]);
  });

  it('keeps conflict, read-only, saving, and recovery facets orthogonal and reviewable', async () => {
    let document = documentRecordReducer(createDocumentRecord({ sourceText: 'a' }), { type: 'sourceChanged', sourceText: 'b' });
    document = documentRecordReducer(document, { type: 'externalConflictChanged', externalConflict: true });
    document = documentRecordReducer(document, { type: 'accessChanged', access: 'readOnly' });
    document = documentRecordReducer(document, { type: 'autosaveStatusChanged', autosaveStatus: 'pending' });
    const store = createStore(document);
    const summary = store.close.summary();
    expect(summary).toMatchObject({ dirtyCount: 1, savingCount: 1, conflictCount: 1, accessBlockedCount: 1, recoveryPendingCount: 1 });
    const begun = await store.close.begin({ kind: 'document', documentId: document.id });
    const reviewed = await store.close.decide(begun.decision!.transactionId, 'review-conflicts');
    expect(reviewed.status).toBe('decision-required');
    expect(store.getState().documentsById[document.id]).toBeDefined();
  });

  it('retries only the stable failed target and closes it after success', async () => {
    const dirty = documentRecordReducer(createDocumentRecord({ sourceText: 'a' }), { type: 'sourceChanged', sourceText: 'b' });
    const store = createStore(dirty);
    let attempt = 0;
    store.saves.registerActor(dirty.id, {
      save: async () => {
        attempt += 1;
        if (attempt === 1) return false;
        store.dispatch({ type: 'updateDocument', documentId: dirty.id, action: { type: 'savedBaselineChanged', savedSourceText: 'b' } });
        return 'saved';
      },
    });
    const begun = await store.close.begin({ kind: 'document', documentId: dirty.id });
    const failed = await store.close.decide(begun.decision!.transactionId, 'save-selected');
    expect(failed.status).toBe('partial-failure');
    const retried = await store.close.decide(begun.decision!.transactionId, 'retry');
    expect(retried.status).toBe('closed');
    expect(store.getState().documentsById[dirty.id]).toBeUndefined();
  });

  it('times out hung saves without removing or destroying the target', async () => {
    const dirty = documentRecordReducer(createDocumentRecord({ sourceText: 'a' }), { type: 'sourceChanged', sourceText: 'b' });
    const store = createStore(dirty, undefined, undefined, 5);
    store.saves.registerActor(dirty.id, { save: () => new Promise(() => undefined) });
    const destroy = vi.fn(async () => undefined);
    const begun = await store.close.begin({ kind: 'quit' }, destroy);
    const result = await store.close.decide(begun.decision!.transactionId, 'save-selected');
    expect(result.status).toBe('partial-failure');
    expect(store.getState().documentsById[dirty.id]).toBeDefined();
    expect(destroy).not.toHaveBeenCalled();
  });

  it('does not finalize a document when manifest publication fails', async () => {
    const dirty = documentRecordReducer(createDocumentRecord({ sourceText: 'a' }), { type: 'sourceChanged', sourceText: 'b' });
    const store = createStore(dirty);
    store.manifest.activate();
    const original = localStorage.setItem.bind(localStorage);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    const begun = await store.close.begin({ kind: 'document', documentId: dirty.id });
    const result = await store.close.decide(begun.decision!.transactionId, 'discard-selected');
    setItem.mockRestore();
    original('close-test-probe', 'ok');

    expect(result.status).toBe('partial-failure');
    expect(store.getState().documentsById[dirty.id]).toBeDefined();
  });
});

function createStore(
  first: ReturnType<typeof createDocumentRecord>,
  second?: ReturnType<typeof createDocumentRecord>,
  events?: string[],
  closeTimeoutMs?: number,
) {
  let state = createWorkspaceState(first, {
    multiDocumentWorkspaceEnabled: true,
    activationSurface: { id: 'close-tests', kind: 'hidden-harness' },
  });
  if (second) state = workspaceReducer(state, { type: 'openDocument', document: second });
  if (second) state = workspaceReducer(state, { type: 'activateDocument', documentId: first.id });
  const backend: WorkspaceRecoveryBackend = {
    checkpoint: async (input) => {
      events?.push('recovery');
      return checkpointRecoveryEntry(input);
    },
    checkpointSync: checkpointRecoveryEntrySync,
    clear: async (documentId, revision) => { events?.push('clear'); return clearRecoveryCatalogEntry(documentId, revision); },
    recoveryCenter: createRecoveryCenterModel,
  };
  const store = createWorkspaceStore(state, { backend, closeTimeoutMs });
  store.manifest.activate();
  if (events) {
    const flushState = store.manifest.flushState.bind(store.manifest);
    store.manifest.flushState = async (nextState, requireDurableStorage, recoveryAlreadySettled) => {
      const result = await flushState(nextState, requireDurableStorage, recoveryAlreadySettled);
      events.push('manifest');
      return result;
    };
  }
  return store;
}
