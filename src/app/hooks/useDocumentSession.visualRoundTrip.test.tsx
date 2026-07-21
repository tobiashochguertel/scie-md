import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_METADATA } from '../documentState';
import type { FileMetadata, ReadTextFileResponse } from '../documentState';
import type { DocumentHost } from '../host/documentHost';
import { loadSettings } from '../../services/settingsService';
import type { PersistedSettings } from '../../services/settingsService';
import type { AuthorshipMark } from '../../markdown/authorship';
import type { ConfirmState } from './useDialogs';
import { useDocumentSession } from './useDocumentSession';
import { documentEditorGateway } from '../documentEditorGateway';
import type { EditorAdapter } from '../../components/editorAdapter';
import { loadRecoveryCatalog, resetRecoveryCatalogForTests } from '../../services/recoveryCatalog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type SessionState = ReturnType<typeof useDocumentSession>;

describe('useDocumentSession visual round-trip write acknowledgement', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestState: SessionState | null;
  let host: MockDocumentHost;
  let pushToast: ReturnType<typeof vi.fn<(text: string, tone?: 'info' | 'success' | 'warning' | 'error') => void>>;
  let confirmText: ReturnType<typeof vi.fn<(state: ConfirmState) => Promise<boolean>>>;
  const mockedReadVisualEditorState = vi.spyOn(documentEditorGateway, 'read');

  beforeEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    localStorage.clear();
    resetRecoveryCatalogForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latestState = null;
    host = createHost();
    pushToast = vi.fn<(text: string, tone?: 'info' | 'success' | 'warning' | 'error') => void>();
    confirmText = vi.fn<(state: ConfirmState) => Promise<boolean>>().mockResolvedValue(true);
    mockedReadVisualEditorState.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('prompts once per risky visual Markdown shape during the session', async () => {
    renderSession();
    const riskyMarkdown = 'Methods\n---\n\n+ compact\n+ list\n';

    let first: boolean | undefined;
    await act(async () => {
      first = await latestState?.confirmVisualRoundTripWrite(riskyMarkdown, { reason: 'save' });
    });
    let second: boolean | undefined;
    await act(async () => {
      second = await latestState?.confirmVisualRoundTripWrite(riskyMarkdown, { reason: 'save' });
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(confirmText).toHaveBeenCalledTimes(1);
    expect(confirmText).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Continue with visual formatting changes?',
      okLabel: 'Continue',
      cancelLabel: 'Cancel',
    }));
  });

  it('cancels an unacknowledged visual write before the caller commits it', async () => {
    confirmText.mockResolvedValue(false);
    renderSession();

    let allowed: boolean | undefined;
    await act(async () => {
      allowed = await latestState?.confirmVisualRoundTripWrite('Title\n---\n', { reason: 'save' });
    });

    expect(allowed).toBe(false);
    expect(pushToast).toHaveBeenCalledWith('Visual formatting write canceled.', 'info');
  });

  it('does not prompt for source-mode saves but does prompt before opening risky source in visual mode', async () => {
    renderSession();
    act(() => {
      latestState?.setMode('source');
    });
    await flushAsync();
    confirmText.mockClear();

    let sourceSaveAllowed: boolean | undefined;
    await act(async () => {
      sourceSaveAllowed = await latestState?.confirmVisualRoundTripWrite('Title\n---\n', { reason: 'save' });
    });
    let sourceToVisualAllowed: boolean | undefined;
    await act(async () => {
      sourceToVisualAllowed = await latestState?.confirmVisualRoundTripWrite('Title\n---\n', { reason: 'mode-switch-to-visual' });
    });

    expect(sourceSaveAllowed).toBe(true);
    expect(sourceToVisualAllowed).toBe(true);
    expect(confirmText).toHaveBeenCalledTimes(1);
  });

  it('flushes structured recovery drafts from source text without reading Markdown visual state', async () => {
    const path = 'C:\\docs\\results.json';
    renderSession();

    await act(async () => {
      await latestState?.handleOpen(path, { draftRestore: 'skip' });
    });
    await flushAsync();

    act(() => {
      latestState?.commitSourceTextEdit('{"ok":false}\n');
    });
    await flushAsync();
    mockedReadVisualEditorState.mockClear();

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await flushAsync();

    expect(mockedReadVisualEditorState).not.toHaveBeenCalled();
    const entry = (await loadRecoveryCatalog()).find((candidate) => candidate.documentId === latestState?.documentId);
    expect(entry).toMatchObject({ sourceText: '{"ok":false}\n', format: 'json' });
    expect(entry?.locator).toMatchObject({ kind: 'file', displayPath: path });
  });

  it('keeps opened frontmatter presentation document-local instead of rewriting global defaults', async () => {
    renderSession();
    const source = [
      '---',
      'scienfy:',
      '  visualStyle: scienfy',
      '  documentType: paper',
      '---',
      '# Paper',
    ].join('\n');

    act(() => {
      latestState?.commitOpenedDocument('C:\\docs\\paper.md', source, DEFAULT_METADATA, 'visual', source, 'markdown');
    });
    await flushAsync();

    expect(latestState?.documentRecord.presentation).toEqual({ visualStyle: 'scienfy', documentType: 'report' });
    expect(vi.mocked(host.settings.updateSettings)).not.toHaveBeenCalled();
    expect(vi.mocked(host.settings.rememberRecentFile)).toHaveBeenCalledWith('C:\\docs\\paper.md');
  });

  it('flushes and commits the addressed editor before replacing its workspace record', async () => {
    renderSession('# Original\n');
    const oldDocumentId = latestState!.documentId;
    const events: string[] = [];
    const adapter: EditorAdapter = {
      surface: 'visual',
      read: () => null,
      flushPendingEdits: () => {
        events.push('flush');
        return {
          surface: 'visual',
          markdown: '# Dirty editor\n',
          changed: true,
          markCommitted: () => events.push('markCommitted'),
        };
      },
      replace: () => false,
      focus: () => undefined,
      captureView: () => {
        events.push('snapshot');
        return { surface: 'visual', selection: { from: 1, to: 3 }, scrollTop: 12 };
      },
    };
    documentEditorGateway.registerAdapter(oldDocumentId, 'visual', adapter);

    act(() => {
      latestState?.commitOpenedDocument('C:\\docs\\next.md', '# Next\n', DEFAULT_METADATA, 'visual', '# Next\n', 'markdown');
    });
    await flushAsync();

    expect(events).toEqual(['flush', 'markCommitted', 'snapshot']);
    expect(latestState?.documentId).not.toBe(oldDocumentId);
    expect(latestState?.sourceText).toBe('# Next\n');
    expect(documentEditorGateway.read(oldDocumentId)).toBeNull();
  });

  it('restores an intentionally empty untitled draft when it differs from the initial document', async () => {
    vi.mocked(host.recovery.loadUntitledDraft).mockResolvedValue({
      markdown: '',
      savedAt: 1000,
      format: 'plainText',
    });
    renderSession('# Initial content\n');
    await flushAsync();

    expect(confirmText).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Restore unsaved draft?',
      okLabel: 'Restore',
    }));
    expect(latestState?.sourceText).toBe('');
    expect(latestState?.format).toBe('plainText');
  });

  it('checkpoints the addressed untitled document after the declared 600 ms recovery lag', async () => {
    vi.useFakeTimers();
    vi.mocked(host.recovery.shouldPersistUntitledDraft).mockReturnValue(true);
    renderSession();

    act(() => {
      latestState?.commitSourceTextEdit('   \n');
    });
    act(() => {
      vi.advanceTimersByTime(599);
    });
    expect((await loadRecoveryCatalog()).find((entry) => entry.documentId === latestState?.documentId)).toBeUndefined();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((await loadRecoveryCatalog()).find((entry) => entry.documentId === latestState?.documentId)).toMatchObject({
      sourceText: '   \n',
      format: 'markdown',
      locator: { kind: 'untitled' },
    });
  });

  it.each(['pagehide', 'beforeunload'] as const)(
    'flushes the addressed recovery target on %s',
    async (eventName) => {
      const path = 'C:\\docs\\results.json';
      renderSession();
      await act(async () => {
        await latestState?.handleOpen(path, { draftRestore: 'skip' });
      });
      await flushAsync();
      act(() => {
        latestState?.commitSourceTextEdit('');
      });
      await flushAsync();
      act(() => {
        window.dispatchEvent(new Event(eventName));
      });
      const entry = (await loadRecoveryCatalog()).find((candidate) => candidate.documentId === latestState?.documentId);
      expect(entry).toMatchObject({ sourceText: '', format: 'json' });
      expect(entry?.locator).toMatchObject({ kind: 'file', displayPath: path });
    },
  );

  it('flushes the addressed recovery target when visibility becomes hidden', async () => {
    const path = 'C:\\docs\\results.json';
    renderSession();
    await act(async () => {
      await latestState?.handleOpen(path, { draftRestore: 'skip' });
    });
    await flushAsync();
    act(() => {
      latestState?.commitSourceTextEdit('');
    });
    await flushAsync();
    const originalVisibilityState = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });

    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await flushAsync();
    } finally {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: originalVisibilityState });
    }

    const entry = (await loadRecoveryCatalog()).find((candidate) => candidate.documentId === latestState?.documentId);
    expect(entry).toMatchObject({ sourceText: '', format: 'json' });
    expect(entry?.locator).toMatchObject({ kind: 'file', displayPath: path });
  });

  function renderSession(initialMarkdown = '') {
    act(() => {
      root.render(
        <Harness
          host={host}
          confirmText={confirmText}
          pushToast={pushToast}
          initialMarkdown={initialMarkdown}
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
  recovery: DocumentHost['recovery'] & {
    saveFileDraftAsync: ReturnType<typeof vi.fn<DocumentHost['recovery']['saveFileDraftAsync']>>;
  };
}

function Harness({
  host,
  confirmText,
  pushToast,
  initialMarkdown,
  onState,
}: {
  host: DocumentHost;
  confirmText: (state: ConfirmState) => Promise<boolean>;
  pushToast: (text: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
  initialMarkdown: string;
  onState: (state: SessionState) => void;
}) {
  const [settings, setSettings] = useState<PersistedSettings>(() => loadSettings());
  const [_authorshipMarks, setAuthorshipMarks] = useState<AuthorshipMark[]>([]);
  const state = useDocumentSession({
    initialMarkdown,
    setSettings,
    confirmText,
    pushToast,
    host,
  });
  void settings;
  onState(state);
  return null;
}

function createHost(): MockDocumentHost {
  let settings = loadSettings();
  return {
    file: {
      readTextFile: vi.fn<(path: string) => Promise<ReadTextFileResponse>>().mockResolvedValue(readResponse('')),
      readTextFileForEdit: vi.fn<(path: string) => Promise<ReadTextFileResponse>>().mockImplementation(async (path) => (
        path.endsWith('.json') ? readResponse('{"ok":true}\n') : readResponse('')
      )),
      statFile: vi.fn<(path: string) => Promise<FileMetadata>>().mockResolvedValue(DEFAULT_METADATA),
      writeTextFileAtomic: vi.fn().mockResolvedValue(DEFAULT_METADATA),
      createBackupSnapshot: vi.fn().mockResolvedValue(null),
    },
    dialog: {
      pickMarkdownFile: vi.fn().mockResolvedValue(null),
      pickDocumentFile: vi.fn().mockResolvedValue(null),
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

function readResponse(content: string): ReadTextFileResponse {
  return {
    content,
    metadata: {
      ...DEFAULT_METADATA,
      lastKnownSizeBytes: content.length,
      contentHash: `hash:${content.length}`,
    },
  };
}

async function flushAsync() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 0);
      });
      await Promise.resolve();
    });
  }
}
