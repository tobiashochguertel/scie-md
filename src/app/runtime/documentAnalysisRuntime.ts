import type { DocumentId, SourceRevision } from '../documentIdentity';
import type { DocumentEffectTarget, EffectToken } from '../effects/documentEffectCoordinator';
import type { SourceSnapshotLease } from '../source/sourceSnapshotService';
import { utf8SourceBytes } from './documentAnalysisPolicy';

export type AnalyzerId = 'markdown-parse' | 'format-parse' | 'markdown-validation' | 'document-metrics' | (string & {});

export interface RuntimeArtifactKey {
  documentId: DocumentId;
  sourceRevision: SourceRevision;
  analyzer: AnalyzerId;
  optionsFingerprint: string;
  dependencyFingerprint: string;
}

export interface SourceSliceRef {
  documentId: DocumentId;
  sourceRevision: SourceRevision;
  from: number;
  to: number;
}

export interface ArtifactProjectionBudget {
  maxArtifactBytes: number;
  maxStringBytes: number;
  maxCollectionEntries: number;
  maxDepth: number;
}

export interface AnalysisRequest<T> {
  key: RuntimeArtifactKey;
  priority: 'active' | 'warm' | 'background';
  transport?: 'main-thread' | 'worker-structured-clone';
  acquireSnapshot: () => SourceSnapshotLease | null;
  run: (sourceText: string, signal: AbortSignal) => Promise<T>;
  project?: (value: T) => T;
  budget?: Partial<ArtifactProjectionBudget>;
  cancel?: () => void;
}

export interface AnalysisArtifactMetrics {
  hits: number;
  misses: number;
  completed: number;
  cancellations: number;
  evictions: number;
  rejections: number;
  requestTransferBytes: number;
  responseRetainedBytes: number;
  activeLeases: number;
  queued: number;
  running: number;
  artifacts: number;
}

interface CacheEntry<T = unknown> {
  key: RuntimeArtifactKey;
  value: T;
  retainedBytes: number;
  lastUsedAt: number;
}

interface PendingJob<T = unknown> {
  sequence: number;
  request: AnalysisRequest<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  controller: AbortController;
  state: 'queued' | 'running' | 'settled';
  lease: SourceSnapshotLease | null;
}

const DEFAULT_BUDGET: ArtifactProjectionBudget = {
  maxArtifactBytes: 8 * 1024 * 1024,
  maxStringBytes: 256 * 1024,
  maxCollectionEntries: 12_000,
  maxDepth: 32,
};
const MAX_ARTIFACTS = 48;
const MAX_RETAINED_BYTES = 48 * 1024 * 1024;
const MAX_QUEUE = 24;
const MAX_CONCURRENCY = 2;

export const WORKER_PAYLOAD_DECISION = {
  strategy: 'one-shot-structured-clone' as const,
  reason: 'Existing parser workers accept one revision snapshot per cache miss. Projected responses remove wholesale source fields; SAB is not justified without cross-origin isolation and measured benefit.',
  requestDeduplication: 'one in-flight transfer per exact artifact key',
  largeInputFallback: 'source editor and viewport highlighting remain on the main thread while deep work is unavailable or background-only',
};

export class DocumentAnalysisRuntime {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, PendingJob<any>>();
  private readonly queue: PendingJob<any>[] = [];
  private sequence = 0;
  private running = 0;
  private retainedBytes = 0;
  private counters = {
    hits: 0,
    misses: 0,
    completed: 0,
    cancellations: 0,
    evictions: 0,
    rejections: 0,
    requestTransferBytes: 0,
    responseRetainedBytes: 0,
    activeLeases: 0,
  };

  request<T>(request: AnalysisRequest<T>): Promise<T> {
    const identity = artifactKeyIdentity(request.key);
    const cached = this.cache.get(identity) as CacheEntry<T> | undefined;
    if (cached) {
      cached.lastUsedAt = Date.now();
      this.counters.hits += 1;
      return Promise.resolve(cached.value);
    }
    const existing = this.pending.get(identity) as PendingJob<T> | undefined;
    if (existing) {
      this.counters.hits += 1;
      return new Promise<T>((resolve, reject) => {
        const originalResolve = existing.resolve;
        const originalReject = existing.reject;
        existing.resolve = (value) => { originalResolve(value); resolve(value); };
        existing.reject = (error) => { originalReject(error); reject(error); };
      });
    }
    this.counters.misses += 1;
    return new Promise<T>((resolve, reject) => {
      while (this.queue.length >= MAX_QUEUE) this.cancelJob(this.queue[this.queue.length - 1], 'Analysis queue limit exceeded.');
      const job: PendingJob<T> = {
        sequence: ++this.sequence,
        request,
        resolve,
        reject,
        controller: new AbortController(),
        state: 'queued',
        lease: null,
      };
      this.pending.set(identity, job);
      this.queue.push(job);
      this.sortQueue();
      this.drain();
    });
  }

