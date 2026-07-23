import { useEffect, useRef } from 'react';
import type { MouseEvent } from 'react';
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/kit/core';
import type { Editor as MilkdownEditor } from '@milkdown/kit/core';
import { Plugin, TextSelection } from '@milkdown/prose/state';
import type { EditorState as ProseMirrorEditorState } from '@milkdown/prose/state';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import type { EditorView } from '@milkdown/prose/view';
import { nord } from '@milkdown/theme-nord';
import { fromVisualImagePaths, toVisualImagePaths } from '../markdown/imagePaths';
import { quoteAnchorPrefix, quoteAnchorSuffix } from '@sciemd/core';
import { $prose, getMarkdown, insert, replaceAll } from '@milkdown/kit/utils';
import type { EditorHistoryControls } from './editorControls';
import type { EditorSelectionGetter } from './editorSelection';
import { visualSourceLineForPosition } from './visualSourceMapping';
import { parseFrontmatter } from '@sciemd/core';
import { mathPreviewPlugin } from './mathPreviewPlugin';
import { createVariablePreviewPlugin } from './variablePreviewPlugin';
import { createCitationHoverPlugin } from './citationHoverPlugin';
import { blockHandlePlugin } from './blockHandlePlugin';
import { editableTailPlugin } from './editableTailPlugin';
import { focusModePlugin } from './focusModePlugin';
import { visualEditingBoundaryPlugin } from './visualEditingBoundaryPlugin';
import { flushScieMetadataNodeViews, isScieMetadataNode, registerScieMetadataEditorContext, scieMetadataPlugins, unregisterScieMetadataEditorContext, updateScieMetadataEditorContext } from './milkdown/scieMetadataNodes';
import type { EditorAdapter, EditorAdapterReady, EditorReadResult, EditorSelectionAnchor, EditorViewSnapshot } from './editorAdapter';
import '@milkdown/theme-nord/style.css';
import 'katex/dist/katex.min.css';
import { canonicalizeVariableTokens } from '@sciemd/core';
import type { VariableDefinition } from '@sciemd/core';
import type { BibtexEntry } from '@sciemd/core';
import type { MarkdownHeading } from '@sciemd/core';
import type { DocumentId, SourceRevision } from '../app/documentIdentity';
import { documentPerformance, utf8ByteLength } from '../app/performance/documentPerformance';

export type VisualMarkdownInsert = (markdown: string, options?: { filePath?: string | null }) => void;
export interface VisualMarkdownJumpTarget {
  id: string;
  level: number;
  text: string;
  line: number;
  occurrence: number;
}
export type VisualMarkdownJump = (target: VisualMarkdownJumpTarget) => void;
export type VisualMarkdownFind = (query: string, occurrence: number, caseSensitive: boolean) => void;
export type VisualMarkdownSelection = EditorSelectionGetter;

export interface VisualClipboardPayload {
  html: string;
  text: string;
}

export function visualClipboardPayload(editor: MilkdownEditor): VisualClipboardPayload | null {
  let payload: VisualClipboardPayload | null = null;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (view.state.selection.empty) return;
    const serialized = view.serializeForClipboard(view.state.selection.content());
    payload = {
      html: serialized.dom.innerHTML,
      text: serialized.text,
    };
  });
  return payload;
}

export async function copyVisualEditorSelection(
  editor: MilkdownEditor,
  clipboardApi: Pick<Clipboard, 'write' | 'writeText'> | undefined = navigator.clipboard,
): Promise<boolean> {
  const payload = visualClipboardPayload(editor);
  if (!payload || !clipboardApi) return false;
  if (typeof ClipboardItem !== 'undefined' && clipboardApi.write) {
    try {
      await clipboardApi.write([
        new ClipboardItem({
          'text/html': new Blob([payload.html], { type: 'text/html' }),
          'text/plain': new Blob([payload.text], { type: 'text/plain' }),
        }),
      ]);
      return true;
    } catch {
      // Some WebView clipboard implementations only expose writeText.
    }
  }
  await clipboardApi.writeText(payload.text);
  return true;
}

