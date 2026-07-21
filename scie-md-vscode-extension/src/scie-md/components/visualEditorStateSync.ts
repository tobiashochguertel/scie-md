type VisualEditorStateReader = () => string | null;

interface RegisteredVisualEditorStateReader {
  id: symbol;
  reader: VisualEditorStateReader;
}

// The VS Code webview is intentionally a single-document host. This is a thin
// compatibility slot with the desktop gateway's read/flush semantics, not a
// second workspace or document-lifecycle kernel.
let registeredReader: RegisteredVisualEditorStateReader | null = null;

export function setVisualEditorStateReader(reader: VisualEditorStateReader): () => void {
  const id = Symbol('visual-editor-state-reader');
  registeredReader = { id, reader };
  return () => {
    if (registeredReader?.id === id) registeredReader = null;
  };
}

export function flushVisualEditorState(): string | null {
  return registeredReader?.reader() ?? null;
}
