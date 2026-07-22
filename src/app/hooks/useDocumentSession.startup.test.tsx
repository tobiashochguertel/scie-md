import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_METADATA } from '../documentState';
import { createHostReadResponse, type FileMetadata, type ReadTextFileResponse } from '../documentState';
import type { DocumentHost } from '../host/documentHost';
import { DocumentHostError } from '../host/documentHostError';
import { loadSettings } from '../../services/settingsService';
import type { PersistedSettings } from '../../services/settingsService';
import type { AuthorshipMark } from '../../markdown/authorship';
import type { ConfirmState } from './useDialogs';
import { useDocumentSession } from './useDocumentSession';
import { fallbackFileLocator } from '../documentIdentity';
import { defaultManifestView } from '../../services/persistence';
import { resetWorkspaceManifestForTests, saveWorkspaceManifest, WORKSPACE_MANIFEST_STORAGE_KEY } from '../../services/workspaceManifestService';
import { resetRecoveryCatalogForTests } from '../../services/recoveryCatalog';
import type { WorkspaceCapabilityState } from '../workspace/workspaceState';
import { HIDDEN_WORKSPACE_ACTIVATION_SURFACE } from '../workspace/hiddenWorkspaceHarness';
import { PRODUCTION_WORKSPACE_CAPABILITY } from '../workspace/workspaceTabs';
import type { DocumentSourceResidencyBudgets } from '../runtime/documentSourceResidency';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    close: vi.fn().mockResolvedValue(undefined),
    onCloseRequested: vi.fn().mockResolvedValue(vi.fn()),
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type SessionState = ReturnType<typeof useDocumentSession>;

