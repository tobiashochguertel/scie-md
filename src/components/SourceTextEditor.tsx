import { useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { json as jsonLanguage } from '@codemirror/lang-json';
import { markdown as markdownLanguage } from '@codemirror/lang-markdown';
import { xml as xmlLanguage } from '@codemirror/lang-xml';
import { yaml as yamlLanguage } from '@codemirror/lang-yaml';
import { lintGutter, linter } from '@codemirror/lint';
import type { Diagnostic as CodeMirrorDiagnostic } from '@codemirror/lint';
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state';
import type { Extension, TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import type { DocumentFormat, FormatDiagnostic, SourceEditorCapabilities, SourceSemanticPresentationMode } from '@sciemd/core';
import { formatByteLengthUtf8, formatBytes, formatDefinitionFor, quoteAnchorPrefix, quoteAnchorSuffix, sourceEditorCapabilitiesFor, sourceSemanticPresentationMode } from '@sciemd/core';
import type { EditorHistoryControls } from './editorControls';
import type { EditorSelectionGetter } from './editorSelection';
import type { EditorAdapter, EditorAdapterReady, EditorSelectionAnchor } from './editorAdapter';
import { createScieMdSemanticHighlighting } from './sourceSemanticHighlighting';
import type { DocumentId, SourceRevision } from '../app/documentIdentity';
import { documentPerformance, utf8ByteLength } from '../app/performance/documentPerformance';
import type { SourceChangeResult, SourceChangeSet, SourceSpanChange } from '../app/source/revisionedSourceBuffer';
import { SOURCE_CHANGE_LIMITS } from '../app/source/revisionedSourceBuffer';
import { documentRuntimeRegistry } from '../app/runtime/documentRuntimeRegistry';

export type SourceTextLanguage = DocumentFormat;
export type SourceTextInsert = (text: string) => void;
export type SourceTextJump = (line: number) => void;
export type SourceTextFind = (from: number, to: number) => void;
export type SourceTextSelection = EditorSelectionGetter;
export type SourceTextContextMenuRequestHandler = (request: SourceTextContextMenuRequest) => boolean | void;
const authoritativeSourceReconciliation = Annotation.define<boolean>();
const SOURCE_EDITOR_PROJECTION_CODE_UNITS = 128 * 1024;
const SOURCE_EDITOR_PROJECTION_THRESHOLD_CODE_UNITS = 512 * 1024;

export interface SourceEditorProjection {
  active: boolean;
  from: number;
  to: number;
  sourceLength: number;
  text: string;
}

export function sourceEditorProjection(
  sourceText: string,
  mode: SourceSemanticPresentationMode,
  requestedFrom = 0,
  viewportCodeUnits = SOURCE_EDITOR_PROJECTION_CODE_UNITS,
): SourceEditorProjection {
  const sourceLength = sourceText.length;
  const shouldProject = mode === 'large-file-fallback'
    ? sourceLength > viewportCodeUnits
    : sourceLength > Math.max(viewportCodeUnits, SOURCE_EDITOR_PROJECTION_THRESHOLD_CODE_UNITS);
  if (!shouldProject) {
    return { active: false, from: 0, to: sourceLength, sourceLength, text: sourceText };
  }
  const safeViewport = Math.max(1, Math.floor(viewportCodeUnits));
  const from = Math.max(0, Math.min(Math.floor(requestedFrom), sourceLength - safeViewport));
  const to = Math.min(sourceLength, from + safeViewport);
  return { active: true, from, to, sourceLength, text: sourceText.slice(from, to) };
}

export interface SourceTextMarker {
  id: string;
  line: number;
  kind: string;
  title: string;
}

export interface SourceTextContextMenuRequest {
  kind: 'selection' | 'line';
  position: { x: number; y: number };
  language: SourceTextLanguage;
  text: string;
  lineText: string;
  selectedLinesText: string;
  line: number;
  endLine: number;
  from: number;
  to: number;
  diagnostics: FormatDiagnostic[];
  sourceEditor: SourceEditorCapabilities;
  selectLine: () => void;
}

export type SourceTextInsertTransactionBuilder = (
  view: Pick<EditorView, 'state'>,
  text: string,
) => TransactionSpec;

export interface SourceTextEditorProps {
  performanceDocumentId?: DocumentId;
  value: string;
  onChange: (value: string) => void;
  revision?: SourceRevision;
  onChangeSet?: (changeSet: SourceChangeSet) => SourceChangeResult;
  reconcileSource?: () => { sourceText: string; revision: SourceRevision };
  language: SourceTextLanguage;
  diagnostics?: FormatDiagnostic[];
  markers?: SourceTextMarker[];
  parsingPending?: boolean;
  autosavePausedReason?: string | null;
  extraExtensions?: Extension[];
  programmaticEditBypassRef?: MutableRefObject<boolean>;
  createInsertTransaction?: SourceTextInsertTransactionBuilder;
  onInsertReady?: (insert: SourceTextInsert | undefined) => void;
  onJumpReady?: (jump: SourceTextJump | undefined) => void;
  onFindReady?: (find: SourceTextFind | undefined) => void;
  onHistoryReady?: (history: EditorHistoryControls | undefined) => void;
  onSelectionTextReady?: (selection: SourceTextSelection | undefined) => void;
  onAdapterReady?: EditorAdapterReady;
  onContextMenuRequest?: SourceTextContextMenuRequestHandler;
  onCursorLineChange?: (line: number, column: number) => void;
  onViewportLineChange?: (line: number) => void;
  onRuntimeAdmissionRefused?: (message: string) => void;
}

export function SourceTextEditor({
  performanceDocumentId,
  value,
  onChange,
  revision,
  onChangeSet,
  reconcileSource,
  language,
  diagnostics = [],
  markers = [],
  parsingPending = false,
  autosavePausedReason = null,
  extraExtensions = [],
  programmaticEditBypassRef,
  createInsertTransaction = createPlainTextInsertTransaction,
  onInsertReady,
  onJumpReady,
  onFindReady,
  onHistoryReady,
  onSelectionTextReady,
  onAdapterReady,
  onContextMenuRequest,
  onCursorLineChange,
  onViewportLineChange,
  onRuntimeAdmissionRefused,
}: SourceTextEditorProps) {
  const sourceEditorProfile = useMemo(() => sourceEditorCapabilitiesFor(language), [language]);
  const sourceByteLength = useMemo(() => formatByteLengthUtf8(value), [value]);
  const semanticPresentationMode = useMemo(() => {
    const threshold = formatDefinitionFor(language)?.runtimePolicy.sourceOnlyFileBytes ?? Number.POSITIVE_INFINITY;
    return sourceSemanticPresentationMode({
      byteLength: sourceByteLength,
      sourceOnlyThresholdBytes: threshold,
      languageAvailable: sourceEditorProfile.codeMirrorLanguage !== 'plainText',
    });
  }, [language, sourceByteLength, sourceEditorProfile.codeMirrorLanguage]);
  const [projectionFrom, setProjectionFrom] = useState(0);
  const projection = useMemo(
    () => sourceEditorProjection(value, semanticPresentationMode, projectionFrom),
    [projectionFrom, semanticPresentationMode, value],
  );
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const adapterRef = useRef<EditorAdapter | null>(null);
  const runtimeInstanceIdRef = useRef(`source-editor-${Math.random().toString(36).slice(2)}`);
  const warmAttachmentRef = useRef<{ documentId: DocumentId; revision: SourceRevision } | null>(null);
  const runtimeOwnerRef = useRef<{ documentId: DocumentId; revision: SourceRevision } | null>(null);
  const performanceDocumentIdRef = useRef(performanceDocumentId);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const revisionRef = useRef(revision);
  const onChangeSetRef = useRef(onChangeSet);
  const reconcileSourceRef = useRef(reconcileSource);
  const onInsertReadyRef = useRef(onInsertReady);
  const onJumpReadyRef = useRef(onJumpReady);
  const onFindReadyRef = useRef(onFindReady);
  const onHistoryReadyRef = useRef(onHistoryReady);
  const onSelectionTextReadyRef = useRef(onSelectionTextReady);
  const onAdapterReadyRef = useRef(onAdapterReady);
  const onContextMenuRequestRef = useRef(onContextMenuRequest);
  const onCursorLineChangeRef = useRef(onCursorLineChange);
  const onViewportLineChangeRef = useRef(onViewportLineChange);
  const onRuntimeAdmissionRefusedRef = useRef(onRuntimeAdmissionRefused);
  const createInsertTransactionRef = useRef(createInsertTransaction);
  const languageRef = useRef(language);
  const sourceEditorProfileRef = useRef(sourceEditorProfile);
  const semanticPresentationModeRef = useRef(semanticPresentationMode);
  const diagnosticsRef = useRef(diagnostics);
  const extraExtensionsRef = useRef(extraExtensions);
  const lastCursorRef = useRef({ line: 1, column: 1 });
  const languageCompartmentRef = useRef(new Compartment());
  const lineWrappingCompartmentRef = useRef(new Compartment());
  const longLineViewportCompartmentRef = useRef(new Compartment());
  const diagnosticsCompartmentRef = useRef(new Compartment());
  const extraExtensionsCompartmentRef = useRef(new Compartment());
  revisionRef.current = revision;
  languageRef.current = language;
  sourceEditorProfileRef.current = sourceEditorProfile;
  diagnosticsRef.current = diagnostics;
  semanticPresentationModeRef.current = semanticPresentationMode;
  extraExtensionsRef.current = extraExtensions;

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    performanceDocumentIdRef.current = performanceDocumentId;
  }, [performanceDocumentId]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    onInsertReadyRef.current = onInsertReady;
  }, [onInsertReady]);

  useEffect(() => {
    onJumpReadyRef.current = onJumpReady;
  }, [onJumpReady]);

  useEffect(() => {
    onFindReadyRef.current = onFindReady;
  }, [onFindReady]);

  useEffect(() => {
    onHistoryReadyRef.current = onHistoryReady;
  }, [onHistoryReady]);

  useEffect(() => {
    onSelectionTextReadyRef.current = onSelectionTextReady;
  }, [onSelectionTextReady]);

  useEffect(() => {
    onAdapterReadyRef.current = onAdapterReady;
  }, [onAdapterReady]);

  useEffect(() => {
    onContextMenuRequestRef.current = onContextMenuRequest;
  }, [onContextMenuRequest]);

  useEffect(() => {
    onCursorLineChangeRef.current = onCursorLineChange;
  }, [onCursorLineChange]);

  useEffect(() => {
    onViewportLineChangeRef.current = onViewportLineChange;
  }, [onViewportLineChange]);

  useEffect(() => {
    onRuntimeAdmissionRefusedRef.current = onRuntimeAdmissionRefused;
  }, [onRuntimeAdmissionRefused]);

  useEffect(() => {
    createInsertTransactionRef.current = createInsertTransaction;
  }, [createInsertTransaction]);

  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  useEffect(() => {
    sourceEditorProfileRef.current = sourceEditorProfile;
  }, [sourceEditorProfile]);

  useEffect(() => {
    diagnosticsRef.current = diagnostics;
  }, [diagnostics]);

  useEffect(() => {
    if (!hostRef.current) return undefined;

    const emitCursorLine = (view: EditorView) => {
      const docLine = view.state.doc.lineAt(view.state.selection.main.head);
      const line = docLine.number;
      const column = view.state.selection.main.head - docLine.from + 1;
      if (lastCursorRef.current.line === line && lastCursorRef.current.column === column) return;
      lastCursorRef.current = { line, column };
      onCursorLineChangeRef.current?.(line, column);
    };

    let viewportAnimationFrame: number | null = null;
    let lastViewportLine = 0;
    const emitViewportLine = () => {
      viewportAnimationFrame = null;
      const currentView = viewRef.current;
      if (!currentView) return;
      const line = viewportTopLine(currentView) + sourceLineOffset(valueRef.current, projectionRef.current.from);
      if (line === lastViewportLine) return;
      lastViewportLine = line;
      onViewportLineChangeRef.current?.(line);
    };
    const scheduleViewportLine = () => {
      if (viewportAnimationFrame !== null) return;
      viewportAnimationFrame = window.requestAnimationFrame(emitViewportLine);
    };

    const createEditorState = (doc: string) => EditorState.create({
        doc: sourceEditorProjection(doc, semanticPresentationModeRef.current, projectionRef.current.from).text,
        extensions: [
          languageCompartmentRef.current.of(createLanguageExtension(sourceEditorProfileRef.current, semanticPresentationModeRef.current)),
          diagnosticsCompartmentRef.current.of(createDiagnosticsExtension(diagnosticsRef.current, sourceEditorProfileRef.current)),
          EditorState.tabSize.of(2),
          EditorState.allowMultipleSelections.of(true),
          lineWrappingCompartmentRef.current.of(createLineWrappingExtension(semanticPresentationModeRef.current)),
          longLineViewportCompartmentRef.current.of(createLongLineViewportExtension(semanticPresentationModeRef.current)),
          keymap.of([indentWithTab, ...defaultKeymap]),
          EditorState.transactionFilter.of((transaction) => {
            if (!transaction.docChanged) return transaction;
            const growthBytes = Math.max(0, (transaction.newDoc.length - transaction.startState.doc.length) * 2);
            const documentId = performanceDocumentIdRef.current;
            if (!documentId || growthBytes === 0) return transaction;
            const admission = documentRuntimeRegistry.canGrowActiveSource(documentId, growthBytes);
            if (admission.status === 'admitted') return transaction;
            documentPerformance.trace({
              name: 'runtime-degraded', documentId, surface: 'source', byteCount: growthBytes, phase: admission.reason,
            });
            queueMicrotask(() => onRuntimeAdmissionRefusedRef.current?.(
              'This edit would exceed the document runtime safety reserve. Save or close another document, then retry.',
            ));
            return [];
          }),
          EditorView.domEventHandlers({
            contextmenu: (event, view) => {
              const request = createSourceContextMenuRequest(
                view,
                event,
                languageRef.current,
                sourceEditorProfileRef.current,
                diagnosticsRef.current,
              );
              if (!request) return false;
              const projectionOffset = projectionRef.current.from;
              const lineOffset = sourceLineOffset(valueRef.current, projectionOffset);
              const handled = onContextMenuRequestRef.current?.({
                ...request,
                line: request.line + lineOffset,
                endLine: request.endLine + lineOffset,
                from: request.from + projectionOffset,
                to: request.to + projectionOffset,
              });
              if (!handled) return false;
              event.preventDefault();
              event.stopPropagation();
              return true;
            },
          }),
          extraExtensionsCompartmentRef.current.of(extraExtensionsRef.current),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(authoritativeSourceReconciliation))) {
              let changeBytes = 0;
              let fullDocumentTransactions = 0;
              const changes: SourceSpanChange[] = [];
              update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
                const insert = inserted.toString();
                const projectionOffset = projectionRef.current.from;
                changeBytes += utf8ByteLength(insert);
                if (fromA === 0 && toA === update.startState.doc.length) fullDocumentTransactions += 1;
                changes.push({
                  from: projectionOffset + fromA,
                  to: projectionOffset + toA,
                  insert,
                  ...(toA - fromA <= SOURCE_CHANGE_LIMITS.maxGuardUtf16
                    ? { expectedText: update.startState.sliceDoc(fromA, toA) }
                    : {}),
                });
              });
              const tracedDocumentId = performanceDocumentIdRef.current;
              if (tracedDocumentId) {
                documentPerformance.trace({
                  name: 'source-change',
                  documentId: tracedDocumentId,
                  surface: 'source',
                  changeBytes,
                  fullDocumentTransactions,
                  phase: 'codemirror-transaction',
                });
              }
              if (tracedDocumentId && revisionRef.current !== undefined && onChangeSetRef.current) {
                const result = onChangeSetRef.current({ documentId: tracedDocumentId, expectedRevision: revisionRef.current, changes });
                if (result.status === 'accepted') {
                  revisionRef.current = result.revision;
                  runtimeOwnerRef.current = { documentId: tracedDocumentId, revision: result.revision };
                  const lengthDelta = update.state.doc.length - update.startState.doc.length;
                  projectionRef.current = {
                    ...projectionRef.current,
                    to: projectionRef.current.to + lengthDelta,
                    sourceLength: projectionRef.current.sourceLength + lengthDelta,
                    text: update.state.doc.toString(),
                  };
                  if (projectionRef.current.active) {
                    const authoritative = reconcileSourceRef.current?.();
                    if (authoritative?.revision === result.revision) valueRef.current = authoritative.sourceText;
                  }
                  documentPerformance.trace({ name: 'input-accepted', documentId: tracedDocumentId, surface: 'source' });
                  requestAnimationFrame(() => documentPerformance.trace({
                    name: 'input-echoed', documentId: tracedDocumentId, surface: 'source',
                  }));
                } else {
                  const authoritative = reconcileSourceRef.current?.();
                  if (authoritative) {
                    revisionRef.current = authoritative.revision;
                    const projected = sourceEditorProjection(
                      authoritative.sourceText,
                      semanticPresentationModeRef.current,
                      projectionRef.current.from,
                    );
                    projectionRef.current = projected;
                    update.view.dispatch({
                      changes: { from: 0, to: update.view.state.doc.length, insert: projected.text },
                      annotations: [Transaction.addToHistory.of(false), authoritativeSourceReconciliation.of(true)],
                    });
                    valueRef.current = authoritative.sourceText;
                  }
                }
              } else {
                const nextText = update.state.doc.toString();
                if (tracedDocumentId) documentPerformance.trace({
                  name: 'whole-source-materialization', documentId: tracedDocumentId, surface: 'source',
                  materializedBytes: utf8ByteLength(nextText), phase: 'named-whole-source-fallback',
                });
                const projected = projectionRef.current;
                onChangeRef.current(projected.active
                  ? `${valueRef.current.slice(0, projected.from)}${nextText}${valueRef.current.slice(projected.to)}`
                  : nextText);
                if (tracedDocumentId) {
                  documentPerformance.trace({ name: 'input-accepted', documentId: tracedDocumentId, surface: 'source' });
                  requestAnimationFrame(() => documentPerformance.trace({
                    name: 'input-echoed', documentId: tracedDocumentId, surface: 'source',
                  }));
                }
              }
            }
            if (update.docChanged || update.selectionSet) {
              emitCursorLine(update.view);
            }
            if (update.selectionSet) {
              maybeTypewriterScroll(update.view);
            }
            if (update.docChanged || update.viewportChanged) {
              scheduleViewportLine();
            }
          }),
        ],
      });
    const view = new EditorView({
      parent: hostRef.current,
      state: createEditorState(value),
    });

    viewRef.current = view;
    remeasureSourceEditorAfterFontsReady(view);
    if (performanceDocumentIdRef.current && revisionRef.current !== undefined) {
      runtimeOwnerRef.current = { documentId: performanceDocumentIdRef.current, revision: revisionRef.current };
    }
    emitCursorLine(view);
    const scrollElement = view.scrollDOM;
    scrollElement.addEventListener('scroll', scheduleViewportLine, { passive: true });
    window.addEventListener('resize', scheduleViewportLine);
    scheduleViewportLine();
    onInsertReadyRef.current?.((text) => {
      const currentView = viewRef.current;
      if (!currentView) return;
      const transaction = createInsertTransactionRef.current(currentView, text);
      currentView.dispatch(transaction);
      currentView.focus();
    });
    onJumpReadyRef.current?.((line) => {
      const currentView = viewRef.current;
      if (!currentView) return;
      const globalFrom = sourceOffsetForLine(valueRef.current, line);
      const projected = sourceEditorProjection(
        valueRef.current,
        semanticPresentationModeRef.current,
        Math.max(0, globalFrom - Math.floor(SOURCE_EDITOR_PROJECTION_CODE_UNITS / 2)),
      );
      if (projected.from !== projectionRef.current.from) {
        projectionRef.current = projected;
        setProjectionFrom(projected.from);
        currentView.setState(createEditorState(valueRef.current));
      }
      const localFrom = Math.max(0, Math.min(globalFrom - projected.from, currentView.state.doc.length));
      currentView.dispatch({
        selection: { anchor: localFrom },
        effects: EditorView.scrollIntoView(localFrom, { y: 'start', yMargin: 18 }),
      });
      currentView.focus();
    });
    onFindReadyRef.current?.((from, to) => {
      const currentView = viewRef.current;
      if (!currentView) return;
      const projected = sourceEditorProjection(
        valueRef.current,
        semanticPresentationModeRef.current,
        Math.max(0, from - Math.floor(SOURCE_EDITOR_PROJECTION_CODE_UNITS / 2)),
      );
      if (projected.from !== projectionRef.current.from) {
        projectionRef.current = projected;
        setProjectionFrom(projected.from);
        currentView.setState(createEditorState(valueRef.current));
      }
      const docLength = currentView.state.doc.length;
      const safeFrom = Math.max(0, Math.min(from - projected.from, docLength));
      const safeTo = Math.max(safeFrom, Math.min(to - projected.from, docLength));
      currentView.dispatch({
        selection: { anchor: safeFrom, head: safeTo },
        effects: EditorView.scrollIntoView(safeFrom, { y: 'center' }),
      });
      currentView.focus();
    });
    onHistoryReadyRef.current?.(undefined);
    onSelectionTextReadyRef.current?.(() => {
      const currentView = viewRef.current;
      if (!currentView) return { text: '' };
      const ranges = [...currentView.state.selection.ranges].sort((left, right) => left.from - right.from);
      const firstRange = ranges[0] ?? currentView.state.selection.main;
      const lastRange = ranges.at(-1) ?? firstRange;
      const projectionOffset = projectionRef.current.from;
      const docLine = currentView.state.doc.lineAt(firstRange.from);
      const docEndLine = currentView.state.doc.lineAt(Math.max(firstRange.from, lastRange.to - 1));
      const text = ranges
        .map((range) => currentView.state.sliceDoc(range.from, range.to))
        .filter(Boolean)
        .join('\n\n');
      return {
        text,
        line: docLine.number,
        endLine: docEndLine.number,
        from: projectionOffset + firstRange.from,
        to: projectionOffset + lastRange.to,
        prefix: quoteAnchorPrefix(valueRef.current.slice(0, projectionOffset + firstRange.from)),
        suffix: quoteAnchorSuffix(valueRef.current.slice(projectionOffset + lastRange.to)),
        surface: 'source',
      };
    });
    const adapter: EditorAdapter = {
      surface: 'source',
      read: () => {
        const currentView = viewRef.current;
        if (!currentView) return null;
        const currentText = projectionRef.current.active
          ? (reconcileSourceRef.current?.().sourceText ?? valueRef.current)
          : currentView.state.doc.toString();
        const tracedDocumentId = performanceDocumentIdRef.current;
        if (tracedDocumentId) documentPerformance.trace({
          name: 'whole-source-materialization',
          documentId: tracedDocumentId,
          surface: 'source',
          materializedBytes: utf8ByteLength(currentText),
          phase: 'editor-adapter-read',
        });
        return {
          surface: 'source',
          markdown: currentText,
          changed: currentText !== valueRef.current,
          markCommitted: () => {
            valueRef.current = currentText;
          },
        };
      },
      replace: (nextText) => {
        const currentView = viewRef.current;
        if (!currentView) return false;
        const projected = sourceEditorProjection(nextText, semanticPresentationModeRef.current, projectionRef.current.from);
        projectionRef.current = projected;
        currentView.dispatch({
          changes: { from: 0, to: currentView.state.doc.length, insert: projected.text },
        });
        valueRef.current = nextText;
        return true;
      },
      focus: () => {
        viewRef.current?.focus();
      },
      getSelectionAnchor: () => {
        const currentView = viewRef.current;
        if (!currentView) return null;
        const selection = currentView.state.selection.main;
        return { from: projectionRef.current.from + selection.from, to: projectionRef.current.from + selection.to };
      },
      restoreSelectionAnchor: (anchor: EditorSelectionAnchor) => {
        const currentView = viewRef.current;
        if (!currentView) return false;
        const projected = projectionRef.current;
        const globalTo = anchor.to ?? anchor.from;
        if (anchor.from < projected.from || globalTo > projected.to) return false;
        const docLength = currentView.state.doc.length;
        const from = Math.max(0, Math.min(anchor.from - projected.from, docLength));
        const to = Math.max(from, Math.min(globalTo - projected.from, docLength));
        currentView.dispatch({ selection: { anchor: from, head: to } });
        currentView.focus();
        return true;
      },
      captureView: () => {
        const currentView = viewRef.current;
        const selection = currentView?.state.selection.main;
        return {
          surface: 'source',
          selection: selection ? {
            from: projectionRef.current.from + selection.from,
            to: projectionRef.current.from + selection.to,
          } : null,
          scrollTop: currentView?.scrollDOM.scrollTop ?? 0,
        };
      },
      restoreView: (snapshot) => {
        const currentView = viewRef.current;
        if (!currentView || snapshot.surface !== 'source') return false;
        if (snapshot.selection) adapter.restoreSelectionAnchor?.(snapshot.selection);
        currentView.scrollDOM.scrollTop = Math.max(0, snapshot.scrollTop);
        return true;
      },
      flushPendingEdits: () => adapter.read(),
      runtimeKey: () => {
        const documentId = performanceDocumentIdRef.current;
        const sourceRevision = revisionRef.current;
        if (!documentId || sourceRevision === undefined) return null;
        return {
          documentId,
          sourceRevision,
          surface: 'source',
          configurationFingerprint: `${runtimeInstanceIdRef.current}:${languageRef.current}:${sourceEditorProfileRef.current.codeMirrorLanguage}:${projectionRef.current.from}:${projectionRef.current.to}`,
        };
      },
      suspendRuntime: () => {
        const currentView = viewRef.current;
        const key = adapter.runtimeKey?.();
        if (!currentView || !key) return null;
        return {
          key,
          state: currentView.state,
          scrollTop: currentView.scrollDOM.scrollTop,
          focused: currentView.hasFocus,
          byteWeight: currentView.state.doc.length * 2 + 64 * 1024,
          historyBytes: Math.min(currentView.state.doc.length, 4 * 1024 * 1024),
          kind: 'exact-state',
        };
      },
      attachRuntime: (runtime) => {
        const currentView = viewRef.current;
        const key = adapter.runtimeKey?.();
        if (!currentView || !key || runtime.kind !== 'exact-state' || !(runtime.state instanceof EditorState)) return false;
        currentView.setState(runtime.state);
        currentView.scrollDOM.scrollTop = Math.max(0, runtime.scrollTop);
        if (runtime.focused) currentView.focus();
        warmAttachmentRef.current = { documentId: key.documentId, revision: key.sourceRevision };
        runtimeOwnerRef.current = { documentId: key.documentId, revision: key.sourceRevision };
        return true;
      },
      rebuildRuntime: () => {
        const currentView = viewRef.current;
        const key = adapter.runtimeKey?.();
        if (!currentView) return false;
        if (key && runtimeOwnerRef.current?.documentId === key.documentId
          && runtimeOwnerRef.current.revision === key.sourceRevision) return true;
        currentView.setState(createEditorState(valueRef.current));
        if (key) runtimeOwnerRef.current = { documentId: key.documentId, revision: key.sourceRevision };
        warmAttachmentRef.current = null;
        return true;
      },
    };
    adapterRef.current = adapter;

    return () => {
      onInsertReadyRef.current?.(undefined);
      onJumpReadyRef.current?.(undefined);
      onFindReadyRef.current?.(undefined);
      onHistoryReadyRef.current?.(undefined);
      onSelectionTextReadyRef.current?.(undefined);
      adapterRef.current = null;
      scrollElement.removeEventListener('scroll', scheduleViewportLine);
      window.removeEventListener('resize', scheduleViewportLine);
      if (viewportAnimationFrame !== null) window.cancelAnimationFrame(viewportAnimationFrame);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) return undefined;
    onAdapterReady?.(adapter);
    return () => onAdapterReady?.(undefined, adapter);
  }, [onAdapterReady, performanceDocumentId]);

  useEffect(() => {
    if (!performanceDocumentId || !viewRef.current) return;
    documentPerformance.trace({ name: 'editor-attach', documentId: performanceDocumentId, surface: 'source' });
    const frame = requestAnimationFrame(() => documentPerformance.trace({
      name: 'next-frame',
      documentId: performanceDocumentId,
      surface: 'source',
    }));
    return () => cancelAnimationFrame(frame);
  }, [performanceDocumentId]);

  useEffect(() => { onChangeSetRef.current = onChangeSet; }, [onChangeSet]);
  useEffect(() => { reconcileSourceRef.current = reconcileSource; }, [reconcileSource]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        languageCompartmentRef.current.reconfigure(createLanguageExtension(sourceEditorProfile, semanticPresentationMode)),
        lineWrappingCompartmentRef.current.reconfigure(createLineWrappingExtension(semanticPresentationMode)),
        longLineViewportCompartmentRef.current.reconfigure(createLongLineViewportExtension(semanticPresentationMode)),
      ],
    });
  }, [semanticPresentationMode, sourceEditorProfile]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: diagnosticsCompartmentRef.current.reconfigure(createDiagnosticsExtension(diagnostics, sourceEditorProfile)),
    });
  }, [diagnostics, sourceEditorProfile]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: extraExtensionsCompartmentRef.current.reconfigure(extraExtensions),
    });
  }, [extraExtensions]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const projected = sourceEditorProjection(value, semanticPresentationMode, projectionFrom);
    if (performanceDocumentId && revision !== undefined
      && runtimeOwnerRef.current?.documentId === performanceDocumentId
      && runtimeOwnerRef.current.revision === revision
      && projectionRef.current.from === projected.from
      && view.state.doc.toString() === projected.text) {
      warmAttachmentRef.current = null;
      valueRef.current = value;
      return;
    }
    const current = view.state.doc.toString();
    if (performanceDocumentId) documentPerformance.trace({
      name: 'whole-source-materialization',
      documentId: performanceDocumentId,
      surface: 'source',
      materializedBytes: utf8ByteLength(current),
      phase: 'external-value-compare',
    });
    projectionRef.current = projected;
    if (current === projected.text) return;
    if (programmaticEditBypassRef) programmaticEditBypassRef.current = true;
    try {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: projected.text },
        annotations: [Transaction.addToHistory.of(false), authoritativeSourceReconciliation.of(true)],
      });
      if (performanceDocumentId && revision !== undefined) {
        runtimeOwnerRef.current = { documentId: performanceDocumentId, revision };
      }
      if (performanceDocumentId) documentPerformance.trace({
        name: 'source-change',
        documentId: performanceDocumentId,
        surface: 'source',
        changeBytes: utf8ByteLength(projected.text),
        fullDocumentTransactions: projected.active ? 0 : 1,
        phase: projected.active ? 'external-bounded-source-projection' : 'external-whole-document-replacement',
      });
    } finally {
      if (programmaticEditBypassRef) programmaticEditBypassRef.current = false;
    }
  }, [performanceDocumentId, programmaticEditBypassRef, projectionFrom, revision, semanticPresentationMode, value]);

  return (
    <div
      className={`source-editor source-editor-shell source-editor-language-${language} source-editor-codemirror-${sourceEditorProfile.codeMirrorLanguage}`}
      data-source-editor-language={sourceEditorProfile.languageId}
      data-source-editor-codemirror={sourceEditorProfile.codeMirrorLanguage}
      data-source-editor-lint={sourceEditorProfile.lintProfile}
      data-source-semantic-highlighting={semanticPresentationMode}
    >
      <SourceEditorStatusStrip
        value={value}
        byteLength={sourceByteLength}
        language={language}
        profile={sourceEditorProfile}
        diagnostics={diagnostics}
        parsingPending={parsingPending}
        autosavePausedReason={autosavePausedReason}
      />
      {projection.active ? (
        <div className="source-editor-projection-controls" role="group" aria-label="Large source window">
          <button
            type="button"
            disabled={projection.from === 0}
            onClick={() => setProjectionFrom(Math.max(0, projection.from - SOURCE_EDITOR_PROJECTION_CODE_UNITS))}
          >
            Previous segment
          </button>
          <span>
            Characters {(projection.from + 1).toLocaleString()}-{projection.to.toLocaleString()} of {projection.sourceLength.toLocaleString()}
          </span>
          <button
            type="button"
            disabled={projection.to >= projection.sourceLength}
            onClick={() => setProjectionFrom(Math.min(
              projection.sourceLength - SOURCE_EDITOR_PROJECTION_CODE_UNITS,
              projection.from + SOURCE_EDITOR_PROJECTION_CODE_UNITS,
            ))}
          >
            Next segment
          </button>
        </div>
      ) : null}
      <div className="source-editor-host" ref={hostRef} />
      <SourceValidationTicks
        value={value}
        diagnostics={diagnostics}
        markers={markers}
      />
    </div>
  );
}