  peek<T>(key: RuntimeArtifactKey): T | undefined {
    const entry = this.cache.get(artifactKeyIdentity(key)) as CacheEntry<T> | undefined;
    if (entry) entry.lastUsedAt = Date.now();
    return entry?.value;
  }

  cancelDocument(documentId: DocumentId, exceptRevision?: SourceRevision): number {
    let count = 0;
    for (const job of Array.from(this.pending.values())) {
      if (job.request.key.documentId !== documentId || job.request.key.sourceRevision === exceptRevision) continue;
      this.cancelJob(job, 'Analysis request superseded by another source revision.');
      count += 1;
    }
    for (const [identity, entry] of this.cache) {
      if (entry.key.documentId !== documentId || entry.key.sourceRevision === exceptRevision) continue;
      this.cache.delete(identity);
      this.retainedBytes -= entry.retainedBytes;
      this.counters.evictions += 1;
    }
    return count;
  }

  releaseDocument(documentId: DocumentId): boolean {
    this.cancelDocument(documentId);
    for (const entry of this.pending.values()) if (entry.request.key.documentId === documentId) return false;
    return true;
  }

  metrics(): AnalysisArtifactMetrics {
    return {
      ...this.counters,
      responseRetainedBytes: this.retainedBytes,
      queued: this.queue.length,
      running: this.running,
      artifacts: this.cache.size,
    };
  }

  resetForTests(): void {
    for (const job of Array.from(this.pending.values())) this.cancelJob(job, 'Analysis runtime reset.');
    this.cache.clear();
    this.queue.length = 0;
    this.running = 0;
    this.retainedBytes = 0;
    this.sequence = 0;
    Object.assign(this.counters, {
      hits: 0, misses: 0, completed: 0, cancellations: 0, evictions: 0, rejections: 0,
      requestTransferBytes: 0, responseRetainedBytes: 0, activeLeases: 0,
    });
  }

  private drain(): void {
    while (this.running < MAX_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (!this.pending.has(artifactKeyIdentity(job.request.key))) continue;
      this.start(job);
    }
  }

  private start<T>(job: PendingJob<T>): void {
    job.state = 'running';
    this.running += 1;
    let lease: SourceSnapshotLease | null = null;
    try {
      lease = job.request.acquireSnapshot();
      if (!lease || lease.documentId !== job.request.key.documentId || lease.revision !== job.request.key.sourceRevision) {
        lease?.release();
        throw new Error('Analysis snapshot lease did not match the artifact key.');
      }
      job.lease = lease;
      this.counters.activeLeases += 1;
      if (job.request.transport === 'worker-structured-clone') {
        this.counters.requestTransferBytes += utf8SourceBytes(lease.sourceText);
      }
    } catch (error) {
      this.finishFailure(job, error);
      return;
    }
    void job.request.run(lease.sourceText, job.controller.signal)
      .then((value) => {
        if (job.controller.signal.aborted) throw new Error('Analysis request was cancelled.');
        const projected = job.request.project ? job.request.project(value) : value;
        const retainedBytes = assertProjectedArtifactWithinBudget(projected, job.request.budget);
        const identity = artifactKeyIdentity(job.request.key);
        this.cache.set(identity, { key: job.request.key, value: projected, retainedBytes, lastUsedAt: Date.now() });
        this.retainedBytes += retainedBytes;
        this.counters.completed += 1;
        this.evictToBudget(identity);
        if (this.finish(job)) job.resolve(projected);
      })
      .catch((error) => this.finishFailure(job, error));
  }

  private finishFailure<T>(job: PendingJob<T>, error: unknown): void {
    if (!this.finish(job)) return;
    this.counters.rejections += 1;
    job.reject(error);
  }

  private finish<T>(job: PendingJob<T>): boolean {
    if (job.state === 'settled') return false;
    const wasRunning = job.state === 'running';
    job.state = 'settled';
    const identity = artifactKeyIdentity(job.request.key);
    if (this.pending.get(identity) === job) this.pending.delete(identity);
    const queuedIndex = this.queue.indexOf(job);
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    if (wasRunning) this.running = Math.max(0, this.running - 1);
    if (job.lease) {
      job.lease.release();
      job.lease = null;
      this.counters.activeLeases = Math.max(0, this.counters.activeLeases - 1);
    }
    this.drain();
    return true;
  }

  private cancelJob<T>(job: PendingJob<T>, reason: string): void {
    job.controller.abort(reason);
    job.request.cancel?.();
    this.counters.cancellations += 1;
    if (this.finish(job)) job.reject(new Error(reason));
  }

