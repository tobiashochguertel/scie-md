import { Channel, invoke } from '@tauri-apps/api/core';
import type { DocumentFormat } from '@sciemd/core';
import type { FileMetadata, ReadTextFileResponse } from '../app/documentState';
import { DEFAULT_METADATA, normalizeFileMetadata } from '../app/documentState';
import type { PandocExportFormat } from '../export/exportTypes';
import type { NativeDocumentLocator } from '../app/documentIdentity';
import type { DocumentReadOptions, NativeReadCancellationResult } from '../app/host/documentHost';
import { DocumentHostError } from '../app/host/documentHostError';

export type FileExplorerEntryKind =
  | 'directory'
  | 'markdown'
  | 'json'
  | 'jsonl'
  | 'yaml'
  | 'toml'
  | 'xml'
  | 'csv'
  | 'tsv'
  | 'plainText';

export interface FileExplorerEntry {
  name: string;
  path: string;
  kind: FileExplorerEntryKind;
  sizeBytes: number;
  modifiedMs: number;
}

export type GeneratedSiblingArtifactKind = 'llm-skill' | 'submission-readiness';

export interface GeneratedSiblingArtifactResponse {
  path: string;
  metadata: FileMetadata;
}

export async function resolveDocumentLocator(path: string, allowMissing = false): Promise<NativeDocumentLocator> {
  return invoke<NativeDocumentLocator>('resolve_document_locator', { path, allowMissing });
}

export async function pickMarkdownFile(): Promise<string | null> {
  return invoke<string | null>('pick_markdown_file');
}

export async function pickDocumentFile(): Promise<string | null> {
  return invoke<string | null>('pick_document_file');
}

export async function pickDocumentFiles(): Promise<string[]> {
  return invoke<string[]>('pick_document_files');
}

export async function pickJsonSchemaFile(): Promise<string | null> {
  return invoke<string | null>('pick_json_schema_file');
}

export async function pickFolder(): Promise<string | null> {
  return invoke<string | null>('pick_folder');
}

export async function pickSavePath(defaultPath?: string | null, format?: DocumentFormat): Promise<string | null> {
  return invoke<string | null>('pick_save_path', {
    defaultPath: defaultPath ?? null,
    format: format ?? null,
  });
}

export async function pickHtmlSavePath(defaultPath?: string | null): Promise<string | null> {
  return invoke<string | null>('pick_html_save_path', { defaultPath: defaultPath ?? null });
}

export async function pickCitationStyleFile(): Promise<string | null> {
  return invoke<string | null>('pick_citation_style_file');
}

export async function pickExportSavePath(
  format: PandocExportFormat,
  defaultPath?: string | null,
): Promise<string | null> {
  return invoke<string | null>('pick_pandoc_export_save_path', {
    defaultPath: defaultPath ?? null,
    format,
  });
}

export async function grantExternalPath(path: string, kind: 'image'): Promise<string> {
  return invoke<string>('grant_external_path', { path, kind });
}

export async function syncDocumentImageGrants(documentPath: string, imageUrls: string[]): Promise<number> {
  return invoke<number>('sync_document_image_grants', { documentPath, imageUrls });
}

export async function getInitialMarkdownPath(): Promise<string | null> {
  return invoke<string | null>('initial_markdown_path');
}

// Native "document" launch commands are the preferred startup/open-with API.
// Markdown-named commands remain as compatibility aliases for older callers.
export async function getInitialDocumentPath(): Promise<string | null> {
  return invoke<string | null>('initial_document_path');
}

export async function peekPendingMarkdownOpen(): Promise<string | null> {
  return invoke<string | null>('peek_pending_markdown_open');
}

export async function peekPendingDocumentOpen(): Promise<string | null> {
  return invoke<string | null>('peek_pending_document_open');
}

export async function takePendingMarkdownOpen(): Promise<string | null> {
  return invoke<string | null>('take_pending_markdown_open');
}

export async function takePendingDocumentOpen(): Promise<string | null> {
  return invoke<string | null>('take_pending_document_open');
}