export function remeasureSourceEditorAfterFontsReady(
  view: Pick<EditorView, 'requestMeasure' | 'dom'>,
  fonts: FontFaceSet | undefined = typeof document === 'undefined' ? undefined : document.fonts,
): void {
  if (!fonts) {
    view.requestMeasure();
    view.dom.dataset.sourceFontRemeasured = 'fallback';
    return;
  }
  void Promise.all([
    fonts.load('400 14px "IBM Plex Mono"', 'α μ − ∞ {} []'),
    fonts.load('italic 400 14px "IBM Plex Mono"', 'source'),
    fonts.load('700 14px "IBM Plex Mono"', 'source'),
    fonts.ready,
  ]).then(() => {
    view.requestMeasure();
    view.dom.dataset.sourceFontRemeasured = 'loaded';
  }).catch(() => {
    view.requestMeasure();
    view.dom.dataset.sourceFontRemeasured = 'fallback';
  });
}

function createSourceContextMenuRequest(
  view: EditorView,
  event: MouseEvent,
  language: SourceTextLanguage,
  sourceEditor: SourceEditorCapabilities,
  diagnostics: FormatDiagnostic[],
): SourceTextContextMenuRequest | null {
  const position = { x: event.clientX, y: event.clientY };
  const ranges = [...view.state.selection.ranges]
    .filter((range) => range.from !== range.to)
    .sort((left, right) => left.from - right.from);

  if (ranges.length === 0) {
    const line = lineForSourceContextPointer(view, event);
    return {
      kind: 'line',
      position,
      language,
      text: line.text,
      lineText: line.text,
      selectedLinesText: line.text,
      line: line.number,
      endLine: line.number,
      from: line.from,
      to: line.to,
      diagnostics: diagnostics.filter((diagnostic) => diagnosticBelongsToLine(diagnostic, line.number, view)),
      sourceEditor,
      selectLine: () => selectSourceLine(view, line.from, line.to),
    };
  }

  const text = ranges
    .map((range) => view.state.sliceDoc(range.from, range.to))
    .filter(Boolean)
    .join('\n\n');

  const firstRange = ranges[0] ?? view.state.selection.main;
  const lastRange = ranges.at(-1) ?? firstRange;
  const firstLine = view.state.doc.lineAt(firstRange.from);
  const lastLine = view.state.doc.lineAt(Math.max(firstRange.from, lastRange.to - 1));
  return {
    kind: 'selection',
    position,
    language,
    text,
    lineText: firstLine.text,
    selectedLinesText: view.state.sliceDoc(firstLine.from, lastLine.to),
    line: firstLine.number,
    endLine: lastLine.number,
    from: firstRange.from,
    to: lastRange.to,
    diagnostics: diagnostics.filter((diagnostic) => {
      const line = lineForSourceDiagnostic(diagnostic, view);
      return line !== null && firstLine.number <= line && line <= lastLine.number;
    }),
    sourceEditor,
    selectLine: () => selectSourceLine(view, firstLine.from, lastLine.to),
  };
}