export interface VisualMarkdownEditorProps {
  performanceDocumentId?: DocumentId;
  revision?: SourceRevision;
  markdown: string;
  filePath: string | null;
  onChange: (markdown: string) => void;
  onEditorReady: (editor: MilkdownEditor | undefined) => void;
  onInsertReady?: (insert: VisualMarkdownInsert | undefined) => void;
  onJumpReady?: (jump: VisualMarkdownJump | undefined) => void;
  onFindReady?: (find: VisualMarkdownFind | undefined) => void;
  onHistoryReady?: (history: EditorHistoryControls | undefined) => void;
  onSelectionTextReady?: (selection: VisualMarkdownSelection | undefined) => void;
  onAdapterReady?: EditorAdapterReady;
  onCursorLineChange?: (line: number, column: number) => void;
  onViewportLineChange?: (line: number) => void;
  outlineHeadings?: MarkdownHeading[];
  onLockViolation?: (message: string) => void;
  onToast?: (text: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
  confirmText?: (state: { title: string; message: string; okLabel: string; cancelLabel: string }) => Promise<boolean>;
  referenceLabels?: string[];
  citationKeys?: string[];
  citationEntries?: BibtexEntry[];
  variableDefinitions?: VariableDefinition[];
  highlightedVariableName?: string | null;
  onEditCitation?: (key: string) => void;
  onEditVariable?: (name: string) => void;
}

function MilkdownSurface({ performanceDocumentId, revision, markdown, filePath, onChange, onEditorReady, onInsertReady, onJumpReady, onFindReady, onHistoryReady, onSelectionTextReady, onAdapterReady, onCursorLineChange, onViewportLineChange, outlineHeadings = [], onLockViolation, onToast, confirmText, citationKeys = [], citationEntries = [], variableDefinitions = [], highlightedVariableName = null, onEditCitation, onEditVariable }: VisualMarkdownEditorProps) {
  const initialSplit = useRef(splitVisualMarkdown(markdown));
  const citationKeysRef = useRef(citationKeys);
  const citationEntriesRef = useRef(citationEntries);
  const onEditCitationRef = useRef(onEditCitation);
  const variableDefinitionsRef = useRef(variableDefinitions);
  const highlightedVariableNameRef = useRef(highlightedVariableName);
  const onEditVariableRef = useRef(onEditVariable);
  const visualPaths = useRef(toVisualImagePaths(initialSplit.current.visualMarkdown, filePath));
  const initialMarkdown = useRef(visualPaths.current.markdown);
  const onChangeRef = useRef(onChange);
  const performanceDocumentIdRef = useRef(performanceDocumentId);
  const revisionRef = useRef(revision);
  const runtimeInstanceIdRef = useRef(`visual-editor-${Math.random().toString(36).slice(2)}`);
  const onCursorLineChangeRef = useRef(onCursorLineChange);
  const onViewportLineChangeRef = useRef(onViewportLineChange);
  const outlineHeadingsRef = useRef(outlineHeadings);
  const onLockViolationRef = useRef(onLockViolation);
  const editorRef = useRef<MilkdownEditor | undefined>(undefined);
  const filePathRef = useRef(filePath);
  const sourceMarkdownRef = useRef(markdown);
  const incomingMarkdownRef = useRef(markdown);
  const frontmatterPrefixRef = useRef(initialSplit.current.frontmatterPrefix);
  const lastEmittedMarkdown = useRef(markdown);
  const pendingLocalEmissionsRef = useRef<VisualMarkdownEmissionFingerprint[]>([]);
  const applyingExternalUpdate = useRef(false);
  const initialEmissionHandled = useRef(false);
  const visualContentMutated = useRef(false);
  const warmAttachmentRef = useRef<{ documentId: DocumentId; revision: SourceRevision } | null>(null);
  const visualEditorRootRef = useRef<HTMLDivElement | null>(null);
  const metadataContextId = useRef(`scie-md-${Math.random().toString(36).slice(2)}`);
  incomingMarkdownRef.current = markdown;

  useEffect(() => {
    const contextId = metadataContextId.current;
    registerScieMetadataEditorContext(contextId, {
      documentPath: filePathRef.current,
      citationEntries: citationEntriesRef.current,
      pushToast: onToast,
      confirmText,
    });
    return () => unregisterScieMetadataEditorContext(contextId);
  }, []);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    performanceDocumentIdRef.current = performanceDocumentId;
  }, [performanceDocumentId]);

  useEffect(() => {
    revisionRef.current = revision;
  }, [revision]);

  useEffect(() => {
    onCursorLineChangeRef.current = onCursorLineChange;
  }, [onCursorLineChange]);

  useEffect(() => {
    onViewportLineChangeRef.current = onViewportLineChange;
  }, [onViewportLineChange]);

  useEffect(() => {
    outlineHeadingsRef.current = outlineHeadings;
  }, [outlineHeadings]);

  useEffect(() => {
    onLockViolationRef.current = onLockViolation;
  }, [onLockViolation]);

  useEffect(() => {
    updateScieMetadataEditorContext(metadataContextId.current, {
      pushToast: onToast,
      confirmText,
    });
  }, [confirmText, onToast]);

  useEffect(() => {
    filePathRef.current = filePath;
    updateScieMetadataEditorContext(metadataContextId.current, { documentPath: filePath });
  }, [filePath]);

  useEffect(() => {
    variableDefinitionsRef.current = variableDefinitions;
    refreshVariablePreviewDecorations(editorRef.current);
  }, [variableDefinitions]);

  useEffect(() => {
    highlightedVariableNameRef.current = highlightedVariableName;
    refreshVariablePreviewDecorations(editorRef.current);
  }, [highlightedVariableName]);

  useEffect(() => {
    onEditVariableRef.current = onEditVariable;
  }, [onEditVariable]);

  useEffect(() => {
    citationKeysRef.current = citationKeys;
  }, [citationKeys]);

  useEffect(() => {
    citationEntriesRef.current = citationEntries;
    updateScieMetadataEditorContext(metadataContextId.current, { citationEntries });
  }, [citationEntries]);

  useEffect(() => {
    onEditCitationRef.current = onEditCitation;
  }, [onEditCitation]);

  useEffect(() => {
    const handleLockViolation = (event: Event) => {
      const custom = event as CustomEvent<{ message?: string }>;
      onLockViolationRef.current?.(custom.detail?.message ?? 'This section is locked. Unlock it before editing.');
    };
    window.addEventListener('scie-md-lock-violation', handleLockViolation);
    return () => window.removeEventListener('scie-md-lock-violation', handleLockViolation);
  }, []);

  const { loading, get } = useEditor(
    (root) =>
      Editor.make()
        .config(nord)
        .use(scieMetadataPlugins)
        .use(commonmark)
        .use(gfm)
        .use(clipboard)
        .use(mathPreviewPlugin)
        .use(createCitationHoverPlugin(() => citationEntriesRef.current, () => citationKeysRef.current, () => onEditCitationRef.current))
        .use(createVariablePreviewPlugin(
          () => variableDefinitionsRef.current,
          () => highlightedVariableNameRef.current,
          (name) => onEditVariableRef.current?.(name),
        ))
        .use(blockHandlePlugin)
        .use(visualEditingBoundaryPlugin)
        .use(editableTailPlugin)
        .use(focusModePlugin)
        .use(createVisualChangeListenerPlugin(
          () => applyingExternalUpdate.current || !initialEmissionHandled.current,
          () => {
            visualContentMutated.current = true;
          },
        ))
        .use(listener)
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, initialMarkdown.current);
          ctx.get(listenerCtx).markdownUpdated((listenerCtxValue, markdownValue) => {
            if (applyingExternalUpdate.current) return;
            cleanupDisplayPathMap(visualPaths.current.displayToOriginal, markdownValue);
            const restored = fromVisualImagePaths(markdownValue, visualPaths.current.displayToOriginal);
            const fullMarkdown = canonicalizeVariableTokens(`${frontmatterPrefixRef.current}${restored}`);
            if (!initialEmissionHandled.current) {
              initialEmissionHandled.current = true;
              lastEmittedMarkdown.current = sourceMarkdownRef.current;
              return;
            }
            if (!visualContentMutated.current) {
              lastEmittedMarkdown.current = sourceMarkdownRef.current;
              return;
            }
            lastEmittedMarkdown.current = fullMarkdown;
            sourceMarkdownRef.current = fullMarkdown;
            pendingLocalEmissionsRef.current = rememberLocalVisualEmission(
              pendingLocalEmissionsRef.current,
              fullMarkdown,
            );
            const tracedDocumentId = performanceDocumentIdRef.current;
            if (tracedDocumentId) {
              documentPerformance.trace({ name: 'input-accepted', documentId: tracedDocumentId, surface: 'visual' });
              documentPerformance.trace({
                name: 'whole-source-materialization',
                documentId: tracedDocumentId,
                surface: 'visual',
                materializedBytes: utf8ByteLength(fullMarkdown),
                phase: 'milkdown-change-callback',
              });
              requestAnimationFrame(() => documentPerformance.trace({ name: 'input-echoed', documentId: tracedDocumentId, surface: 'visual' }));
            }
            onChangeRef.current(fullMarkdown);
          });
        }),
    [],
  );

  useEffect(() => {
    if (loading) {
      if (editorRef.current) {
        editorRef.current = undefined;
        onEditorReady(undefined);
        onInsertReady?.(undefined);
        onJumpReady?.(undefined);
        onFindReady?.(undefined);
        onHistoryReady?.(undefined);
        onSelectionTextReady?.(undefined);
        onAdapterReady?.(undefined);
      }
      return undefined;
    }

    const editor = get();
    if (editorRef.current === editor) return undefined;
    editorRef.current = editor;
    onEditorReady(editor);
    if (!editor) {
      onInsertReady?.(undefined);
      onJumpReady?.(undefined);
      onFindReady?.(undefined);
      onHistoryReady?.(undefined);
      onSelectionTextReady?.(undefined);
      onAdapterReady?.(undefined);
      return undefined;
    }
    if (performanceDocumentIdRef.current) {
      const tracedDocumentId = performanceDocumentIdRef.current;
      documentPerformance.trace({ name: 'editor-attach', documentId: tracedDocumentId, surface: 'visual' });
      requestAnimationFrame(() => documentPerformance.trace({ name: 'next-frame', documentId: tracedDocumentId, surface: 'visual' }));
    }

    onInsertReady?.((markdownSnippet, options) => {
      visualContentMutated.current = true;
      const visualMarkdown = markdownSnippet;
      const nextVisualPaths = toVisualImagePaths(visualMarkdown, options?.filePath ?? filePathRef.current);
      for (const [displayUrl, originalUrl] of nextVisualPaths.displayToOriginal.entries()) {
        visualPaths.current.displayToOriginal.set(displayUrl, originalUrl);
      }
      editor.action(insert(nextVisualPaths.markdown));
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        appendWritableTailIfNeeded(view);
        view.focus();
      });
    });
    onJumpReady?.((target) => {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const position = findHeadingPosition(view, target, sourceMarkdownRef.current, frontmatterPrefixRef.current);
        if (position === null) return;
        const selection = TextSelection.near(view.state.doc.resolve(Math.min(position + 1, view.state.doc.content.size)));
        view.dispatch(view.state.tr.setSelection(selection));
        view.focus();
        scrollEditorPositionToTop(view, position);
      });
    });
    onFindReady?.((query, occurrence, caseSensitive) => {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const match = findTextMatchPosition(view.state.doc, query, occurrence, caseSensitive);
        if (!match) return;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to)));
        view.focus();
        scrollEditorPositionToCenter(view, match.from);
      });
    });
    onHistoryReady?.(undefined);
    onSelectionTextReady?.(() => {
      let selectedText = '';
      let line: number | undefined;
      let endLine: number | undefined;
      let from: number | undefined;
      let to: number | undefined;
      let prefix: string | undefined;
      let suffix: string | undefined;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const selection = view.state.selection;
        const slice = view.state.selection.content();
        selectedText = restoreSelectedVisualMarkdown(slice.content.textBetween(0, slice.content.size, '\n'), visualPaths.current.displayToOriginal);
        line = visualSourceLineForPosition(view.state.doc, selection.from, sourceMarkdownRef.current)
          ?? visualLineForPosition(view, selection.from, frontmatterPrefixRef.current);
        const selectionEndPosition = Math.max(selection.from, selection.to - 1);
        endLine = visualSourceLineForPosition(view.state.doc, selectionEndPosition, sourceMarkdownRef.current)
          ?? visualLineForPosition(view, selectionEndPosition, frontmatterPrefixRef.current);
        from = selection.from;
        to = selection.to;
        const beforeText = restoreSelectedVisualMarkdown(view.state.doc.textBetween(0, selection.from, '\n', '\n'), visualPaths.current.displayToOriginal);
        const afterText = restoreSelectedVisualMarkdown(view.state.doc.textBetween(selection.to, view.state.doc.content.size, '\n', '\n'), visualPaths.current.displayToOriginal);
        prefix = quoteAnchorPrefix(beforeText);
        suffix = quoteAnchorSuffix(afterText);
      });
      return {
        text: selectedText || restoreSelectedVisualMarkdown(window.getSelection()?.toString() ?? '', visualPaths.current.displayToOriginal),
        line,
        endLine,
        from,
        to,
        prefix,
        suffix,
        surface: 'visual',
      };
    });
    let disposeCursorListeners: (() => void) | undefined;
    let disposeViewportListeners: (() => void) | undefined;
    if (onCursorLineChangeRef.current) {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const emitCursorLocation = () => {
          const textBefore = view.state.doc.textBetween(0, view.state.selection.from, '\n', '\n');
          const lines = textBefore.split('\n');
          const line = visualLineForPosition(view, view.state.selection.from, frontmatterPrefixRef.current);
          const column = (lines.at(-1) ?? '').length + 1;
          onCursorLineChangeRef.current?.(line, column);
        };
        view.dom.addEventListener('keyup', emitCursorLocation);
        view.dom.addEventListener('mouseup', emitCursorLocation);
        view.dom.addEventListener('focus', emitCursorLocation);
        emitCursorLocation();
        disposeCursorListeners = () => {
          view.dom.removeEventListener('keyup', emitCursorLocation);
          view.dom.removeEventListener('mouseup', emitCursorLocation);
          view.dom.removeEventListener('focus', emitCursorLocation);
        };
      });
    }
    if (onViewportLineChangeRef.current) {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const scroller = findScrollContainer(view.dom);
        const scrollTarget = scroller instanceof Window ? window : scroller;
        let animationFrame: number | null = null;
        let lastViewportLine = 0;
        const emitViewportLocation = () => {
          animationFrame = null;
          const line = visualViewportTopLine(
            view,
            outlineHeadingsRef.current,
            scroller,
            sourceMarkdownRef.current,
            frontmatterPrefixRef.current,
          );
          if (line === null || line === lastViewportLine) return;
          lastViewportLine = line;
          onViewportLineChangeRef.current?.(line);
        };
        const scheduleViewportLocation = () => {
          if (animationFrame !== null) return;
          animationFrame = window.requestAnimationFrame(emitViewportLocation);
        };
        scrollTarget.addEventListener('scroll', scheduleViewportLocation, { passive: true });
        window.addEventListener('resize', scheduleViewportLocation);
        scheduleViewportLocation();
        disposeViewportListeners = () => {
          scrollTarget.removeEventListener('scroll', scheduleViewportLocation);
          window.removeEventListener('resize', scheduleViewportLocation);
          if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
        };
      });
    }
    let disposeMutationListeners: (() => void) | undefined;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const markMutation = () => {
        visualContentMutated.current = true;
      };
      const markKeyMutation = (event: KeyboardEvent) => {
        if (
          event.key.length === 1
          || event.key === 'Backspace'
          || event.key === 'Delete'
          || event.key === 'Enter'
          || event.key === 'Tab'
        ) {
          visualContentMutated.current = true;
        }
      };
      view.dom.addEventListener('beforeinput', markMutation);
      view.dom.addEventListener('paste', markMutation);
      view.dom.addEventListener('drop', markMutation);
      view.dom.addEventListener('keydown', markKeyMutation);
      disposeMutationListeners = () => {
        view.dom.removeEventListener('beforeinput', markMutation);
        view.dom.removeEventListener('paste', markMutation);
        view.dom.removeEventListener('drop', markMutation);
        view.dom.removeEventListener('keydown', markKeyMutation);
      };
    });
    editor.action((ctx) => {
      appendWritableTailIfNeeded(ctx.get(editorViewCtx));
    });
    let idleSyncHandle: number | null = null;
    let timeoutSyncHandle: ReturnType<typeof setTimeout> | null = null;
    const readFullMarkdownFromEditor = (): string | null => {
      const currentEditor = editorRef.current;
      if (
        !currentEditor
        || applyingExternalUpdate.current
      ) return null;
      try {
        flushScieMetadataNodeViews();
        const markdownValue = currentEditor.action(getMarkdown());
        cleanupDisplayPathMap(visualPaths.current.displayToOriginal, markdownValue);
        const restored = fromVisualImagePaths(markdownValue, visualPaths.current.displayToOriginal);
        return canonicalizeVariableTokens(`${frontmatterPrefixRef.current}${restored}`);
      } catch (error) {
        console.warn('Could not read visual editor state.', error);
        return null;
      }
    };
    const flushPendingMetadataEditsForRead = (): boolean => {
      if (applyingExternalUpdate.current) return false;
      const pendingMetadataChanged = flushScieMetadataNodeViews();
      if (pendingMetadataChanged) visualContentMutated.current = true;
      return pendingMetadataChanged;
    };
    const readEditorState = (): EditorReadResult | null => {
      return readVisualEditorStateSnapshot({
        visualContentMutated: visualContentMutated.current,
        sourceMarkdown: sourceMarkdownRef.current,
        lastEmittedMarkdown: lastEmittedMarkdown.current,
        flushPendingMetadataEdits: flushPendingMetadataEditsForRead,
        readFullMarkdown: readFullMarkdownFromEditor,
        markCommitted: (markdownValue) => {
          lastEmittedMarkdown.current = markdownValue;
          sourceMarkdownRef.current = markdownValue;
          pendingLocalEmissionsRef.current = rememberLocalVisualEmission(
            pendingLocalEmissionsRef.current,
            markdownValue,
          );
        },
      });
    };
    const replaceEditorState = (nextMarkdown: string): boolean => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return false;
      const viewSnapshot = captureVisualEditorView(currentEditor);
      const split = splitVisualMarkdown(nextMarkdown);
      visualContentMutated.current = false;
      pendingLocalEmissionsRef.current = [];
      sourceMarkdownRef.current = nextMarkdown;
      frontmatterPrefixRef.current = split.frontmatterPrefix;
      const nextVisualPaths = toVisualImagePaths(split.visualMarkdown, filePathRef.current);
      visualPaths.current = nextVisualPaths;
      applyingExternalUpdate.current = true;
      currentEditor.action(replaceAll(nextVisualPaths.markdown, true));
      restoreVisualEditorView(currentEditor, viewSnapshot);
      queueMicrotask(() => {
        applyingExternalUpdate.current = false;
        lastEmittedMarkdown.current = nextMarkdown;
      });
      return true;
    };
    const focusEditor = () => {
      editorRef.current?.action((ctx) => ctx.get(editorViewCtx).focus());
    };
    const getSelectionAnchor = (): EditorSelectionAnchor | null => {
      let anchor: EditorSelectionAnchor | null = null;
      editorRef.current?.action((ctx) => {
        const selection = ctx.get(editorViewCtx).state.selection;
        anchor = { from: selection.from, to: selection.to };
      });
      return anchor;
    };
    const restoreSelectionAnchor = (anchor: EditorSelectionAnchor): boolean => {
      let restored = false;
      editorRef.current?.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const from = Math.max(0, Math.min(anchor.from, view.state.doc.content.size));
        const to = Math.max(from, Math.min(anchor.to ?? anchor.from, view.state.doc.content.size));
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
        view.focus();
        restored = true;
      });
      return restored;
    };
    const adapter: EditorAdapter = {
      surface: 'visual',
      read: readEditorState,
      replace: replaceEditorState,
      focus: focusEditor,
      getSelectionAnchor,
      restoreSelectionAnchor,
      captureView: () => {
        let scrollTop = 0;
        editorRef.current?.action((ctx) => {
          const scroller = findScrollContainer(ctx.get(editorViewCtx).dom);
          scrollTop = scroller instanceof Window ? window.scrollY : scroller.scrollTop;
        });
        return { surface: 'visual', selection: getSelectionAnchor(), scrollTop };
      },
      restoreView: (snapshot) => {
        if (snapshot.surface !== 'visual' || !editorRef.current) return false;
        if (snapshot.selection) restoreSelectionAnchor(snapshot.selection);
        editorRef.current.action((ctx) => {
          const scroller = findScrollContainer(ctx.get(editorViewCtx).dom);
          if (scroller instanceof Window) window.scrollTo({ top: Math.max(0, snapshot.scrollTop) });
          else scroller.scrollTop = Math.max(0, snapshot.scrollTop);
        });
        return true;
      },
      flushPendingEdits: readEditorState,
      runtimeKey: () => {
        const documentId = performanceDocumentIdRef.current;
        const sourceRevision = revisionRef.current;
        if (!documentId || sourceRevision === undefined) return null;
        return { documentId, sourceRevision, surface: 'visual', configurationFingerprint: runtimeInstanceIdRef.current };
      },
      suspendRuntime: () => {
        const key = adapter.runtimeKey?.();
        const currentEditor = editorRef.current;
        if (!key || !currentEditor) return null;
        const snapshot = adapter.captureView?.();
        const state = captureVisualEditorRuntimeState({
          editor: currentEditor,
          sourceMarkdown: sourceMarkdownRef.current,
          frontmatterPrefix: frontmatterPrefixRef.current,
          visualMarkdown: visualPaths.current.markdown,
          displayToOriginal: visualPaths.current.displayToOriginal,
        });
        if (!state) return null;
        const byteWeight = estimateVisualEditorRuntimeByteWeight(sourceMarkdownRef.current);
        return {
          key,
          state,
          scrollTop: snapshot?.scrollTop ?? 0,
          focused: false,
          byteWeight: byteWeight.totalBytes,
          historyBytes: byteWeight.historyBytes,
          kind: 'exact-state',
        };
      },
      attachRuntime: (runtime) => {
        const key = adapter.runtimeKey?.();
        const currentEditor = editorRef.current;
        if (!key || !currentEditor || runtime.kind !== 'exact-state') return false;
        const runtimeState = visualEditorRuntimeState(runtime.state);
        if (!runtimeState || runtimeState.sourceMarkdown !== incomingMarkdownRef.current) return false;
        if (!attachVisualEditorRuntimeState(currentEditor, runtimeState)) return false;
        sourceMarkdownRef.current = runtimeState.sourceMarkdown;
        frontmatterPrefixRef.current = runtimeState.frontmatterPrefix;
        visualPaths.current = {
          markdown: runtimeState.visualMarkdown,
          displayToOriginal: new Map(runtimeState.displayToOriginal),
        };
        lastEmittedMarkdown.current = runtimeState.sourceMarkdown;
        pendingLocalEmissionsRef.current = [];
        applyingExternalUpdate.current = false;
        initialEmissionHandled.current = true;
        visualContentMutated.current = false;
        warmAttachmentRef.current = { documentId: key.documentId, revision: key.sourceRevision };
        return true;
      },
      rebuildRuntime: () => {
        warmAttachmentRef.current = null;
        return true;
      },
    };
    onAdapterReady?.(adapter);
    const synchronizeEditorState = (force = false) => {
      idleSyncHandle = null;
      timeoutSyncHandle = null;
      if (!force && (document.visibilityState === 'hidden' || !document.hasFocus())) return;
      flushPendingMetadataEditsForRead();
      if (!visualContentMutated.current) return;
      const fullMarkdown = readFullMarkdownFromEditor();
      if (fullMarkdown === null || equivalentVisualMarkdown(fullMarkdown, lastEmittedMarkdown.current)) return;
      try {
        console.warn('Visual editor state diverged from React markdown state; synchronizing from editor state.');
        lastEmittedMarkdown.current = fullMarkdown;
        sourceMarkdownRef.current = fullMarkdown;
        pendingLocalEmissionsRef.current = rememberLocalVisualEmission(
          pendingLocalEmissionsRef.current,
          fullMarkdown,
        );
        onChangeRef.current(fullMarkdown);
      } catch (error) {
        console.warn('Could not validate visual editor state synchronization.', error);
      }
    };
    const scheduleStateSynchronization = () => {
      if (idleSyncHandle !== null || timeoutSyncHandle !== null || document.visibilityState === 'hidden' || !document.hasFocus()) return;
      if ('requestIdleCallback' in window) {
        idleSyncHandle = window.requestIdleCallback(() => synchronizeEditorState(), { timeout: 1000 });
      } else {
        timeoutSyncHandle = setTimeout(() => synchronizeEditorState(), 0);
      }
    };
    const handleVisibilityOrFocus = () => scheduleStateSynchronization();
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    window.addEventListener('focus', handleVisibilityOrFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      window.removeEventListener('focus', handleVisibilityOrFocus);
      if (idleSyncHandle !== null) {
        if ('cancelIdleCallback' in window) window.cancelIdleCallback(idleSyncHandle);
        else globalThis.clearTimeout(idleSyncHandle);
      }
      if (timeoutSyncHandle !== null) clearTimeout(timeoutSyncHandle);
      synchronizeEditorState(true);
      if (editorRef.current === editor) {
        editorRef.current = undefined;
        onEditorReady(undefined);
        onInsertReady?.(undefined);
        onJumpReady?.(undefined);
        onFindReady?.(undefined);
        onHistoryReady?.(undefined);
        onSelectionTextReady?.(undefined);
        onAdapterReady?.(undefined, adapter);
        disposeCursorListeners?.();
        disposeViewportListeners?.();
        disposeMutationListeners?.();
      }
    };
  }, [loading, onEditorReady, onInsertReady, onJumpReady, onFindReady, onHistoryReady, onSelectionTextReady, onAdapterReady]);

  useEffect(() => {
    const editor = editorRef.current;
    if (loading || !editor) return;
    const warmAttachment = warmAttachmentRef.current;
    if (
      warmAttachment
      && warmAttachment.documentId === performanceDocumentId
      && warmAttachment.revision === revision
    ) {
      warmAttachmentRef.current = null;
      sourceMarkdownRef.current = markdown;
      lastEmittedMarkdown.current = markdown;
      pendingLocalEmissionsRef.current = [];
      return;
    }
    warmAttachmentRef.current = null;

    const reconciliation = reconcileVisualMarkdownProp(
      markdown,
      lastEmittedMarkdown.current,
      pendingLocalEmissionsRef.current,
    );
    pendingLocalEmissionsRef.current = reconciliation.pendingLocalEmissions;
    if (reconciliation.kind !== 'external') {
      if (reconciliation.kind === 'current-local-echo') {
        sourceMarkdownRef.current = markdown;
      }
      return;
    }

    const currentVisualMarkdown = readFullVisualMarkdown(editor, frontmatterPrefixRef.current, visualPaths.current);
    if (currentVisualMarkdown !== null && equivalentVisualMarkdown(currentVisualMarkdown, markdown)) {
      sourceMarkdownRef.current = markdown;
      lastEmittedMarkdown.current = markdown;
      return;
    }

    const viewSnapshot = captureVisualEditorView(editor);
    const split = splitVisualMarkdown(markdown);
    initialEmissionHandled.current = true;
    visualContentMutated.current = false;
    sourceMarkdownRef.current = markdown;
    frontmatterPrefixRef.current = split.frontmatterPrefix;
    const nextVisualPaths = toVisualImagePaths(split.visualMarkdown, filePath);
    visualPaths.current = nextVisualPaths;
    applyingExternalUpdate.current = true;
    if (performanceDocumentId) documentPerformance.trace({
      name: 'source-change',
      documentId: performanceDocumentId,
      surface: 'visual',
      byteCount: utf8ByteLength(markdown),
      fullDocumentTransactions: 1,
      phase: 'milkdown-external-replace',
    });
    editor.action(replaceAll(nextVisualPaths.markdown, true));
    restoreVisualEditorView(editor, viewSnapshot);
    queueMicrotask(() => {
      applyingExternalUpdate.current = false;
      lastEmittedMarkdown.current = markdown;
    });
  }, [filePath, loading, markdown]);

  const handleVisualEditorMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const clickedWritableSurface = target === event.currentTarget;
    if (!clickedWritableSurface) return;
    event.preventDefault();
    editorRef.current?.action((ctx) => {
      focusAtWritableEnd(ctx.get(editorViewCtx), true);
    });
  };

  return (
    <div
      ref={visualEditorRootRef}
      className="visual-editor"
      spellCheck={false}
      data-scie-md-runtime-context={metadataContextId.current}
      onMouseDown={handleVisualEditorMouseDown}
    >
      <Milkdown />
    </div>
  );
}

