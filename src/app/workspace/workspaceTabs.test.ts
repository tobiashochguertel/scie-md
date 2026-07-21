import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDocumentRecord } from '../documentRecord';
import { fallbackFileLocator } from '../documentIdentity';
import { createWorkspaceState, workspaceReducer } from './workspaceState';
import { createWorkspaceTabsModel, PRODUCTION_WORKSPACE_CAPABILITY } from './workspaceTabs';

describe('workspace tabs contract', () => {
  it('enables the production flag and activation surface atomically', () => {
    expect(PRODUCTION_WORKSPACE_CAPABILITY).toEqual({
      multiDocumentWorkspaceEnabled: true,
      activationSurface: { id: 'desktop-workspace-tabs', kind: 'production-tabs' },
    });
  });

  it('projects heterogeneous duplicate names and textual lifecycle states', () => {
    const markdown = createDocumentRecord({
      locator: fallbackFileLocator('C:\\papers\\paper.md'),
      format: 'markdown',
      sourceText: 'changed',
      savedSourceText: 'saved',
    });
    const json = createDocumentRecord({ locator: fallbackFileLocator('C:\\data\\paper.md'), format: 'json', sourceText: '{}' });
    const text = createDocumentRecord({ locator: fallbackFileLocator('C:\\notes\\readme.txt'), format: 'plainText', sourceText: 'notes' });
    let state = createWorkspaceState(markdown, PRODUCTION_WORKSPACE_CAPABILITY);
    state = workspaceReducer(state, { type: 'openDocument', document: json });
    state = workspaceReducer(state, { type: 'openDocument', document: text });
    state = workspaceReducer(state, { type: 'updateDocument', documentId: markdown.id, action: { type: 'autosaveStatusChanged', autosaveStatus: 'error' } });
    state = workspaceReducer(state, { type: 'updateDocument', documentId: json.id, action: { type: 'accessChanged', access: 'readOnly' } });
    state = workspaceReducer(state, { type: 'updateDocument', documentId: json.id, action: { type: 'externalConflictChanged', externalConflict: true } });

    const model = createWorkspaceTabsModel(state);
    expect(model.tabs.map((tab) => tab.formatLabel)).toEqual(['MARKDOWN', 'JSON', 'Text']);
    expect(model.tabs[0].label).toContain('papers');
    expect(model.tabs[1].label).toContain('data');
    expect(model.tabs[0].statuses).toEqual(expect.arrayContaining(['Unsaved', 'Save failed', 'Recovery pending']));
    expect(model.tabs[1].statuses).toEqual(expect.arrayContaining(['Changed on disk', 'Read only']));
    expect(model.tabs[2].accessibleName).toContain('tab 3 of 3');
    expect(model.mruDocumentId).toBe(json.id);
  });

  it('projects many tabs without creating editor or panel instances', () => {
    const first = createDocumentRecord({ sourceText: '0' });
    let state = createWorkspaceState(first, PRODUCTION_WORKSPACE_CAPABILITY);
    for (let index = 1; index < 60; index += 1) {
      state = workspaceReducer(state, { type: 'newDocument', document: createDocumentRecord({ sourceText: String(index) }) });
    }
    const model = createWorkspaceTabsModel(state);
    expect(model.tabs).toHaveLength(60);
    expect(model.tabs.filter((tab) => tab.active)).toHaveLength(1);
  });

  it('keeps the VS Code extension free of a desktop workspace fork', () => {
    const files = listFiles(join(process.cwd(), 'scie-md-vscode-extension', 'src'));
    expect(files.some((path) => /workspace(?:tabs?|store|state)/i.test(path))).toBe(false);
  });

  it('keeps overflow, 200-percent zoom, and forced-color rules explicit', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'styles', 'app.shell.css'), 'utf8');
    expect(css).toContain('overflow-x: auto');
    expect(css).toContain('(min-resolution: 1.75dppx)');
    expect(css).toContain('@media (forced-colors: active)');
  });
});

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}
