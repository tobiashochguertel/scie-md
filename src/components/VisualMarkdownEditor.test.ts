import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/kit/core';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { getMarkdown, replaceAll } from '@milkdown/kit/utils';
import { AllSelection } from '@milkdown/prose/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachVisualEditorRuntimeState,
  captureVisualEditorRuntimeState,
  estimateVisualEditorRuntimeByteWeight,
  equivalentVisualMarkdown,
  readVisualEditorStateSnapshot,
  reconcileVisualMarkdownProp,
  rememberLocalVisualEmission,
  visualClipboardPayload,
  VisualMarkdownEditor,
  type VisualMarkdownEditorProps,
} from './VisualMarkdownEditor';
import { createDocumentId, sourceRevision } from '../app/documentIdentity';
import { DocumentKeyedEditorGateway } from '../app/documentEditorGateway';
import { DocumentRuntimeRegistry } from '../app/runtime/documentRuntimeRegistry';
import { documentPerformance } from '../app/performance/documentPerformance';
import type { EditorAdapter } from './editorAdapter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('VisualMarkdownEditor warm tab activation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    documentPerformance.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  it('reattaches A -> B -> A without a whole-document Milkdown replacement', async () => {
    const registry = new DocumentRuntimeRegistry({
      lowWatermarkBytes: 16 * 1024 * 1024,
      highWatermarkBytes: 32 * 1024 * 1024,
      hardCeilingBytes: 64 * 1024 * 1024,
      reservedActiveHeadroomBytes: 8 * 1024 * 1024,
      minimumResidencyMs: 0,
    });
    const gateway = new DocumentKeyedEditorGateway(registry);
    const first = createDocumentId();
    const second = createDocumentId();
    let activeAdapter: EditorAdapter | undefined;
    let activeEditor: Editor | undefined;
    const onEditorReady = (editor: Editor | undefined) => { activeEditor = editor; };

    const renderDocument = async (
      documentId: typeof first,
      markdown: string,
      revision: number,
    ) => {
      const onAdapterReady = (adapter: EditorAdapter | undefined, retiringAdapter?: EditorAdapter) => {
        if (retiringAdapter) gateway.unregisterAdapter(documentId, 'visual', retiringAdapter);
        else {
          activeAdapter = adapter;
          gateway.registerAdapter(documentId, 'visual', adapter);
        }
      };
      await act(async () => {
        root.render(createElement(VisualMarkdownEditor, {
          performanceDocumentId: documentId,
          revision: sourceRevision(revision),
          markdown,
          filePath: null,
          onChange: vi.fn(),
          onEditorReady,
          onAdapterReady,
        } satisfies VisualMarkdownEditorProps));
      });
      await waitForCondition(() => Boolean(activeAdapter && activeEditor));
      await waitForCondition(() => activeEditor?.action(getMarkdown()).includes(markdown.includes('First') ? 'First' : 'Second') === true);
    };

    await renderDocument(first, '# First\n\nWarm document A.\n', 0);
    gateway.deactivate(first, vi.fn());
    activeAdapter = undefined;

    await renderDocument(second, '# Second\n\nWarm document B.\n', 0);
    gateway.deactivate(second, vi.fn());
    activeAdapter = undefined;

    documentPerformance.clear();
    await renderDocument(first, '# First\n\nWarm document A.\n', 0);

    expect(activeEditor?.action(getMarkdown())).toContain('First');
    expect(registry.metrics()).toMatchObject({ hits: 1 });
    expect(documentPerformance.report().events.filter((event) => (
      event.surface === 'visual'
      && event.phase === 'milkdown-external-replace'
    ))).toEqual([]);
  });

  it('reactivates through a fresh Milkdown host after a source/visual surface remount', async () => {
    const registry = new DocumentRuntimeRegistry({
      lowWatermarkBytes: 16 * 1024 * 1024,
      highWatermarkBytes: 32 * 1024 * 1024,
      hardCeilingBytes: 64 * 1024 * 1024,
      reservedActiveHeadroomBytes: 8 * 1024 * 1024,
      minimumResidencyMs: 0,
    });
    const gateway = new DocumentKeyedEditorGateway(registry);
    const documentId = createDocumentId();
    const markdown = '# Remounted\n\nReturn from source mode without reparsing Markdown.\n';
    let activeAdapter: EditorAdapter | undefined;
    let activeEditor: Editor | undefined;
    const onAdapterReady = (adapter: EditorAdapter | undefined, retiringAdapter?: EditorAdapter) => {
      if (retiringAdapter) gateway.unregisterAdapter(documentId, 'visual', retiringAdapter);
      else {
        activeAdapter = adapter;
        gateway.registerAdapter(documentId, 'visual', adapter);
      }
    };
    const renderVisual = async (warmRuntimeExpected: boolean) => {
      await act(async () => {
        root.render(createElement(VisualMarkdownEditor, {
          performanceDocumentId: documentId,
          revision: sourceRevision(0),
          warmRuntimeExpected,
          markdown,
          filePath: null,
          onChange: vi.fn(),
          onEditorReady: (editor) => { activeEditor = editor; },
          onAdapterReady,
        } satisfies VisualMarkdownEditorProps));
      });
      await waitForCondition(() => Boolean(activeAdapter && activeEditor));
    };

    await renderVisual(false);
    gateway.deactivate(documentId, vi.fn());
    activeAdapter = undefined;
    await act(async () => {
      root.render(createElement('div', { 'data-testid': 'source-surface' }));
    });

    documentPerformance.clear();
    await renderVisual(true);

    expect(activeEditor?.action(getMarkdown())).toContain('Remounted');
    expect(registry.metrics()).toMatchObject({ hits: 1 });
    expect(documentPerformance.report().events).toContainEqual(expect.objectContaining({
      name: 'runtime-attach',
      surface: 'visual',
      cache: 'hit',
      phase: 'transferable-state',
    }));
    expect(documentPerformance.report().events.filter((event) => (
      event.surface === 'visual'
      && event.phase === 'milkdown-external-replace'
    ))).toEqual([]);
  });
});

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the visual editor test condition.');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe('visual editor warm runtime', () => {
  it('reattaches the exact ProseMirror state without reparsing Markdown', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const source = '# First\n\nWarm visual document.\n';
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, source);
      })
      .use(commonmark)
      .use(gfm)
      .create();
    const runtime = captureVisualEditorRuntimeState({
      editor,
      hostInstanceId: 'visual-host-a',
      sourceMarkdown: source,
      frontmatterPrefix: '',
      visualMarkdown: source,
      displayToOriginal: new Map(),
    });
    expect(runtime).not.toBeNull();

    editor.action(replaceAll('# Second\n\nCold replacement.\n', true));
    expect(editor.action(getMarkdown())).toContain('Second');

    expect(attachVisualEditorRuntimeState(editor, runtime!)).toBe(true);
    expect(editor.ctx.get(editorViewCtx).state).toBe(runtime?.editorState);
    expect(editor.action(getMarkdown())).toContain('First');
    expect(editor.action(getMarkdown())).not.toContain('Second');

    await editor.destroy();
    root.remove();
  });

  it('transfers a parked document into a newly mounted Milkdown host without retaining stale plugin closures', async () => {
    const firstRoot = document.createElement('div');
    const secondRoot = document.createElement('div');
    document.body.append(firstRoot, secondRoot);
    const source = '# Transferable\n\nVisual state survives a surface remount.\n';
    const firstEditor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, firstRoot);
        ctx.set(defaultValueCtx, source);
      })
      .use(commonmark)
      .use(gfm)
      .create();
    const runtime = captureVisualEditorRuntimeState({
      editor: firstEditor,
      hostInstanceId: 'visual-host-a',
      sourceMarkdown: source,
      frontmatterPrefix: '',
      visualMarkdown: source,
      displayToOriginal: new Map(),
    });
    const secondEditor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, secondRoot);
        ctx.set(defaultValueCtx, '');
      })
      .use(commonmark)
      .use(gfm)
      .create();

    expect(attachVisualEditorRuntimeState(secondEditor, runtime!, 'visual-host-b')).toBe(true);
    expect(secondEditor.ctx.get(editorViewCtx).state).not.toBe(runtime?.editorState);
    expect(secondEditor.action(getMarkdown())).toContain('Transferable');

    await firstEditor.destroy();
    await secondEditor.destroy();
    firstRoot.remove();
    secondRoot.remove();
  });

  it('accounts conservatively for source, document tree, and bounded history', () => {
    const small = estimateVisualEditorRuntimeByteWeight('a'.repeat(10));
    const large = estimateVisualEditorRuntimeByteWeight('a'.repeat(5 * 1024 * 1024));

    expect(small.totalBytes).toBe(256 * 1024);
    expect(large.historyBytes).toBe(8 * 1024 * 1024);
    expect(large.totalBytes).toBe(28 * 1024 * 1024);
  });
});

