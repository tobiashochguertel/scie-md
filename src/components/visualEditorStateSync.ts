import type { EditorAdapter, EditorReadResult } from './editorAdapter';

/** Host-neutral read semantics shared by the document-keyed gateway. */
export function readEditorAdapterState(adapter: EditorAdapter | undefined): EditorReadResult | null {
  return adapter?.read() ?? null;
}

/** Flushes editor-owned pending controls before reading their canonical Markdown. */
export function flushEditorAdapterState(adapter: EditorAdapter | undefined): EditorReadResult | null {
  return adapter?.flushPendingEdits() ?? null;
}

export function commitVisualEditorReadResult(
  result: EditorReadResult | null,
  onCommit: (markdown: string) => void,
): string | null {
  if (!result) return null;
  if (result.changed) {
    result.markCommitted?.();
    onCommit(result.markdown);
  }
  return result.markdown;
}