function lineForSourceContextPointer(view: EditorView, event: MouseEvent) {
  let pointerPos: number | null = null;
  try {
    pointerPos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  } catch {
    pointerPos = null;
  }
  const fallbackPos = view.state.selection.main.head;
  return view.state.doc.lineAt(clampOffset(pointerPos ?? fallbackPos, view.state.doc.length));
}

function diagnosticBelongsToLine(diagnostic: FormatDiagnostic, line: number, view: EditorView): boolean {
  return lineForSourceDiagnostic(diagnostic, view) === line;
}

function selectSourceLine(view: EditorView, from: number, to: number): void {
  view.dispatch({
    selection: { anchor: from, head: to },
    effects: EditorView.scrollIntoView(from, { y: 'nearest', yMargin: 18 }),
  });
  view.focus();
}

function lineForSourceDiagnostic(diagnostic: FormatDiagnostic, view: EditorView): number | null {
  if (diagnostic.line && diagnostic.line > 0) return diagnostic.line;
  const messageLine = lineFromDiagnostic(diagnostic);
  if (messageLine) return messageLine;
  if (diagnostic.offset !== undefined) {
    return view.state.doc.lineAt(clampOffset(diagnostic.offset, view.state.doc.length)).number;
  }
  return lineFromDiagnostic({ message: diagnostic.message });
}

