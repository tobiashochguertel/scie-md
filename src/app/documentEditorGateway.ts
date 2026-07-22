import type { EditorAdapter, EditorReadResult, EditorSurface, EditorViewSnapshot } from '../components/editorAdapter';
import {
  commitVisualEditorReadResult,
  flushEditorAdapterState,
  readEditorAdapterState,
} from '../components/visualEditorStateSync';
import { createDocumentHistory, resetDocumentHistory, type DocumentHistoryState } from '../markdown/documentHistory';
import type { DocumentId } from './documentIdentity';
import { documentPerformance, utf8ByteLength } from './performance/documentPerformance';
import { DocumentRuntimeRegistry, documentRuntimeRegistry, type RuntimeRegistryMetrics } from './runtime/documentRuntimeRegistry';

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
  surface(documentId: DocumentId): EditorSurface | null;
  read(documentId: DocumentId): EditorReadResult | null;
  flush(documentId: DocumentId): EditorReadResult | null;
  commit(documentId: DocumentId, onCommit: (sourceText: string) => void): string | null;
  focus(documentId: DocumentId): boolean;
  hasWarmRuntime(documentId: DocumentId, surface: EditorSurface): boolean;
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

  constructor(private readonly registry: DocumentRuntimeRegistry = documentRuntimeRegistry) {}

  surface(documentId: DocumentId): EditorSurface | null {
    return this.runtimes.get(documentId)?.activeSurface ?? null;
  }

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
    const runtimeKey = adapter.runtimeKey?.();
    if (runtimeKey) {
      const candidateWasWarm = this.registry.has(runtimeKey.documentId, runtimeKey.surface, runtimeKey.sourceRevision);
      const suspended = this.registry.attach(runtimeKey);
      const attached = suspended ? adapter.attachRuntime?.(suspended) === true : false;
      if (!attached) adapter.rebuildRuntime?.();
      documentPerformance.trace({
        name: 'runtime-attach', documentId, surface,
        cache: attached && suspended?.kind === 'exact-state' ? 'hit' : 'miss',
        byteCount: suspended?.byteWeight ?? 0,
        phase: attached ? suspended?.kind : candidateWasWarm ? 'attach-rejected' : 'cache-miss',
      });
    }
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
    const started = monotonicNow();
    const result = flushEditorAdapterState(this.activeAdapter(documentId));
    if (result) documentPerformance.trace({
      name: 'whole-source-materialization',
      documentId,
      surface: result.surface,
      durationMs: monotonicNow() - started,
      materializedBytes: utf8ByteLength(result.markdown),
      phase: 'editor-gateway-flush',
    });
    return result;
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
    const committed = this.surface(documentId) === 'source' ? null : this.commit(documentId, onCommit);
    const adapter = this.activeAdapter(documentId);
    this.snapshotAdapter(documentId, adapter);
    const suspended = adapter?.suspendRuntime?.();
    if (suspended) {
      const admission = this.registry.suspend(suspended);
      documentPerformance.trace({
        name: admission.status === 'admitted' ? 'runtime-suspend' : 'runtime-admission-refused',
        documentId, surface: suspended.key.surface, byteCount: suspended.byteWeight,
        phase: admission.status === 'admitted' ? suspended.kind : admission.reason,
      });
      if (admission.status === 'admitted') {
        for (const eviction of admission.evicted) documentPerformance.trace({
          name: 'runtime-eviction', documentId: eviction.documentId, surface: eviction.surface,
          byteCount: eviction.byteWeight, phase: eviction.reason,
        });
      }
    }
    this.runtimes.delete(documentId);
    return committed;
  }

  hasWarmRuntime(documentId: DocumentId, surface: EditorSurface): boolean {
    return this.registry.has(documentId, surface);
  }

  runtimeMetrics(): RuntimeRegistryMetrics {
    return this.registry.metrics();
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
    this.registry.invalidate(documentId);
  }

  releaseDocument(documentId: DocumentId): void {
    this.runtimes.delete(documentId);
    this.views.delete(documentId);
    this.histories.delete(documentId);
    this.registry.releaseDocument(documentId);
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

function monotonicNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}
