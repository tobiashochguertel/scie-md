import type { DocumentId, SourceRevision } from '../documentIdentity';
import type { EditorSurface } from '../../components/editorAdapter';

export interface DocumentRuntimeBudgets {
  lowWatermarkBytes: number;
  highWatermarkBytes: number;
  hardCeilingBytes: number;
  reservedActiveHeadroomBytes: number;
  minimumResidencyMs: number;
}

export const DOCUMENT_RUNTIME_BUDGETS: Readonly<DocumentRuntimeBudgets> = Object.freeze({
  lowWatermarkBytes: 64 * 1024 * 1024,
  highWatermarkBytes: 96 * 1024 * 1024,
  hardCeilingBytes: 160 * 1024 * 1024,
  reservedActiveHeadroomBytes: 32 * 1024 * 1024,
  minimumResidencyMs: 2_000,
});

export interface DocumentRuntimeKey {
  documentId: DocumentId;
  sourceRevision: SourceRevision;
  surface: EditorSurface;
  configurationFingerprint: string;
}

export interface SuspendedEditorRuntime {
  key: DocumentRuntimeKey;
  state: unknown;
  scrollTop: number;
  focused: boolean;
  byteWeight: number;
  historyBytes: number;
  suspendedAt: number;
  kind: 'exact-state' | 'bounded-rebuild';
}

export type RuntimeAdmissionResult =
  | { status: 'admitted'; evicted: readonly RuntimeEviction[] }
  | { status: 'refused'; reason: 'reserved-headroom' | 'hard-ceiling'; requiredBytes: number; availableBytes: number };

export interface RuntimeEviction {
  documentId: DocumentId;
  surface: EditorSurface;
  reason: 'high-watermark' | 'memory-pressure' | 'history-truncation' | 'document-release' | 'revision-mismatch' | 'configuration-mismatch';
  byteWeight: number;
}

export interface RuntimeRegistryMetrics {
  entryCount: number;
  byteWeight: number;
  hits: number;
  misses: number;
  refusals: number;
  evictions: number;
  degraded: readonly DocumentId[];
}

export interface ColdCleanReleaseRequest {
  documentId: DocumentId;
  clean: boolean;
  pathBacked: boolean;
  saving: boolean;
  conflicted: boolean;
  recoveryOnly: boolean;
  release: readonly (() => void | Promise<void>)[];
  dropAuthoritativeSource: () => void | Promise<void>;
}

export type ColdCleanReleaseResult =
  | { status: 'cold-clean' }
  | { status: 'ineligible'; reason: 'dirty' | 'untitled' | 'saving' | 'conflicted' | 'recovery-only' }
  | { status: 'failed'; completedReleaseSteps: number; error: unknown };

/** Sole runtime writer. Entries are reconstructible and are never serialized. */
export class DocumentRuntimeRegistry {
  private readonly entries = new Map<string, SuspendedEditorRuntime>();
  private readonly degradedDocuments = new Set<DocumentId>();
  private hits = 0;
  private misses = 0;
  private refusals = 0;
  private evictionCount = 0;

  constructor(
    private readonly budgets: Readonly<DocumentRuntimeBudgets> = DOCUMENT_RUNTIME_BUDGETS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  suspend(entry: Omit<SuspendedEditorRuntime, 'suspendedAt'>): RuntimeAdmissionResult {
    const normalized: SuspendedEditorRuntime = {
      ...entry,
      byteWeight: Math.max(0, Math.floor(entry.byteWeight)),
      historyBytes: Math.max(0, Math.floor(entry.historyBytes)),
      suspendedAt: this.now(),
    };
    const key = runtimeKey(normalized.key);
    const previous = this.entries.get(key);
    const currentWeight = this.totalWeight() - (previous?.byteWeight ?? 0);
    const maximumAdmitted = this.budgets.hardCeilingBytes - this.budgets.reservedActiveHeadroomBytes;
    if (normalized.byteWeight > maximumAdmitted) {
      this.refusals += 1;
      return { status: 'refused', reason: 'reserved-headroom', requiredBytes: normalized.byteWeight, availableBytes: maximumAdmitted };
    }
    if (currentWeight + normalized.byteWeight > this.budgets.hardCeilingBytes) {
      this.refusals += 1;
      return { status: 'refused', reason: 'hard-ceiling', requiredBytes: normalized.byteWeight, availableBytes: Math.max(0, this.budgets.hardCeilingBytes - currentWeight) };
    }
    this.entries.set(key, normalized);
    const evicted = this.shedToLowWatermark(normalized.key.documentId, 'high-watermark');
    return { status: 'admitted', evicted };
  }

  attach(key: DocumentRuntimeKey): SuspendedEditorRuntime | null {
    const exactKey = runtimeKey(key);
    const exact = this.entries.get(exactKey);
    if (exact) {
      this.entries.delete(exactKey);
      this.hits += 1;
      return exact;
    }
    this.misses += 1;
    for (const [candidateKey, entry] of this.entries) {
      if (entry.key.documentId !== key.documentId || entry.key.surface !== key.surface) continue;
      this.entries.delete(candidateKey);
      this.evictionCount += 1;
    }
    return null;
  }

  has(documentId: DocumentId, surface: EditorSurface, sourceRevision?: SourceRevision): boolean {
    return [...this.entries.values()].some((entry) => entry.key.documentId === documentId
      && entry.key.surface === surface
      && entry.kind === 'exact-state'
      && (sourceRevision === undefined || entry.key.sourceRevision === sourceRevision));
  }

  invalidate(documentId: DocumentId): RuntimeEviction[] {
    return this.releaseDocument(documentId, 'revision-mismatch');
  }

  releaseDocument(documentId: DocumentId, reason: RuntimeEviction['reason'] = 'document-release'): RuntimeEviction[] {
    const evicted: RuntimeEviction[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.key.documentId !== documentId) continue;
      this.entries.delete(key);
      evicted.push(toEviction(entry, reason));
    }
    this.degradedDocuments.delete(documentId);
    this.evictionCount += evicted.length;
    return evicted;
  }

