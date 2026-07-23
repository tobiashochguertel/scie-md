import { describe, expect, it, vi } from 'vitest';
import budgets from './documentPerformanceBudgets.v1.json';
import {
  DOCUMENT_PERFORMANCE_FIXTURES,
  DOCUMENT_PERFORMANCE_WORKSPACE_FIXTURES,
  createDocumentPerformanceFixture,
} from './documentPerformanceFixtures';
import { documentPerformance, utf8ByteLength } from './documentPerformance';
import { DocumentKeyedEditorGateway } from '../documentEditorGateway';
import { createDocumentId } from '../documentIdentity';

describe('Round 1 production-path performance contract', () => {
  it('freezes exact byte fixture classes, states, workspace density, and named budgets', () => {
    expect(DOCUMENT_PERFORMANCE_FIXTURES.map((fixture) => fixture.bytes)).toEqual([
      (5 * 1024 * 1024) - 1,
      5 * 1024 * 1024,
      (5 * 1024 * 1024) + 1,
      1024 * 1024,
      5 * 1024 * 1024,
      10 * 1024 * 1024,
      24 * 1024 * 1024,
    ]);
    for (const fixture of DOCUMENT_PERFORMANCE_FIXTURES) {
      expect(utf8ByteLength(createDocumentPerformanceFixture(fixture))).toBe(fixture.bytes);
    }
    expect(DOCUMENT_PERFORMANCE_FIXTURES.filter((fixture) => fixture.id.startsWith('markdown-'))
      .every((fixture) => fixture.cleanStates.join(',') === 'clean,dirty')).toBe(true);
    expect(DOCUMENT_PERFORMANCE_WORKSPACE_FIXTURES).toMatchObject({
      fiveByTenMiB: { documentCount: 5, bytesPerDocument: 10 * 1024 * 1024 },
      severalByTwentyFourMiB: { documentCount: 3, bytesPerDocument: 24 * 1024 * 1024 },
      mixedStructuredFormats: ['json', 'jsonl', 'yaml', 'toml', 'xml', 'csv', 'tsv'],
    });
    expect(budgets.sampleCount).toBeGreaterThanOrEqual(5);
    expect(budgets.budgets.native_cancel_stop_p95_ms).toBeGreaterThan(0);
    expect(budgets.budgets.visual_warm_reactivation_next_frame_p95_ms).toBeGreaterThan(0);
  });

  it('drives the real document-addressed gateway across clean and dirty A-B-A without byte acquisition', () => {
    documentPerformance.clear();
    const gateway = new DocumentKeyedEditorGateway();
    const first = createDocumentId();
    const second = createDocumentId();
    gateway.registerAdapter(first, 'source', adapter('# first', false));
    gateway.registerAdapter(second, 'source', adapter('# second dirty', true));

    for (const [documentId, state] of [[first, 'clean'], [second, 'dirty'], [first, 'clean']] as const) {
      documentPerformance.trace({ name: 'activation-start', documentId, state, surface: 'source', cache: 'miss' });
      gateway.activate(documentId, 'source');
      gateway.flush(documentId);
      expect(gateway.focus(documentId)).toBe(true);
      documentPerformance.trace({ name: 'editor-attach', documentId, surface: 'source' });
      documentPerformance.trace({ name: 'next-frame', documentId, surface: 'source' });
    }

    const report = documentPerformance.report();
    expect(report.events.filter((event) => event.name === 'activation-start')).toHaveLength(3);
    expect(report.summary.mainDocumentByteAcquisitions).toBe(0);
    expect(report.events.some((event) => event.phase === 'editor-gateway-flush')).toBe(true);
  });

  it('fails telemetry closed without blocking the measured operation', () => {
    const collector = documentPerformance;
    const failure = vi.spyOn(collector, 'record').mockImplementation(() => { throw new Error('injected'); });
    expect(collector.trace({ name: 'analysis-state', cache: 'miss' })).toBeNull();
    expect(collector.beginOpenSafe('md:1-5mib')).toMatch(/^open-/);
    failure.mockRestore();
  });
});

function adapter(markdown: string, changed: boolean) {
  return {
    surface: 'source' as const,
    read: () => ({ surface: 'source' as const, markdown, changed }),
    flushPendingEdits: () => ({ surface: 'source' as const, markdown, changed }),
    replace: () => true,
    focus: vi.fn(),
  };
}