describe('visual clipboard serialization', () => {
  it('provides rich HTML and Markdown-preserving plain text for formatted selections', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, [
          'A **bold** and *italic* [link](https://example.com).',
          '',
          '- First bullet',
          '- Second bullet',
          '',
          '3. Third item',
          '4. Fourth item',
        ].join('\n'));
      })
      .use(commonmark)
      .use(gfm)
      .use(clipboard)
      .create();
    const view = editor.ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));

    const payload = visualClipboardPayload(editor);

    expect(payload?.html).toContain('<strong>bold</strong>');
    expect(payload?.html).toContain('<em>italic</em>');
    expect(payload?.html).toContain('<a href="https://example.com">link</a>');
    expect(payload?.html).toContain('<ul ');
    expect(payload?.html).toContain('<ol start="3"');
    expect(payload?.text).toContain('**bold**');
    expect(payload?.text).toMatch(/\*italic\*|_italic_/);
    expect(payload?.text).toContain('[link](https://example.com)');
    expect(payload?.text).toMatch(/[-*+] First bullet/);
    expect(payload?.text).toContain('3. Third item');

    await editor.destroy();
    root.remove();
  });
});

describe('equivalentVisualMarkdown', () => {
  it('treats first-mount line ending and trailing whitespace normalization as equivalent', () => {
    expect(equivalentVisualMarkdown('---\ntitle: Demo\n---\n# Title  \n', '---\r\ntitle: Demo\r\n---\r\n# Title\n')).toBe(true);
  });

  it('does not hide meaningful content changes', () => {
    expect(equivalentVisualMarkdown('# Title\n\nA', '# Title\n\nB')).toBe(false);
  });
});

