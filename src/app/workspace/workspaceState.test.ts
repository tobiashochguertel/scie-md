import { describe, expect, it } from 'vitest';
import { createDocumentId, createUntitledLocator, fallbackFileLocator, normalizeNativeLocator } from '../documentIdentity';
import { createDocumentRecord, documentRecordReducer } from '../documentRecord';
import { createHiddenWorkspaceHarness } from './hiddenWorkspaceHarness';
import {
  assertValidWorkspaceState,
  createWorkspaceLocatorIndex,
  createWorkspaceState,
  selectActiveDocument,
  workspaceReducer,
  type WorkspaceCommand,
} from './workspaceState';

function fileRecord(path: string, format: 'markdown' | 'json' | 'plainText' = 'markdown') {
  return createDocumentRecord({ locator: fallbackFileLocator(path), format, sourceText: `${format}:${path}` });
}

describe('workspace state and commands', () => {
  it('defaults to one-visible-document compatibility and refuses a second record', () => {
    const first = fileRecord('C:\\docs\\first.md');
    const second = fileRecord('C:\\docs\\second.json', 'json');
    const initial = createWorkspaceState(first);
    const refused = workspaceReducer(initial, { type: 'openDocument', document: second });

    expect(refused.tabOrder).toEqual([first.id]);
    expect(refused.activeDocumentId).toBe(first.id);
    expect(refused.invariantDiagnostics.at(-1)).toMatchObject({ code: 'MULTI_DOCUMENT_DISABLED', command: 'openDocument' });
  });

  it('fails closed when the flag is enabled without an activation surface', () => {
    const first = fileRecord('C:\\docs\\first.md');
    const second = fileRecord('C:\\docs\\second.json', 'json');
    const initial = createWorkspaceState(first, { multiDocumentWorkspaceEnabled: true });
    const refused = workspaceReducer(initial, { type: 'openDocument', document: second });

    expect(refused.tabOrder).toEqual([first.id]);
    expect(refused.invariantDiagnostics.at(-1)).toMatchObject({ code: 'ACTIVATION_SURFACE_REQUIRED' });
  });

  it('keeps Markdown, JSON, and untitled plain text isolated in the hidden harness', () => {
    const markdown = fileRecord('C:\\docs\\paper.md');
    const json = fileRecord('C:\\docs\\data.json', 'json');
    const plainText = createDocumentRecord({ format: 'plainText', sourceText: 'notes' });
    const harness = createHiddenWorkspaceHarness(markdown);

    harness.dispatch({ type: 'openDocument', document: json });
    harness.dispatch({ type: 'newDocument', document: plainText });
    harness.dispatch({ type: 'updateDocument', documentId: markdown.id, action: { type: 'sourceChanged', sourceText: '# changed' } });
    harness.dispatch({ type: 'updateDocument', documentId: json.id, action: { type: 'viewChanged', view: { selectedStructuredPath: '$.samples[0]' } } });
    harness.dispatch({ type: 'activateDocument', documentId: markdown.id });

    const state = harness.getState();
    expect(state.tabOrder).toEqual([markdown.id, json.id, plainText.id]);
    expect(selectActiveDocument(state)?.id).toBe(markdown.id);
    expect(state.documentsById[markdown.id].source.sourceText).toBe('# changed');
    expect(state.documentsById[json.id].source.sourceText).toBe('json:C:\\docs\\data.json');
    expect(state.documentsById[json.id].view.selectedStructuredPath).toBe('$.samples[0]');
    expect(state.documentsById[plainText.id]).toMatchObject({ format: 'plainText', source: { sourceText: 'notes' } });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('makes duplicate locator Open idempotent, focuses the owner, and retains aliases', () => {
    const first = fileRecord('C:\\docs\\paper.md');
    const second = fileRecord('C:\\docs\\data.json', 'json');
    const harness = createHiddenWorkspaceHarness(first);
    harness.dispatch({ type: 'openDocument', document: second });
    const firstStableLocator = { ...fallbackFileLocator('C:\\docs\\paper.md'), stableFileId: 'file:1', identityConfidence: 'stableFileId' as const };
    const alias = createDocumentRecord({
      locator: { ...fallbackFileLocator('C:\\DOCS\\paper.md'), displayPath: 'C:\\alias\\paper.md', stableFileId: 'file:1', identityConfidence: 'stableFileId' },
      sourceText: 'must not replace existing content',
    });
    harness.dispatch({
      type: 'replaceDocument',
      documentId: first.id,
      document: { ...first, locator: firstStableLocator },
    });
    harness.dispatch({ type: 'openDocument', document: alias });

    const state = harness.getState();
    expect(state.tabOrder).toHaveLength(2);
    expect(state.activeDocumentId).toBe(first.id);
    expect(state.documentsById[first.id].source.sourceText).toBe('markdown:C:\\docs\\paper.md');
    expect(state.documentsById[first.id].locator).toMatchObject({ displayPath: 'C:\\docs\\paper.md', aliases: ['C:\\alias\\paper.md'] });
  });

  it('updates the locator index on Save As and blocks collisions and competing reservations', () => {
    const first = fileRecord('C:\\docs\\first.md');
    const second = fileRecord('C:\\docs\\second.md');
    const harness = createHiddenWorkspaceHarness(first);
    harness.dispatch({ type: 'openDocument', document: second });
    const target = fallbackFileLocator('C:\\docs\\renamed.md');
    harness.dispatch({ type: 'reserveLocator', documentId: first.id, locator: target });
    harness.dispatch({ type: 'updateDocument', documentId: first.id, action: { type: 'locatorChanged', locator: target } });

    let state = harness.getState();
    expect(createWorkspaceLocatorIndex(state).get(`path:${target.comparisonKey}`)).toBe(first.id);
    expect(state.locatorReservations).toEqual([]);

    harness.dispatch({ type: 'reserveLocator', documentId: second.id, locator: target });
    state = harness.getState();
    expect(state.locatorReservations).toEqual([]);
    expect(state.invariantDiagnostics.at(-1)).toMatchObject({ code: 'LOCATOR_COLLISION', documentId: second.id });
  });

  it('blocks a later stable-file identity discovery that would create two owners', () => {
    const first = fileRecord('C:\\docs\\first.md');
    const second = fileRecord('C:\\docs\\second.md');
    const harness = createHiddenWorkspaceHarness(first);
    harness.dispatch({ type: 'openDocument', document: second });
    const firstStable = normalizeNativeLocator({
      displayPath: 'C:\\docs\\first.md', comparisonKey: 'c:/docs/first.md', stableFileId: 'volume:42', identityConfidence: 'stableFileId',
    }, 'C:\\docs\\first.md');
    const discoveredAlias = normalizeNativeLocator({
      displayPath: 'C:\\docs\\second.md', comparisonKey: 'c:/docs/second.md', stableFileId: 'volume:42', identityConfidence: 'stableFileId',
    }, 'C:\\docs\\second.md');
    harness.dispatch({ type: 'updateDocument', documentId: first.id, action: { type: 'locatorChanged', locator: firstStable } });
    harness.dispatch({ type: 'updateDocument', documentId: second.id, action: { type: 'locatorChanged', locator: discoveredAlias } });

    expect(harness.getState().documentsById[second.id].locator).toEqual(second.locator);
    expect(harness.getState().invariantDiagnostics.at(-1)).toMatchObject({ code: 'LOCATOR_COLLISION', documentId: second.id });
  });

  it('keeps several untitled identities distinct', () => {
    const first = createDocumentRecord({ locator: createUntitledLocator() });
    const second = createDocumentRecord({ locator: createUntitledLocator() });
    const third = createDocumentRecord({ locator: createUntitledLocator() });
    const harness = createHiddenWorkspaceHarness(first);
    harness.dispatch({ type: 'newDocument', document: second });
    harness.dispatch({ type: 'newDocument', document: third });

    expect(harness.getState().tabOrder).toEqual([first.id, second.id, third.id]);
    const untitledIds = harness.getState().tabOrder.map((id) => {
      const locator = harness.getState().documentsById[id].locator;
      return locator.kind === 'untitled' ? locator.untitledId : null;
    });
    expect(new Set(untitledIds).size).toBe(3);
  });

  it('activation and reordering never mutate document content', () => {
    const first = fileRecord('C:\\docs\\first.md');
    const second = fileRecord('C:\\docs\\second.json', 'json');
    const harness = createHiddenWorkspaceHarness(first);
    harness.dispatch({ type: 'openDocument', document: second });
    const before = JSON.stringify(harness.getState().documentsById);
    harness.dispatch({ type: 'activateDocument', documentId: first.id });
    harness.dispatch({ type: 'reorderDocument', documentId: second.id, toIndex: 0 });

    expect(JSON.stringify(harness.getState().documentsById)).toBe(before);
    expect(harness.getState().tabOrder).toEqual([second.id, first.id]);
    expect(harness.getState().recentlyActiveDocumentIds).toEqual([first.id, second.id]);
  });

  it('requires a matching close request and durability authorization before removal', () => {
    const clean = fileRecord('C:\\docs\\clean.md');
    const dirty = documentRecordReducer(fileRecord('C:\\docs\\dirty.md'), { type: 'sourceChanged', sourceText: 'dirty' });
    const harness = createHiddenWorkspaceHarness(clean);
    harness.dispatch({ type: 'openDocument', document: dirty });

    harness.dispatch({
      type: 'finalizeRemoveDocument',
      authorization: { requestId: 'forged', documentId: dirty.id, sourceRevision: dirty.source.revision, outcome: 'discarded' },
    });
    expect(harness.getState().documentsById[dirty.id]).toBeDefined();
    expect(harness.getState().invariantDiagnostics.at(-1)?.code).toBe('CLOSE_NOT_REQUESTED');

    harness.dispatch({ type: 'requestClose', documentId: dirty.id, requestId: 'close-dirty' });
    harness.dispatch({ type: 'updateDocument', documentId: dirty.id, action: { type: 'sourceChanged', sourceText: 'newer dirty revision' } });
    harness.dispatch({
      type: 'finalizeRemoveDocument',
      authorization: { requestId: 'close-dirty', documentId: dirty.id, sourceRevision: dirty.source.revision, outcome: 'clean' },
    });
    expect(harness.getState().documentsById[dirty.id]).toBeDefined();
    expect(harness.getState().invariantDiagnostics.at(-1)?.code).toBe('CLOSE_AUTHORIZATION_INVALID');

    const currentDirty = harness.getState().documentsById[dirty.id];
    harness.dispatch({ type: 'requestClose', documentId: dirty.id, requestId: 'close-current-dirty' });

    harness.dispatch({
      type: 'finalizeRemoveDocument',
      authorization: { requestId: 'close-current-dirty', documentId: dirty.id, sourceRevision: currentDirty.source.revision, outcome: 'discarded' },
    });
    expect(harness.getState().documentsById[dirty.id]).toBeUndefined();
    expect(harness.getState().activeDocumentId).toBe(clean.id);
  });

  it('supports close-others, close-right, active removal, and reopen without bypassing requests', () => {
    const first = fileRecord('C:\\docs\\first.md');
    const second = fileRecord('C:\\docs\\second.json', 'json');
    const third = createDocumentRecord({ format: 'plainText', sourceText: 'third' });
    const harness = createHiddenWorkspaceHarness(first);
    harness.dispatch({ type: 'openDocument', document: second });
    harness.dispatch({ type: 'newDocument', document: third });
    harness.dispatch({ type: 'closeRight', documentId: first.id, requests: { [second.id]: 'second', [third.id]: 'third' } as Record<ReturnType<typeof createDocumentId>, string> });
    expect(Object.keys(harness.getState().pendingCloseRequests)).toEqual([second.id, third.id]);

    harness.dispatch({
      type: 'finalizeRemoveDocument',
      authorization: { requestId: 'third', documentId: third.id, sourceRevision: third.source.revision, outcome: 'clean' },
    });
    expect(harness.getState().activeDocumentId).toBe(second.id);
    harness.dispatch({ type: 'reopenDocument', documentId: third.id });
    expect(harness.getState().activeDocumentId).toBe(third.id);

    harness.dispatch({ type: 'closeOthers', documentId: third.id, requests: { [first.id]: 'first', [second.id]: 'second-again' } as Record<ReturnType<typeof createDocumentId>, string> });
    expect(harness.getState().pendingCloseRequests[first.id]?.requestId).toBe('first');
    expect(harness.getState().pendingCloseRequests[second.id]?.requestId).toBe('second-again');
  });

  it('rejects stale single-document replacements and accepts the settled active revision', () => {
    const first = documentRecordReducer(fileRecord('C:\\docs\\first.md'), { type: 'sourceChanged', sourceText: 'dirty' });
    const next = fileRecord('C:\\docs\\next.md');
    let state = createWorkspaceState(first);
    state = workspaceReducer(state, {
      type: 'replaceActiveDocument',
      document: next,
      authorization: { kind: 'settled-single-document-replacement', documentId: first.id, sourceRevision: 0 as never },
    });
    expect(state.activeDocumentId).toBe(first.id);
    expect(state.invariantDiagnostics.at(-1)?.code).toBe('STALE_REPLACEMENT');

    state = workspaceReducer(state, {
      type: 'replaceActiveDocument',
      document: next,
      authorization: { kind: 'settled-single-document-replacement', documentId: first.id, sourceRevision: first.source.revision },
    });
    expect(state).toMatchObject({ activeDocumentId: next.id, tabOrder: [next.id] });
  });

  it('preserves workspace invariants across deterministic randomized command sequences', () => {
    const records = Array.from({ length: 8 }, (_, index) => createDocumentRecord({ sourceText: `document-${index}` }));
    let state = createWorkspaceState(records[0], {
      multiDocumentWorkspaceEnabled: true,
      activationSurface: { id: 'property-harness', kind: 'hidden-harness' },
    });
    for (const record of records.slice(1)) state = workspaceReducer(state, { type: 'newDocument', document: record });
    let seed = 0x5c1e7;
    const random = (max: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % max;
    };
    for (let index = 0; index < 250; index += 1) {
      const ids = state.tabOrder;
      const documentId = ids[random(ids.length)];
      const commands: WorkspaceCommand[] = [
        { type: 'activateDocument', documentId },
        { type: 'reorderDocument', documentId, toIndex: random(ids.length) },
        { type: 'updateDocument', documentId, action: { type: 'viewChanged', view: { selectedStructuredPath: `$.${index}` } } },
        { type: 'deactivateDocument', documentId },
      ];
      state = workspaceReducer(state, commands[random(commands.length)]);
      expect(assertValidWorkspaceState(state)).toBe(state);
      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    }
  });
});
