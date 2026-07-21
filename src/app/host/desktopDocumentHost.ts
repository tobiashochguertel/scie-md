import { listen } from '@tauri-apps/api/event';
import {
  clearPendingDocumentOpen,
  clearPendingMarkdownOpen,
  getInitialDocumentPath,
  getInitialMarkdownPath,
  peekPendingDocumentOpen,
  peekPendingMarkdownOpen,
  pickDocumentFile,
  pickDocumentFiles,
  pickJsonSchemaFile,
  pickMarkdownFile,
  pickSavePath,
  takePendingDocumentOpen,
  takePendingMarkdownOpen,
  readTextFile,
  readTextFileForEdit,
  statFile,
  writeTextFileAtomic,
  createBackupSnapshot,
  resolveDocumentLocator,
} from '../../services/fileService';
import {
  clearFileDraft,
  clearFileDraftAsync,
  clearUntitledDraftAsync,
  isBundledWelcomeMarkdown,
  loadFileDraftAsync,
  loadUntitledDraftAsync,
  saveFileDraft,
  saveFileDraftAsync,
  saveUntitledDraft,
  saveUntitledDraftAsync,
  shouldOfferFileDraftRestore,
  shouldPersistUntitledDraft,
} from '../../services/draftRecoveryService';
import { appendDiagnosticsEvent } from '../../services/nativeRecoveryService';
import { forgetRecentFile, rememberRecentFile, updateSettings } from '../../services/settingsService';
import {
  clearWatchedFiles,
  listenFileWatchChanges,
  updateWatchedFiles,
} from '../../services/fileWatchService';
import type { DocumentHost } from './documentHost';
import { normalizeDocumentHostError } from './documentHostError';
import { normalizeNativeLocator } from '../documentIdentity';

async function typedFileCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw normalizeDocumentHostError(error);
  }
}

export const desktopDocumentHost: DocumentHost = {
  file: {
    readTextFile: (path) => typedFileCall(() => readTextFile(path)),
    readTextFileForEdit: (path) => typedFileCall(() => readTextFileForEdit(path)),
    statFile: (path, options) => typedFileCall(() => statFile(path, options)),
    writeTextFileAtomic: (path, sourceText, metadata, expectedMetadata) => typedFileCall(
      () => writeTextFileAtomic(path, sourceText, metadata, expectedMetadata),
    ),
    createBackupSnapshot: (path, label) => typedFileCall(() => createBackupSnapshot(path, label)),
  },
  dialog: {
    pickMarkdownFile,
    pickDocumentFile,
    pickDocumentFiles,
    pickJsonSchemaFile,
    pickSavePath,
  },
  launch: {
    getInitialMarkdownPath,
    getInitialDocumentPath,
    peekPendingMarkdownOpen,
    peekPendingDocumentOpen,
    takePendingMarkdownOpen,
    takePendingDocumentOpen,
    clearPendingMarkdownOpen,
    clearPendingDocumentOpen,
    listenSingleInstanceOpen: async (callback) => listen<string>('single-instance-open', (event) => {
      callback(typeof event.payload === 'string' ? event.payload : '');
    }),
  },
  recovery: {
    loadUntitledDraft: loadUntitledDraftAsync,
    loadFileDraft: loadFileDraftAsync,
    saveUntitledDraft,
    saveUntitledDraftAsync,
    clearUntitledDraftAsync,
    saveFileDraft,
    saveFileDraftAsync,
    clearFileDraft,
    clearFileDraftAsync,
    shouldPersistUntitledDraft,
    shouldOfferFileDraftRestore,
    isBundledWelcomeMarkdown,
    appendDiagnosticsEvent,
  },
  settings: {
    rememberRecentFile,
    forgetRecentFile,
    updateSettings,
  },
  watcher: {
    listenFileWatchChanges,
    updateWatchedFiles,
    clearWatchedFiles,
  },
  identity: {
    resolveFileLocator: async (path, options) => normalizeNativeLocator(
      await resolveDocumentLocator(path, options?.allowMissing ?? false),
      path,
    ),
  },
};
