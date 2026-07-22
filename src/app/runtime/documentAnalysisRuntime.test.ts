import { describe, expect, it, vi } from 'vitest';
import { createDocumentId, sourceRevision } from '../documentIdentity';
import type { SourceSnapshotLease } from '../source/sourceSnapshotService';
import {
  assertProjectedArtifactWithinBudget,
  canonicalFingerprint,
  createSourceSliceBroker,
  DocumentAnalysisRuntime,
  WORKER_PAYLOAD_DECISION,
} from './documentAnalysisRuntime';
import { documentAnalysisPolicy, utf8SourceBytes } from './documentAnalysisPolicy';
import { projectFormatParseResult, projectParsedScienfyDocument } from './analysisArtifactProjection';
import { safeParseScienfyDocument, adapterForFormat } from '@sciemd/core';

describe('DocumentAnalysisRuntime', () => {
  it('uses canonical semantic fingerprints rather than object insertion order', () => {
    expect(canonicalFingerprint({ beta: 2, alpha: { z: 1, a: 0 } }))
      .toBe(canonicalFingerprint({ alpha: { a: 0, z: 1 }, beta: 2 }));
    expect(canonicalFingerprint({ source: 'a' })).not.toBe(canonicalFingerprint({ source: 'b' }));
  });

  it('deduplicates one exact revision transfer, caches the projected result, and releases every lease', async () => {
    const runtime = new DocumentAnalysisRuntime();
    const documentId = createDocumentId();
    const revision = sourceRevision(3);
    const release = vi.fn();
    const run = vi.fn(async (source: string) => ({ title: source, sourceEcho: '' }));
    const request = {
      key: { documentId, sourceRevision: revision, analyzer: 'test', optionsFingerprint: 'o', dependencyFingerprint: 'd' },
      priority: 'active' as const,
      transport: 'worker-structured-clone' as const,
      acquireSnapshot: () => lease(documentId, revision, 'hello', release),
      run,
    };

    const [first, second] = await Promise.all([runtime.request(request), runtime.request(request)]);
    const third = await runtime.request(request);

    expect(first).toEqual(second);
    expect(third).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(runtime.metrics()).toMatchObject({ hits: 2, misses: 1, artifacts: 1, activeLeases: 0, requestTransferBytes: 5 });
  });

  it('cancels superseded revisions, invokes worker cancellation, and returns leases to zero', async () => {
    const runtime = new DocumentAnalysisRuntime();
    const documentId = createDocumentId();
    const revision = sourceRevision(1);
    const release = vi.fn();
    const cancel = vi.fn();
    const pending = deferred<string>();
    const promise = runtime.request({
      key: { documentId, sourceRevision: revision, analyzer: 'test', optionsFingerprint: 'o', dependencyFingerprint: 'd' },
      priority: 'active',
      acquireSnapshot: () => lease(documentId, revision, 'source', release),
      run: () => pending.promise,
      cancel,
    });

    expect(runtime.cancelDocument(documentId, sourceRevision(2))).toBe(1);
    await expect(promise).rejects.toThrow(/superseded/);
    pending.resolve('late');
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(runtime.metrics()).toMatchObject({ activeLeases: 0, running: 0, cancellations: 1, artifacts: 0 });
  });

  it('prioritizes active work ahead of queued background work without starving FIFO peers', async () => {
    const runtime = new DocumentAnalysisRuntime();
    const starts: string[] = [];
    const gates = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()];
    const make = (name: string, priority: 'active' | 'background', index: number) => {
      const documentId = createDocumentId();
      const revision = sourceRevision(0);
      return runtime.request({
        key: { documentId, sourceRevision: revision, analyzer: 'test', optionsFingerprint: name, dependencyFingerprint: '' },
        priority,
        acquireSnapshot: () => lease(documentId, revision, name),
        run: () => { starts.push(name); return gates[index].promise; },
      });
    };
    const first = make('running-1', 'background', 0);
    const second = make('running-2', 'background', 1);
    const background = make('queued-background', 'background', 2);
    const active = make('queued-active', 'active', 3);

    gates[0].resolve('one');
    await first;
    await Promise.resolve();
    expect(starts).toEqual(['running-1', 'running-2', 'queued-active']);

    gates[3].resolve('active');
    await active;
    gates[1].resolve('two');
    gates[2].resolve('background');
    await Promise.all([second, background]);
  });
});

describe('analysis projection, slices, and policy', () => {
  it('removes wholesale source fields from parser artifacts and enforces recursive budgets', () => {
    const markdown = `---\ntitle: Test\n---\n${'body '.repeat(1000)}`;
    const projected = projectParsedScienfyDocument(safeParseScienfyDocument(markdown));
    expect(projected.frontmatter.body).toBe('');
    expect(projected.frontmatter.sourcePrefix).toBe('');

    const json = adapterForFormat('json')!.parse(adapterForFormat('json')!.createContent('{"value":1}', null));
    expect(projectFormatParseResult(json).content.text).toBe('');
    expect(() => assertProjectedArtifactWithinBudget({ nested: ['x'.repeat(1024)] }, { maxStringBytes: 64 })).toThrow(/oversized string/);
    expect(WORKER_PAYLOAD_DECISION.strategy).toBe('one-shot-structured-clone');
  });

  it('fails source slices closed on stale revision, range, and byte-budget violations', () => {
    const broker = createSourceSliceBroker();
    const documentId = createDocumentId();
    const revision = sourceRevision(4);
    const release = vi.fn();
    const acquire = () => lease(documentId, revision, 'abcdef', release);

    expect(broker.read({ documentId, sourceRevision: revision, from: 1, to: 4 }, acquire)).toBe('bcd');
    expect(() => broker.read({ documentId, sourceRevision: sourceRevision(3), from: 0, to: 1 }, acquire)).toThrow(/stale/);
    expect(() => broker.read({ documentId, sourceRevision: revision, from: 0, to: 20 }, acquire)).toThrow(/exceeds/);
    expect(() => broker.read({ documentId, sourceRevision: revision, from: 0, to: 6 }, acquire, 2)).toThrow(/byte budget/);
    expect(release).toHaveBeenCalledTimes(4);
  });

  it('uses UTF-8 bytes explicitly and preserves viewport highlighting when deep work is unavailable', () => {
    const source = 'μ'.repeat(600_000);
    expect(utf8SourceBytes(source)).toBe(source.length * 2);
    expect(documentAnalysisPolicy('json', 'format-parse', source).mode).toBe('unavailable');
    expect(documentAnalysisPolicy('json', 'source-highlighting', source).mode).toBe('viewport');
  });
});

function lease(
  documentId: ReturnType<typeof createDocumentId>,
  revision: ReturnType<typeof sourceRevision>,
  sourceText: string,
  release: () => void = () => undefined,
): SourceSnapshotLease {
  return { documentId, revision, sourceText, release };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => { resolve = innerResolve; reject = innerReject; });
  return { promise, resolve, reject };
}
