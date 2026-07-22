import { describe, expect, it, vi } from 'vitest';
import { desktopDocumentHost } from './desktopDocumentHost';
import { readTextFileForEdit, resolveDocumentLocator } from '../../services/fileService';
import errorFixture from './fixtures/documentHostErrors.v1.json';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

vi.mock('../../services/fileService', () => ({
  clearPendingDocumentOpen: vi.fn(),
  clearPendingMarkdownOpen: vi.fn(),
  createBackupSnapshot: vi.fn(),
  getInitialDocumentPath: vi.fn(),
  getInitialMarkdownPath: vi.fn(),
  peekPendingDocumentOpen: vi.fn(),
  peekPendingMarkdownOpen: vi.fn(),
  pickDocumentFile: vi.fn(),
  pickDocumentFiles: vi.fn(),
  pickJsonSchemaFile: vi.fn(),
  pickMarkdownFile: vi.fn(),
  pickSavePath: vi.fn(),
  takePendingDocumentOpen: vi.fn(),
  takePendingMarkdownOpen: vi.fn(),
  readTextFile: vi.fn(),
  readTextFileForEdit: vi.fn(),
  resolveDocumentLocator: vi.fn(),
  statFile: vi.fn(),
  writeTextFileAtomic: vi.fn(),
}));

vi.mock('../../services/draftRecoveryService', () => ({
  clearFileDraft: vi.fn(),
  clearFileDraftAsync: vi.fn(),
  clearUntitledDraftAsync: vi.fn(),
  isBundledWelcomeMarkdown: vi.fn(),
  loadFileDraftAsync: vi.fn(),
  loadUntitledDraftAsync: vi.fn(),
  saveFileDraft: vi.fn(),
  saveFileDraftAsync: vi.fn(),
  saveUntitledDraft: vi.fn(),
  saveUntitledDraftAsync: vi.fn(),
  shouldOfferFileDraftRestore: vi.fn(),
  shouldPersistUntitledDraft: vi.fn(),
}));

vi.mock('../../services/nativeRecoveryService', () => ({
  appendDiagnosticsEvent: vi.fn(),
}));

vi.mock('../../services/settingsService', () => ({
  forgetRecentFile: vi.fn(),
  rememberRecentFile: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('../../services/fileWatchService', () => ({
  clearWatchedFiles: vi.fn(),
  listenFileWatchChanges: vi.fn(),
  updateWatchedFiles: vi.fn(),
}));

describe('desktopDocumentHost', () => {
  it('exposes typed host sections for document lifecycle dependencies', () => {
    expect(desktopDocumentHost.file.readTextFileForEdit).toEqual(expect.any(Function));
    expect(desktopDocumentHost.dialog.pickMarkdownFile).toEqual(expect.any(Function));
    expect(desktopDocumentHost.dialog.pickDocumentFile).toEqual(expect.any(Function));
    expect(desktopDocumentHost.dialog.pickDocumentFiles).toEqual(expect.any(Function));
    expect(desktopDocumentHost.dialog.pickJsonSchemaFile).toEqual(expect.any(Function));
    expect(desktopDocumentHost.launch.getInitialMarkdownPath).toEqual(expect.any(Function));
    expect(desktopDocumentHost.launch.getInitialDocumentPath).toEqual(expect.any(Function));
    expect(desktopDocumentHost.launch.peekPendingDocumentOpen).toEqual(expect.any(Function));
    expect(desktopDocumentHost.launch.takePendingDocumentOpen).toEqual(expect.any(Function));
    expect(desktopDocumentHost.launch.clearPendingDocumentOpen).toEqual(expect.any(Function));
    expect(desktopDocumentHost.launch.listenSingleInstanceOpen).toEqual(expect.any(Function));
    expect(desktopDocumentHost.recovery.loadFileDraft).toEqual(expect.any(Function));
    expect(desktopDocumentHost.settings.rememberRecentFile).toEqual(expect.any(Function));
    expect(desktopDocumentHost.watcher.updateWatchedFiles).toEqual(expect.any(Function));
    expect(desktopDocumentHost.identity?.resolveFileLocator).toEqual(expect.any(Function));
    expect(desktopDocumentHost.structuredMutation?.capabilities.tomlNativePlanning).toBe(true);
    expect(desktopDocumentHost.structuredMutation?.inspectToml).toEqual(expect.any(Function));
    expect(desktopDocumentHost.structuredMutation?.planToml).toEqual(expect.any(Function));
  });

  it('normalizes the native locator while preserving the requested display path', async () => {
    vi.mocked(resolveDocumentLocator).mockResolvedValueOnce({
      displayPath: 'C:\\Alias\\Paper.md',
      comparisonKey: 'c:/real/paper.md',
      stableFileId: 'windows:volume:file',
      identityConfidence: 'stableFileId',
      aliases: ['C:\\Real\\Paper.md'],
    });

    await expect(desktopDocumentHost.identity?.resolveFileLocator('C:\\Alias\\Paper.md')).resolves.toMatchObject({
      displayPath: 'C:\\Alias\\Paper.md',
      comparisonKey: 'c:/real/paper.md',
      stableFileId: 'windows:volume:file',
      identityConfidence: 'stableFileId',
      aliases: ['C:\\Real\\Paper.md'],
    });
  });

  it.each(errorFixture)('normalizes native $code failures at the file adapter', async (payload) => {
    vi.mocked(readTextFileForEdit).mockRejectedValueOnce(payload);

    await expect(desktopDocumentHost.file.readTextFileForEdit('C:\\docs\\paper.md')).rejects.toMatchObject({
      contractVersion: 2,
      code: payload.code,
      message: payload.message,
    });
  });

  it('maps future native codes and legacy browser errors to UNKNOWN_HOST_ERROR', async () => {
    vi.mocked(readTextFileForEdit).mockRejectedValueOnce({
      contractVersion: 1,
      code: 'FUTURE_ERROR',
      message: 'A future host failure.',
    });
    await expect(desktopDocumentHost.file.readTextFileForEdit('future.md')).rejects.toMatchObject({
      code: 'UNKNOWN_HOST_ERROR',
      message: 'A future host failure.',
    });

    vi.mocked(readTextFileForEdit).mockRejectedValueOnce(new Error('Browser file handle failed.'));
    await expect(desktopDocumentHost.file.readTextFileForEdit('browser.md')).rejects.toMatchObject({
      code: 'UNKNOWN_HOST_ERROR',
      message: 'Browser file handle failed.',
    });
  });
});