export async function clearPendingMarkdownOpen(path: string): Promise<void> {
  await invoke('clear_pending_markdown_open', { path });
}

export async function clearPendingDocumentOpen(path: string): Promise<void> {
  await invoke('clear_pending_document_open', { path });
}

export async function readTextFile(path: string, options: DocumentReadOptions = {}): Promise<ReadTextFileResponse> {
  return invokeNativeTextRead('read_text_file', path, options);
}

export async function readTextFileForEdit(path: string, options: DocumentReadOptions = {}): Promise<ReadTextFileResponse> {
  return invokeNativeTextRead('read_text_file_for_edit', path, options);
}

export async function readTextFilePreview(path: string, maxBytes = 8192): Promise<{ content: string; modifiedMs: number }> {
  return invoke<{ content: string; modifiedMs: number }>('read_text_file_preview', { path, maxBytes });
}

export async function readBinaryFileBase64(path: string): Promise<string> {
  return invoke<string>('read_binary_file_base64', { path });
}

export async function listReadableFiles(path: string): Promise<FileExplorerEntry[]> {
  return invoke<FileExplorerEntry[]>('list_readable_files', { path });
}

export async function statFile(path: string, options: { contentHash?: boolean } = {}): Promise<FileMetadata> {
  return normalizeFileMetadata(await invoke<FileMetadata>('stat_file', {
    path,
    includeContentHash: options.contentHash ?? false,
  }));
}

export async function writeTextFileAtomic(
  path: string,
  sourceText: string,
  metadata: FileMetadata | null,
  expectedMetadata: FileMetadata | null = null,
): Promise<FileMetadata> {
  const writeMetadata = metadata ?? DEFAULT_METADATA;
  return normalizeFileMetadata(await invoke<FileMetadata>('write_text_file_atomic', {
    path,
    sourceText,
    lineEnding: writeMetadata.lineEnding,
    encoding: writeMetadata.encoding,
    hasBom: writeMetadata.hasBom,
    expectedMtimeMs: expectedMetadata?.lastKnownMtimeMs ?? null,
    expectedSizeBytes: expectedMetadata?.lastKnownSizeBytes ?? null,
    expectedContentHash: expectedMetadata?.contentHash ?? null,
  }));
}

export async function writeTextFileCreateNew(
  path: string,
  sourceText: string,
  metadata: FileMetadata | null = null,
): Promise<FileMetadata> {
  const writeMetadata = metadata ?? DEFAULT_METADATA;
  return normalizeFileMetadata(await invoke<FileMetadata>('write_text_file_create_new', {
    path,
    sourceText,
    lineEnding: writeMetadata.lineEnding,
    encoding: writeMetadata.encoding,
    hasBom: writeMetadata.hasBom,
  }));
}

export async function createGeneratedSiblingArtifact(
  documentPath: string,
  artifactKind: GeneratedSiblingArtifactKind,
  sourceText: string,
  metadata: FileMetadata | null = null,
): Promise<GeneratedSiblingArtifactResponse> {
  const writeMetadata = metadata ?? DEFAULT_METADATA;
  const response = await invoke<GeneratedSiblingArtifactResponse>('create_generated_sibling_artifact', {
    documentPath,
    artifactKind,
    markdown: sourceText,
    lineEnding: writeMetadata.lineEnding,
    encoding: writeMetadata.encoding,
    hasBom: writeMetadata.hasBom,
  });
  return { ...response, metadata: normalizeFileMetadata(response.metadata) };
}

interface NativeReadTextFileComplete {
  kind: 'complete';
  contractVersion: number;
  chunkCount: number;
  metadata: Partial<FileMetadata>;
  nativeTimings?: ReadTextFileResponse['nativeTimings'];
  snapshot: ReadTextFileResponse['snapshot'];
}

type NativeTextReadEvent =
  | { kind: 'sourceChunk'; sequence: number; sourceChunk: string }
  | NativeReadTextFileComplete;

