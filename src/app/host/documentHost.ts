import type { FileMetadata, NativeDocumentReadTimings, ReadTextFileResponse } from '../documentState';
import type { DocumentFormat, TomlNativeMutationIntent, TomlNativeMutationPlanReport, TomlNativeSourceMapReport } from '@sciemd/core';
import type { DiagnosticsEvent } from '../../services/nativeRecoveryService';
import type { PersistedSettings } from '../../services/settingsService';
import type { UntitledDraft } from '../../services/draftRecoveryService';
import type { FileWatchChangeEvent } from '../../services/fileWatchService';
import type { FileDocumentLocator } from '../documentIdentity';

export {
  DOCUMENT_HOST_ERROR_CODES,
  DOCUMENT_HOST_ERROR_CONTRACT_VERSION,
  DocumentHostError,
  isDocumentHostError,
  normalizeDocumentHostError,
} from './documentHostError';
export type { DocumentHostErrorCode, DocumentHostErrorPayload } from './documentHostError';

export type HostUnlisten = () => void;

export interface NativeReadCancellationResult {
  accepted: boolean;
  stopped: boolean;
  stopMs: number;
}

export interface DocumentReadOptions {
  operationId?: string;
  signal?: AbortSignal;
  onEarlyMetadata?: (metadata: FileMetadata) => void;
  onNativeCancellation?: (result: NativeReadCancellationResult) => void;
  onNativeTimings?: (timings: NativeDocumentReadTimings) => void;
}

export interface FileHost {
  /** Lifecycle methods reject with DocumentHostError, including browser/test hosts. */
  readTextFile(path: string, options?: DocumentReadOptions): Promise<ReadTextFileResponse>;
  readTextFileForEdit(path: string, options?: DocumentReadOptions): Promise<ReadTextFileResponse>;
  statFile(path: string, options?: { contentHash?: boolean }): Promise<FileMetadata>;
  writeTextFileAtomic(
    path: string,
    sourceText: string,
    metadata: FileMetadata | null,
    expectedMetadata?: FileMetadata | null,
  ): Promise<FileMetadata>;
  createBackupSnapshot(path: string, label: string): Promise<string | null>;
}

export interface DialogHost {
  pickMarkdownFile(): Promise<string | null>;
  pickDocumentFile(): Promise<string | null>;
  pickDocumentFiles?(): Promise<string[]>;
  pickJsonSchemaFile(): Promise<string | null>;
  pickSavePath(defaultPath?: string | null, format?: DocumentFormat): Promise<string | null>;
}

export interface LaunchHost {
  /**
   * The generic document launch methods are preferred for native startup and
   * Open With. Markdown-named methods remain as compatibility aliases.
   */
  getInitialMarkdownPath(): Promise<string | null>;
  getInitialDocumentPath(): Promise<string | null>;
  peekPendingMarkdownOpen(): Promise<string | null>;
  peekPendingDocumentOpen(): Promise<string | null>;
  takePendingMarkdownOpen(): Promise<string | null>;
  takePendingDocumentOpen(): Promise<string | null>;
  clearPendingMarkdownOpen(path: string): Promise<void>;
  clearPendingDocumentOpen(path: string): Promise<void>;
  listenSingleInstanceOpen(callback: (path: string) => void): Promise<HostUnlisten>;
}

export interface RecoveryHost {
  loadUntitledDraft(now?: number): Promise<UntitledDraft | null>;
  loadFileDraft(filePath: string, now?: number): Promise<UntitledDraft | null>;
  saveUntitledDraft(sourceText: string, savedAt?: number, format?: DocumentFormat): void;
  saveUntitledDraftAsync(sourceText: string, savedAt?: number, format?: DocumentFormat): Promise<void>;
  clearUntitledDraftAsync(): Promise<void>;
  saveFileDraft(filePath: string, sourceText: string, savedAt?: number, baseMetadata?: FileMetadata | null, format?: DocumentFormat): void;
  saveFileDraftAsync(filePath: string, sourceText: string, savedAt?: number, baseMetadata?: FileMetadata | null, format?: DocumentFormat): Promise<void>;
  clearFileDraft(filePath: string): void;
  clearFileDraftAsync(filePath: string): Promise<void>;
  shouldPersistUntitledDraft(sourceText: string, initialSourceText: string, options?: { suppressBundledWelcome?: boolean }): boolean;
  shouldOfferFileDraftRestore(draft: UntitledDraft, diskMetadata: FileMetadata): boolean;
  isBundledWelcomeMarkdown(markdown: string): boolean;
  appendDiagnosticsEvent(event: DiagnosticsEvent): Promise<boolean>;
}

export interface SettingsHost {
  rememberRecentFile(filePath: string): PersistedSettings;
  forgetRecentFile(filePath: string): PersistedSettings;
  updateSettings(patch: Partial<PersistedSettings>): PersistedSettings;
}

export interface WatcherHost {
  listenFileWatchChanges(callback: (event: FileWatchChangeEvent) => void): Promise<HostUnlisten>;
  updateWatchedFiles(scope: string, paths: string[]): Promise<boolean>;
  clearWatchedFiles(scope: string): Promise<boolean>;
}

export interface IdentityHost {
  resolveFileLocator(path: string, options?: { allowMissing?: boolean }): Promise<FileDocumentLocator>;
}

export interface StructuredMutationHost {
  readonly capabilities: { readonly tomlNativePlanning: boolean };
  inspectToml(sourceText: string): Promise<TomlNativeSourceMapReport>;
  planToml(sourceText: string, intent: TomlNativeMutationIntent): Promise<TomlNativeMutationPlanReport>;
}

export interface DocumentHost {
  file: FileHost;
  dialog: DialogHost;
  launch: LaunchHost;
  recovery: RecoveryHost;
  settings: SettingsHost;
  watcher: WatcherHost;
  /** Optional only for compatibility hosts; production desktop always provides it. */
  identity?: IdentityHost;
  /** Absent on browser/extension compatibility hosts; they keep TOML visual mode read-only. */
  structuredMutation?: StructuredMutationHost;
}
