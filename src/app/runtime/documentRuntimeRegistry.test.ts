import { describe, expect, it, vi } from 'vitest';
import { createDocumentId, sourceRevision } from '../documentIdentity';
import { DocumentRuntimeRegistry } from './documentRuntimeRegistry';

const MiB = 1024 * 1024;

describe('DocumentRuntimeRegistry', () => {
  it('reattaches only an exact document/revision/surface/configuration state', () => {
    const registry = registryWithBudget();
    const documentId = createDocumentId();
    const state = { history: ['edit'], selection: 12 };
    expect(registry.suspend(entry(documentId, 3, 'markdown:v1', state)).status).toBe('admitted');
    expect(registry.attach(key(documentId, 3, 'markdown:v1'))?.state).toBe(state);
    expect(registry.metrics()).toMatchObject({ hits: 1, misses: 0, entryCount: 0 });

    registry.suspend(entry(documentId, 4, 'markdown:v1', state));
    expect(registry.attach(key(documentId, 5, 'markdown:v1'))).toBeNull();
    expect(registry.metrics()).toMatchObject({ hits: 1, misses: 1, entryCount: 0, evictions: 1 });
  });

  it('uses high/low watermarks, minimum residency, and deterministic LRU shedding', () => {
    let now = 0;
    const registry = new DocumentRuntimeRegistry({
      lowWatermarkBytes: 8 * MiB,
      highWatermarkBytes: 12 * MiB,
      hardCeilingBytes: 24 * MiB,
      reservedActiveHeadroomBytes: 4 * MiB,
      minimumResidencyMs: 100,
    }, () => now);
    const first = createDocumentId();
    const second = createDocumentId();
    const third = createDocumentId();
    registry.suspend(entry(first, 1, 'plain', {}, 6 * MiB));
    now = 101;
    registry.suspend(entry(second, 1, 'plain', {}, 6 * MiB));
    now = 202;
    const result = registry.suspend(entry(third, 1, 'plain', {}, 6 * MiB));
    expect(result).toMatchObject({ status: 'admitted', evicted: [{ documentId: first, reason: 'high-watermark' }, { documentId: second, reason: 'high-watermark' }] });
    expect(registry.has(third, 'source')).toBe(true);
    expect(registry.metrics().byteWeight).toBe(6 * MiB);
  });

  it('refuses admission that consumes reserved headroom and marks unsafe active growth degraded', () => {
    const registry = registryWithBudget();
    const documentId = createDocumentId();
    expect(registry.suspend(entry(documentId, 1, 'plain', {}, 21 * MiB))).toMatchObject({ status: 'refused', reason: 'reserved-headroom' });
    expect(registry.canGrowActiveSource(documentId, 21 * MiB)).toMatchObject({ status: 'refused', reason: 'reserved-headroom' });
    expect(registry.metrics()).toMatchObject({ refusals: 2, degraded: [documentId] });
  });

  it('evicts inactive cached runtimes before refusing an active source edit', () => {
    const registry = registryWithBudget();
    const active = createDocumentId();
    const inactive = createDocumentId();
    expect(registry.suspend(entry(inactive, 1, 'plain', {}, 11 * MiB))).toMatchObject({ status: 'admitted' });

    const admission = registry.canGrowActiveSource(active, 10 * MiB);

    expect(admission).toMatchObject({
      status: 'admitted',
      evicted: [{ documentId: inactive, surface: 'source', reason: 'memory-pressure' }],
    });
    expect(registry.metrics()).toMatchObject({
      entryCount: 0,
      refusals: 0,
      degraded: [],
    });
  });

  it('never drops source unless every cold-clean release barrier succeeds', async () => {
    const registry = registryWithBudget();
    const documentId = createDocumentId();
    const dropped = vi.fn();
    expect(await registry.transitionToColdClean({
      documentId, clean: false, pathBacked: true, saving: false, conflicted: false, recoveryOnly: false,
      release: [], dropAuthoritativeSource: dropped,
    })).toEqual({ status: 'ineligible', reason: 'dirty' });
    expect(dropped).not.toHaveBeenCalled();

    const failure = new Error('lease still active');
    expect(await registry.transitionToColdClean({
      documentId, clean: true, pathBacked: true, saving: false, conflicted: false, recoveryOnly: false,
      release: [vi.fn(), vi.fn(() => { throw failure; }), vi.fn()], dropAuthoritativeSource: dropped,
    })).toEqual({ status: 'failed', completedReleaseSteps: 1, error: failure });
    expect(dropped).not.toHaveBeenCalled();

    expect(await registry.transitionToColdClean({
      documentId, clean: true, pathBacked: true, saving: false, conflicted: false, recoveryOnly: false,
      release: [vi.fn(), vi.fn()], dropAuthoritativeSource: dropped,
    })).toEqual({ status: 'cold-clean' });
    expect(dropped).toHaveBeenCalledOnce();
  });

  it('releases every surface and degraded marker on close', () => {
    const registry = registryWithBudget();
    const documentId = createDocumentId();
    registry.suspend(entry(documentId, 1, 'source', {}));
    registry.suspend({ ...entry(documentId, 1, 'visual', {}), key: { ...key(documentId, 1, 'visual'), surface: 'visual' }, kind: 'bounded-rebuild' });
    registry.markDegraded(documentId);
    expect(registry.releaseDocument(documentId)).toHaveLength(2);
    expect(registry.metrics()).toMatchObject({ entryCount: 0, degraded: [] });
  });

  it('reports exact visual state as warm but never mislabels a bounded rebuild', () => {
    const registry = registryWithBudget();
    const exactDocument = createDocumentId();
    const rebuildDocument = createDocumentId();
    registry.suspend({
      ...entry(exactDocument, 1, 'visual-host', {}),
      key: { ...key(exactDocument, 1, 'visual-host'), surface: 'visual' },
    });
    registry.suspend({
      ...entry(rebuildDocument, 1, 'visual-host', {}),
      key: { ...key(rebuildDocument, 1, 'visual-host'), surface: 'visual' },
      kind: 'bounded-rebuild',
    });

    expect(registry.has(exactDocument, 'visual', sourceRevision(1))).toBe(true);
    expect(registry.has(rebuildDocument, 'visual', sourceRevision(1))).toBe(false);
  });
});

function registryWithBudget() {
  return new DocumentRuntimeRegistry({ lowWatermarkBytes: 8 * MiB, highWatermarkBytes: 12 * MiB, hardCeilingBytes: 24 * MiB, reservedActiveHeadroomBytes: 4 * MiB, minimumResidencyMs: 0 });
}

function key(documentId: ReturnType<typeof createDocumentId>, revision: number, configurationFingerprint: string) {
  return { documentId, sourceRevision: sourceRevision(revision), surface: 'source' as const, configurationFingerprint };
}

function entry(documentId: ReturnType<typeof createDocumentId>, revision: number, configurationFingerprint: string, state: unknown, byteWeight = MiB) {
  return { key: key(documentId, revision, configurationFingerprint), state, scrollTop: 7, focused: false, byteWeight, historyBytes: 0, kind: 'exact-state' as const };
}
