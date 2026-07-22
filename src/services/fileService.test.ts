import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_METADATA } from '../app/documentState';
import {
  clearPendingDocumentOpen,
  clearPendingMarkdownOpen,
  createGeneratedSiblingArtifact,
  getInitialDocumentPath,
  getInitialMarkdownPath,
  grantExternalPath,
  listReadableFiles,
  peekPendingDocumentOpen,
  peekPendingMarkdownOpen,
  pickDocumentFile,
  pickDocumentFiles,
  pickMarkdownFile,
  pickSavePath,
  readTextFile,
  readTextFileForEdit,
  statFile,
  syncDocumentImageGrants,
  takePendingDocumentOpen,
  takePendingMarkdownOpen,
  writeTextFileAtomic,
} from './fileService';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class MockChannel<T> {
    onmessage: (event: T) => void = () => undefined;
  },
}));

describe('fileService', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue({
      lineEnding: 'lf',
      encoding: 'utf8',
      hasBom: false,
      hasMixedLineEndings: false,
      lastKnownMtimeMs: 1,
      lastKnownSizeBytes: 2,
      contentHash: null,
      cloudState: 'local',
    });
  });

  it('opens the additive document picker through the native command', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(['C:\\docs\\a.md', 'C:\\docs\\b.json']);
    await expect(pickDocumentFiles()).resolves.toEqual(['C:\\docs\\a.md', 'C:\\docs\\b.json']);
    expect(invoke).toHaveBeenCalledWith('pick_document_files');
  });

  it('uses metadata-only stat calls by default', async () => {
    await statFile('C:\\docs\\paper.md');

    expect(invoke).toHaveBeenCalledWith('stat_file', {
      path: 'C:\\docs\\paper.md',
      includeContentHash: false,
    });
  });

  it('allows callers to opt into content hashing for conflict-sensitive writes', async () => {
    await statFile('C:\\docs\\paper.md', { contentHash: true });

    expect(invoke).toHaveBeenCalledWith('stat_file', {
      path: 'C:\\docs\\paper.md',
      includeContentHash: true,
    });
  });

  it('can grant validated external image paths before non-dialog reads', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('C:\\docs\\figure.png');

    await expect(grantExternalPath('C:\\docs\\figure.png', 'image')).resolves.toBe('C:\\docs\\figure.png');
    expect(invoke).toHaveBeenCalledWith('grant_external_path', {
      path: 'C:\\docs\\figure.png',
      kind: 'image',
    });
  });

  it('keeps Markdown picker and generic document picker on separate native commands', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce('C:\\docs\\paper.md')
      .mockResolvedValueOnce('C:\\docs\\results.json');

    await expect(pickMarkdownFile()).resolves.toBe('C:\\docs\\paper.md');
    await expect(pickDocumentFile()).resolves.toBe('C:\\docs\\results.json');

    expect(invoke).toHaveBeenNthCalledWith(1, 'pick_markdown_file');
    expect(invoke).toHaveBeenNthCalledWith(2, 'pick_document_file');
  });

  it('passes the active document format to the native Save As dialog', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('C:\\docs\\config.yaml');

    await expect(pickSavePath('Untitled.yaml', 'yaml')).resolves.toBe('C:\\docs\\config.yaml');

    expect(invoke).toHaveBeenCalledWith('pick_save_path', {
      defaultPath: 'Untitled.yaml',
      format: 'yaml',
    });
  });

  it('keeps generic document launch aliases tied to the Markdown launch queue', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce('C:\\docs\\startup.md')
      .mockResolvedValueOnce('C:\\docs\\startup.md')
      .mockResolvedValueOnce('C:\\docs\\pending.md')
      .mockResolvedValueOnce('C:\\docs\\pending.md')
      .mockResolvedValueOnce('C:\\docs\\taken.md')
      .mockResolvedValueOnce('C:\\docs\\taken.md')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await expect(getInitialMarkdownPath()).resolves.toBe('C:\\docs\\startup.md');
    await expect(getInitialDocumentPath()).resolves.toBe('C:\\docs\\startup.md');
    await expect(peekPendingMarkdownOpen()).resolves.toBe('C:\\docs\\pending.md');
    await expect(peekPendingDocumentOpen()).resolves.toBe('C:\\docs\\pending.md');
    await expect(takePendingMarkdownOpen()).resolves.toBe('C:\\docs\\taken.md');
    await expect(takePendingDocumentOpen()).resolves.toBe('C:\\docs\\taken.md');
    await clearPendingMarkdownOpen('C:\\docs\\old.md');
    await clearPendingDocumentOpen('C:\\docs\\old.md');

    expect(invoke).toHaveBeenNthCalledWith(1, 'initial_markdown_path');
    expect(invoke).toHaveBeenNthCalledWith(2, 'initial_document_path');
    expect(invoke).toHaveBeenNthCalledWith(3, 'peek_pending_markdown_open');
    expect(invoke).toHaveBeenNthCalledWith(4, 'peek_pending_document_open');
    expect(invoke).toHaveBeenNthCalledWith(5, 'take_pending_markdown_open');
    expect(invoke).toHaveBeenNthCalledWith(6, 'take_pending_document_open');
    expect(invoke).toHaveBeenNthCalledWith(7, 'clear_pending_markdown_open', { path: 'C:\\docs\\old.md' });
    expect(invoke).toHaveBeenNthCalledWith(8, 'clear_pending_document_open', { path: 'C:\\docs\\old.md' });
  });

  it('syncs current document image grants through the native boundary', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(2);

    await expect(syncDocumentImageGrants('C:\\docs\\paper.md', ['assets/a.png', 'assets/b.svg'])).resolves.toBe(2);
    expect(invoke).toHaveBeenCalledWith('sync_document_image_grants', {
      documentPath: 'C:\\docs\\paper.md',
      imageUrls: ['assets/a.png', 'assets/b.svg'],
    });
  });

  it('keeps generic text reads separate from edit-open text reads', async () => {
    const nativeComplete = {
      kind: 'complete' as const,
      contractVersion: 2,
      chunkCount: 1,
      snapshot: { method: 'windows-write-excluding-handle-v1', attempts: 1, identityVerified: true },
      metadata: {
        lineEnding: 'cr' as const,
        lineEndings: 'cr' as const,
        encoding: 'utf8' as const,
        hasBom: false,
        hasMixedLineEndings: false,
        decodeLossy: false,
        losslessWrite: 'yes' as const,
        lossReasons: [],
        originalByteHash: 'hash',
        lastKnownMtimeMs: 1,
        lastKnownSizeBytes: 11,
        contentHash: 'hash',
        cloudState: 'local' as const,
      },
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'read_text_file' || command === 'read_text_file_for_edit') {
        const channel = (args as { onEvent: { onmessage(event: unknown): void } }).onEvent;
        setTimeout(() => {
          channel.onmessage({ kind: 'sourceChunk', sequence: 0, sourceChunk: 'alpha\nbeta\n' });
          channel.onmessage(nativeComplete);
        }, 0);
      }
      return undefined as never;
    });

    const read = await readTextFile('C:\\docs\\paper.md');
    const editRead = await readTextFileForEdit('C:\\docs\\paper.md');

    expect(read).toMatchObject({
      sourceText: 'alpha\nbeta\n',
      contractVersion: 2,
      snapshot: { identityVerified: true },
    });
    expect(editRead.sourceText).toBe('alpha\nbeta\n');

    expect(invoke).toHaveBeenNthCalledWith(1, 'read_text_file', {
      path: 'C:\\docs\\paper.md',
      operationId: expect.any(String),
      onEvent: expect.any(Object),
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'read_text_file_for_edit', {
      path: 'C:\\docs\\paper.md',
      operationId: expect.any(String),
      onEvent: expect.any(Object),
    });
  });

  it('sends operation-ID cancellation and rejects a completed native value before renderer commit', async () => {
    const nativeComplete = {
      kind: 'complete' as const,
      contractVersion: 2,
      chunkCount: 1,
      snapshot: { method: 'windows-write-excluding-handle-v1', attempts: 1, identityVerified: true },
      metadata: { ...DEFAULT_METADATA },
    };
    let resolveRead!: () => void;
    let readChannel!: { onmessage(event: unknown): void };
    const nativeRead = new Promise<void>((resolve) => { resolveRead = resolve; });
    const onNativeCancellation = vi.fn();
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'read_text_file_for_edit') {
        readChannel = (args as { onEvent: { onmessage(event: unknown): void } }).onEvent;
        return nativeRead as never;
      }
      if (command === 'cancel_text_file_read') return Promise.resolve({ accepted: true, stopped: true, stopMs: 4 }) as never;
      return Promise.resolve(DEFAULT_METADATA) as never;
    });
    const controller = new AbortController();

    const read = readTextFileForEdit('C:\\docs\\paper.md', {
      operationId: 'read-cancel-test',
      signal: controller.signal,
      onNativeCancellation,
    });
    controller.abort();
    readChannel.onmessage({ kind: 'sourceChunk', sequence: 0, sourceChunk: 'never commit' });
    readChannel.onmessage(nativeComplete);
    resolveRead();

    await expect(read).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(invoke).toHaveBeenCalledWith('cancel_text_file_read', { operationId: 'read-cancel-test' });
    await vi.waitFor(() => expect(onNativeCancellation).toHaveBeenCalledWith({ accepted: true, stopped: true, stopMs: 4 }));
  });

  it('uses generic sourceText and CR fidelity metadata for atomic writes', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      lineEnding: 'cr',
      encoding: 'utf8',
      hasBom: false,
      hasMixedLineEndings: false,
      lastKnownMtimeMs: 2,
      lastKnownSizeBytes: 11,
      contentHash: 'next',
      cloudState: 'local',
    });

    const result = await writeTextFileAtomic('C:\\docs\\paper.txt', 'alpha\nbeta\n', {
      lineEnding: 'cr',
      encoding: 'utf8',
      hasBom: false,
      hasMixedLineEndings: false,
      lastKnownMtimeMs: 1,
      lastKnownSizeBytes: 11,
      contentHash: 'old',
      cloudState: 'local',
    });

    expect(invoke).toHaveBeenCalledWith('write_text_file_atomic', expect.objectContaining({
      sourceText: 'alpha\nbeta\n',
      lineEnding: 'cr',
    }));
    expect(result.lineEndings).toBe('cr');
    expect(result.losslessWrite).toBe('unknown');
  });

  it('lists readable explorer entries through the document native boundary', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      {
        name: 'notes',
        path: 'C:\\docs\\notes',
        kind: 'directory',
        sizeBytes: 0,
        modifiedMs: 1,
      },
      {
        name: 'paper.md',
        path: 'C:\\docs\\paper.md',
        kind: 'markdown',
        sizeBytes: 7,
        modifiedMs: 2,
      },
      {
        name: 'results.json',
        path: 'C:\\docs\\results.json',
        kind: 'json',
        sizeBytes: 12,
        modifiedMs: 3,
      },
      {
        name: 'records.jsonl',
        path: 'C:\\docs\\records.jsonl',
        kind: 'jsonl',
        sizeBytes: 18,
        modifiedMs: 4,
      },
      {
        name: 'config.yaml',
        path: 'C:\\docs\\config.yaml',
        kind: 'yaml',
        sizeBytes: 20,
        modifiedMs: 5,
      },
      {
        name: 'settings.toml',
        path: 'C:\\docs\\settings.toml',
        kind: 'toml',
        sizeBytes: 24,
        modifiedMs: 6,
      },
      {
        name: 'metadata.xml',
        path: 'C:\\docs\\metadata.xml',
        kind: 'xml',
        sizeBytes: 28,
        modifiedMs: 7,
      },
      {
        name: 'samples.csv',
        path: 'C:\\docs\\samples.csv',
        kind: 'csv',
        sizeBytes: 32,
        modifiedMs: 8,
      },
      {
        name: 'samples.tsv',
        path: 'C:\\docs\\samples.tsv',
        kind: 'tsv',
        sizeBytes: 36,
        modifiedMs: 9,
      },
    ]);

    await expect(listReadableFiles('C:\\docs')).resolves.toEqual([
      {
        name: 'notes',
        path: 'C:\\docs\\notes',
        kind: 'directory',
        sizeBytes: 0,
        modifiedMs: 1,
      },
      {
        name: 'paper.md',
        path: 'C:\\docs\\paper.md',
        kind: 'markdown',
        sizeBytes: 7,
        modifiedMs: 2,
      },
      {
        name: 'results.json',
        path: 'C:\\docs\\results.json',
        kind: 'json',
        sizeBytes: 12,
        modifiedMs: 3,
      },
      {
        name: 'records.jsonl',
        path: 'C:\\docs\\records.jsonl',
        kind: 'jsonl',
        sizeBytes: 18,
        modifiedMs: 4,
      },
      {
        name: 'config.yaml',
        path: 'C:\\docs\\config.yaml',
        kind: 'yaml',
        sizeBytes: 20,
        modifiedMs: 5,
      },
      {
        name: 'settings.toml',
        path: 'C:\\docs\\settings.toml',
        kind: 'toml',
        sizeBytes: 24,
        modifiedMs: 6,
      },
      {
        name: 'metadata.xml',
        path: 'C:\\docs\\metadata.xml',
        kind: 'xml',
        sizeBytes: 28,
        modifiedMs: 7,
      },
      {
        name: 'samples.csv',
        path: 'C:\\docs\\samples.csv',
        kind: 'csv',
        sizeBytes: 32,
        modifiedMs: 8,
      },
      {
        name: 'samples.tsv',
        path: 'C:\\docs\\samples.tsv',
        kind: 'tsv',
        sizeBytes: 36,
        modifiedMs: 9,
      },
    ]);
    expect(invoke).toHaveBeenCalledWith('list_readable_files', {
      path: 'C:\\docs',
    });
  });

  it('creates allowlisted generated sibling artifacts through the native boundary', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      path: 'C:\\docs\\ScieMD_LLM_skill.md',
      metadata: {
        lineEnding: 'lf',
        encoding: 'utf8',
        hasBom: false,
        hasMixedLineEndings: false,
        lastKnownMtimeMs: 1,
        lastKnownSizeBytes: 2,
        contentHash: null,
        cloudState: 'local',
      },
    });

    await createGeneratedSiblingArtifact('C:\\docs\\paper.md', 'llm-skill', '# Skill\n');

    expect(invoke).toHaveBeenCalledWith('create_generated_sibling_artifact', {
      documentPath: 'C:\\docs\\paper.md',
      artifactKind: 'llm-skill',
      markdown: '# Skill\n',
      lineEnding: 'lf',
      encoding: 'utf8',
      hasBom: false,
    });
  });
});