export function createPlainTextInsertTransaction(view: Pick<EditorView, 'state'>, text: string): TransactionSpec {
  const selection = view.state.selection.main;
  return {
    changes: { from: selection.from, to: selection.to, insert: text },
    selection: { anchor: selection.from + text.length },
  };
}

function SourceEditorStatusStrip({
  value,
  byteLength,
  language,
  profile,
  diagnostics,
  parsingPending,
  autosavePausedReason,
}: {
  value: string;
  byteLength: number;
  language: SourceTextLanguage;
  profile: SourceEditorCapabilities;
  diagnostics: FormatDiagnostic[];
  parsingPending: boolean;
  autosavePausedReason: string | null;
}) {
  const badges = sourceEditorStatusBadges({
    value,
    byteLength,
    language,
    profile,
    diagnostics,
    parsingPending,
    autosavePausedReason,
  });
  if (badges.length === 0) return null;
  return (
    <div className="source-editor-status-strip" aria-label="Source editor status">
      {badges.map((badge) => (
        <span key={badge.id} className={`source-editor-status-badge ${badge.tone}`} title={badge.title}>
          {badge.label}
        </span>
      ))}
    </div>
  );
}

interface SourceEditorStatusBadge {
  id: string;
  label: string;
  title: string;
  tone: 'neutral' | 'success' | 'warning' | 'error';
}