describe('visual Markdown prop reconciliation', () => {
  it('ignores delayed local echoes instead of replacing the live editor document', () => {
    let pending = rememberLocalVisualEmission([], '# Title\n\na');
    pending = rememberLocalVisualEmission(pending, '# Title\n\nab');
    pending = rememberLocalVisualEmission(pending, '# Title\n\nabc');

    const stale = reconcileVisualMarkdownProp('# Title\n\na', '# Title\n\nabc', pending);
    expect(stale.kind).toBe('stale-local-echo');
    expect(stale.pendingLocalEmissions).toHaveLength(2);

    const current = reconcileVisualMarkdownProp(
      '# Title\n\nabc',
      '# Title\n\nabc',
      stale.pendingLocalEmissions,
    );
    expect(current).toEqual({
      kind: 'current-local-echo',
      pendingLocalEmissions: [],
    });
  });

  it('treats an equivalent normalized echo as local without queuing a full replacement', () => {
    expect(reconcileVisualMarkdownProp(
      '# Title  \r\n',
      '# Title\n',
      [],
    )).toEqual({
      kind: 'current-local-echo',
      pendingLocalEmissions: [],
    });
  });

  it('classifies a genuinely different source update as external', () => {
    const pending = rememberLocalVisualEmission([], '# Title\n\nlocal');
    expect(reconcileVisualMarkdownProp(
      '# Title\n\nchanged on disk',
      '# Title\n\nlocal',
      pending,
    )).toEqual({
      kind: 'external',
      pendingLocalEmissions: [],
    });
  });
});

