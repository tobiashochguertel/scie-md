import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, vi } from 'vitest';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { highlightingFor, syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { formatByteLengthUtf8, sourceEditorCapabilitiesFor, sourceSemanticPresentationMode } from '@sciemd/core';
import { LONG_LINE_VIEWPORT_CODE_UNITS, SourceTextEditor, createLanguageExtension, formatDiagnosticsForCodeMirror, longLineViewportRanges, remeasureSourceEditorAfterFontsReady, shouldTypewriterScroll, sourceEditorProjection, type SourceTextContextMenuRequest, type SourceTextEditorProps, type SourceTextFind, type SourceTextSelection } from './SourceTextEditor';
import { createDocumentId, sourceRevision } from '../app/documentIdentity';
import { applySourceChangeSet, createRevisionedSourceBuffer, materializeCurrentSource } from '../app/source/revisionedSourceBuffer';
import { documentPerformance } from '../app/performance/documentPerformance';
import { DocumentKeyedEditorGateway } from '../app/documentEditorGateway';
import type { EditorAdapter } from './editorAdapter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('semantic source presentation contract', () => {
  it('never typewriter-scrolls ordinary document edits', () => {
    expect(shouldTypewriterScroll({ selectionSet: true, docChanged: true })).toBe(false);
    expect(shouldTypewriterScroll({ selectionSet: true, docChanged: false })).toBe(true);
    expect(shouldTypewriterScroll({ selectionSet: false, docChanged: false })).toBe(false);
  });

  it('remeasures CodeMirror after every required IBM Plex Mono face is ready', async () => {
    const requestMeasure = vi.fn();
    const dom = document.createElement('div');
    const load = vi.fn().mockResolvedValue([]);
    const fonts = { load, ready: Promise.resolve({}) } as unknown as FontFaceSet;

    remeasureSourceEditorAfterFontsReady({ requestMeasure, dom }, fonts);
    await Promise.resolve();
    await Promise.resolve();

    expect(load).toHaveBeenCalledTimes(3);
    expect(load.mock.calls.map(([descriptor]) => descriptor)).toEqual([
      '300 14px "IBM Plex Mono"',
      'italic 300 14px "IBM Plex Mono"',
      '500 14px "IBM Plex Mono"',
    ]);
    expect(requestMeasure).toHaveBeenCalledTimes(1);
    expect(dom.dataset.sourceFontRemeasured).toBe('loaded');
  });

  it('styles Markdown and structured grammar tags without changing source, selection, or parse tree', () => {
    const fixtureBytes = readFileSync(join(process.cwd(), 'src/app/host/fixtures/source-semantic-invariance.md'));
    const source = fixtureBytes.toString('utf8');
    expect(fixtureBytes.equals(Buffer.from(source, 'utf8'))).toBe(true);
    expect(source).not.toContain('\r');

    for (const format of ['markdown', 'json', 'yaml', 'xml'] as const) {
      const profile = sourceEditorCapabilitiesFor(format);
      const doc = format === 'markdown' ? source : format === 'json' ? '{"key": true}' : format === 'yaml' ? 'key: true\n' : '<root key="value" />';
      const baseline = EditorState.create({ doc, selection: { anchor: Math.min(2, doc.length) }, extensions: createLanguageExtension(profile, 'enabled') });
      const tree = syntaxTree(baseline).toString();
      expect(baseline.doc.toString()).toBe(doc);
      expect(baseline.selection.main.anchor).toBe(Math.min(2, doc.length));
      expect(syntaxTree(baseline).toString()).toBe(tree);
      expect(highlightingFor(baseline, [tags.string, tags.propertyName, tags.heading, tags.tagName])).toBeTruthy();
    }
    expect(source).toContain('**Strong**');
    expect(source).toContain('[@smith2026]');
  });

  it('colors Markdown syntax delimiters independently from their semantic content', () => {
    const doc = '# Heading\n*em* **strong** [link](url)\n- item\n> quote\n`code`';
    const state = EditorState.create({
      doc,
      extensions: createLanguageExtension(sourceEditorCapabilitiesFor('markdown'), 'enabled'),
    });
    const host = document.createElement('div');
    const view = new EditorView({ state, parent: host });

    const markerText = [...host.querySelectorAll('.cm-source-syntax-marker')]
      .map((element) => element.textContent);
    expect(markerText).toEqual(expect.arrayContaining([
      '#', '*', '**', '[', ']', '(', ')', '-', '>', '`',
    ]));
    expect(markerText).not.toContain('em');
    expect(markerText).not.toContain('strong');
    expect(markerText).not.toContain('Heading');

    view.destroy();
  });

  it('uses conservative plain fallback for unsupported grammars and over-threshold files', () => {
    expect(sourceSemanticPresentationMode({ byteLength: 11, sourceOnlyThresholdBytes: 10, languageAvailable: true })).toBe('large-file-fallback');
    expect(sourceSemanticPresentationMode({ byteLength: 1, sourceOnlyThresholdBytes: 10, languageAvailable: false })).toBe('unsupported-plain');
    const fallback = EditorState.create({ doc: 'key = "value"', extensions: createLanguageExtension(sourceEditorCapabilitiesFor('toml'), 'unsupported-plain') });
    expect(syntaxTree(fallback).toString()).toBe('');
    expect(formatByteLengthUtf8(fallback.doc.toString())).toBe(Buffer.byteLength('key = "value"', 'utf8'));
  });

  it('bounds one enormous logical line around the active source position', () => {
    const lineTo = 24 * 1024 * 1024;
    const atStart = longLineViewportRanges(0, lineTo, 0);
    expect(atStart).toEqual([expect.objectContaining({
      from: LONG_LINE_VIEWPORT_CODE_UNITS,
      to: lineTo,
      direction: 'next',
    })]);
    const inMiddle = longLineViewportRanges(0, lineTo, lineTo / 2);
    expect(inMiddle).toHaveLength(2);
    expect(inMiddle.reduce((visible, range) => visible - range.hiddenCodeUnits, lineTo)).toBe(LONG_LINE_VIEWPORT_CODE_UNITS);
    expect(longLineViewportRanges(0, 1024, 512)).toEqual([]);
  });

  it('projects large fallback source into a revision-mappable bounded editor window', () => {
    const source = '0123456789'.repeat(20);
    expect(sourceEditorProjection(source, 'enabled', 40, 32)).toEqual({
      active: false, from: 0, to: source.length, sourceLength: source.length, text: source,
    });
    expect(sourceEditorProjection(source, 'large-file-fallback', 40, 32)).toEqual({
      active: true, from: 40, to: 72, sourceLength: source.length, text: source.slice(40, 72),
    });
    const atEnd = sourceEditorProjection(source, 'large-file-fallback', source.length, 32);
    expect(atEnd).toMatchObject({ active: true, from: source.length - 32, to: source.length });
    expect(atEnd.text).toBe(source.slice(-32));
  });

  it('uses the same bounded editor window for large enhanced source without changing the format threshold', () => {
    const source = 'x'.repeat((512 * 1024) + 1);
    const projected = sourceEditorProjection(source, 'enabled');

    expect(projected).toMatchObject({
      active: true,
      from: 0,
      to: 128 * 1024,
      sourceLength: source.length,
    });
    expect(projected.text).toHaveLength(128 * 1024);
  });
});

