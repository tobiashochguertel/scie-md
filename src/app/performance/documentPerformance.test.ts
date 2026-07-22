import { describe, expect, it } from 'vitest';
import { createDocumentId } from '../documentIdentity';
import { DocumentPerformanceCollector, sourceDisplayClass } from './documentPerformance';

describe('DocumentPerformanceCollector', () => {
  it('orders correlated open and activation evidence on one renderer clock', () => {
    let now = 10;
    const collector = new DocumentPerformanceCollector(32, { now: () => ++now });
    const operationId = collector.beginOpen(sourceDisplayClass('C:\\private\\paper.md', 5 * 1024 * 1024));
    const documentId = createDocumentId();
    collector.record({ name: 'ipc-read', operationId, durationMs: 8, byteCount: 5 * 1024 * 1024 });
    collector.associate(operationId, documentId);
    collector.record({ name: 'activation-start', documentId, state: 'clean' });

    const report = collector.report();
    expect(report.events.map((event) => event.name)).toEqual([
      'open-start', 'ipc-read', 'operation-associated', 'activation-start',
    ]);
    expect(report.events.map((event) => event.monotonicMs)).toEqual([11, 12, 13, 14]);
    expect(JSON.stringify(report)).not.toContain('private');
  });

  it('retains a bounded tail and reports dropped events', () => {
    const collector = new DocumentPerformanceCollector(16, { now: () => 1 });
    for (let index = 0; index < 20; index += 1) {
      collector.record({ name: 'analysis-state', cache: 'miss', byteCount: index });
    }
    expect(collector.report()).toMatchObject({ retentionLimit: 16, droppedEvents: 4 });
    expect(collector.report().events[0].byteCount).toBe(4);
  });

  it('rejects unredacted display classes and content-shaped fields at runtime', () => {
    const collector = new DocumentPerformanceCollector();
    expect(() => collector.beginOpen('C:\\private\\paper.md')).toThrow(/redacted/);
    expect(() => collector.record({ name: 'open-failed', sourceText: 'secret' } as never)).toThrow(/source text or path/);
  });

  it('summarizes byte acquisition, materialization, and full replacement counters', () => {
    const collector = new DocumentPerformanceCollector();
    collector.record({ name: 'byte-acquisition', acquisitionReason: 'open', byteCount: 100 });
    collector.record({ name: 'whole-source-materialization', materializedBytes: 80 });
    collector.record({ name: 'source-change', changeBytes: 1, fullDocumentTransactions: 1 });
    expect(collector.report().summary).toMatchObject({
      mainDocumentByteAcquisitions: 1,
      acquiredBytes: 100,
      wholeSourceMaterializations: 1,
      materializedBytes: 80,
      fullDocumentTransactions: 1,
    });
  });
});