function sourceEditorStatusBadges({
  value,
  byteLength,
  language,
  profile,
  diagnostics,
  parsingPending,
  autosavePausedReason,
}: {
  value: string;
  byteLength: number;
  language: SourceTextLanguage;
  profile: SourceEditorCapabilities;
  diagnostics: FormatDiagnostic[];
  parsingPending: boolean;
  autosavePausedReason: string | null;
}): SourceEditorStatusBadge[] {
  const label = formatDefinitionFor(language)?.label ?? language;
  const badges: SourceEditorStatusBadge[] = [];
  const parserDiagnostics = diagnostics.filter((diagnostic) => diagnostic.category === 'parser' || /\bsyntax\b/i.test(diagnostic.code));
  const parserErrors = parserDiagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const parserWarnings = parserDiagnostics.filter((diagnostic) => diagnostic.severity !== 'error').length;
  const schemaDiagnostics = diagnostics.filter((diagnostic) => diagnostic.category === 'schema');
  const preservationDiagnostics = diagnostics.filter((diagnostic) => diagnostic.category === 'preservation');
  const sourceOnlyDiagnostic = diagnostics.find((diagnostic) => diagnostic.code.includes('source-only'));
  const lineEndings = detectLineEndingState(value);

  if (
    language === 'markdown'
    && diagnostics.length === 0
    && !parsingPending
    && !autosavePausedReason
    && !lineEndings.mixed
  ) {
    return [];
  }

  badges.push({
    id: 'format',
    label,
    title: `${label} source mode`,
    tone: 'neutral',
  });

  if (parsingPending) {
    badges.push({
      id: 'parser',
      label: 'Checking',
      title: 'Background parser diagnostics are still running.',
      tone: 'neutral',
    });
  } else if (parserErrors > 0) {
    badges.push({
      id: 'parser',
      label: `${parserErrors} syntax ${parserErrors === 1 ? 'error' : 'errors'}`,
      title: 'Parser errors block safe visual projection until the source is fixed.',
      tone: 'error',
    });
  } else if (parserWarnings > 0) {
    badges.push({
      id: 'parser',
      label: `${parserWarnings} parser ${parserWarnings === 1 ? 'warning' : 'warnings'}`,
      title: 'Parser diagnostics are available for this source.',
      tone: 'warning',
    });
  } else if (profile.lintProfile !== 'none') {
    badges.push({
      id: 'parser',
      label: 'Parser OK',
      title: 'No parser errors were reported for this source.',
      tone: 'success',
    });
  }

  if (schemaDiagnostics.length > 0) {
    badges.push({
      id: 'schema',
      label: `${schemaDiagnostics.length} schema ${schemaDiagnostics.length === 1 ? 'issue' : 'issues'}`,
      title: 'Schema diagnostics are present for this document.',
      tone: schemaDiagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 'error' : 'warning',
    });
  }

  if (preservationDiagnostics.length > 0) {
    badges.push({
      id: 'preservation',
      label: `${preservationDiagnostics.length} preservation ${preservationDiagnostics.length === 1 ? 'warning' : 'warnings'}`,
      title: 'Some source syntax may not round-trip through visual projections.',
      tone: 'warning',
    });
  }

  if (sourceOnlyDiagnostic) {
    badges.push({
      id: 'source-only',
      label: 'Source-only',
      title: sourceOnlyDiagnostic.message,
      tone: 'warning',
    });
  } else if (profile.sourceOnlyThresholdBytes !== undefined) {
    badges.push({
      id: 'budget',
      label: `${formatBytes(byteLength)} / ${formatBytes(profile.sourceOnlyThresholdBytes)}`,
      title: 'Current source size compared with this format parser budget.',
      tone: byteLength > profile.sourceOnlyThresholdBytes ? 'warning' : 'neutral',
    });
  }

  if (language !== 'plainText' && !profile.codeMirrorLanguageAvailable && profile.plainTextReason) {
    badges.push({
      id: 'language',
      label: 'Plain text',
      title: profile.plainTextReason,
      tone: 'neutral',
    });
  }

  if (lineEndings.mixed) {
    badges.push({
      id: 'line-endings',
      label: 'Mixed line endings',
      title: `Detected ${lineEndings.labels.join(', ')} line endings in this source.`,
      tone: 'warning',
    });
  }

  if (autosavePausedReason) {
    badges.push({
      id: 'autosave',
      label: 'Autosave paused',
      title: autosavePausedReason,
      tone: 'warning',
    });
  }

  return badges;
}