export interface VisualEditorRuntimeState {
  kind: 'visual-editor-state-v1';
  editorState: ProseMirrorEditorState;
  sourceMarkdown: string;
  frontmatterPrefix: string;
  visualMarkdown: string;
  displayToOriginal: readonly (readonly [string, string])[];
}

export function captureVisualEditorRuntimeState({
  editor,
  sourceMarkdown,
  frontmatterPrefix,
  visualMarkdown,
  displayToOriginal,
}: {
  editor: MilkdownEditor;
  sourceMarkdown: string;
  frontmatterPrefix: string;
  visualMarkdown: string;
  displayToOriginal: ReadonlyMap<string, string>;
}): VisualEditorRuntimeState | null {
  let editorState: ProseMirrorEditorState | null = null;
  editor.action((ctx) => {
    editorState = ctx.get(editorViewCtx).state;
  });
  if (!editorState) return null;
  return {
    kind: 'visual-editor-state-v1',
    editorState,
    sourceMarkdown,
    frontmatterPrefix,
    visualMarkdown,
    displayToOriginal: [...displayToOriginal.entries()],
  };
}

export function attachVisualEditorRuntimeState(
  editor: MilkdownEditor,
  runtime: VisualEditorRuntimeState,
): boolean {
  let attached = false;
  editor.action((ctx) => {
    ctx.get(editorViewCtx).updateState(runtime.editorState);
    attached = true;
  });
  return attached;
}