  private sortQueue(): void {
    const rank = { active: 0, warm: 1, background: 2 } as const;
    this.queue.sort((left, right) => rank[left.request.priority] - rank[right.request.priority] || left.sequence - right.sequence);
  }

  private evictToBudget(protectedIdentity: string): void {
    const candidates = () => Array.from(this.cache.entries())
      .filter(([identity]) => identity !== protectedIdentity)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
    while (this.cache.size > MAX_ARTIFACTS || this.retainedBytes > MAX_RETAINED_BYTES) {
      const candidate = candidates()[0];
      if (!candidate) break;
      this.cache.delete(candidate[0]);
      this.retainedBytes -= candidate[1].retainedBytes;
      this.counters.evictions += 1;
    }
  }
}

export const documentAnalysisRuntime = new DocumentAnalysisRuntime();

export function artifactKeyIdentity(key: RuntimeArtifactKey): string {
  return [key.documentId, key.sourceRevision, key.analyzer, key.optionsFingerprint, key.dependencyFingerprint].join('\u0000');
}

export function canonicalFingerprint(value: unknown): string {
  const canonical = canonicalize(value);
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:v1:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function analysisSourceFingerprint(target: DocumentEffectTarget, sourceText: string): string {
  return target.sourceRevision === undefined
    ? canonicalFingerprint(sourceText)
    : `source-revision:v1:${target.sourceRevision}`;
}

export function createSourceSliceBroker() {
  return {
    read(ref: SourceSliceRef, acquireSnapshot: () => SourceSnapshotLease | null, maxBytes = 64 * 1024): string {
      if (!Number.isSafeInteger(ref.from) || !Number.isSafeInteger(ref.to) || ref.from < 0 || ref.to < ref.from) {
        throw new RangeError('Source slice range is invalid.');
      }
      const lease = acquireSnapshot();
      if (!lease || lease.documentId !== ref.documentId || lease.revision !== ref.sourceRevision) {
        lease?.release();
        throw new Error('Source slice revision is stale.');
      }
      try {
        if (ref.to > lease.sourceText.length) throw new RangeError('Source slice range exceeds the revision snapshot.');
        const slice = lease.sourceText.slice(ref.from, ref.to);
        if (new TextEncoder().encode(slice).length > maxBytes) throw new RangeError('Source slice exceeds the excerpt byte budget.');
        return slice;
      } finally {
        lease.release();
      }
    },
  };
}

export const sourceSliceBroker = createSourceSliceBroker();

export function acquireAnalysisSnapshot(
  target: DocumentEffectTarget,
  token: EffectToken,
  fallbackSourceText: string,
): SourceSnapshotLease | null {
  if (fallbackSourceText.length === 0 && (target.sourceByteLength ?? 0) > 0) {
    return {
      documentId: target.documentId,
      revision: token.sourceRevision,
      sourceText: '',
      release: () => undefined,
    } satisfies SourceSnapshotLease;
  }
  if (target.leaseSource) return target.leaseSource(token.sourceRevision);
  return {
    documentId: target.documentId,
    revision: token.sourceRevision,
    sourceText: fallbackSourceText,
    release: () => undefined,
  } satisfies SourceSnapshotLease;
}

export function assertProjectedArtifactWithinBudget(value: unknown, override: Partial<ArtifactProjectionBudget> = {}): number {
  const budget = { ...DEFAULT_BUDGET, ...override };
  const seen = new WeakSet<object>();
  let bytes = 0;
  let entries = 0;
  const visit = (current: unknown, depth: number) => {
    if (depth > budget.maxDepth) throw new Error('Projected artifact exceeds the recursive depth budget.');
    if (typeof current === 'string') {
      const stringBytes = new TextEncoder().encode(current).length;
      if (stringBytes > budget.maxStringBytes) throw new Error('Projected artifact retains an oversized string.');
      bytes += stringBytes;
      return;
    }
    if (current === null || current === undefined || typeof current === 'boolean') { bytes += 4; return; }
    if (typeof current === 'number' || typeof current === 'bigint') { bytes += 8; return; }
    if (typeof current !== 'object') return;
    if (seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      entries += current.length;
      for (const item of current) visit(item, depth + 1);
    } else {
      const pairs = Object.entries(current);
      entries += pairs.length;
      for (const [key, item] of pairs) { bytes += key.length * 2; visit(item, depth + 1); }
    }
    if (entries > budget.maxCollectionEntries) throw new Error('Projected artifact exceeds the collection-entry budget.');
    if (bytes > budget.maxArtifactBytes) throw new Error('Projected artifact exceeds the retained-byte budget.');
  };
  visit(value, 0);
  return bytes;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
}
