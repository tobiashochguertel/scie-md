import { describe, expect, it } from 'vitest';
import { fallbackFileLocator } from '../documentIdentity';
import { createDocumentRecord, documentRecordReducer } from '../documentRecord';
import { createHiddenWorkspaceHarness } from './hiddenWorkspaceHarness';
import { createWorkspaceState } from './workspaceState';
import { createWorkspaceStore } from './workspaceStore';

describe('workspace ingress coordinator', () => {
  it('serializes mixed ingress, preserves order, and isolates per-entry failure', async () => {
    const first = createDocumentRecord();
    const store = createHiddenWorkspaceHarness(first);
    const order: string[] = [];
    const failure = store.ingress.enqueue('drop', async () => { order.push('bad'); throw new Error('bad read'); });
    const success = store.ingress.enqueue('explorer', async () => { order.push('good'); return true; });
    await expect(failure).rejects.toThrow('bad read');
    await expect(success).resolves.toBe(true);
    expect(order).toEqual(['bad', 'good']);
    expect(store.ingress.diagnostics().at(-1)).toMatchObject({ code: 'TASK_FAILED', origin: 'drop' });
  });

  it('adds heterogeneous records and focuses canonical duplicate locators with the hidden surface', () => {
    const first = createDocumentRecord({ locator: fallbackFileLocator('C:\\docs\\first.md') });
    const store = createHiddenWorkspaceHarness(first);
    const json = createDocumentRecord({ locator: fallbackFileLocator('C:\\docs\\data.json'), format: 'json' });
    const add = store.ingress.route(request(store, json, 'open'));
    const duplicate = createDocumentRecord({ locator: fallbackFileLocator('c:/docs/data.json'), format: 'json' });
    const focus = store.ingress.route(request(store, duplicate, 'open'));

    expect(add.status).toBe('added');
    expect(focus).toMatchObject({ status: 'focused', documentId: json.id });
    expect(store.getState().tabOrder).toEqual([first.id, json.id]);
  });

  it('uses explicit compatibility replacement when production multi-document capability is off', () => {
    const first = createDocumentRecord({ sourceText: 'first' });
    const store = createWorkspaceStore(createWorkspaceState(first));
    const second = createDocumentRecord({ sourceText: 'second' });
    const result = store.ingress.route(request(store, second, 'open'));

    expect(result.status).toBe('replaced');
    expect(store.getState().tabOrder).toEqual([second.id]);
    expect(store.getState().documentsById[first.id]).toBeUndefined();
  });

  it('refuses and preserves a second request when the capability lacks an activation surface', () => {
    const first = createDocumentRecord();
    const store = createWorkspaceStore(createWorkspaceState(first, { multiDocumentWorkspaceEnabled: true }));
    const second = createDocumentRecord();
    const result = store.ingress.route(request(store, second, 'new'));

    expect(result.status).toBe('deferred');
    expect(store.getState().tabOrder).toEqual([first.id]);
    expect(store.ingress.deferred().map((entry) => entry.document.id)).toEqual([second.id]);
    expect(store.ingress.diagnostics().at(-1)).toMatchObject({ code: 'DEFERRED_ACTIVATION_SURFACE_REQUIRED', origin: 'new' });
  });

  it('gives every New request a distinct durable identity', () => {
    const store = createHiddenWorkspaceHarness(createDocumentRecord());
    const firstNew = createDocumentRecord();
    const secondNew = createDocumentRecord();
    store.ingress.route(request(store, firstNew, 'new'));
    store.ingress.route(request(store, secondNew, 'new'));
    expect(new Set(store.getState().tabOrder).size).toBe(3);
  });

  it('preserves dirty, saving, and externally conflicted state when another document is added', () => {
    let first = createDocumentRecord({ sourceText: 'saved' });
    first = documentRecordReducer(first, { type: 'sourceChanged', sourceText: 'local edits' });
    first = documentRecordReducer(first, { type: 'autosaveStatusChanged', autosaveStatus: 'saving' });
    first = documentRecordReducer(first, { type: 'externalConflictChanged', externalConflict: true });
    const store = createHiddenWorkspaceHarness(first);
    const lifecycleBefore = store.getState().documentsById[first.id].lifecycle;

    store.ingress.route(request(store, createDocumentRecord({ sourceText: 'second' }), 'open'));

    expect(store.getState().documentsById[first.id]).toMatchObject({
      source: { sourceText: 'local edits' },
      lifecycle: lifecycleBefore,
    });
  });
});

function request(
  store: ReturnType<typeof createHiddenWorkspaceHarness> | ReturnType<typeof createWorkspaceStore>,
  document: ReturnType<typeof createDocumentRecord>,
  kind: 'open' | 'new',
) {
  const active = store.getState().documentsById[store.getState().activeDocumentId!];
  return {
    origin: kind === 'new' ? 'new' as const : 'picker' as const,
    kind,
    document,
    replacementAuthorization: {
      kind: 'settled-single-document-replacement' as const,
      documentId: active.id,
      sourceRevision: active.source.revision,
    },
  };
}