export function estimateVisualEditorRuntimeByteWeight(sourceMarkdown: string): {
  totalBytes: number;
  historyBytes: number;
} {
  const sourceBytes = utf8ByteLength(sourceMarkdown);
  const historyBytes = Math.min(8 * 1024 * 1024, sourceBytes * 2);
  return {
    totalBytes: Math.max(256 * 1024, sourceBytes * 4 + historyBytes),
    historyBytes,
  };
}

function visualEditorRuntimeState(value: unknown): VisualEditorRuntimeState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<VisualEditorRuntimeState>;
  if (
    candidate.kind !== 'visual-editor-state-v1'
    || !candidate.editorState
    || typeof candidate.sourceMarkdown !== 'string'
    || typeof candidate.frontmatterPrefix !== 'string'
    || typeof candidate.visualMarkdown !== 'string'
    || !Array.isArray(candidate.displayToOriginal)
  ) return null;
  return candidate as VisualEditorRuntimeState;
}

function cleanupDisplayPathMap(displayToOriginal: Map<string, string>, visualMarkdown: string): void {
  if (displayToOriginal.size === 0) return;
  for (const displayUrl of Array.from(displayToOriginal.keys())) {
    if (!visualMarkdown.includes(displayUrl)) {
      displayToOriginal.delete(displayUrl);
    }
  }
}