function detectLineEndingState(value: string): { mixed: boolean; labels: string[] } {
  const labels: string[] = [];
  if (/\r\n/.test(value)) labels.push('CRLF');
  if (/(^|[^\r])\n/.test(value)) labels.push('LF');
  if (/\r(?!\n)/.test(value)) labels.push('CR');
  return {
    mixed: labels.length > 1,
    labels,
  };
}

function SourceValidationTicks({
  value,
  diagnostics,
  markers,
}: {
  value: string;
  diagnostics: FormatDiagnostic[];
  markers: SourceTextMarker[];
}) {
  if (diagnostics.length === 0 && markers.length === 0) return null;
  let totalLines = 1;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\n') totalLines++;
  }
  const diagnosticTicks: SourceTextMarker[] = diagnostics
    .map((diagnostic): SourceTextMarker | null => {
      const line = diagnostic.line ?? lineFromDiagnostic(diagnostic);
      return line
        ? {
            id: `diagnostic-${diagnostic.code}-${line}-${diagnostic.message}`,
            line,
            kind: diagnostic.severity,
            title: diagnostic.message,
          }
        : null;
    })
    .filter((tick): tick is SourceTextMarker => Boolean(tick));
  const ticks: SourceTextMarker[] = [
    ...diagnosticTicks,
    ...markers,
  ];

  if (ticks.length === 0) return null;

  return (
    <div className="source-validation-ticks" aria-hidden="true">
      {ticks.map((tick) => {
        const top = totalLines <= 1 ? 0 : ((Math.max(1, Math.min(tick.line, totalLines)) - 1) / (totalLines - 1)) * 100;
        return (
          <span
            key={tick.id}
            className={`source-validation-tick ${tick.kind}`}
            title={tick.title}
            style={{ top: `${top}%` }}
          />
        );
      })}
    </div>
  );
}