describe('useDocumentSession startup fallback', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestState: SessionState | null;
  let pushToast: ReturnType<typeof vi.fn<(text: string, tone?: 'info' | 'success' | 'warning' | 'error') => void>>;
  let confirmText: ReturnType<typeof vi.fn<() => Promise<boolean>>>;

  beforeEach(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    localStorage.clear();
    resetWorkspaceManifestForTests();
    resetRecoveryCatalogForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latestState = null;
    pushToast = vi.fn<(text: string, tone?: 'info' | 'success' | 'warning' | 'error') => void>();
    confirmText = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    localStorage.clear();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('records no-path startup diagnostics and settles without a failure banner', async () => {
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    renderSession(host);

    await flushAsync();

    expect(latestState?.startupDocumentOpenPending).toBe(false);
    expect(latestState?.startupDocumentOpenFailure).toBeNull();
    expect(host.recovery.appendDiagnosticsEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'startup-open-no-path',
      documentPath: null,
    }));
  });

  it('restores the persisted workspace through the production startup consumer', async () => {
    const path = 'C:\\Users\\amin_\\restored.md';
    await saveWorkspaceManifest({
      tabOrder: ['restored'],
      activeDocumentId: 'restored',
      recentlyActiveDocumentIds: ['restored'],
      documents: [{
        documentId: 'restored',
        locator: { ...fallbackFileLocator(path), aliases: [] },
        format: 'markdown',
        view: { ...defaultManifestView(), mode: 'source' },
        presentation: { visualStyle: 'academic', documentType: 'report' },
        recoveryReference: null,
      }],
      recoveryReferences: [],
      invalidEntries: [],
      savedAt: 1,
    });
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    host.file.readTextFileForEdit.mockResolvedValue(readResponse('# Restored workspace\n'));
    renderSession(host);

    await flushAsync();

    expect(latestState?.markdown).toBe('# Restored workspace\n');
    expect(latestState?.filePath).toBe(path);
    expect(latestState?.mode).toBe('source');
    expect(host.recovery.loadUntitledDraft).not.toHaveBeenCalled();
  });

  it('routes a production watcher event through the workspace into the current conflict projection', async () => {
    const path = 'C:\\Users\\amin_\\watched.md';
    await saveWorkspaceManifest({
      tabOrder: ['watched'], activeDocumentId: 'watched', recentlyActiveDocumentIds: ['watched'],
      documents: [{
        documentId: 'watched', locator: { ...fallbackFileLocator(path), aliases: [] }, format: 'markdown',
        view: defaultManifestView(), presentation: { visualStyle: null, documentType: null }, recoveryReference: null,
      }],
      recoveryReferences: [], invalidEntries: [], savedAt: 1,
    });
    const initialMetadata = { ...DEFAULT_METADATA, lastKnownMtimeMs: 1000, lastKnownSizeBytes: 5, contentHash: 'base' };
    const diskMetadata = { ...initialMetadata, lastKnownMtimeMs: 2000, lastKnownSizeBytes: 9, contentHash: 'external' };
    const host = createHost();
    let emitWatch: ((event: { paths: string[]; kind: string; changedAtMs: number }) => void) | null = null;
    host.file.readTextFileForEdit.mockResolvedValue(readResponse('base\n', initialMetadata));
    host.file.statFile.mockResolvedValue(diskMetadata);
    host.file.readTextFile.mockResolvedValue(readResponse('external\n', diskMetadata));
    vi.mocked(host.watcher.listenFileWatchChanges).mockImplementation(async (handler) => {
      emitWatch = handler;
      return () => undefined;
    });
    renderSession(host);
    await flushAsync();

    await act(async () => {
      emitWatch?.({ paths: [path], kind: 'Modify', changedAtMs: 2 });
      await new Promise((resolve) => window.setTimeout(resolve, 60));
    });
    await flushAsync();

    expect(latestState?.externalConflict).toBe(true);
    expect(latestState?.documentRecord.observedExternal).toMatchObject({ contentHash: 'external' });
    expect(host.watcher.listenFileWatchChanges).toHaveBeenCalledTimes(1);
  });

  it('surfaces a quarantined future manifest without blanking startup', async () => {
    localStorage.setItem(WORKSPACE_MANIFEST_STORAGE_KEY, JSON.stringify({
      family: 'workspaceManifest', schemaVersion: 99, generation: 1, checksum: 'future', commitState: 'committed', payload: {},
    }));
    const host = createHost();
    renderSession(host);
    await flushAsync();
    expect(latestState?.startupDocumentOpenPending).toBe(false);
    expect(latestState?.workspaceRestoreOutcomes).toEqual([
      expect.objectContaining({ status: 'corrupt-manifest-entry', detail: expect.stringContaining('future-version') }),
    ]);
  });

  it('keeps a durable startup failure, records diagnostics, and clears it after retry opens the document', async () => {
    const startupPath = 'C:\\Users\\amin_\\missing.md';
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(startupPath);
    host.file.readTextFileForEdit
      .mockRejectedValueOnce(new DocumentHostError('PERMISSION_DENIED', 'File access denied'))
      .mockResolvedValueOnce(readResponse('# Recovered\n'));
    renderSession(host);

    await flushAsync();

    expect(latestState?.startupDocumentOpenPending).toBe(false);
    expect(latestState?.startupDocumentOpenFailure).toMatchObject({
      kind: 'open-failed',
      path: startupPath,
      canRetry: true,
    });
    expect(latestState?.startupDocumentOpenFailed).toBe(true);
    expect(latestState?.markdown).toBe('');
    expect(pushToast).toHaveBeenCalledWith('Use Open or Files to grant access to this document again.', 'error');
    expect(host.recovery.appendDiagnosticsEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'document-open-failed',
      documentPath: startupPath,
    }));
    expect(host.recovery.appendDiagnosticsEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'startup-open-failed',
      documentPath: startupPath,
    }));

    let retryResult: boolean | undefined;
    await act(async () => {
      retryResult = await latestState?.retryStartupDocumentOpen();
    });
    await flushAsync();

    expect(retryResult).toBe(true);
    expect(latestState?.startupDocumentOpenFailure).toBeNull();
    expect(latestState?.startupDocumentOpenFailed).toBe(false);
    expect(latestState?.filePath).toBe(startupPath);
    expect(latestState?.markdown).toBe('# Recovered\n');
    expect(host.launch.clearPendingDocumentOpen).toHaveBeenCalledWith(startupPath);
    expect(host.recovery.appendDiagnosticsEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'startup-open-retry-requested',
      documentPath: startupPath,
    }));
    expect(host.recovery.appendDiagnosticsEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'document-open-committed',
      documentPath: startupPath,
    }));
  });

  it('records fallback commits without clearing an active startup failure', async () => {
    const startupPath = 'C:\\Users\\amin_\\missing.md';
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(startupPath);
    host.file.readTextFileForEdit.mockRejectedValueOnce(new Error('Not found'));
    renderSession(host);

    await flushAsync();
    expect(latestState?.startupDocumentOpenFailure?.path).toBe(startupPath);

    act(() => {
      latestState?.recordStartupFallbackCommitted('# Welcome\n');
    });

    expect(latestState?.startupDocumentOpenFailure?.path).toBe(startupPath);
    expect(host.recovery.appendDiagnosticsEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'startup-open-fallback-committed',
      documentPath: startupPath,
      sourceTextBytes: 10,
    }));
  });

  it('waits for desktop startup path resolution before offering an untitled draft', async () => {
    const startupPath = deferred<string | null>();
    const host = createHost();
    host.launch.getInitialDocumentPath.mockReturnValue(startupPath.promise);
    host.recovery.loadUntitledDraft.mockResolvedValue({
      markdown: '# Unsaved draft\n',
      savedAt: 1000,
      format: 'markdown',
    });
    confirmText.mockResolvedValue(true);
    renderSession(host);

    await flushAsync();

    expect(host.recovery.loadUntitledDraft).not.toHaveBeenCalled();
    expect(confirmText).not.toHaveBeenCalled();

    startupPath.resolve(null);
    await flushAsync();

    expect(host.launch.getInitialDocumentPath).toHaveBeenCalledTimes(1);
    expect(host.recovery.loadUntitledDraft).toHaveBeenCalledTimes(1);
    expect(confirmText).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Restore unsaved draft?',
      okLabel: 'Restore',
    }));
    expect(latestState?.filePath).toBeNull();
    expect(latestState?.markdown).toBe('# Unsaved draft\n');
    expect(pushToast).toHaveBeenCalledWith('Restored unsaved draft.', 'warning');
  });

  it('keeps a successful startup document active instead of restoring an untitled draft over it', async () => {
    const startupPath = 'C:\\Users\\amin_\\startup.md';
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(startupPath);
    host.file.readTextFileForEdit.mockResolvedValue(readResponse('# Startup document\n'));
    host.recovery.loadUntitledDraft.mockResolvedValue({
      markdown: '# Unsaved draft\n',
      savedAt: 1000,
      format: 'markdown',
    });
    confirmText.mockResolvedValue(true);
    renderSession(host);

    await flushAsync();

    expect(host.file.readTextFileForEdit).toHaveBeenCalledWith(startupPath, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(host.recovery.loadUntitledDraft).not.toHaveBeenCalled();
    expect(confirmText).not.toHaveBeenCalled();
    expect(latestState?.filePath).toBe(startupPath);
    expect(latestState?.markdown).toBe('# Startup document\n');
  });

  it('opens structured startup documents from the native document launch path', async () => {
    const startupPath = 'C:\\Users\\amin_\\startup.json';
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(startupPath);
    host.file.readTextFileForEdit.mockResolvedValue(readResponse('{"ok":true}\n'));
    renderSession(host);

    await flushAsync();

    expect(host.file.readTextFileForEdit).toHaveBeenCalledWith(startupPath, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(host.recovery.loadUntitledDraft).not.toHaveBeenCalled();
    expect(latestState?.filePath).toBe(startupPath);
    expect(latestState?.format).toBe('json');
    expect(latestState?.mode).toBe('visual');
    expect(latestState?.workspaceState.tabOrder).toEqual([latestState?.documentId]);
    expect(latestState?.workspaceState.activeDocumentId).toBe(latestState?.documentId);
    expect(latestState?.workspaceState.capability).toEqual({ multiDocumentWorkspaceEnabled: false, activationSurface: null });
    expect(latestState?.markdown).toBe('{"ok":true}\n');
  });

  it('drains pending launch paths only after the startup handshake has settled', async () => {
    const startupPath = deferred<string | null>();
    const pendingPath = 'C:\\Users\\amin_\\pending.md';
    const host = createHost();
    host.launch.getInitialDocumentPath.mockReturnValue(startupPath.promise);
    host.launch.takePendingDocumentOpen
      .mockResolvedValueOnce(pendingPath)
      .mockResolvedValue(null);
    host.file.readTextFileForEdit.mockResolvedValue(readResponse('# Pending launch\n'));
    renderSession(host);

    await flushAsync();

    expect(host.launch.listenSingleInstanceOpen).toHaveBeenCalled();
    expect(host.launch.takePendingDocumentOpen).not.toHaveBeenCalled();
    expect(host.file.readTextFileForEdit).not.toHaveBeenCalled();

    startupPath.resolve(null);
    await flushAsync();

    expect(host.launch.takePendingDocumentOpen).toHaveBeenCalled();
    expect(host.file.readTextFileForEdit).toHaveBeenCalledWith(pendingPath, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(host.launch.clearPendingDocumentOpen).not.toHaveBeenCalledWith(pendingPath);
    expect(latestState?.filePath).toBe(pendingPath);
    expect(latestState?.markdown).toBe('# Pending launch\n');
  });

  it('opens JSON documents in preferred visual mode with JSON format state', async () => {
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    host.file.readTextFileForEdit.mockResolvedValue(readResponse('{"ok":true}\n'));
    renderSession(host);
    await flushAsync();

    let opened: boolean | undefined;
    await act(async () => {
      opened = await latestState?.handleOpen('C:\\Users\\amin_\\results.json', {
        preferredMode: 'visual',
        draftRestore: 'skip',
      });
    });
    await flushAsync();

    expect(opened).toBe(true);
    expect(latestState?.filePath).toBe('C:\\Users\\amin_\\results.json');
    expect(latestState?.format).toBe('json');
    expect(latestState?.mode).toBe('visual');
    expect(latestState?.markdown).toBe('{"ok":true}\n');
  });

  it.each([
    ['jsonl', 'C:\\Users\\amin_\\records.jsonl', '{"id":1}\n'] as const,
    ['yaml', 'C:\\Users\\amin_\\config.yaml', 'ok: true\n'] as const,
    ['toml', 'C:\\Users\\amin_\\settings.toml', 'ok = true\n'] as const,
    ['xml', 'C:\\Users\\amin_\\metadata.xml', '<root/>\n'] as const,
    ['csv', 'C:\\Users\\amin_\\samples.csv', 'name,value\nalpha,1\n'] as const,
    ['tsv', 'C:\\Users\\amin_\\samples.tsv', 'name\tvalue\nalpha\t1\n'] as const,
  ])('opens %s documents manually with format-aware visual state', async (format, path, content) => {
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    host.file.readTextFileForEdit.mockResolvedValue(readResponse(content));
    renderSession(host);
    await flushAsync();

    let opened: boolean | undefined;
    await act(async () => {
      opened = await latestState?.handleOpen(path, { draftRestore: 'skip' });
    });
    await flushAsync();

    expect(opened).toBe(true);
    expect(latestState?.filePath).toBe(path);
    expect(latestState?.format).toBe(format);
    expect(latestState?.mode).toBe('visual');
    expect(latestState?.markdown).toBe(content);
    expect(host.settings.rememberRecentFile).toHaveBeenCalledWith(path);
  });

  it('creates structured starter documents with matching format state', async () => {
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    renderSession(host);
    await flushAsync();

    await act(async () => {
      await latestState?.handleNewFromTemplate('json');
    });
    await flushAsync();

    expect(latestState?.filePath).toBeNull();
    expect(latestState?.format).toBe('json');
    expect(latestState?.mode).toBe('visual');
    expect(latestState?.markdown).toContain('"document"');
    expect(latestState?.markdown).toContain('"classes"');
    expect(pushToast).toHaveBeenCalledWith('JSON created', 'success');
  });

  it('creates a Markdown starter for the direct new-document command', async () => {
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    renderSession(host);
    await flushAsync();

    await act(async () => {
      await latestState?.handleNew();
    });
    await flushAsync();

    expect(latestState?.filePath).toBeNull();
    expect(latestState?.format).toBe('markdown');
    expect(latestState?.mode).toBe('visual');
    expect(latestState?.markdown).toBe('# Header\n\nMain text\n');
    expect(latestState?.workspaceState.tabOrder).toEqual([latestState?.documentId]);
    expect(latestState?.workspaceState.activeDocumentId).toBe(latestState?.documentId);
    expect(latestState?.workspaceState.capability).toEqual({ multiDocumentWorkspaceEnabled: false, activationSurface: null });
  });

  it('routes a multi-select picker additively through the hidden activation surface', async () => {
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    host.dialog.pickDocumentFiles = vi.fn().mockResolvedValue([
      'C:\\Users\\amin_\\paper.md',
      'C:\\Users\\amin_\\data.json',
    ]);
    host.file.readTextFileForEdit.mockImplementation(async (path) => readResponse(path.endsWith('.json') ? '{"ok":true}' : '# Paper'));
    renderSession(host, { multiDocumentWorkspaceEnabled: true, activationSurface: HIDDEN_WORKSPACE_ACTIVATION_SURFACE });
    await flushAsync();

    await act(async () => { await latestState?.handleOpen(); });
    await flushAsync();

    expect(latestState?.workspaceState.tabOrder).toHaveLength(3);
    expect(Object.values(latestState!.workspaceState.documentsById).map((record) => record.format)).toEqual(['markdown', 'markdown', 'json']);
    expect(latestState?.filePath).toBe('C:\\Users\\amin_\\data.json');
    expect(confirmText).not.toHaveBeenCalled();
  });

  it('uses the production tab capability for additive heterogeneous ingress and activation', async () => {
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    host.file.readTextFileForEdit.mockImplementation(async (path) => readResponse(path.endsWith('.json') ? '{"ok":true}' : '# Paper'));
    renderSession(host, PRODUCTION_WORKSPACE_CAPABILITY);
    await flushAsync();
    await act(async () => { await latestState?.handleOpen('C:\\docs\\paper.md', { draftRestore: 'skip' }); });
    await act(async () => { await latestState?.handleOpen('C:\\docs\\data.json', { draftRestore: 'skip' }); });

    const [initialId, markdownId, jsonId] = latestState!.workspaceState.tabOrder;
    expect(latestState?.workspaceState.capability).toEqual(PRODUCTION_WORKSPACE_CAPABILITY);
    expect(latestState?.workspaceState.documentsById[markdownId].format).toBe('markdown');
    expect(latestState?.workspaceState.documentsById[jsonId].format).toBe('json');
    act(() => { latestState?.activateWorkspaceDocument(initialId); });
    expect(latestState?.workspaceState.activeDocumentId).toBe(initialId);
  });

  it('keeps above-threshold Markdown on the source surface without layer-two parsing', async () => {
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    host.file.readTextFileForEdit.mockResolvedValue(readResponse('# Hidden Large Title', {
      lastKnownSizeBytes: (5 * 1024 * 1024) + 1,
    }));
    renderSession(host, PRODUCTION_WORKSPACE_CAPABILITY);
    await flushAsync();

    await act(async () => { await latestState?.handleOpen('C:\\docs\\large.md', { draftRestore: 'skip' }); });
    await flushAsync();

    expect(latestState?.markdown).toBe('# Hidden Large Title');
    expect(latestState?.layerTwoDocument.title).toBeNull();
    expect(latestState?.documentParsingPending).toBe(false);
  });

  it('drops clean inactive source bytes and baseline-verifies reacquisition before activation', async () => {
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    host.file.readTextFileForEdit.mockImplementation(async (path) => readResponse(path.endsWith('first.md') ? '# First source' : '# Second source'));
    renderSession(host, PRODUCTION_WORKSPACE_CAPABILITY, TINY_SOURCE_RESIDENCY_BUDGETS);
    await flushAsync();
    await act(async () => { await latestState?.handleOpen('C:\\docs\\first.md', { draftRestore: 'skip' }); });
    await act(async () => { await latestState?.handleOpen('C:\\docs\\second.md', { draftRestore: 'skip' }); });
    await flushAsync();

    const [, firstId, secondId] = latestState!.workspaceState.tabOrder;
    const cold = latestState!.workspaceState.documentsById[firstId];
    expect(cold.source.residency.kind).toBe('coldClean');
    expect(cold.source.sourceText).toBe('');
    expect(cold.source.buffer.current.text).toEqual({ segments: [], length: 0 });

    await act(async () => { await latestState?.activateWorkspaceDocument(firstId); });
    await flushAsync();

    expect(latestState?.workspaceState.activeDocumentId).toBe(firstId);
    expect(latestState?.workspaceState.documentsById[firstId].source.sourceText).toBe('# First source');
    expect(latestState?.workspaceState.documentsById[firstId].source.residency.kind).toBe('resident');
    expect(latestState?.workspaceState.documentsById[secondId].source.residency.kind).toBe('coldClean');
    expect(host.file.readTextFileForEdit).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['baseline mismatch', async () => readResponse('# Changed source')],
    ['missing file', async () => { throw new DocumentHostError('NOT_FOUND', 'File is missing'); }],
    ['permission failure', async () => { throw new DocumentHostError('PERMISSION_DENIED', 'File access denied'); }],
  ])('keeps a cold document inactive on %s during reacquisition', async (_caseName, failedRead) => {
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    host.file.readTextFileForEdit.mockImplementation(async (path) => readResponse(path.endsWith('first.md') ? '# First source' : '# Second source'));
    renderSession(host, PRODUCTION_WORKSPACE_CAPABILITY, TINY_SOURCE_RESIDENCY_BUDGETS);
    await flushAsync();
    await act(async () => { await latestState?.handleOpen('C:\\docs\\first.md', { draftRestore: 'skip' }); });
    await act(async () => { await latestState?.handleOpen('C:\\docs\\second.md', { draftRestore: 'skip' }); });
    await flushAsync();
    const [, firstId, secondId] = latestState!.workspaceState.tabOrder;
    host.file.readTextFileForEdit.mockImplementationOnce(failedRead);

    let activated: boolean | undefined;
    await act(async () => { activated = await latestState?.activateWorkspaceDocument(firstId); });
    await flushAsync();

    expect(activated).toBe(false);
    expect(latestState?.workspaceState.activeDocumentId).toBe(secondId);
    expect(latestState?.workspaceState.documentsById[firstId].source.residency.kind).toBe('coldClean');
    expect(latestState?.workspaceState.documentsById[firstId].source.sourceText).toBe('');
    expect(pushToast).toHaveBeenCalledWith(expect.stringContaining('cold document'), 'warning');
  });

  it('focuses an alias duplicate without rereading or duplicating its record', async () => {
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    renderSession(host, { multiDocumentWorkspaceEnabled: true, activationSurface: HIDDEN_WORKSPACE_ACTIVATION_SURFACE });
    await flushAsync();
    await act(async () => { await latestState?.handleOpen('C:\\Docs\\Paper.md', { draftRestore: 'skip' }); });
    await act(async () => { await latestState?.handleOpen('c:/docs/paper.md', { draftRestore: 'skip' }); });

    expect(latestState?.workspaceState.tabOrder).toHaveLength(2);
    expect(host.file.readTextFileForEdit).toHaveBeenCalledTimes(1);
  });

  it('drains every queued native path in FIFO order under the hidden surface', async () => {
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    host.launch.takePendingDocumentOpen
      .mockResolvedValueOnce('C:\\queue\\one.md')
      .mockResolvedValueOnce('C:\\queue\\two.json')
      .mockResolvedValueOnce('C:\\queue\\three.txt')
      .mockResolvedValue(null);
    host.file.readTextFileForEdit.mockImplementation(async (path) => readResponse(path));
    renderSession(host, { multiDocumentWorkspaceEnabled: true, activationSurface: HIDDEN_WORKSPACE_ACTIVATION_SURFACE });
    await flushAsync();

    expect(host.file.readTextFileForEdit.mock.calls.map(([path]) => path)).toEqual([
      'C:\\queue\\one.md', 'C:\\queue\\two.json', 'C:\\queue\\three.txt',
    ]);
    expect(latestState?.workspaceState.tabOrder).toHaveLength(4);
    expect(latestState?.filePath).toBe('C:\\queue\\three.txt');
  });

  it('keeps a dirty document intact when a warm single-instance path arrives', async () => {
    let listener: ((path: string) => void) | null = null;
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    host.launch.listenSingleInstanceOpen.mockImplementation(async (callback) => { listener = callback; return vi.fn<() => void>(); });
    host.launch.takePendingDocumentOpen
      .mockResolvedValueOnce('C:\\warm\\second.json')
      .mockResolvedValue(null);
    host.file.readTextFileForEdit.mockResolvedValue(readResponse('{"second":true}'));
    renderSession(host, { multiDocumentWorkspaceEnabled: true, activationSurface: HIDDEN_WORKSPACE_ACTIVATION_SURFACE });
    await flushAsync();
    act(() => latestState?.setSourceText('dirty first'));
    act(() => listener?.('C:\\warm\\second.json'));
    await flushAsync();

    const records = Object.values(latestState!.workspaceState.documentsById);
    expect(records.some((record) => record.source.sourceText === 'dirty first' && record.lifecycle.content === 'dirty')).toBe(true);
    expect(latestState?.filePath).toBe('C:\\warm\\second.json');
    expect(confirmText).not.toHaveBeenCalled();
  });

  it('isolates unsupported and failed picker entries while opening healthy siblings', async () => {
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    host.dialog.pickDocumentFiles = vi.fn().mockResolvedValue([
      'C:\\batch\\unsupported.pdf',
      'C:\\batch\\bad.md',
      'C:\\batch\\good.json',
    ]);
    host.file.readTextFileForEdit.mockImplementation(async (path) => {
      if (path.endsWith('bad.md')) throw new Error('read failed');
      return readResponse('{"good":true}');
    });
    renderSession(host, { multiDocumentWorkspaceEnabled: true, activationSurface: HIDDEN_WORKSPACE_ACTIVATION_SURFACE });
    await flushAsync();
    await act(async () => { await latestState?.handleOpen(); });
    await flushAsync();

    expect(host.file.readTextFileForEdit).not.toHaveBeenCalledWith('C:\\batch\\unsupported.pdf');
    expect(latestState?.filePath).toBe('C:\\batch\\good.json');
    expect(latestState?.workspaceState.tabOrder).toHaveLength(2);
  });

  it('preserves a second ingress request when the enabled capability has no activation surface', async () => {
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    renderSession(host, { multiDocumentWorkspaceEnabled: true, activationSurface: null });
    await flushAsync();
    let opened: boolean | undefined;
    await act(async () => { opened = await latestState?.handleOpen('C:\\docs\\deferred.md', { draftRestore: 'skip' }); });
    expect(opened).toBe(false);
    expect(latestState?.workspaceState.tabOrder).toHaveLength(1);
    expect(latestState?.filePath).toBeNull();
  });

  it('creates unique additive New and template documents', async () => {
    const host = createHost();
    host.launch.getInitialDocumentPath.mockResolvedValue(null);
    renderSession(host, { multiDocumentWorkspaceEnabled: true, activationSurface: HIDDEN_WORKSPACE_ACTIVATION_SURFACE });
    await flushAsync();
    await act(async () => { await latestState?.handleNew(); });
    await act(async () => { await latestState?.handleNewFromTemplate('json'); });
    expect(latestState?.workspaceState.tabOrder).toHaveLength(3);
    expect(new Set(latestState?.workspaceState.tabOrder).size).toBe(3);
  });

  function renderSession(
    host: MockDocumentHost,
    workspaceCapability?: Partial<WorkspaceCapabilityState>,
    sourceResidencyBudgets?: Readonly<DocumentSourceResidencyBudgets>,
  ) {
    act(() => {
      root.render(
        <Harness
          host={host}
          confirmText={confirmText}
          pushToast={pushToast}
          workspaceCapability={workspaceCapability}
          sourceResidencyBudgets={sourceResidencyBudgets}
          onState={(state) => {
            latestState = state;
          }}
        />,
      );
    });
  }
});

interface MockDocumentHost extends DocumentHost {
  file: {
    readTextFile: ReturnType<typeof vi.fn<(path: string) => Promise<ReadTextFileResponse>>>;
    readTextFileForEdit: ReturnType<typeof vi.fn<(path: string) => Promise<ReadTextFileResponse>>>;
    statFile: ReturnType<typeof vi.fn<(path: string) => Promise<FileMetadata>>>;
    writeTextFileAtomic: DocumentHost['file']['writeTextFileAtomic'];
    createBackupSnapshot: DocumentHost['file']['createBackupSnapshot'];
  };
  launch: {
    getInitialMarkdownPath: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
    getInitialDocumentPath: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
    peekPendingMarkdownOpen: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
    peekPendingDocumentOpen: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
    takePendingMarkdownOpen: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
    takePendingDocumentOpen: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
    clearPendingMarkdownOpen: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;
    clearPendingDocumentOpen: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;
    listenSingleInstanceOpen: ReturnType<typeof vi.fn<DocumentHost['launch']['listenSingleInstanceOpen']>>;
  };
  recovery: DocumentHost['recovery'] & {
    loadUntitledDraft: ReturnType<typeof vi.fn<DocumentHost['recovery']['loadUntitledDraft']>>;
    appendDiagnosticsEvent: ReturnType<typeof vi.fn<DocumentHost['recovery']['appendDiagnosticsEvent']>>;
  };
}

function Harness({
  host,
  confirmText,
  pushToast,
  onState,
  workspaceCapability,
  sourceResidencyBudgets,
}: {
  host: DocumentHost;
  confirmText: (state: ConfirmState) => Promise<boolean>;
  pushToast: (text: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
  onState: (state: SessionState) => void;
  workspaceCapability?: Partial<WorkspaceCapabilityState>;
  sourceResidencyBudgets?: Readonly<DocumentSourceResidencyBudgets>;
}) {
  const [settings, setSettings] = useState<PersistedSettings>(() => loadSettings());
  const [_authorshipMarks, setAuthorshipMarks] = useState<AuthorshipMark[]>([]);
  const state = useDocumentSession({
    initialMarkdown: '',
    setSettings,
    confirmText,
    pushToast,
    host,
    workspaceCapability,
    sourceResidencyBudgets,
  });
  void settings;
  onState(state);
  return null;
}

const TINY_SOURCE_RESIDENCY_BUDGETS: Readonly<DocumentSourceResidencyBudgets> = Object.freeze({
  lowWatermarkBytes: 1,
  highWatermarkBytes: 10,
  hardCeilingBytes: 10,
  minimumResidencyMs: 0,
});

function createHost(): MockDocumentHost {
  let settings = loadSettings();
  return {
    file: {
      readTextFile: vi.fn<(path: string) => Promise<ReadTextFileResponse>>().mockResolvedValue(readResponse('')),
      readTextFileForEdit: vi.fn<(path: string) => Promise<ReadTextFileResponse>>().mockResolvedValue(readResponse('')),
      statFile: vi.fn<(path: string) => Promise<FileMetadata>>().mockResolvedValue(DEFAULT_METADATA),
      writeTextFileAtomic: vi.fn().mockResolvedValue(DEFAULT_METADATA),
      createBackupSnapshot: vi.fn().mockResolvedValue(null),
    },
    dialog: {
      pickMarkdownFile: vi.fn().mockResolvedValue(null),
      pickDocumentFile: vi.fn().mockResolvedValue(null),
      pickDocumentFiles: vi.fn().mockResolvedValue([]),
      pickJsonSchemaFile: vi.fn().mockResolvedValue(null),
      pickSavePath: vi.fn().mockResolvedValue(null),
    },
    launch: {
      getInitialMarkdownPath: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
      getInitialDocumentPath: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
      peekPendingMarkdownOpen: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
      peekPendingDocumentOpen: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
      takePendingMarkdownOpen: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
      takePendingDocumentOpen: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
      clearPendingMarkdownOpen: vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined),
      clearPendingDocumentOpen: vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined),
      listenSingleInstanceOpen: vi.fn<DocumentHost['launch']['listenSingleInstanceOpen']>().mockResolvedValue(vi.fn()),
    },
    recovery: {
      loadUntitledDraft: vi.fn().mockResolvedValue(null),
      loadFileDraft: vi.fn().mockResolvedValue(null),
      saveUntitledDraft: vi.fn(),
      saveUntitledDraftAsync: vi.fn().mockResolvedValue(undefined),
      clearUntitledDraftAsync: vi.fn().mockResolvedValue(undefined),
      saveFileDraft: vi.fn(),
      saveFileDraftAsync: vi.fn().mockResolvedValue(undefined),
      clearFileDraft: vi.fn(),
      clearFileDraftAsync: vi.fn().mockResolvedValue(undefined),
      shouldPersistUntitledDraft: vi.fn().mockReturnValue(false),
      shouldOfferFileDraftRestore: vi.fn().mockReturnValue(false),
      isBundledWelcomeMarkdown: vi.fn().mockReturnValue(false),
      appendDiagnosticsEvent: vi.fn().mockResolvedValue(true),
    },
    settings: {
      rememberRecentFile: vi.fn((filePath: string) => {
        settings = {
          ...settings,
          recentFiles: [filePath, ...settings.recentFiles.filter((item) => item !== filePath)],
        };
        return settings;
      }),
      forgetRecentFile: vi.fn((filePath: string) => {
        settings = {
          ...settings,
          recentFiles: settings.recentFiles.filter((item) => item !== filePath),
        };
        return settings;
      }),
      updateSettings: vi.fn((patch: Partial<PersistedSettings>) => {
        settings = { ...settings, ...patch };
        return settings;
      }),
    },
    watcher: {
      listenFileWatchChanges: vi.fn().mockResolvedValue(vi.fn()),
      updateWatchedFiles: vi.fn().mockResolvedValue(true),
      clearWatchedFiles: vi.fn().mockResolvedValue(true),
    },
  };
}

function readResponse(content: string, metadataPatch: Partial<FileMetadata> = {}): ReadTextFileResponse {
  return createHostReadResponse(content, {
      ...DEFAULT_METADATA,
      lastKnownSizeBytes: content.length,
      contentHash: `hash:${content.length}`,
      ...metadataPatch,
  });
}

async function flushAsync() {
  for (let index = 0; index < 10; index += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 0);
      });
      await Promise.resolve();
    });
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