function restoreSelectedVisualMarkdown(
  selectedText: string,
  displayToOriginal: Map<string, string>,
): string {
  if (!selectedText.trim()) return '';
  return fromVisualImagePaths(selectedText, displayToOriginal).trim();
}

function visualLineForPosition(view: EditorView, position: number, frontmatterPrefix: string): number {
  const safePosition = Math.max(0, Math.min(position, view.state.doc.content.size));
  const textBefore = view.state.doc.textBetween(0, safePosition, '\n', '\n');
  const frontmatterLineOffset = frontmatterPrefix
    ? countLineBreaks(frontmatterPrefix)
    : 0;
  return frontmatterLineOffset + textBefore.split('\n').length;
}

function splitVisualMarkdown(markdown: string): { visualMarkdown: string; frontmatterPrefix: string } {
  const frontmatter = parseFrontmatter(markdown);
  if (!frontmatter.hasFrontmatter || frontmatter.error) {
    return { visualMarkdown: markdown, frontmatterPrefix: '' };
  }
  return {
    visualMarkdown: frontmatter.body,
    frontmatterPrefix: frontmatter.sourcePrefix,
  };
}

function countLineBreaks(text: string): number {
  return text.match(/\r\n|\n|\r/g)?.length ?? 0;
}

export function equivalentVisualMarkdown(left: string, right: string): boolean {
  return normalizeVisualMarkdownEmission(left) === normalizeVisualMarkdownEmission(right);
}

