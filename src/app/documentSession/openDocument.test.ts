import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_METADATA } from '../documentState';
import { createHostReadResponse, type ReadTextFileResponse } from '../documentState';
import { DocumentHostError, type DocumentHost } from '../host/documentHost';
import { loadSettings } from '../../services/settingsService';
import type { PersistedSettings } from '../../services/settingsService';
import { openDocumentForSession } from './openDocument';
import type { OpenDocumentForSessionInput } from './openDocument';

describe('openDocumentForSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a disk document with status and diagnostics around read and commit', async () => {
    const path = 'C:\\docs\\paper.md';
    const input = createOpenInput({ timeouts: { fileReadMs: 1_000, draftRestoreMs: 1_000 } });
    input.host.file.readTextFileForEdit = vi.fn().mockResolvedValue(readResponse('# Disk\n'));

    const opened = await openDocumentForSession({ ...input, explicitPath: path });

    expect(opened).toBe(true);
    expect(input.settleDirtyDocumentBeforeReplace).toHaveBeenCalledTimes(1);
    expect(input.preserveDirtyDraftBeforeExternalOpen).not.toHaveBeenCalled();
    expect(input.host.file.readTextFileForEdit).toHaveBeenCalledWith(path, expect.objectContaining({
      operationId: expect.any(String),
      signal: expect.any(AbortSignal),
    }));
    expect(input.commitOpenedDocument).toHaveBeenCalledWith(path, '# Disk\n', readResponse('# Disk\n').metadata, undefined);
    expect(input.showDocumentOpenStatus).toHaveBeenNthCalledWith(1, path, 'reading', {});
    expect(input.showDocumentOpenStatus).toHaveBeenNthCalledWith(2, path, 'preparing', { immediate: false });
    expect(input.clearDocumentOpenStatus).toHaveBeenCalledWith(2, 220);
    expect(diagnosticEventTypes(input.host)).toEqual([
      'document-open-selected',
      'document-open-read-complete',
      'document-open-committed',
    ]);
  });

  it.each(['read-first', 'recovery-first'] as const)('overlaps native read and recovery lookup when %s settles first', async (first) => {
    const path = 'C:\\docs\\overlap.md';
    const input = createOpenInput({ timeouts: { fileReadMs: 1_000, draftRestoreMs: 1_000 } });
    const read = deferred<ReadTextFileResponse>();
    const recovery = deferred<null>();
    input.host.file.readTextFileForEdit = vi.fn().mockReturnValue(read.promise);
    input.host.recovery.loadFileDraft = vi.fn().mockReturnValue(recovery.promise);

    const opening = openDocumentForSession({ ...input, explicitPath: path });
    await vi.waitFor(() => {
      expect(input.host.file.readTextFileForEdit).toHaveBeenCalledTimes(1);
      expect(input.host.recovery.loadFileDraft).toHaveBeenCalledTimes(1);
    });
    if (first === 'read-first') {
      read.resolve(readResponse('# Disk\n'));
      await Promise.resolve();
      expect(input.commitOpenedDocument).not.toHaveBeenCalled();
      recovery.resolve(null);
    } else {
      recovery.resolve(null);
      await Promise.resolve();
      expect(input.commitOpenedDocument).not.toHaveBeenCalled();
      read.resolve(readResponse('# Disk\n'));
    }

    await expect(opening).resolves.toBe(true);
    expect(input.commitOpenedDocument).toHaveBeenCalledTimes(1);
  });

  it('aborts the native operation and never commits when the owning open is cancelled', async () => {
    const path = 'C:\\docs\\cancelled.md';
    const controller = new AbortController();
    const input = createOpenInput({ readSignal: controller.signal });
    input.host.file.readTextFileForEdit = vi.fn<DocumentHost['file']['readTextFileForEdit']>((_path, options) => new Promise<ReadTextFileResponse>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DocumentHostError('CANCELLED', 'cancelled')), { once: true });
    }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const opening = openDocumentForSession({ ...input, explicitPath: path });
    await vi.waitFor(() => expect(input.host.file.readTextFileForEdit).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(opening).resolves.toBe(false);
    expect(input.commitOpenedDocument).not.toHaveBeenCalled();
  });

  it('uses the generic document picker when no explicit path is provided', async () => {
    const input = createOpenInput();
    input.host.dialog.pickDocumentFile = vi.fn().mockResolvedValue('C:\\docs\\results.json');
    input.host.file.readTextFileForEdit = vi.fn().mockResolvedValue(readResponse('{"ok":true}\n'));

    const opened = await openDocumentForSession(input);

    expect(opened).toBe(true);
    expect(input.host.dialog.pickDocumentFile).toHaveBeenCalledTimes(1);
    expect(input.host.dialog.pickMarkdownFile).not.toHaveBeenCalled();
    expect(input.commitOpenedDocument).toHaveBeenCalledWith(
      'C:\\docs\\results.json',
      '{"ok":true}\n',
      readResponse('{"ok":true}\n').metadata,
      undefined,
    );
  });

  it('prompts for an offerable file draft and commits the draft with the disk content as saved baseline', async () => {
    const path = 'C:\\docs\\drafted.md';
    const input = createOpenInput({
      confirmText: vi.fn<OpenDocumentForSessionInput['confirmText']>().mockResolvedValue(true),
    });
    input.host.file.readTextFileForEdit = vi.fn().mockResolvedValue(readResponse('# Disk\n'));
    input.host.recovery.loadFileDraft = vi.fn().mockResolvedValue({ markdown: '# Draft\n', savedAt: 1000, format: 'markdown' });
    input.host.recovery.shouldOfferFileDraftRestore = vi.fn().mockReturnValue(true);

    const opened = await openDocumentForSession({ ...input, explicitPath: path });

    expect(opened).toBe(true);
    expect(input.confirmText).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Restore unsaved file draft?',
      okLabel: 'Restore draft',
      cancelLabel: 'Open disk version',
    }));
    expect(input.clearDocumentOpenStatus).toHaveBeenNthCalledWith(1, 1, 0);
    expect(input.showDocumentOpenStatus).toHaveBeenLastCalledWith(path, 'restoring', { immediate: true });
    expect(input.commitOpenedDocument).toHaveBeenCalledWith(path, '# Draft\n', readResponse('# Disk\n').metadata, 'visual', '# Disk\n', 'markdown');
    expect(input.pushToast).toHaveBeenCalledWith('Restored unsaved file draft.', 'warning');
    expect(input.host.recovery.clearFileDraft).not.toHaveBeenCalled();
  });

  it('joins external-launch recovery before committing the auto-restored draft exactly once', async () => {
    const path = 'C:\\docs\\launch.md';
    const input = createOpenInput();
    input.host.file.readTextFileForEdit = vi.fn().mockResolvedValue(readResponse('# Disk\n'));
    input.host.recovery.loadFileDraft = vi.fn().mockResolvedValue({ markdown: '# Draft\n', savedAt: 1000, format: 'markdown' });
    input.host.recovery.shouldOfferFileDraftRestore = vi.fn().mockReturnValue(true);

    const opened = await openDocumentForSession({
      ...input,
      explicitPath: path,
      options: { externalLaunch: true, draftRestore: 'auto', preferredMode: 'visual' },
    });

    expect(opened).toBe(true);
    expect(input.preserveDirtyDraftBeforeExternalOpen).toHaveBeenCalledTimes(1);
    expect(input.commitOpenedDocument).toHaveBeenCalledTimes(1);
    expect(input.commitOpenedDocument).toHaveBeenCalledWith(
      path,
      '# Draft\n',
      readResponse('# Disk\n').metadata,
      'visual',
      '# Disk\n',
      'markdown',
    );
  });

  it('clears an offerable file draft when the user opens the disk version', async () => {
    const path = 'C:\\docs\\disk.md';
    const input = createOpenInput({
      confirmText: vi.fn<OpenDocumentForSessionInput['confirmText']>().mockResolvedValue(false),
    });
    input.host.file.readTextFileForEdit = vi.fn().mockResolvedValue(readResponse('# Disk\n'));
    input.host.recovery.loadFileDraft = vi.fn().mockResolvedValue({ markdown: '# Draft\n', savedAt: 1000, format: 'markdown' });
    input.host.recovery.shouldOfferFileDraftRestore = vi.fn().mockReturnValue(true);

    const opened = await openDocumentForSession({ ...input, explicitPath: path });

    expect(opened).toBe(true);
    expect(input.host.recovery.clearFileDraft).toHaveBeenCalledWith(path);
    expect(input.commitOpenedDocument).toHaveBeenCalledWith(path, '# Disk\n', readResponse('# Disk\n').metadata, undefined);
  });

  it('stops before path selection when dirty-document settlement is rejected', async () => {
    const input = createOpenInput({
      settleDirtyDocumentBeforeReplace: vi.fn<OpenDocumentForSessionInput['settleDirtyDocumentBeforeReplace']>().mockResolvedValue(false),
    });

    const opened = await openDocumentForSession(input);

    expect(opened).toBe(false);
    expect(input.host.dialog.pickDocumentFile).not.toHaveBeenCalled();
    expect(input.host.file.readTextFileForEdit).not.toHaveBeenCalled();
  });

  it('focuses an explicitly opened workspace duplicate before settlement or disk read', async () => {
    const path = 'C:\\docs\\already-open.md';
    const input = createOpenInput({
      onResolvedLocator: vi.fn<NonNullable<OpenDocumentForSessionInput['onResolvedLocator']>>().mockReturnValue(true),
    });

    const opened = await openDocumentForSession({ ...input, explicitPath: path });

    expect(opened).toBe(true);
    expect(input.onResolvedLocator).toHaveBeenCalledWith(expect.objectContaining({ kind: 'file', displayPath: path }));
    expect(input.settleDirtyDocumentBeforeReplace).not.toHaveBeenCalled();
    expect(input.host.file.readTextFileForEdit).not.toHaveBeenCalled();
    expect(input.commitOpenedDocument).not.toHaveBeenCalled();
    expect(diagnosticEventTypes(input.host)).toEqual(['document-open-duplicate-skipped']);
  });

  it('records open failures and forgets recent files except for grant failures', async () => {
    const path = 'C:\\docs\\missing.md';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const input = createOpenInput();
    input.host.file.readTextFileForEdit = vi.fn().mockRejectedValue(new DocumentHostError('NOT_FOUND', 'Not found'));

    const opened = await openDocumentForSession({ ...input, explicitPath: path });

    expect(opened).toBe(false);
    expect(consoleError).toHaveBeenCalled();
    expect(input.host.settings.forgetRecentFile).toHaveBeenCalledWith(path);
    expect(input.setSettings).toHaveBeenCalledWith(expect.objectContaining({ recentFiles: expect.any(Array) }));
    expect(input.pushToast).toHaveBeenCalledWith('Not found', 'error');
    expect(diagnosticEventTypes(input.host)).toContain('document-open-failed');

    const accessDeniedInput = createOpenInput();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    accessDeniedInput.host.file.readTextFileForEdit = vi.fn().mockRejectedValue(
      new DocumentHostError('PERMISSION_DENIED', 'Autorisation refusée'),
    );

    const accessDeniedOpened = await openDocumentForSession({ ...accessDeniedInput, explicitPath: path });

    expect(accessDeniedOpened).toBe(false);
    expect(accessDeniedInput.host.settings.forgetRecentFile).not.toHaveBeenCalled();
    expect(accessDeniedInput.pushToast).toHaveBeenCalledWith('Use Open or Files to grant access to this document again.', 'error');
  });
});

