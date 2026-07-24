import type { DocumentId } from '../documentIdentity';

export type OpenOperationId = string & { readonly __brand: 'OpenOperationId' };

export type DocumentPerformanceEventName =
  | 'open-start'
  | 'locator-resolved'
  | 'native-read'
  | 'ipc-read'
  | 'recovery-draft'
  | 'aggregate-commit'
  | 'operation-associated'
  | 'open-cancelled'
  | 'open-failed'
  | 'activation-start'
  | 'gateway-flush'
  | 'active-projection'
  | 'editor-attach'
  | 'next-frame'
  | 'visual-interaction-ready'
  | 'input-accepted'
  | 'input-echoed'
  | 'background-ready'
  | 'byte-acquisition'
  | 'source-change'
  | 'whole-source-materialization'
  | 'analysis-state'
  | 'long-task'
  | 'memory-sample'
  | 'runtime-suspend'
  | 'runtime-attach'
  | 'runtime-eviction'
  | 'runtime-admission-refused'
  | 'runtime-degraded'
  | 'cold-transition';

export type MainDocumentByteAcquisitionReason =
  | 'open'
  | 'coldCleanRehydrate'
  | 'externalVerification'
  | 'watcherHash'
  | 'recovery'
  | 'other';

export interface DocumentPerformanceEvent {
  sequence: number;
  name: DocumentPerformanceEventName;
  monotonicMs: number;
  operationId?: OpenOperationId;
  documentId?: DocumentId;
  durationMs?: number;
  byteCount?: number;
  changeBytes?: number;
  materializedBytes?: number;
  fullDocumentTransactions?: number;
  acquisitionReason?: MainDocumentByteAcquisitionReason;
  surface?: 'source' | 'visual' | 'structured';
  state?: 'clean' | 'dirty' | 'unknown';
  cache?: 'hit' | 'miss' | 'pending' | 'not-applicable';
  displayClass?: string;
  phase?: string;
  queueDepth?: number;
  lineCount?: number;
  heapBytes?: number;
  workingSetBytes?: number;
}

export interface DocumentPerformanceReport {
  schemaVersion: 1;
  generatedAt: string;
  retentionLimit: number;
  droppedEvents: number;
  events: readonly DocumentPerformanceEvent[];
  summary: {
    openOperations: number;
    activations: number;
    mainDocumentByteAcquisitions: number;
    acquiredBytes: number;
    wholeSourceMaterializations: number;
    materializedBytes: number;
    fullDocumentTransactions: number;
  };
}

export interface DocumentPerformanceClock {
  now(): number;
}

const DEFAULT_RETENTION_LIMIT = 512;

export class DocumentPerformanceCollector {
  private readonly events: DocumentPerformanceEvent[] = [];
  private sequence = 0;
  private operationSequence = 0;
  private droppedEvents = 0;

  constructor(
    private readonly retentionLimit = DEFAULT_RETENTION_LIMIT,
    private readonly clock: DocumentPerformanceClock = { now: monotonicNow },
  ) {
    if (!Number.isInteger(retentionLimit) || retentionLimit < 16) {
      throw new Error('Document performance retention must be an integer of at least 16 events.');
    }
  }

  beginOpen(displayClass: string): OpenOperationId {
    const operationId = `open-${++this.operationSequence}` as OpenOperationId;
    this.record({ name: 'open-start', operationId, displayClass: sanitizeDisplayClass(displayClass) });
    return operationId;
  }

  beginOpenSafe(displayClass: string): OpenOperationId {
    const operationId = `open-${++this.operationSequence}` as OpenOperationId;
    this.trace({ name: 'open-start', operationId, displayClass });
    return operationId;
  }

  record(event: Omit<DocumentPerformanceEvent, 'sequence' | 'monotonicMs'>): DocumentPerformanceEvent {
    const safe = validateContentFreeEvent(event);
    const recorded: DocumentPerformanceEvent = {
      ...safe,
      sequence: ++this.sequence,
      monotonicMs: this.clock.now(),
    };
    this.events.push(recorded);
    if (this.events.length > this.retentionLimit) {
      const overflow = this.events.length - this.retentionLimit;
      this.events.splice(0, overflow);
      this.droppedEvents += overflow;
    }
    return recorded;
  }

  trace(event: Omit<DocumentPerformanceEvent, 'sequence' | 'monotonicMs'>): DocumentPerformanceEvent | null {
    try {
      return this.record(event);
    } catch {
      return null;
    }
  }