function normalizeReadResponse(response: NativeReadTextFileComplete, sourceText: string): ReadTextFileResponse {
  if (response.contractVersion !== 2 || !Number.isInteger(response.chunkCount)) {
    throw new DocumentHostError('UNKNOWN_HOST_ERROR', 'Native document read returned an unsupported response contract.');
  }
  const metadata = normalizeFileMetadata(response.metadata);
  return {
    contractVersion: 2,
    sourceText,
    metadata,
    nativeTimings: response.nativeTimings,
    snapshot: response.snapshot,
  };
}

let textReadSequence = 0;

async function invokeNativeTextRead(
  command: 'read_text_file' | 'read_text_file_for_edit',
  path: string,
  options: DocumentReadOptions,
): Promise<ReadTextFileResponse> {
  const operationId = options.operationId ?? `renderer-read-${Date.now()}-${++textReadSequence}`;
  if (options.signal?.aborted) throw new DocumentHostError('CANCELLED', 'Document read cancelled before native acquisition.');

  const earlyMetadata = options.onEarlyMetadata
    ? statFile(path).then((metadata) => {
      if (!options.signal?.aborted) options.onEarlyMetadata?.(metadata);
    }).catch(() => undefined)
    : Promise.resolve();
  void earlyMetadata;

  const cancel = () => {
    void invoke<NativeReadCancellationResult>('cancel_text_file_read', { operationId })
      .then((result) => options.onNativeCancellation?.(result))
      .catch(() => undefined);
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  let sourceChunks: string[] | null = null;
  let eventChannel: Channel<NativeTextReadEvent> | null = null;
  try {
    const chunks: string[] = [];
    sourceChunks = chunks;
    let channelCompleted = false;
    let resolveCompletion!: (event: NativeReadTextFileComplete) => void;
    let rejectCompletion!: (error: DocumentHostError) => void;
    const completion = new Promise<NativeReadTextFileComplete>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const onEvent = new Channel<NativeTextReadEvent>();
    eventChannel = onEvent;
    onEvent.onmessage = (event) => {
      if (channelCompleted) return;
      if (event.kind === 'sourceChunk') {
        if (event.sequence !== chunks.length || typeof event.sourceChunk !== 'string') {
          channelCompleted = true;
          rejectCompletion(new DocumentHostError('UNKNOWN_HOST_ERROR', 'Native document read channel returned an invalid source chunk sequence.'));
          return;
        }
        chunks.push(event.sourceChunk);
        return;
      }
      if (event.chunkCount !== chunks.length) {
        channelCompleted = true;
        rejectCompletion(new DocumentHostError('UNKNOWN_HOST_ERROR', 'Native document read channel returned an invalid completion record.'));
        return;
      }
      channelCompleted = true;
      resolveCompletion(event);
    };
    await invoke<void>(command, { path, operationId, onEvent });
    const complete = await completion;
    const sourceText = chunks.join('');
    chunks.length = 0;
    const response = normalizeReadResponse(complete, sourceText);
    if (options.signal?.aborted) throw new DocumentHostError('CANCELLED', 'Document read cancelled before renderer commit.');
    if (response.nativeTimings) options.onNativeTimings?.(response.nativeTimings);
    return response;
  } finally {
    if (eventChannel) {
      eventChannel.onmessage = () => undefined;
      const closableChannel = eventChannel as unknown as { cleanupCallback?: () => void };
      closableChannel.cleanupCallback?.();
    }
    if (sourceChunks) sourceChunks.length = 0;
    options.signal?.removeEventListener('abort', cancel);
  }
}


export async function createBackupSnapshot(path: string, label: string): Promise<string | null> {
  const result = await invoke<string | null>('create_backup_snapshot', { path, label });
  return result ?? null;
}

export async function listBackups(path: string): Promise<string[]> {
  return invoke<string[]>('list_backups', { path });
}

export async function cleanupStaleTempFilesForPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await invoke('cleanup_stale_temp_files_for_paths', { paths });
}
