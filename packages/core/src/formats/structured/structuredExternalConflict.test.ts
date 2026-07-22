import { describe, expect, it } from 'vitest';
import {
  applyStructuredExternalConflictReviewDecisions,
  createStructuredExternalConflictReview,
  createTomlNativeExternalConflictReview,
} from './structuredExternalConflict';
import type { TomlNativeSourceMapReport } from '../toml/tomlNative';

describe('structuredExternalConflict', () => {
  it('creates and applies source-preserving JSONL line reviews', () => {
    const base = '{"id":1,"name":"base","big":9007199254740993}\n{"id":2,"name":"same"}\n';
    const current = '{"id":1,"name":"local","big":9007199254740993}\n{"id":2,"name":"same"}\n';
    const disk = '{"id":1,"name":"disk","big":9007199254740995}\n{"id":2,"name":"same"}\n';

    const review = createStructuredExternalConflictReview('jsonl', base, current, disk);

    expect(review.status).toBe('ready');
    expect(review.entries).toHaveLength(1);
    expect(review.entries[0]).toMatchObject({
      entryKind: 'jsonl-line',
      displayTarget: 'Line 1',
      conflict: true,
    });

    const result = applyStructuredExternalConflictReviewDecisions(review, new Set());

    expect(result.ok).toBe(true);
    expect(result.nextSource).toBe(disk);
    expect(result.nextSource).toContain('9007199254740995');
  });

  it('falls back for JSONL inserted or deleted records until line identity is stable', () => {
    const review = createStructuredExternalConflictReview(
      'jsonl',
      '{"id":1}\n',
      '{"id":1}\n',
      '{"id":1}\n{"id":2}\n',
    );

    expect(review.status).toBe('fallback');
    expect(review.fallbackReason).toContain('line counts are unchanged');
  });

  it('creates and applies source-preserving CSV cell reviews', () => {
    const base = 'sample_id,note,count\nS-001,base,10\nS-002,same,20\n';
    const current = 'sample_id,note,count\nS-001,local,10\nS-002,same,20\n';
    const disk = 'sample_id,note,count\nS-001,"thin, film",10\nS-002,same,20\n';

    const review = createStructuredExternalConflictReview('csv', base, current, disk);

    expect(review.status).toBe('ready');
    expect(review.entries).toHaveLength(1);
    expect(review.entries[0]).toMatchObject({
      entryKind: 'tabular-cell',
      displayTarget: 'Row 1, note',
      currentPreview: 'local',
      diskPreview: '"thin, film"',
      conflict: true,
    });

    const result = applyStructuredExternalConflictReviewDecisions(review, new Set());

    expect(result.ok).toBe(true);
    expect(result.nextSource).toBe(disk);
  });

  it('keeps rejected table cells from the current source', () => {
    const base = 'sample_id,count\nS-001,10\n';
    const current = 'sample_id,count\nS-001,11\n';
    const disk = 'sample_id,count\nS-001,12\n';
    const review = createStructuredExternalConflictReview('csv', base, current, disk);
    const entry = review.entries[0];

    const result = applyStructuredExternalConflictReviewDecisions(review, new Set([entry.id]));

    expect(result.ok).toBe(true);
    expect(result.nextSource).toBe(current);
  });

  it('falls back for changed table shape', () => {
    const review = createStructuredExternalConflictReview(
      'tsv',
      'id\tcount\nS-001\t10\n',
      'id\tcount\nS-001\t11\n',
      'id\tcount\tnote\nS-001\t12\tdisk\n',
    );

    expect(review.status).toBe('fallback');
    expect(review.fallbackReason).toContain('column counts are unchanged');
  });

  it('creates and applies source-preserving YAML scalar path reviews', () => {
    const base = 'study:\n  title: base\n  count: 1\n';
    const current = 'study:\n  title: local\n  count: 1\n';
    const disk = 'study:\n  title: disk\n  count: 2\n';
    const review = createStructuredExternalConflictReview('yaml', base, current, disk);

    expect(review.status).toBe('ready');
    expect(review.entries).toHaveLength(2);
    expect(review.entries[0]).toMatchObject({
      entryKind: 'structured-path',
      displayTarget: '$.study.count',
      basePreview: '1',
      diskPreview: '2',
      conflict: false,
    });
    expect(review.entries[1]).toMatchObject({
      entryKind: 'structured-path',
      displayTarget: '$.study.title',
      basePreview: 'base',
      currentPreview: 'local',
      diskPreview: 'disk',
      conflict: true,
    });

    const rejected = new Set(review.entries
      .filter((entry) => entry.displayTarget === '$.study.title')
      .map((entry) => entry.id));
    const result = applyStructuredExternalConflictReviewDecisions(review, rejected);

    expect(result.ok).toBe(true);
    expect(result.nextSource).toBe('study:\n  title: local\n  count: 2\n');
  });

  it('creates and applies source-preserving TOML scalar path reviews', () => {
    const base = 'title = "base"\n\n[study]\ncount = 1\nstatus = "draft"\n';
    const current = 'title = "local"\n\n[study]\ncount = 1\nstatus = "draft"\n';
    const disk = 'title = "disk"\n\n[study]\ncount = 2\nstatus = "draft"\n';
    const review = createTomlNativeExternalConflictReview(base, current, disk, {
      base: nativeTomlReport(base), current: nativeTomlReport(current), disk: nativeTomlReport(disk),
    });

    expect(review.status).toBe('ready');
    expect(review.entries).toHaveLength(2);
    expect(review.entries.map((entry) => entry.displayTarget)).toEqual(['$.study.count', '$.title']);
    expect(review.entries.find((entry) => entry.displayTarget === '$.title')).toMatchObject({
      entryKind: 'structured-path',
      currentPreview: '"local"',
      diskPreview: '"disk"',
      conflict: true,
    });

    const rejected = new Set(review.entries
      .filter((entry) => entry.displayTarget === '$.title')
      .map((entry) => entry.id));
    const result = applyStructuredExternalConflictReviewDecisions(review, rejected);

    expect(result.ok).toBe(true);
    expect(result.nextSource).toBe('title = "local"\n\n[study]\ncount = 2\nstatus = "draft"\n');
  });

  it('falls back for YAML and TOML changes without stable scalar spans', () => {
    const yamlReview = createStructuredExternalConflictReview(
      'yaml',
      'items:\n  - base\n',
      'items:\n  - local\n',
      'items:\n  - disk\n  - added\n',
    );
    expect(yamlReview.status).toBe('fallback');
    expect(yamlReview.fallbackReason).toContain('added or removed paths');

    const tomlReview = createStructuredExternalConflictReview(
      'toml',
      '[study]\ncount = 1\n',
      '[study]\ncount = 2\n',
      '[study]\ncount = 3\nextra = true\n',
    );
    expect(tomlReview.status).toBe('fallback');
    expect(tomlReview.fallbackReason).toContain('desktop native toml_edit');
  });

  it('reviews source-mapped XML scalar conflicts and falls back for mixed content', () => {
    const review = createStructuredExternalConflictReview('xml', '<title>base</title>\n', '<title>local</title>\n', '<title>disk</title>\n');
    expect(review.status).toBe('ready');
    expect(review.entries).toHaveLength(1);
    expect(applyStructuredExternalConflictReviewDecisions(review, new Set())).toMatchObject({
      ok: true,
      nextSource: '<title>disk</title>\n',
    });

    const mixed = createStructuredExternalConflictReview(
      'xml',
      '<title>base<em>x</em></title>\n',
      '<title>local<em>x</em></title>\n',
      '<title>disk<em>x</em></title>\n',
    );
    expect(mixed.status).toBe('fallback');
    expect(mixed.fallbackReason).toContain('unsupported source syntax');
  });
});