function lineFromDiagnostic(diagnostic: Pick<FormatDiagnostic, 'message'>): number | null {
  const match = diagnostic.message.match(/\bline\s+(\d+)\b/i);
  if (!match) return null;
  const line = Number(match[1]);
  return Number.isFinite(line) && line > 0 ? line : null;
}

function maybeTypewriterScroll(view: EditorView): void {
  if (!document.querySelector('.app-shell.focus-mode')) return;
  const head = view.state.selection.main.head;
  window.requestAnimationFrame(() => {
    const coords = view.coordsAtPos(head);
    if (!coords) return;
    const scroller = view.scrollDOM;
    const scrollerRect = scroller.getBoundingClientRect();
    const target = scroller.scrollTop + coords.top - scrollerRect.top - scroller.clientHeight * 0.42;
    scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  });
}

function viewportTopLine(view: EditorView): number {
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 24);
  return view.state.doc.lineAt(block.from).number;
}

function sourceLineOffset(sourceText: string, offset: number): number {
  let lines = 0;
  for (let index = 0; index < Math.min(offset, sourceText.length); index += 1) {
    if (sourceText.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function sourceOffsetForLine(sourceText: string, requestedLine: number): number {
  const targetLine = Math.max(1, Math.floor(requestedLine));
  if (targetLine === 1) return 0;
  let line = 1;
  for (let index = 0; index < sourceText.length; index += 1) {
    if (sourceText.charCodeAt(index) !== 10) continue;
    line += 1;
    if (line === targetLine) return index + 1;
  }
  return sourceText.length;
}

export function createLanguageExtension(profile: SourceEditorCapabilities, mode: SourceSemanticPresentationMode = 'enabled'): Extension {
  if (mode !== 'enabled') return [];
  if (profile.codeMirrorLanguage === 'markdown') return [markdownLanguage(), createScieMdSemanticHighlighting()];
  if (profile.codeMirrorLanguage === 'json') return [jsonLanguage(), createScieMdSemanticHighlighting()];
  if (profile.codeMirrorLanguage === 'yaml') return [yamlLanguage(), createScieMdSemanticHighlighting()];
  if (profile.codeMirrorLanguage === 'xml') return [xmlLanguage(), createScieMdSemanticHighlighting()];
  return [];
}

export function createLineWrappingExtension(mode: SourceSemanticPresentationMode = 'enabled'): Extension {
  return mode === 'enabled' ? EditorView.lineWrapping : [];
}

export const LONG_LINE_VIEWPORT_CODE_UNITS = 128 * 1024;

export interface LongLineViewportRange {
  from: number;
  to: number;
  hiddenCodeUnits: number;
  revealAt: number;
  direction: 'previous' | 'next';
}

export function longLineViewportRanges(
  lineFrom: number,
  lineTo: number,
  anchor: number,
  viewportCodeUnits = LONG_LINE_VIEWPORT_CODE_UNITS,
): readonly LongLineViewportRange[] {
  const lineLength = Math.max(0, lineTo - lineFrom);
  if (lineLength <= viewportCodeUnits) return [];
  const radius = Math.max(1, Math.floor(viewportCodeUnits / 2));
  const boundedAnchor = Math.max(lineFrom, Math.min(lineTo, anchor));
  let visibleFrom = Math.max(lineFrom, boundedAnchor - radius);
  let visibleTo = Math.min(lineTo, visibleFrom + viewportCodeUnits);
  visibleFrom = Math.max(lineFrom, visibleTo - viewportCodeUnits);
  const ranges: LongLineViewportRange[] = [];
  if (visibleFrom > lineFrom) ranges.push({
    from: lineFrom,
    to: visibleFrom,
    hiddenCodeUnits: visibleFrom - lineFrom,
    revealAt: Math.max(lineFrom, visibleFrom - radius),
    direction: 'previous',
  });
  if (visibleTo < lineTo) ranges.push({
    from: visibleTo,
    to: lineTo,
    hiddenCodeUnits: lineTo - visibleTo,
    revealAt: Math.min(lineTo, visibleTo + radius),
    direction: 'next',
  });
  return ranges;
}

class LongLineViewportWidget extends WidgetType {
  constructor(private readonly range: LongLineViewportRange) { super(); }

  eq(other: LongLineViewportWidget): boolean {
    return this.range.hiddenCodeUnits === other.range.hiddenCodeUnits
      && this.range.revealAt === other.range.revealAt
      && this.range.direction === other.range.direction;
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'source-editor-long-line-reveal';
    button.textContent = `… ${this.range.hiddenCodeUnits.toLocaleString()} characters hidden; show ${this.range.direction} segment …`;
    button.setAttribute('aria-label', `Show ${this.range.direction} segment of the long source line`);
    button.addEventListener('click', () => {
      view.dispatch({ selection: { anchor: this.range.revealAt }, scrollIntoView: true });
      view.focus();
    });
    return button;
  }

  ignoreEvent(): boolean { return false; }
}

function longLineDecorations(view: EditorView): DecorationSet {
  const anchor = view.state.selection.main.head;
  const line = view.state.doc.lineAt(anchor);
  const ranges = longLineViewportRanges(line.from, line.to, anchor);
  return Decoration.set(ranges.map((range) => Decoration.replace({
    widget: new LongLineViewportWidget(range),
    inclusive: false,
  }).range(range.from, range.to)), true);
}

const longLineViewportPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = longLineDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = longLineDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

export function createLongLineViewportExtension(mode: SourceSemanticPresentationMode = 'enabled'): Extension {
  return mode === 'large-file-fallback' ? longLineViewportPlugin : [];
}

function createDiagnosticsExtension(diagnostics: FormatDiagnostic[], profile: SourceEditorCapabilities): Extension {
  if (diagnostics.length === 0) return [];
  if (profile.lintProfile === 'none' || profile.diagnosticsRangeSupport === 'none') return [];
  return [
    lintGutter(),
    linter((view) => formatDiagnosticsForCodeMirror(diagnostics, view.state.doc.toString()), { delay: 100 }),
  ];
}

export function formatDiagnosticsForCodeMirror(
  diagnostics: readonly FormatDiagnostic[],
  text: string,
): CodeMirrorDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const from = clampOffset(diagnostic.offset ?? offsetFromLineColumn(text, diagnostic.line, diagnostic.column), text.length);
    const to = clampOffset(from + Math.max(1, diagnostic.length ?? 1), text.length);
    return {
      from,
      to: Math.max(from, to),
      severity: diagnostic.severity,
      source: diagnostic.source ?? 'source',
      message: diagnostic.message,
    };
  });
}

function offsetFromLineColumn(text: string, line?: number, column?: number): number {
  if (!line || line < 1) return 0;
  let currentLine = 1;
  let lineStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (currentLine === line) break;
    if (text.charCodeAt(index) === 10) {
      currentLine += 1;
      lineStart = index + 1;
    }
  }
  if (currentLine !== line) return text.length;
  return lineStart + Math.max(0, (column ?? 1) - 1);
}

function clampOffset(offset: number, documentLength: number): number {
  return Math.max(0, Math.min(offset, documentLength));
}