  associate(operationId: OpenOperationId, documentId: DocumentId): void {
    this.trace({ name: 'operation-associated', operationId, documentId });
  }

  clear(): void {
    this.events.length = 0;
    this.droppedEvents = 0;
  }

  report(): DocumentPerformanceReport {
    const events = this.events.map((event) => ({ ...event }));
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      retentionLimit: this.retentionLimit,
      droppedEvents: this.droppedEvents,
      events,
      summary: {
        openOperations: new Set(events.flatMap((event) => event.operationId ? [event.operationId] : [])).size,
        activations: events.filter((event) => event.name === 'activation-start').length,
        mainDocumentByteAcquisitions: events.filter((event) => event.name === 'byte-acquisition').length,
        acquiredBytes: sum(events, 'byteCount'),
        wholeSourceMaterializations: events.filter((event) => event.name === 'whole-source-materialization').length,
        materializedBytes: sum(events, 'materializedBytes'),
        fullDocumentTransactions: sum(events, 'fullDocumentTransactions'),
      },
    };
  }
}

export const documentPerformance = new DocumentPerformanceCollector();

export function documentPerformanceReportText(): string {
  return JSON.stringify({
    ...documentPerformance.report(),
    analysisRuntime: documentAnalysisRuntime.metrics(),
    workerPayloadDecision: WORKER_PAYLOAD_DECISION,
  }, null, 2);
}

export function sourceDisplayClass(path: string | null | undefined, byteCount?: number | null): string {
  const extension = path?.match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase() ?? 'untitled';
  const size = byteCount == null
    ? 'unknown'
    : byteCount < 1024 * 1024
      ? 'under-1mib'
      : byteCount < 5 * 1024 * 1024
        ? '1-5mib'
        : byteCount < 10 * 1024 * 1024
          ? '5-10mib'
          : byteCount < 24 * 1024 * 1024
            ? '10-24mib'
            : '24mib-plus';
  return `${extension}:${size}`;
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) bytes += 1;
    else if (codeUnit < 0x800) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function sanitizeDisplayClass(value: string): string {
  const safe = value.trim().toLowerCase();
  if (!/^[a-z0-9_-]+:(unknown|under-1mib|1-5mib|5-10mib|10-24mib|24mib-plus)$/.test(safe)) {
    throw new Error('Document performance display classes must be redacted extension:size buckets.');
  }
  return safe;
}

function validateContentFreeEvent<T extends Omit<DocumentPerformanceEvent, 'sequence' | 'monotonicMs'>>(event: T): T {
  const keys = Object.keys(event);
  if (keys.some((key) => /source|content|text|path|filename/i.test(key))) {
    throw new Error('Document performance events cannot contain source text or path fields.');
  }
  if (event.displayClass) sanitizeDisplayClass(event.displayClass);
  for (const value of Object.values(event)) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
      throw new Error('Document performance numeric evidence must be finite and non-negative.');
    }
  }
  return event;
}

function sum(events: readonly DocumentPerformanceEvent[], key: 'byteCount' | 'materializedBytes' | 'fullDocumentTransactions'): number {
  return events.reduce((total, event) => total + (event[key] ?? 0), 0);
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

declare global {
  interface Window {
    __SCIEMD_DOCUMENT_PERFORMANCE__?: {
      report: () => DocumentPerformanceReport;
      analysis: () => {
        metrics: ReturnType<typeof documentAnalysisRuntime.metrics>;
        workerPayloadDecision: typeof WORKER_PAYLOAD_DECISION;
      };
      clear: () => void;
    };
  }
}

if (typeof window !== 'undefined') {
  window.__SCIEMD_DOCUMENT_PERFORMANCE__ = {
    report: () => documentPerformance.report(),
    analysis: () => ({ metrics: documentAnalysisRuntime.metrics(), workerPayloadDecision: WORKER_PAYLOAD_DECISION }),
    clear: () => documentPerformance.clear(),
  };
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) documentPerformance.trace({
          name: 'long-task',
          durationMs: entry.duration,
          phase: 'renderer-main-thread',
        });
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch {
      // Long-task observation is optional; instrumentation must never block startup.
    }
  }
}
import { documentAnalysisRuntime, WORKER_PAYLOAD_DECISION } from '../runtime/documentAnalysisRuntime';