function createOpenInput(overrides: Partial<OpenDocumentForSessionInput> = {}): OpenDocumentForSessionInput {
  let statusToken = 0;
  return {
    host: createHost(),
    confirmText: vi.fn<OpenDocumentForSessionInput['confirmText']>().mockResolvedValue(false),
    pushToast: vi.fn<OpenDocumentForSessionInput['pushToast']>(),
    setSettings: vi.fn<(settings: PersistedSettings | ((current: PersistedSettings) => PersistedSettings)) => void>(),
    isLatestOpenRequest: vi.fn<OpenDocumentForSessionInput['isLatestOpenRequest']>().mockReturnValue(true),
    settleDirtyDocumentBeforeReplace: vi.fn<OpenDocumentForSessionInput['settleDirtyDocumentBeforeReplace']>().mockResolvedValue(true),
    preserveDirtyDraftBeforeExternalOpen: vi.fn<OpenDocumentForSessionInput['preserveDirtyDraftBeforeExternalOpen']>(),
    showDocumentOpenStatus: vi.fn<OpenDocumentForSessionInput['showDocumentOpenStatus']>(() => {
      statusToken += 1;
      return statusToken;
    }),
    clearDocumentOpenStatus: vi.fn<OpenDocumentForSessionInput['clearDocumentOpenStatus']>(),
    commitOpenedDocument: vi.fn<OpenDocumentForSessionInput['commitOpenedDocument']>(),
    timeouts: { fileReadMs: 20, draftRestoreMs: 20 },
    ...overrides,
  };
}

