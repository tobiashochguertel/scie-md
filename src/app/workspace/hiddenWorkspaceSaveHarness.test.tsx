import { act, useEffect, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_METADATA } from '../documentState';
import { documentEditorGateway } from '../documentEditorGateway';
import { fallbackFileLocator, type DocumentId } from '../documentIdentity';
import { createDocumentRecord } from '../documentRecord';
import type { EditorAdapter } from '../../components/editorAdapter';
import { createHiddenWorkspaceHarness } from './hiddenWorkspaceHarness';
import type { WorkspaceStore } from './workspaceStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('hidden two-document save harness', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('survives editor switching, simultaneous saves, a delayed inactive completion, and empty-dirty recovery', async () => {
    const first = createDocumentRecord({
      locator: fallbackFileLocator('C:\\docs\\first.md'),
      sourceText: '',
      savedSourceText: '# previously saved',
    });
    const second = createDocumentRecord({
      locator: fallbackFileLocator('C:\\docs\\second.json'),
      format: 'json',
      sourceText: '{"version":2}',
      savedSourceText: '{"version":1}',
    });
    const store = createHiddenWorkspaceHarness(first);
    store.dispatch({ type: 'openDocument', document: second });
    store.dispatch({ type: 'activateDocument', documentId: first.id });
    const mounted: DocumentId[] = [];
    act(() => root.render(<ActiveEditorHarness store={store} onMounted={(id) => mounted.push(id)} />));

    expect(store.getState().documentsById[first.id].lifecycle.recovery).toBe('pending');
    const firstToken = store.saves.begin(first.id, 'autosave')!;
    const secondToken = store.saves.begin(second.id, 'manual')!;
    const firstWrite = deferred<void>();
    const order: string[] = [];
    const firstSave = store.saves.enqueue(firstToken, async () => {
      await store.saves.scheduleNativeWrite(firstToken, async () => {
        order.push('first-write');
        await firstWrite.promise;
      });
      return store.saves.commitOrigin(firstToken, () => {
        store.dispatch({ type: 'updateDocument', documentId: first.id, action: { type: 'fileBaselineChanged', fileBaseline: { ...DEFAULT_METADATA, contentHash: 'first-saved' } } });
        store.dispatch({ type: 'updateDocument', documentId: first.id, action: { type: 'savedBaselineChanged', savedSourceText: '' } });
      }).accepted;
    });

    act(() => store.dispatch({ type: 'activateDocument', documentId: second.id }));
    const secondSave = store.saves.enqueue(secondToken, async () => {
      await store.saves.scheduleNativeWrite(secondToken, async () => { order.push('second-write'); });
      return store.saves.commitOrigin(secondToken, () => {
        store.dispatch({ type: 'updateDocument', documentId: second.id, action: { type: 'savedBaselineChanged', savedSourceText: '{"version":2}' } });
      }).accepted;
    });
    const delayedEffect = store.effects.begin(first.id, 'document-validation')!;
    expect(store.effects.commit(delayedEffect, () => true).accepted).toBe(true);
    expect(documentEditorGateway.read(first.id)).toBeNull();
    expect(documentEditorGateway.read(second.id)?.markdown).toBe('{"version":2}');

    firstWrite.resolve();
    let saveResults!: [boolean, boolean];
    await act(async () => { saveResults = await Promise.all([firstSave, secondSave]); });

    const state = store.getState();
    expect(order).toEqual(['first-write', 'second-write']);
    expect(saveResults).toEqual([true, true]);
    expect(state.activeDocumentId).toBe(second.id);
    expect(state.documentsById[first.id].source.sourceText).toBe('');
    expect(state.documentsById[first.id].lifecycle).toMatchObject({ content: 'clean', recovery: 'notRequired' });
    expect(state.documentsById[second.id].source.sourceText).toBe('{"version":2}');
    expect(state.documentsById[second.id].lifecycle.content).toBe('clean');
    expect(mounted).toEqual([first.id, second.id]);
    expect(documentEditorGateway.historyFor(first.id)).not.toBe(documentEditorGateway.historyFor(second.id));
  });
});

function ActiveEditorHarness({ store, onMounted }: { store: WorkspaceStore; onMounted: (documentId: DocumentId) => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const documentId = state.activeDocumentId;
  useEffect(() => {
    if (!documentId) return undefined;
    const adapter: EditorAdapter = {
      surface: 'source',
      read: () => ({
        surface: 'source',
        markdown: store.getState().documentsById[documentId].source.sourceText,
        changed: false,
      }),
      replace: () => false,
      focus: vi.fn(),
      flushPendingEdits: () => ({
        surface: 'source',
        markdown: store.getState().documentsById[documentId].source.sourceText,
        changed: false,
      }),
    };
    documentEditorGateway.registerAdapter(documentId, 'source', adapter);
    onMounted(documentId);
    return () => documentEditorGateway.unregisterAdapter(documentId, 'source', adapter);
  }, [documentId, onMounted, store]);
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