export interface VisualMarkdownEmissionFingerprint {
  length: number;
  hash: number;
}

export type VisualMarkdownPropReconciliation =
  | {
      kind: 'current-local-echo' | 'stale-local-echo';
      pendingLocalEmissions: VisualMarkdownEmissionFingerprint[];
    }
  | {
      kind: 'external';
      pendingLocalEmissions: [];
    };

const MAX_PENDING_VISUAL_EMISSIONS = 64;

export function rememberLocalVisualEmission(
  pendingLocalEmissions: readonly VisualMarkdownEmissionFingerprint[],
  markdown: string,
): VisualMarkdownEmissionFingerprint[] {
  const fingerprint = fingerprintVisualMarkdown(markdown);
  const previous = pendingLocalEmissions.at(-1);
  if (previous && sameVisualMarkdownFingerprint(previous, fingerprint)) {
    return pendingLocalEmissions.slice();
  }
  return [...pendingLocalEmissions, fingerprint].slice(-MAX_PENDING_VISUAL_EMISSIONS);
}

export function reconcileVisualMarkdownProp(
  markdown: string,
  lastEmittedMarkdown: string,
  pendingLocalEmissions: readonly VisualMarkdownEmissionFingerprint[],
): VisualMarkdownPropReconciliation {
  const fingerprint = fingerprintVisualMarkdown(markdown);
  const localIndex = pendingLocalEmissions.findIndex((candidate) => (
    sameVisualMarkdownFingerprint(candidate, fingerprint)
  ));
  if (localIndex >= 0) {
    const remaining = pendingLocalEmissions.slice(localIndex + 1);
    return {
      kind: remaining.length === 0 && equivalentVisualMarkdown(markdown, lastEmittedMarkdown)
        ? 'current-local-echo'
        : 'stale-local-echo',
      pendingLocalEmissions: remaining,
    };
  }
  if (equivalentVisualMarkdown(markdown, lastEmittedMarkdown)) {
    return { kind: 'current-local-echo', pendingLocalEmissions: pendingLocalEmissions.slice() };
  }
  return { kind: 'external', pendingLocalEmissions: [] };
}

