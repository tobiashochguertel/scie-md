import type { EditorAdapter, EditorReadResult, EditorSurface, EditorViewSnapshot } from '../components/editorAdapter';
import {
  commitVisualEditorReadResult,
  flushEditorAdapterState,
  readEditorAdapterState,
} from '../components/visualEditorStateSync';
import { createDocumentHistory, resetDocumentHistory, type DocumentHistoryState } from '../markdown/documentHistory';
import type { DocumentId } from './documentIdentity';

export type DocumentRuntimeSlot =
  | 'sourceInsert'
  | 'visualInsert'
  | 'sourceJump'
  | 'sourceFind'
  | 'visualJump'
  | 'visualFind'
  | 'sourceHistory'
  | 'visualHistory'
  | 'sourceSelection'
  | 'visualSelection';

export interface DocumentEditorGateway {
  read(documentId: DocumentId): EditorReadResult | null;
  flush(documentId: DocumentId): EditorReadResult | null;
  commit(documentId: DocumentId, onCommit: (sourceText: string) => void): string | null;
  focus(documentId: DocumentId): boolean;
}

interface DocumentEditorRuntime {
  activeSurface: EditorSurface | null;
  adapters: Map<EditorSurface, EditorAdapter>;
  slots: Map<DocumentRuntimeSlot, unknown>;
}

/** The sole writer for document-addressed editor runtime, view, and history state. */
export class DocumentKeyedEditorGateway implements DocumentEditorGateway {
  private readonly runtimes = new Map<DocumentId, DocumentEditorRuntime>();
  private readonly views = new Map<DocumentId, Map<EditorSurface, EditorViewSnapshot>>();
  private readonly histories = new Map<DocumentId, DocumentHistoryState>();

  activate(documentId: DocumentId, surface: EditorSurface): void {
    this.runtime(documentId).activeSurface = surface;
    const adapter = this.runtimes.get(documentId)?.adapters.get(surface);
    const snapshot = this.views.get(documentId)?.get(surface);
    if (adapter && snapshot) adapter.restoreView?.(snapshot);
  }

  registerAdapter(documentId: DocumentId, surface: EditorSurface, adapter: EditorAdapter | undefined): void {
    if (!adapter) {
      const runtime = this.runtimes.get(documentId);
      if (!runtime) return;
      this.snapshotAdapter(documentId, runtime.adapters.get(surface));
      runtime.adapters.delete(surface);
      return;
    }
    const runtime = this.runtime(documentId);
    if (adapter.surface !== surface) return;
    runtime.adapters.set(surface, adapter);
    runtime.activeSurface = surface;
    const snapshot = this.views.get(documentId)?.get(surface);
    if (snapshot) adapter.restoreView?.(snapshot);
  }

  unregisterAdapter(documentId: DocumentId, surface: EditorSurface, adapter: EditorAdapter): void {
    const runtime = this.runtimes.get(documentId);
    if (!runtime || runtime.adapters.get(surface) !== adapter) return;
    this.snapshotAdapter(documentId, adapter);
    runtime.adapters.delete(surface);
  }

  registerRuntime<T>(documentId: DocumentId, slot: DocumentRuntimeSlot, handler: T | undefined): void {
    if (handler === undefined) {
      this.runtimes.get(documentId)?.slots.delete(slot);
      return;
    }
    this.runtime(documentId).slots.set(slot, handler);
  }

  getRuntime<T>(documentId: DocumentId, slot: DocumentRuntimeSlot): T | undefined {
    return this.runtimes.get(documentId)?.slots.get(slot) as T | undefined;
  }

  read(documentId: DocumentId): EditorReadResult | null {
    return readEditorAdapterState(this.activeAdapter(documentId));
  }

  flush(documentId: DocumentId): EditorReadResult | null {
    return flushEditorAdapterState(this.activeAdapter(documentId));
  }

  commit(documentId: DocumentId, onCommit: (sourceText: string) => void): string | null {
    return commitVisualEditorReadResult(this.flush(documentId), onCommit);
  }

  focus(documentId: DocumentId): boolean {
    const adapter = this.activeAdapter(documentId);
    if (!adapter) return false;
    adapter.focus();
    return true;
  }

  snapshotView(documentId: DocumentId): EditorViewSnapshot | null {
    return this.snapshotAdapter(documentId, this.activeAdapter(documentId));
  }

  private snapshotAdapter(documentId: DocumentId, adapter: EditorAdapter | undefined): EditorViewSnapshot | null {
    const snapshot = adapter?.captureView?.() ?? null;
    if (!snapshot) return null;
    const snapshots = this.views.get(documentId) ?? new Map<EditorSurface, EditorViewSnapshot>();
    snapshots.set(snapshot.surface, snapshot);
    this.views.set(documentId, snapshots);
    return snapshot;
  }

  getViewSnapshot(documentId: DocumentId, surface: EditorSurface): EditorViewSnapshot | null {
    return this.views.get(documentId)?.get(surface) ?? null;
  }

  deactivate(documentId: DocumentId, onCommit: (sourceText: string) => void): string | null {
    const committed = this.commit(documentId, onCommit);
    this.snapshotView(documentId);
    this.runtimes.delete(documentId);
    return committed;
  }

  historyFor(documentId: DocumentId): DocumentHistoryState {
    const history = this.histories.get(documentId) ?? createDocumentHistory();
    this.histories.set(documentId, history);
    return history;
  }

  clearHistory(documentId: DocumentId): void {
    resetDocumentHistory(this.historyFor(documentId));
  }

  clearRuntime(documentId: DocumentId): void {
    this.snapshotView(documentId);
    this.runtimes.delete(documentId);
  }

  releaseDocument(documentId: DocumentId): void {
    this.runtimes.delete(documentId);
    this.views.delete(documentId);
    this.histories.delete(documentId);
  }

  private activeAdapter(documentId: DocumentId): EditorAdapter | undefined {
    const runtime = this.runtimes.get(documentId);
    if (!runtime) return undefined;
    if (runtime.activeSurface) return runtime.adapters.get(runtime.activeSurface);
    return runtime.adapters.values().next().value;
  }

  private runtime(documentId: DocumentId): DocumentEditorRuntime {
    const runtime = this.runtimes.get(documentId) ?? {
      activeSurface: null,
      adapters: new Map<EditorSurface, EditorAdapter>(),
      slots: new Map<DocumentRuntimeSlot, unknown>(),
    };
    this.runtimes.set(documentId, runtime);
    return runtime;
  }
}

export const documentEditorGateway = new DocumentKeyedEditorGateway();
export { commitVisualEditorReadResult };