function createHost(): DocumentHost {
  return {
    file: {
      readTextFile: vi.fn().mockResolvedValue(readResponse('')),
      readTextFileForEdit: vi.fn().mockResolvedValue(readResponse('')),
      statFile: vi.fn().mockResolvedValue(DEFAULT_METADATA),
      writeTextFileAtomic: vi.fn().mockResolvedValue(DEFAULT_METADATA),
      createBackupSnapshot: vi.fn().mockResolvedValue(null),
    },
    dialog: {
      pickMarkdownFile: vi.fn().mockResolvedValue('C:\\docs\\picked.md'),
      pickDocumentFile: vi.fn().mockResolvedValue('C:\\docs\\picked.md'),
      pickJsonSchemaFile: vi.fn().mockResolvedValue(null),
      pickSavePath: vi.fn().mockResolvedValue(null),
    },
    launch: {
      getInitialMarkdownPath: vi.fn().mockResolvedValue(null),
      getInitialDocumentPath: vi.fn().mockResolvedValue(null),
      peekPendingMarkdownOpen: vi.fn().mockResolvedValue(null),
      peekPendingDocumentOpen: vi.fn().mockResolvedValue(null),
      takePendingMarkdownOpen: vi.fn().mockResolvedValue(null),
      takePendingDocumentOpen: vi.fn().mockResolvedValue(null),
      clearPendingMarkdownOpen: vi.fn().mockResolvedValue(undefined),
      clearPendingDocumentOpen: vi.fn().mockResolvedValue(undefined),
      listenSingleInstanceOpen: vi.fn().mockResolvedValue(vi.fn()),
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
      rememberRecentFile: vi.fn().mockReturnValue(loadSettings()),
      forgetRecentFile: vi.fn().mockReturnValue(loadSettings()),
      updateSettings: vi.fn().mockReturnValue(loadSettings()),
    },
    watcher: {
      listenFileWatchChanges: vi.fn().mockResolvedValue(vi.fn()),
      updateWatchedFiles: vi.fn().mockResolvedValue(true),
      clearWatchedFiles: vi.fn().mockResolvedValue(true),
    },
  };
}

function readResponse(content: string): ReadTextFileResponse {
  return createHostReadResponse(content, {
      ...DEFAULT_METADATA,
      lastKnownSizeBytes: content.length,
      contentHash: `hash:${content.length}`,
  });
}

function diagnosticEventTypes(host: DocumentHost): string[] {
  const appendDiagnosticsEvent = host.recovery.appendDiagnosticsEvent as ReturnType<typeof vi.fn>;
  return appendDiagnosticsEvent.mock.calls.map(([event]) => event.eventType);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