describe('readVisualEditorStateSnapshot', () => {
  it('returns the React source markdown without serializing when visual and metadata state are clean', () => {
    const flushPendingMetadataEdits = vi.fn(() => false);
    const readFullMarkdown = vi.fn(() => '# Serialized\n');

    expect(readVisualEditorStateSnapshot({
      visualContentMutated: false,
      sourceMarkdown: '# Source\n',
      lastEmittedMarkdown: '# Source\n',
      flushPendingMetadataEdits,
      readFullMarkdown,
      markCommitted: vi.fn(),
    })).toEqual({
      surface: 'visual',
      markdown: '# Source\n',
      changed: false,
    });
    expect(flushPendingMetadataEdits).toHaveBeenCalledTimes(1);
    expect(readFullMarkdown).not.toHaveBeenCalled();
  });

  it('serializes the full editor when metadata node views flush pending textarea edits', () => {
    const markCommitted = vi.fn();
    const result = readVisualEditorStateSnapshot({
      visualContentMutated: false,
      sourceMarkdown: '<!-- scie_md:note id="n1": Old note. -->',
      lastEmittedMarkdown: '<!-- scie_md:note id="n1": Old note. -->',
      flushPendingMetadataEdits: vi.fn(() => true),
      readFullMarkdown: vi.fn(() => '<!-- scie_md:note id="n1": Pending note. -->'),
      markCommitted,
    });

    expect(result).toMatchObject({
      surface: 'visual',
      markdown: '<!-- scie_md:note id="n1": Pending note. -->',
      changed: true,
    });
    expect(result?.markCommitted).toEqual(expect.any(Function));

    result?.markCommitted?.();
    expect(markCommitted).toHaveBeenCalledWith('<!-- scie_md:note id="n1": Pending note. -->');
  });

  it('does not mark committed when the serialized editor remains equivalent', () => {
    const markCommitted = vi.fn();
    const markSynchronized = vi.fn();
    const result = readVisualEditorStateSnapshot({
      visualContentMutated: false,
      sourceMarkdown: '# Source\n',
      lastEmittedMarkdown: '# Source\n',
      flushPendingMetadataEdits: vi.fn(() => true),
      readFullMarkdown: vi.fn(() => '# Source  \n'),
      markCommitted,
      markSynchronized,
    });

    expect(result).toMatchObject({
      surface: 'visual',
      markdown: '# Source  \n',
      changed: false,
    });
    expect(result?.markCommitted).toBeUndefined();
    expect(markSynchronized).toHaveBeenCalledWith('# Source  \n');
  });

  it('clears the mutation marker when a changed snapshot is committed so cleanup does not serialize again', () => {
    const markCommitted = vi.fn();
    const markSynchronized = vi.fn();
    const result = readVisualEditorStateSnapshot({
      visualContentMutated: true,
      sourceMarkdown: '# Before\n',
      lastEmittedMarkdown: '# Before\n',
      flushPendingMetadataEdits: vi.fn(() => false),
      readFullMarkdown: vi.fn(() => '# After\n'),
      markCommitted,
      markSynchronized,
    });

    expect(markSynchronized).not.toHaveBeenCalled();
    result?.markCommitted?.();
    expect(markCommitted).toHaveBeenCalledWith('# After\n');
    expect(markSynchronized).toHaveBeenCalledWith('# After\n');
  });
});
