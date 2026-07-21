import { safeParseScienfyDocument } from '@sciemd/core';
import type { ParsedScienfyDocument, ParseScienfyDocumentOptions } from '@sciemd/core';
import { SOURCE_ONLY_FILE_BYTES } from '../../markdown/supportedMarkdown';
import type { EffectToken } from '../../app/effects/documentEffectCoordinator';

interface ParseWorkerResponse {
  id: number;
  document?: ParsedScienfyDocument;
  error?: string;
}

interface PendingParse {
  resolve: (document: ParsedScienfyDocument) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  markdown: string;
  options: ParseScienfyDocumentOptions;
  worker: Worker;
  effectToken?: EffectToken;
}

let parserWorker: Worker | null = null;
let nextRequestId = 1;
const pendingParses = new Map<number, PendingParse>();

export const PARSER_WORKER_TIMEOUT_MS = 8000;
export const PARSER_WORKER_MAX_PENDING = 8;
const TRANSIENT_WORKER_FAILURE_PATTERN = /timed out|superseded|queue limit|worker failed|empty response/i;

export function parseScienfyDocumentAsync(
  markdown: string,
  options: ParseScienfyDocumentOptions = {},
  effectToken?: EffectToken,
): Promise<ParsedScienfyDocument> {
  if (markdown.length > SOURCE_ONLY_FILE_BYTES && pendingParses.size > 0) {
    const superseded = new Error('Document parser worker parse was superseded by a newer large-document request.');
    if (effectToken) rejectPendingParsesForDocument(effectToken.documentId, superseded);
    else rejectPendingParses(superseded);
  }
  const worker = getParserWorker();
  if (!worker) return Promise.resolve().then(() => safeParseScienfyDocument(markdown, options));

  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    trimPendingParseQueue();
    const timeout = setTimeout(() => {
      if (!pendingParses.has(id)) return;
      handleParseTimeout(id);
    }, PARSER_WORKER_TIMEOUT_MS);
    pendingParses.set(id, { resolve, reject, timeout, markdown, options, worker, effectToken });
    try {
      worker.postMessage({ id, markdown, options });
    } catch (error) {
      clearPendingParse(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function cancelScienfyDocumentParse(token: EffectToken): boolean {
  for (const [id, pending] of pendingParses) {
    if (pending.effectToken?.operationId !== token.operationId) continue;
    clearPendingParse(id);
    pending.reject(new Error('Document parser worker parse was superseded by targeted cancellation.'));
    return true;
  }
  return false;
}

export function isTransientParserWorkerFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_WORKER_FAILURE_PATTERN.test(message);
}

function getParserWorker(): Worker | null {
  if (parserWorker) return parserWorker;
  if (typeof Worker === 'undefined') return null;
  try {
    const worker = new Worker(new URL('./documentParser.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = handleWorkerMessage;
    worker.onerror = (event) => {
      const message = event.message || 'Document parser worker failed.';
      rejectPendingParses(new Error(message));
    };
    parserWorker = worker;
    return parserWorker;
  } catch {
    parserWorker = null;
    return null;
  }
}

function handleWorkerMessage(event: MessageEvent<ParseWorkerResponse>): void {
  const { id, document, error } = event.data;
  const pending = pendingParses.get(id);
  if (!pending) return;
  clearPendingParse(id);
  if (error) {
    pending.reject(new Error(error));
    return;
  }
  if (!document) {
    pending.reject(new Error('Document parser worker returned an empty response.'));
    return;
  }
  pending.resolve(document);
}

function trimPendingParseQueue(): void {
  while (pendingParses.size >= PARSER_WORKER_MAX_PENDING) {
    const oldestId = pendingParses.keys().next().value as number | undefined;
    if (oldestId === undefined) return;
    const pending = pendingParses.get(oldestId);
    clearPendingParse(oldestId);
    pending?.reject(new Error('Document parser worker queue limit exceeded.'));
  }
}

function clearPendingParse(id: number): void {
  const pending = pendingParses.get(id);
  if (pending) clearTimeout(pending.timeout);
  pendingParses.delete(id);
}

function handleParseTimeout(id: number): void {
  const timedOut = pendingParses.get(id);
  if (!timedOut) return;
  const failedWorker = timedOut.worker;
  clearPendingParse(id);
  timedOut.reject(new Error(`Document parser worker timed out after ${PARSER_WORKER_TIMEOUT_MS} ms.`));
  if (parserWorker === failedWorker) {
    failedWorker.terminate();
    parserWorker = null;
  }
  const unrelated = Array.from(pendingParses.entries()).filter(([, pending]) => pending.worker === failedWorker);
  for (const [pendingId, pending] of unrelated) {
    clearPendingParse(pendingId);
    Promise.resolve()
      .then(() => safeParseScienfyDocument(pending.markdown, pending.options))
      .then(pending.resolve, pending.reject);
  }
}

function rejectPendingParsesForDocument(documentId: EffectToken['documentId'] | undefined, error: Error): void {
  if (!documentId) return;
  for (const [id, pending] of pendingParses) {
    if (pending.effectToken?.documentId !== documentId) continue;
    clearPendingParse(id);
    pending.reject(error);
  }
}

function rejectPendingParses(error: Error): void {
  for (const pending of pendingParses.values()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
  pendingParses.clear();
  parserWorker?.terminate();
  parserWorker = null;
}
