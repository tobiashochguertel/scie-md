import { describe, expect, it } from 'vitest';
import { fallbackFileLocator } from '../documentIdentity';
import { createDocumentRecord, documentRecordReducer } from '../documentRecord';
import { createHiddenWorkspaceHarness } from './hiddenWorkspaceHarness';
import { createWorkspaceShellProjection } from './workspaceShellProjection';

describe('workspace shell projection', () => {
  it('switches every active format projection without transferring document ownership', () => {
    const markdown = createDocumentRecord({ locator: fallbackFileLocator('C:\\docs\\paper.md'), sourceText: '# Paper' });
    const json = createDocumentRecord({ locator: fallbackFileLocator('C:\\docs\\data.json'), format: 'json', sourceText: '{"ok":true}' });
    const plain = createDocumentRecord({ format: 'plainText', sourceText: 'notes', mode: 'visual' });
    const store = createHiddenWorkspaceHarness(markdown);
    store.dispatch({ type: 'openDocument', document: json });
    store.dispatch({ type: 'openDocument', document: plain });

    expect(createWorkspaceShellProjection(store.getState()).active).toMatchObject({
      documentId: plain.id,
      format: 'plainText',
      mode: 'source',
      chrome: { displayName: 'Untitled.txt' },
    });
    store.dispatch({ type: 'activateDocument', documentId: json.id });
    expect(createWorkspaceShellProjection(store.getState()).active).toMatchObject({
      documentId: json.id,
      format: 'json',
      mode: 'visual',
      formatCapabilities: { canUseStructuredVisualMode: true, canUseMarkdownToolbar: false },
      chrome: { displayName: 'data.json' },
    });
    store.dispatch({ type: 'activateDocument', documentId: markdown.id });
    expect(createWorkspaceShellProjection(store.getState()).active.formatCapabilities.canUseMarkdownToolbar).toBe(true);
    expect(store.getState().documentsById[json.id].source.sourceText).toBe('{"ok":true}');
    expect(store.getState().documentsById[plain.id].source.sourceText).toBe('notes');
  });

  it('projects active dirty state and aggregate background work into title and accessible status', () => {
    const clean = createDocumentRecord({ locator: fallbackFileLocator('C:\\docs\\clean.md'), sourceText: 'clean' });
    let background = createDocumentRecord({ locator: fallbackFileLocator('C:\\docs\\dirty.json'), format: 'json', sourceText: '{}' });
    background = documentRecordReducer(background, { type: 'sourceChanged', sourceText: '{"dirty":true}' });
    background = documentRecordReducer(background, { type: 'autosaveStatusChanged', autosaveStatus: 'saving' });
    background = documentRecordReducer(background, { type: 'externalConflictChanged', externalConflict: true });
    const store = createHiddenWorkspaceHarness(clean);
    store.dispatch({ type: 'openDocument', document: background });
    store.dispatch({ type: 'activateDocument', documentId: clean.id });

    const cleanProjection = createWorkspaceShellProjection(store.getState());
    expect(cleanProjection.active.chrome).toMatchObject({
      activeDirty: false,
      unsavedCount: 1,
      backgroundUnsavedCount: 1,
      aggregateStatus: '1 unsaved, 1 saving, 1 conflicted, 1 recovery pending',
      windowTitle: 'clean.md · 1 unsaved - ScieMD',
    });

    store.dispatch({ type: 'activateDocument', documentId: background.id });
    const dirtyProjection = createWorkspaceShellProjection(store.getState());
    expect(dirtyProjection.active.chrome.windowTitle).toBe('* dirty.json · 1 unsaved - ScieMD');
    expect(dirtyProjection.active.chrome.backgroundUnsavedCount).toBe(0);
  });
});