  pressure(): RuntimeEviction[] {
    return this.shedToLowWatermark(null, 'memory-pressure', true);
  }

  markDegraded(documentId: DocumentId): void {
    this.degradedDocuments.add(documentId);
  }

  clearDegraded(documentId: DocumentId): void {
    this.degradedDocuments.delete(documentId);
  }

  canGrowActiveSource(documentId: DocumentId, additionalBytes: number): RuntimeAdmissionResult {
    let availableBytes = this.budgets.hardCeilingBytes - this.budgets.reservedActiveHeadroomBytes - this.totalWeight();
    if (additionalBytes <= availableBytes) return { status: 'admitted', evicted: [] };

    const evicted = this.shedToLowWatermark(documentId, 'memory-pressure', true);
    availableBytes = this.budgets.hardCeilingBytes - this.budgets.reservedActiveHeadroomBytes - this.totalWeight();
    if (additionalBytes <= availableBytes) return { status: 'admitted', evicted };

    this.refusals += 1;
    this.markDegraded(documentId);
    return { status: 'refused', reason: 'reserved-headroom', requiredBytes: additionalBytes, availableBytes: Math.max(0, availableBytes) };
  }

  async transitionToColdClean(request: ColdCleanReleaseRequest): Promise<ColdCleanReleaseResult> {
    if (!request.clean) return { status: 'ineligible', reason: 'dirty' };
    if (!request.pathBacked) return { status: 'ineligible', reason: 'untitled' };
    if (request.saving) return { status: 'ineligible', reason: 'saving' };
    if (request.conflicted) return { status: 'ineligible', reason: 'conflicted' };
    if (request.recoveryOnly) return { status: 'ineligible', reason: 'recovery-only' };
    let completedReleaseSteps = 0;
    try {
      for (const release of request.release) {
        await release();
        completedReleaseSteps += 1;
      }
      this.releaseDocument(request.documentId);
      await request.dropAuthoritativeSource();
      return { status: 'cold-clean' };
    } catch (error) {
      return { status: 'failed', completedReleaseSteps, error };
    }
  }

  metrics(): RuntimeRegistryMetrics {
    return {
      entryCount: this.entries.size,
      byteWeight: this.totalWeight(),
      hits: this.hits,
      misses: this.misses,
      refusals: this.refusals,
      evictions: this.evictionCount,
      degraded: [...this.degradedDocuments],
    };
  }

  private totalWeight(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.byteWeight;
    return total;
  }

  private shedToLowWatermark(
    pinnedDocumentId: DocumentId | null,
    reason: RuntimeEviction['reason'],
    force = false,
  ): RuntimeEviction[] {
    if (!force && this.totalWeight() <= this.budgets.highWatermarkBytes) return [];
    const candidates = [...this.entries.entries()]
      .filter(([, entry]) => entry.key.documentId !== pinnedDocumentId)
      .filter(([, entry]) => force || this.now() - entry.suspendedAt >= this.budgets.minimumResidencyMs)
      .sort((left, right) => left[1].suspendedAt - right[1].suspendedAt);
    const evicted: RuntimeEviction[] = [];
    for (const [key, entry] of candidates) {
      if (this.totalWeight() <= this.budgets.lowWatermarkBytes) break;
      this.entries.delete(key);
      evicted.push(toEviction(entry, reason));
    }
    this.evictionCount += evicted.length;
    return evicted;
  }
}

function runtimeKey(key: DocumentRuntimeKey): string {
  return `${key.documentId}\u0000${key.sourceRevision}\u0000${key.surface}\u0000${key.configurationFingerprint}`;
}

function toEviction(entry: SuspendedEditorRuntime, reason: RuntimeEviction['reason']): RuntimeEviction {
  return { documentId: entry.key.documentId, surface: entry.key.surface, reason, byteWeight: entry.byteWeight };
}

export const documentRuntimeRegistry = new DocumentRuntimeRegistry();