function fingerprintVisualMarkdown(markdown: string): VisualMarkdownEmissionFingerprint {
  let hash = 2166136261;
  for (let index = 0; index < markdown.length; index += 1) {
    hash ^= markdown.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return { length: markdown.length, hash: hash >>> 0 };
}

function sameVisualMarkdownFingerprint(
  left: VisualMarkdownEmissionFingerprint,
  right: VisualMarkdownEmissionFingerprint,
): boolean {
  return left.length === right.length && left.hash === right.hash;
}

interface CapturedVisualEditorView {
  selection: EditorSelectionAnchor;
  scrollTop: number;
  focused: boolean;
}

function captureVisualEditorView(editor: MilkdownEditor): CapturedVisualEditorView | null {
  let snapshot: CapturedVisualEditorView | null = null;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const scroller = findScrollContainer(view.dom);
    snapshot = {
      selection: { from: view.state.selection.from, to: view.state.selection.to },
      scrollTop: scroller instanceof Window ? window.scrollY : scroller.scrollTop,
      focused: view.hasFocus(),
    };
  });
  return snapshot;
}

function restoreVisualEditorView(
  editor: MilkdownEditor,
  snapshot: CapturedVisualEditorView | null,
): void {
  if (!snapshot) return;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const from = Math.max(0, Math.min(snapshot.selection.from, view.state.doc.content.size));
    const to = Math.max(from, Math.min(snapshot.selection.to ?? snapshot.selection.from, view.state.doc.content.size));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    const scroller = findScrollContainer(view.dom);
    if (scroller instanceof Window) window.scrollTo({ top: Math.max(0, snapshot.scrollTop) });
    else scroller.scrollTop = Math.max(0, snapshot.scrollTop);
    if (snapshot.focused) view.focus();
  });
}

function readFullVisualMarkdown(
  editor: MilkdownEditor,
  frontmatterPrefix: string,
  visualPaths: ReturnType<typeof toVisualImagePaths>,
): string | null {
  try {
    const markdownValue = editor.action(getMarkdown());
    const restored = fromVisualImagePaths(markdownValue, visualPaths.displayToOriginal);
    return canonicalizeVariableTokens(`${frontmatterPrefix}${restored}`);
  } catch {
    return null;
  }
}

export function readVisualEditorStateSnapshot({
  visualContentMutated,
  sourceMarkdown,
  lastEmittedMarkdown,
  flushPendingMetadataEdits,
  readFullMarkdown,
  markCommitted,
}: {
  visualContentMutated: boolean;
  sourceMarkdown: string;
  lastEmittedMarkdown: string;
  flushPendingMetadataEdits: () => boolean;
  readFullMarkdown: () => string | null;
  markCommitted: (markdown: string) => void;
}): EditorReadResult | null {
  const pendingMetadataChanged = flushPendingMetadataEdits();
  if (!visualContentMutated && !pendingMetadataChanged) {
    return {
      surface: 'visual',
      markdown: sourceMarkdown,
      changed: false,
    };
  }

  const fullMarkdown = readFullMarkdown();
  if (fullMarkdown === null) return null;
  const changed = !equivalentVisualMarkdown(fullMarkdown, lastEmittedMarkdown);
  return {
    surface: 'visual',
    markdown: fullMarkdown,
    changed,
    markCommitted: changed
      ? () => markCommitted(fullMarkdown)
      : undefined,
  };
}

function normalizeVisualMarkdownEmission(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/g, '\n');
}

function refreshVariablePreviewDecorations(editor: MilkdownEditor | undefined): void {
  editor?.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.setMeta('scie-md-variable-preview-refresh', true));
  });
}

function createVisualChangeListenerPlugin(
  shouldIgnoreTransaction: () => boolean,
  markVisualMutation: () => void,
) {
  return $prose(() => new Plugin({
    appendTransaction(transactions) {
      if (shouldIgnoreTransaction()) return null;
      if (transactions.some((transaction) => transaction.docChanged)) {
        markVisualMutation();
      }
      return null;
    },
  }));
}

function findHeadingPosition(
  view: EditorView,
  target: VisualMarkdownJumpTarget,
  sourceMarkdown: string,
  frontmatterPrefix: string,
): number | null {
  const lineMatch = findHeadingPositionBySourceLine(view, target, sourceMarkdown, frontmatterPrefix);
  if (lineMatch !== null) return lineMatch;
  return findHeadingPositionByText(view.state.doc, target);
}

function findHeadingPositionBySourceLine(
  view: EditorView,
  target: VisualMarkdownJumpTarget,
  sourceMarkdown: string,
  frontmatterPrefix: string,
): number | null {
  let found: number | null = null;
  view.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name !== 'heading' || node.attrs?.level !== target.level) return true;
    const line = visualSourceLineForPosition(view.state.doc, Math.min(pos + 1, view.state.doc.content.size), sourceMarkdown)
      ?? visualLineForPosition(view, Math.min(pos + 1, view.state.doc.content.size), frontmatterPrefix);
    if (line === target.line) {
      found = pos;
      return false;
    }
    return false;
  });
  return found;
}

function findHeadingPositionByText(doc: { descendants: (callback: (node: { type: { name: string }; attrs?: { level?: number }; textContent: string }, pos: number) => boolean | void) => void; content: { size: number } }, target: VisualMarkdownJumpTarget): number | null {
  let seen = 0;
  let found: number | null = null;
  const targetText = normalizeHeadingText(target.text);

  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name !== 'heading' || node.attrs?.level !== target.level) return true;
    if (normalizeHeadingText(node.textContent) !== targetText) return false;
    if (seen === target.occurrence) {
      found = pos;
      return false;
    }
    seen += 1;
    return false;
  });

  return found;
}

function findTextMatchPosition(
  doc: {
    descendants: (callback: (node: { type: { name: string }; text?: string; textContent: string }, pos: number) => boolean | void) => void;
  },
  query: string,
  occurrence: number,
  caseSensitive: boolean,
): { from: number; to: number } | null {
  if (!query) return null;
  const needle = caseSensitive ? query : query.toLowerCase();
  let seen = 0;
  let found: { from: number; to: number } | null = null;

  doc.descendants((node, pos) => {
    if (found) return false;
    const text = node.type.name === 'text' ? node.text ?? node.textContent : '';
    if (!text) return true;
    const haystack = caseSensitive ? text : text.toLowerCase();
    let index = haystack.indexOf(needle);
    while (index >= 0) {
      if (seen === occurrence) {
        found = { from: pos + index, to: pos + index + query.length };
        return false;
      }
      seen += 1;
      index = haystack.indexOf(needle, index + Math.max(1, needle.length));
    }
    return true;
  });

  return found;
}