describe('SourceTextEditor diagnostics', () => {
  it('maps format diagnostic offsets into CodeMirror diagnostics', () => {
    const diagnostics = formatDiagnosticsForCodeMirror([
      {
        severity: 'error',
        code: 'json-syntax',
        message: 'Expected a JSON value.',
        offset: 8,
        length: 2,
        source: 'json',
      },
    ], '{\n  "a": \n}');

    expect(diagnostics).toEqual([{
      from: 8,
      to: 10,
      severity: 'error',
      source: 'json',
      message: 'Expected a JSON value.',
    }]);
  });

  it('falls back to line and column when offsets are unavailable', () => {
    const diagnostics = formatDiagnosticsForCodeMirror([
      {
        severity: 'warning',
        code: 'json-health',
        message: 'Array has mixed values.',
        line: 3,
        column: 5,
        source: 'json',
      },
    ], '{\n  "a": [\n    1\n  ]\n}');

    expect(diagnostics[0]).toMatchObject({
      from: 15,
      to: 16,
      severity: 'warning',
      source: 'json',
    });
  });
});

describe('SourceTextEditor context menu requests', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  it('uses CodeMirror selection state as the single visible caret authority', () => {
    renderSourceTextEditor({ value: 'alpha', language: 'markdown' });

    expect(container.querySelector('.cm-cursorLayer')).not.toBeNull();
    const sourceStyles = readFileSync(join(process.cwd(), 'src/styles/app.source-editor.css'), 'utf8');
    expect(sourceStyles).toContain('caret-color: transparent');
    expect(sourceStyles).toContain('.source-editor .cm-cursor');
  });

  it('emits a selected source payload and prevents the native menu only when handled', () => {
    let findSelection: SourceTextFind | undefined;
    const requests: SourceTextContextMenuRequest[] = [];
    const onContextMenuRequest = vi.fn((request: SourceTextContextMenuRequest) => {
      requests.push(request);
      return true;
    });

    renderSourceTextEditor({
      value: 'alpha\nbeta\n',
      language: 'json',
      diagnostics: [{
        severity: 'error',
        code: 'json-test',
        message: 'Line issue.',
        line: 1,
        column: 2,
        source: 'json',
      }],
      onFindReady: (handler) => {
        findSelection = handler;
      },
      onContextMenuRequest,
    });

    act(() => {
      findSelection?.(0, 5);
    });
    const event = dispatchSourceContextMenu();

    expect(event.defaultPrevented).toBe(true);
    expect(onContextMenuRequest).toHaveBeenCalledTimes(1);
    expect(requests[0]).toMatchObject({
      kind: 'selection',
      position: { x: 210, y: 120 },
      language: 'json',
      text: 'alpha',
      lineText: 'alpha',
      selectedLinesText: 'alpha',
      line: 1,
      endLine: 1,
      from: 0,
      to: 5,
      diagnostics: [{
        severity: 'error',
        code: 'json-test',
        message: 'Line issue.',
        line: 1,
        column: 2,
        source: 'json',
      }],
    });
  });

  it('emits a line source payload when no text is selected', () => {
    let findSelection: SourceTextFind | undefined;
    let getSelection: SourceTextSelection | undefined;
    const requests: SourceTextContextMenuRequest[] = [];
    const onContextMenuRequest = vi.fn((request: SourceTextContextMenuRequest) => {
      requests.push(request);
      return true;
    });

    renderSourceTextEditor({
      value: 'alpha\nbeta\n',
      language: 'json',
      diagnostics: [{
        severity: 'warning',
        code: 'json-line',
        message: 'Beta issue.',
        line: 2,
        source: 'json',
      }],
      onFindReady: (handler) => {
        findSelection = handler;
      },
      onSelectionTextReady: (handler) => {
        getSelection = handler;
      },
      onContextMenuRequest,
    });

    act(() => {
      findSelection?.(6, 6);
    });
    const event = dispatchSourceContextMenu();

    expect(event.defaultPrevented).toBe(true);
    expect(onContextMenuRequest).toHaveBeenCalledTimes(1);
    expect(requests[0]).toMatchObject({
      kind: 'line',
      language: 'json',
      text: 'beta',
      lineText: 'beta',
      selectedLinesText: 'beta',
      line: 2,
      endLine: 2,
      diagnostics: [{
        severity: 'warning',
        code: 'json-line',
        message: 'Beta issue.',
        line: 2,
        source: 'json',
      }],
    });

    act(() => {
      requests[0].selectLine();
    });

    expect(getSelection?.()).toMatchObject({
      text: 'beta',
      line: 2,
      endLine: 2,
      surface: 'source',
    });
  });

  it('leaves the native source context menu alone when the app does not handle a request', () => {
    const onContextMenuRequest = vi.fn(() => false);

    renderSourceTextEditor({
      value: 'alpha\nbeta\n',
      language: 'json',
      onContextMenuRequest,
    });

    const event = dispatchSourceContextMenu();

    expect(onContextMenuRequest).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it('keeps normal text update wiring intact', () => {
    let insertText: ((text: string) => void) | undefined;
    const onChange = vi.fn();

    renderSourceTextEditor({
      value: 'alpha',
      language: 'markdown',
      onChange,
      onInsertReady: (handler) => {
        insertText = handler;
      },
    });

    act(() => {
      insertText?.(' beta');
    });

    expect(onChange).toHaveBeenCalledWith(' betaalpha');
  });

  it('routes production CodeMirror edits as bounded change sets without a whole-source callback or materialization', () => {
    let insertText: ((text: string) => void) | undefined;
    const documentId = createDocumentId();
    const onChange = vi.fn();
    let buffer = createRevisionedSourceBuffer('alpha');
    const onChangeSet = vi.fn((changeSet) => {
      const result = applySourceChangeSet(documentId, buffer, changeSet);
      if (result.status === 'accepted') buffer = result.buffer;
      return result;
    });
    renderSourceTextEditor({
      performanceDocumentId: documentId,
      value: 'alpha',
      revision: sourceRevision(0),
      language: 'markdown',
      onChange,
      onChangeSet,
      onInsertReady: (handler) => { insertText = handler; },
    });
    documentPerformance.clear();
    act(() => { insertText?.('x'); });
    expect(onChange).not.toHaveBeenCalled();
    expect(onChangeSet).toHaveBeenCalledWith(expect.objectContaining({
      documentId,
      expectedRevision: 0,
      changes: [{ from: 0, to: 0, insert: 'x', expectedText: '' }],
    }));
    const report = documentPerformance.report();
    expect(report.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'source-change', changeBytes: 1, fullDocumentTransactions: 0, phase: 'codemirror-transaction' }),
    ]));
    expect(report.events.filter((event) => event.name === 'whole-source-materialization')).toEqual([]);
  });

  it('does not roll the live editor revision backward when a delayed React prop replays', () => {
    let insertText: ((text: string) => void) | undefined;
    const documentId = createDocumentId();
    let buffer = createRevisionedSourceBuffer('alpha');
    const onChangeSet = vi.fn((changeSet) => {
      const result = applySourceChangeSet(documentId, buffer, changeSet);
      if (result.status === 'accepted') buffer = result.buffer;
      return result;
    });
    const renderRevision = (value: string, revision: number) => {
      renderSourceTextEditor({
        performanceDocumentId: documentId,
        value,
        revision: sourceRevision(revision),
        language: 'markdown',
        onChangeSet,
        reconcileSource: () => ({
          sourceText: materializeCurrentSource(buffer),
          revision: buffer.current.revision,
        }),
        onInsertReady: (handler) => { insertText = handler; },
      });
    };

    renderRevision('alpha', 0);
    act(() => { insertText?.('x'); });
    expect(materializeCurrentSource(buffer)).toBe('xalpha');

    renderRevision('alpha', 0);
    act(() => { insertText?.('y'); });

    expect(onChangeSet.mock.calls.map(([changeSet]) => changeSet.expectedRevision)).toEqual([
      sourceRevision(0),
      sourceRevision(1),
    ]);
    expect(materializeCurrentSource(buffer)).toBe('xyalpha');
    expect(container.querySelector('.cm-content')?.textContent).toBe('xyalpha');
  });

  it('treats a stale compatibility value carrying the accepted revision as an acknowledgement', () => {
    let insertText: ((text: string) => void) | undefined;
    const documentId = createDocumentId();
    let buffer = createRevisionedSourceBuffer('alpha');
    const onChangeSet = vi.fn((changeSet) => {
      const result = applySourceChangeSet(documentId, buffer, changeSet);
      if (result.status === 'accepted') buffer = result.buffer;
      return result;
    });
    const renderRevision = (value: string, revision: number) => {
      renderSourceTextEditor({
        performanceDocumentId: documentId,
        value,
        revision: sourceRevision(revision),
        language: 'markdown',
        onChangeSet,
        reconcileSource: () => ({
          sourceText: materializeCurrentSource(buffer),
          revision: buffer.current.revision,
        }),
        onInsertReady: (handler) => { insertText = handler; },
      });
    };

    renderRevision('alpha', 0);
    act(() => { insertText?.('x'); });
    expect(materializeCurrentSource(buffer)).toBe('xalpha');

    // The workspace store publishes the accepted revision on the next frame,
    // while the legacy string projection can still contain the previous text.
    renderRevision('alpha', 1);
    expect(container.querySelector('.cm-content')?.textContent).toBe('xalpha');

    act(() => { insertText?.('y'); });
    expect(onChangeSet.mock.calls.map(([changeSet]) => changeSet.expectedRevision)).toEqual([
      sourceRevision(0),
      sourceRevision(1),
    ]);
    expect(materializeCurrentSource(buffer)).toBe('xyalpha');
    expect(container.querySelector('.cm-content')?.textContent).toBe('xyalpha');
  });

  it('reattaches an exact parked CodeMirror state for A -> B -> A without a content transaction', () => {
    const gateway = new DocumentKeyedEditorGateway();
    const first = createDocumentId();
    const second = createDocumentId();
    const largeSourceOnlyMarkdown = `${'# row\n'.repeat(900_000)}tail`;
    let firstBuffer = createRevisionedSourceBuffer('alpha');
    let secondBuffer = createRevisionedSourceBuffer(largeSourceOnlyMarkdown);
    let insertText: ((text: string) => void) | undefined;
    let findSelection: SourceTextFind | undefined;
    let getSelection: SourceTextSelection | undefined;

    const renderDocument = (documentId: typeof first, value: string, revision: number) => {
      const onAdapterReady = (adapter: EditorAdapter | undefined, retiringAdapter?: EditorAdapter) => {
        if (retiringAdapter) gateway.unregisterAdapter(documentId, 'source', retiringAdapter);
        else gateway.registerAdapter(documentId, 'source', adapter);
      };
      renderSourceTextEditor({
        performanceDocumentId: documentId,
        value,
        revision: sourceRevision(revision),
        language: 'markdown',
        onAdapterReady,
        onInsertReady: (handler) => { insertText = handler; },
        onFindReady: (handler) => { findSelection = handler; },
        onSelectionTextReady: (handler) => { getSelection = handler; },
        onChangeSet: (changeSet) => {
          const current = documentId === first ? firstBuffer : secondBuffer;
          const result = applySourceChangeSet(documentId, current, changeSet);
          if (result.status === 'accepted') {
            if (documentId === first) firstBuffer = result.buffer;
            else secondBuffer = result.buffer;
          }
          return result;
        },
      });
    };

    renderDocument(first, 'alpha', 0);
    act(() => { insertText?.('x'); findSelection?.(1, 3); });
    gateway.deactivate(first, vi.fn());
    renderDocument(second, largeSourceOnlyMarkdown, 0);
    expect(container.querySelector('.source-editor')?.getAttribute('data-source-semantic-highlighting')).toBe('large-file-fallback');
    gateway.deactivate(second, vi.fn());

    documentPerformance.clear();
    renderDocument(first, 'xalpha', 1);
    expect(getSelection?.()).toMatchObject({ text: 'al', from: 1, to: 3, surface: 'source' });
    expect(gateway.runtimeMetrics()).toMatchObject({ hits: 1 });
    const events = documentPerformance.report().events;
    expect(events.filter((event) => event.name === 'source-change' && event.fullDocumentTransactions)).toEqual([]);
    expect(events.filter((event) => event.name === 'whole-source-materialization')).toEqual([]);
  });

  it('uses adapter source metadata for language and status presentation', () => {
    renderSourceTextEditor({
      value: 'sample:\n  id: S-001\n',
      language: 'yaml',
    });

    expect(container.querySelector('.source-editor')?.getAttribute('data-source-editor-codemirror')).toBe('yaml');
    expect(container.querySelector('.source-editor')?.getAttribute('data-source-editor-lint')).toBe('structured');
    expect(container.querySelector('.source-editor-status-strip')?.textContent).toContain('YAML');
    expect(container.querySelector('.source-editor-status-strip')?.textContent).toContain('Parser OK');
  });

  it('shows format-aware source warnings without changing default Markdown source mode', () => {
    renderSourceTextEditor({
      value: '# Intro\n',
      language: 'markdown',
    });

    expect(container.querySelector('.source-editor-status-strip')).toBeNull();

    act(() => {
      root.render(createElement(SourceTextEditor, {
        value: 'a = [\r\nb = 1\n',
        language: 'toml',
        diagnostics: [
          {
            severity: 'error',
            code: 'toml-syntax',
            message: 'Invalid TOML.',
            line: 1,
            source: 'toml',
          },
          {
            severity: 'warning',
            code: 'toml-source-only-large-file',
            message: 'TOML exceeds the parser budget.',
            source: 'toml',
          },
        ],
        autosavePausedReason: 'Autosave paused: TOML syntax is invalid.',
        onChange: vi.fn(),
      }));
    });

    const statusText = container.querySelector('.source-editor-status-strip')?.textContent ?? '';
    expect(container.querySelector('.source-editor')?.getAttribute('data-source-editor-codemirror')).toBe('plainText');
    expect(statusText).toContain('TOML');
    expect(statusText).toContain('1 syntax error');
    expect(statusText).toContain('Source-only');
    expect(statusText).toContain('Plain text');
    expect(statusText).toContain('Mixed line endings');
    expect(statusText).toContain('Autosave paused');
  });

  it('shows one source status badge for true plain text documents', () => {
    renderSourceTextEditor({
      value: 'Header\n\nMain text\n',
      language: 'plainText',
    });

    const badgeLabels = Array.from(container.querySelectorAll('.source-editor-status-badge'))
      .map((badge) => badge.textContent);
    expect(badgeLabels).toEqual(['Plain Text']);
  });

  function renderSourceTextEditor(overrides: Partial<SourceTextEditorProps> = {}) {
    act(() => {
      root.render(createElement(SourceTextEditor, {
        value: '',
        language: 'markdown',
        diagnostics: [],
        onChange: vi.fn(),
        ...overrides,
      }));
    });
  }

  function dispatchSourceContextMenu(): MouseEvent {
    const target = container.querySelector<HTMLElement>('.cm-content');
    expect(target).not.toBeNull();
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 210,
      clientY: 120,
      button: 2,
    });
    act(() => {
      target?.dispatchEvent(event);
    });
    return event;
  }
});
