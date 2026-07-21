import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FormatParseResult } from '@sciemd/core';
import { createDocumentId, sourceRevision } from '../../app/documentIdentity';
import type { EffectOperationId, EffectToken } from '../../app/effects/documentEffectCoordinator';

describe('formatParserWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('parses through the async API when a Worker implementation is not available', async () => {
    vi.stubGlobal('Worker', undefined);
    const { parseFormatDocumentAsync } = await import('./formatParserWorker');
    const parsed = await parseFormatDocumentAsync('json', '{"ok":true}', 'C:\\Lab\\result.json');

    expect(parsed.format).toBe('json');
    expect(parsed.content.path).toBe('C:\\Lab\\result.json');
    expect((parsed.parsed as { value?: unknown } | null)?.value).toEqual({ ok: true });
  });

  it('posts format, text, path, and options to the worker', async () => {
    const workers: ResponsiveWorker[] = [];
    vi.stubGlobal('Worker', class extends ResponsiveWorker {
      constructor(...args: unknown[]) {
        super(...args);
        workers.push(this);
      }
    });
    const { parseFormatDocumentAsync } = await import('./formatParserWorker');

    const parsed = await parseFormatDocumentAsync('json', '{"worker":true}', 'C:\\Lab\\worker.json', { mode: 'test' });

    expect(workers).toHaveLength(1);
    expect(workers[0].messages[0]).toMatchObject({
      id: 1,
      format: 'json',
      text: '{"worker":true}',
      path: 'C:\\Lab\\worker.json',
      options: { mode: 'test' },
    });
    expect(parsed).toMatchObject({
      format: 'json',
      content: {
        format: 'json',
        text: '{"worker":true}',
        path: 'C:\\Lab\\worker.json',
      },
      sourceOnly: false,
    });
  });

  it('terminates a stuck worker and rejects pending parses instead of leaking them', async () => {
    vi.useFakeTimers();
    const workers: HangingWorker[] = [];
    vi.stubGlobal('Worker', class extends HangingWorker {
      constructor(...args: unknown[]) {
        super(...args);
        workers.push(this);
      }
    });
    const { FORMAT_PARSER_WORKER_TIMEOUT_MS, parseFormatDocumentAsync } = await import('./formatParserWorker');

    const parsePromise = parseFormatDocumentAsync('json', '{"hang":true}');
    const rejection = expect(parsePromise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(FORMAT_PARSER_WORKER_TIMEOUT_MS);

    await rejection;
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(true);
  });

  it('retries unrelated pending parses on a fresh worker after one request times out', async () => {
    vi.useFakeTimers();
    const workers: Array<HangingWorker | ResponsiveWorker> = [];
    function WorkerStub(...args: unknown[]) {
      const instance = workers.length === 0
        ? new HangingWorker(...args)
        : new ResponsiveWorker(...args);
      workers.push(instance);
      return instance;
    }
    vi.stubGlobal('Worker', WorkerStub);
    const { FORMAT_PARSER_WORKER_TIMEOUT_MS, parseFormatDocumentAsync } = await import('./formatParserWorker');

    const stuck = parseFormatDocumentAsync('json', '{"hang":true}', 'C:\\Lab\\stuck.json');
    const stillUseful = parseFormatDocumentAsync('json', '{"ok":true}', 'C:\\Lab\\ok.json');
    const rejection = expect(stuck).rejects.toThrow(/timed out/);

    await vi.advanceTimersByTimeAsync(FORMAT_PARSER_WORKER_TIMEOUT_MS);

    await rejection;
    await expect(stillUseful).resolves.toMatchObject({
      content: {
        text: '{"ok":true}',
        path: 'C:\\Lab\\ok.json',
      },
    });
    expect(workers).toHaveLength(2);
    expect((workers[0] as HangingWorker).terminated).toBe(true);
    expect((workers[1] as ResponsiveWorker).messages[0]).toMatchObject({
      text: '{"ok":true}',
      path: 'C:\\Lab\\ok.json',
    });
  });

  it('rejects superseded same-document parses without cancelling the newer request', async () => {
    const workers: ResponsiveWorker[] = [];
    vi.stubGlobal('Worker', class extends ResponsiveWorker {
      constructor(...args: unknown[]) {
        super(...args);
        workers.push(this);
      }
    });
    const { parseFormatDocumentAsync } = await import('./formatParserWorker');

    const stale = parseFormatDocumentAsync('json', '{"version":1}', 'C:\\Lab\\same.json');
    const fresh = parseFormatDocumentAsync('json', '{"version":2}', 'C:\\Lab\\same.json');

    await expect(stale).rejects.toThrow(/superseded/);
    await expect(fresh).resolves.toMatchObject({
      content: {
        text: '{"version":2}',
        path: 'C:\\Lab\\same.json',
      },
    });
    expect(workers[0].messages).toHaveLength(2);
  });

  it('rejects the oldest pending parse when the queue limit is exceeded', async () => {
    const workers: HangingWorker[] = [];
    vi.stubGlobal('Worker', class extends HangingWorker {
      constructor(...args: unknown[]) {
        super(...args);
        workers.push(this);
      }
    });
    const { FORMAT_PARSER_WORKER_MAX_PENDING, parseFormatDocumentAsync } = await import('./formatParserWorker');

    const parses = Array.from({ length: FORMAT_PARSER_WORKER_MAX_PENDING + 1 }, (_, index) => (
      parseFormatDocumentAsync('json', `{"index":${index}}`)
    ));

    await expect(parses[0]).rejects.toThrow(/queue limit/);
    expect(workers).toHaveLength(1);
    expect(workers[0].messages).toHaveLength(FORMAT_PARSER_WORKER_MAX_PENDING + 1);
  });

  it('targets untitled cancellation by document operation instead of the null path', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', HangingWorker);
    const { cancelFormatDocumentParse, FORMAT_PARSER_WORKER_TIMEOUT_MS, parseFormatDocumentAsync } = await import('./formatParserWorker');
    const firstToken = effectToken('source-format-diagnostics:untitled-a');
    const secondToken = effectToken('source-format-diagnostics:untitled-b');

    const first = parseFormatDocumentAsync('json', '{"a":1}', null, {}, firstToken);
    const second = parseFormatDocumentAsync('json', '{"b":2}', null, {}, secondToken);
    const firstRejection = expect(first).rejects.toThrow(/targeted cancellation/);

    expect(cancelFormatDocumentParse(firstToken)).toBe(true);
    await firstRejection;
    let secondSettled = false;
    void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    const secondRejection = expect(second).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(FORMAT_PARSER_WORKER_TIMEOUT_MS);
    await secondRejection;
  });
});

function effectToken(operationId: string): EffectToken {
  return {
    documentId: createDocumentId(),
    operationId: operationId as EffectOperationId,
    sourceRevision: sourceRevision(0),
  };
}

class ResponsiveWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: Array<{ id: number; format: string; text: string; path: string | null; options?: unknown }> = [];

  constructor(..._args: unknown[]) {
    // The worker URL and options are intentionally ignored by this test double.
  }

  postMessage(message: { id: number; format: string; text: string; path: string | null; options?: unknown }): void {
    this.messages.push(message);
    queueMicrotask(() => {
      this.onmessage?.({
        data: {
          id: message.id,
          parseResult: createWorkerParseResult(message),
        },
      } as MessageEvent);
    });
  }

  terminate(): void {
    // Responsive workers are not terminated in these tests.
  }
}

class HangingWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: unknown[] = [];
  terminated = false;

  constructor(..._args: unknown[]) {
    // The worker URL and options are intentionally ignored by this test double.
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function createWorkerParseResult(message: { format: string; text: string; path: string | null }): FormatParseResult {
  return {
    format: message.format as never,
    content: {
      format: message.format as never,
      text: message.text,
      path: message.path,
    },
    parsed: null,
    diagnostics: [],
    sourceOnly: false,
  };
}