function scrollEditorPositionToTop(view: EditorView, position: number): void {
  scrollEditorPosition(view, position, 18);
}

function scrollEditorPositionToCenter(view: EditorView, position: number): void {
  const scroller = findScrollContainer(view.dom);
  const height = scroller instanceof Window
    ? window.innerHeight
    : scroller.clientHeight;
  scrollEditorPosition(view, position, Math.max(24, height * 0.42));
}

function scrollEditorPosition(view: EditorView, position: number, topOffset: number): void {
  window.requestAnimationFrame(() => {
    const coords = view.coordsAtPos(Math.max(0, Math.min(position, view.state.doc.content.size)));
    if (!coords) return;
    const scroller = findScrollContainer(view.dom);
    if (scroller instanceof Window) {
      window.scrollTo({ top: Math.max(0, window.scrollY + coords.top - topOffset), behavior: 'smooth' });
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + coords.top - scrollerRect.top - topOffset), behavior: 'smooth' });
  });
}

function visualViewportTopLine(
  view: EditorView,
  headings: MarkdownHeading[],
  scroller: HTMLElement | Window,
  sourceMarkdown: string,
  frontmatterPrefix: string,
): number | null {
  if (headings.length === 0) return 1;
  const headingElements = Array.from(view.dom.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
    .filter((element) => !element.closest('.scie-md-visual-atom'));
  if (headingElements.length === 0) return headings[0]?.line ?? 1;

  const lineByElement = mapVisualHeadingElementsToLines(view, headingElements, headings, sourceMarkdown, frontmatterPrefix);
  const viewportTop = scroller instanceof Window ? 0 : scroller.getBoundingClientRect().top;
  const activationY = viewportTop + 96;
  let activeLine: number | null = null;
  let nextLine: number | null = null;

  for (const element of headingElements) {
    const line = lineByElement.get(element);
    if (!line) continue;
    const top = element.getBoundingClientRect().top;
    if (top <= activationY) {
      activeLine = line;
    } else {
      nextLine = line;
      break;
    }
  }

  return activeLine ?? nextLine ?? headings[0]?.line ?? 1;
}

function mapVisualHeadingElementsToLines(
  view: EditorView,
  elements: HTMLElement[],
  headings: MarkdownHeading[],
  sourceMarkdown: string,
  frontmatterPrefix: string,
): Map<HTMLElement, number> {
  const fallback = mapVisualHeadingElementsToLinesByText(elements, headings);
  const headingLines = new Set(headings.map((heading) => `${heading.level}:${heading.line}`));
  const lineByElement = new Map<HTMLElement, number>();
  for (const element of elements) {
    const level = Number(element.tagName.slice(1));
    const line = sourceLineForHeadingElement(view, element, sourceMarkdown, frontmatterPrefix);
    if (line !== null && headingLines.has(`${level}:${line}`)) {
      lineByElement.set(element, line);
      continue;
    }
    const fallbackLine = fallback.get(element);
    if (fallbackLine) lineByElement.set(element, fallbackLine);
  }
  return lineByElement;
}

function sourceLineForHeadingElement(
  view: EditorView,
  element: HTMLElement,
  sourceMarkdown: string,
  frontmatterPrefix: string,
): number | null {
  try {
    const position = Math.min(view.posAtDOM(element, 0) + 1, view.state.doc.content.size);
    return visualSourceLineForPosition(view.state.doc, position, sourceMarkdown)
      ?? visualLineForPosition(view, position, frontmatterPrefix);
  } catch {
    return null;
  }
}

function mapVisualHeadingElementsToLinesByText(elements: HTMLElement[], headings: MarkdownHeading[]): Map<HTMLElement, number> {
  const headingsByKey = new Map<string, MarkdownHeading[]>();
  for (const heading of headings) {
    const key = headingKey(heading.level, heading.text);
    const list = headingsByKey.get(key) ?? [];
    list.push(heading);
    headingsByKey.set(key, list);
  }

  const occurrenceByKey = new Map<string, number>();
  const lineByElement = new Map<HTMLElement, number>();
  for (const element of elements) {
    const level = Number(element.tagName.slice(1));
    const key = headingKey(level, element.textContent ?? '');
    const occurrence = occurrenceByKey.get(key) ?? 0;
    occurrenceByKey.set(key, occurrence + 1);
    const heading = headingsByKey.get(key)?.[occurrence];
    if (heading) lineByElement.set(element, heading.line);
  }
  return lineByElement;
}

function headingKey(level: number, text: string): string {
  return `${level}:${normalizeHeadingText(text).toLowerCase()}`;
}

function findScrollContainer(element: HTMLElement): HTMLElement | Window {
  let current: HTMLElement | null = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const scrollable = /(auto|scroll|overlay)/.test(style.overflowY);
    if (scrollable && current.scrollHeight > current.clientHeight) return current;
    current = current.parentElement;
  }
  return window;
}

function normalizeHeadingText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function focusAtWritableEnd(view: EditorView, scrollIntoView: boolean): void {
  appendWritableTailIfNeeded(view);
  const nextState = view.state;
  let transaction = nextState.tr;
  const lastChild = nextState.doc.childCount > 0 ? nextState.doc.child(nextState.doc.childCount - 1) : null;
  let selectionPosition = Math.max(0, nextState.doc.content.size);

  if (lastChild?.type.name === 'paragraph' && lastChild.content.size === 0) {
    selectionPosition = Math.max(1, nextState.doc.content.size - 1);
  }

  const resolvedPosition = transaction.doc.resolve(Math.min(selectionPosition, transaction.doc.content.size));
  transaction = transaction.setSelection(TextSelection.near(resolvedPosition, -1));
  if (scrollIntoView) transaction = transaction.scrollIntoView();
  view.dispatch(transaction);
  view.focus();
}

function appendWritableTailIfNeeded(view: EditorView): void {
  const { state } = view;
  const paragraph = state.schema.nodes.paragraph;
  const lastChild = state.doc.childCount > 0 ? state.doc.child(state.doc.childCount - 1) : null;
  if (!paragraph || !lastChild || !isScieMetadataNode(lastChild)) return;
  view.dispatch(state.tr.insert(state.doc.content.size, paragraph.create()));
}

export function VisualMarkdownEditor(props: VisualMarkdownEditorProps) {
  return (
    <MilkdownProvider>
      <MilkdownSurface {...props} />
    </MilkdownProvider>
  );
}