function nativeTomlReport(source: string): TomlNativeSourceMapReport {
  const title = /title = ("[^"]*")/.exec(source); const count = /count = (\d+)/.exec(source); const status = /status = ("[^"]*")/.exec(source);
  const value = {
    title: title?.[1].slice(1, -1),
    study: { count: Number(count?.[1]), status: status?.[1].slice(1, -1) },
  };
  const scalar = (path: (string | number)[], pointer: string, displayPath: string, match: RegExpExecArray | null) => {
    const raw = match?.[1] ?? ''; const offset = match ? match.index + match[0].indexOf(raw) : 0;
    const span = { offset, length: raw.length, line: source.slice(0, offset).split('\n').length, column: offset - source.lastIndexOf('\n', offset - 1) };
    return { path, pointer, displayPath, kind: 'scalar', valueType: typeof path.at(-1), span, valueSpan: span, keySpan: null, editableCandidate: true, editableOperations: ['replaceScalar'] };
  };
  const nodes = [
    { path: [], pointer: '', displayPath: '$', kind: 'table', valueType: 'table', span: null, valueSpan: null, keySpan: null, editableCandidate: true, editableOperations: ['addObjectField'] },
    scalar(['title'], '/title', '$.title', title),
    { path: ['study'], pointer: '/study', displayPath: '$.study', kind: 'table', valueType: 'table', span: null, valueSpan: null, keySpan: null, editableCandidate: true, editableOperations: ['addObjectField'] },
    scalar(['study', 'count'], '/study/count', '$.study.count', count),
    scalar(['study', 'status'], '/study/status', '$.study.status', status),
  ];
  return {
    dtoVersion: 'toml-native-dto-v1', plannerVersion: 'toml-edit-native-v1', status: 'valid', value,
    diagnostics: [], nodes, unsupportedFeatures: [],
    summary: { nodeCount: nodes.length, spannedNodeCount: 3, unsupportedFeatureCount: 0, noOpRoundTripPreserved: true, visualWritesEnabled: true, boundaryStatus: 'production-source-preserving', commandScope: 'inspect-and-plan-guarded-patches' },
  };
}
