import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { planYamlVisualEdit, yamlSourceHash } from './yamlEdits.js';

const source = [
  '# study configuration',
  'study:',
  "  title: 'Alpha' # preserve title note",
  '  count: 2',
  '  samples:',
  '    - first',
  '    - second',
  'after: untouched',
  '',
].join('\n');

describe('YAML CST visual edits', () => {
  it('replaces a scalar token while preserving comments, quotes, whitespace, and untouched bytes', () => {
    const plan = planYamlVisualEdit(source, {
      kind: 'replaceScalar', path: ['study', 'title'], nextValue: "Beta's", expectedSourceHash: yamlSourceHash(source),
    });
    expect(plan.ok).toBe(true);
    expect(plan.edits).toEqual([{ offset: source.indexOf("'Alpha'"), length: 7, content: "'Beta''s'" }]);
    expect(plan.nextSource).toBe(source.replace("'Alpha'", "'Beta''s'"));
    expect(parseDocument(plan.nextSource!).toJS()).toMatchObject({ study: { title: "Beta's" }, after: 'untouched' });
  });

  it('renames keys and adds or deletes unambiguous block mapping fields', () => {
    const renamed = planYamlVisualEdit(source, { kind: 'renameObjectKey', path: ['study', 'count'], newKey: 'replicates' });
    expect(renamed.ok).toBe(true);
    expect(renamed.nextSource).toContain('  replicates: 2\n');
    expect(renamed.nextSource).toContain("  title: 'Alpha' # preserve title note\n");

    const added = planYamlVisualEdit(source, { kind: 'addObjectField', path: ['study'], key: 'enabled', value: true });
    expect(added.ok).toBe(true);
    expect(added.nextSource).toContain('    - second\n  enabled: true\nafter: untouched\n');

    const deleted = planYamlVisualEdit(source, { kind: 'deleteObjectField', path: ['study', 'count'] });
    expect(deleted.ok, deleted.unsupportedReason).toBe(true);
    expect(deleted.nextSource).not.toContain('  count: 2\n');
    expect(deleted.nextSource).toContain("  title: 'Alpha' # preserve title note\n");
  });

  it('appends and deletes block sequence items without regenerating the collection', () => {
    const added = planYamlVisualEdit(source, { kind: 'addArrayItem', path: ['study', 'samples'], value: 'third' });
    expect(added.ok).toBe(true);
    expect(added.nextSource).toContain('    - second\n    - third\nafter: untouched\n');

    const deleted = planYamlVisualEdit(source, { kind: 'deleteArrayItem', path: ['study', 'samples', 0] });
    expect(deleted.ok, deleted.unsupportedReason).toBe(true);
    expect(deleted.nextSource).toContain('  samples:\n    - second\n');
    expect(deleted.nextSource).not.toContain('    - first\n');
  });

  it('handles EOF without a trailing newline and rejects deletion that would change an empty-container representation', () => {
    const mapAdded = planYamlVisualEdit('root:\n  a: 1', { kind: 'addObjectField', path: ['root'], key: 'b', value: 2 });
    expect(mapAdded.ok, mapAdded.unsupportedReason).toBe(true);
    expect(mapAdded.nextSource).toBe('root:\n  a: 1\n  b: 2\n');
    const sequenceAdded = planYamlVisualEdit('items:\n  - one', { kind: 'addArrayItem', path: ['items'], value: 'two' });
    expect(sequenceAdded.ok, sequenceAdded.unsupportedReason).toBe(true);
    expect(sequenceAdded.nextSource).toBe('items:\n  - one\n  - two\n');
    expect(planYamlVisualEdit('root:\n  a: 1\n', { kind: 'deleteObjectField', path: ['root', 'a'] }).unsupportedReason).toContain('final block-mapping field');
    expect(planYamlVisualEdit('items:\n  - one\n', { kind: 'deleteArrayItem', path: ['items', 0] }).unsupportedReason).toContain('final block-sequence item');
  });

  it('fails closed for duplicate keys, flow collections, aliases, block scalars, comments in deletion spans, and stale source', () => {
    expect(planYamlVisualEdit('a: 1\na: 2\n', { kind: 'replaceScalar', path: ['a'], nextValue: 3 }).unsupportedReason).toMatch(/Map keys must be unique|unique/i);
    expect(planYamlVisualEdit('a: { b: 1 }\n', { kind: 'replaceScalar', path: ['a', 'b'], nextValue: 2 }).unsupportedReason).toContain('Flow collections');
    expect(planYamlVisualEdit('a: &base 1\nb: *base\n', { kind: 'replaceScalar', path: ['b'], nextValue: 2 }).unsupportedReason).toContain('Aliases');
    expect(planYamlVisualEdit('a: |\n  text\n', { kind: 'replaceScalar', path: ['a'], nextValue: 'new' }).unsupportedReason).toContain('Block scalars');
    expect(planYamlVisualEdit('a: 1 # keep\nb: 2\n', { kind: 'deleteObjectField', path: ['a'] }).unsupportedReason).toContain('comment');
    expect(planYamlVisualEdit('a: 1\n', { kind: 'replaceScalar', path: ['a'], nextValue: 2, expectedSourceHash: 'stale' }).unsupportedReason).toContain('changed');
    expect(planYamlVisualEdit('a: 1\n---\nb: 2\n', { kind: 'replaceScalar', path: ['a'], nextValue: 2 }).unsupportedReason).toContain('multi-document');
    expect(planYamlVisualEdit('%YAML 1.2\n---\na: 1\n', { kind: 'replaceScalar', path: ['a'], nextValue: 2 }).unsupportedReason).toContain('directives');
    expect(planYamlVisualEdit(`a: ${'x'.repeat(1024 * 1024)}\n`, { kind: 'replaceScalar', path: ['a'], nextValue: 'small' }).unsupportedReason).toContain('1 MiB');
  });

  it('preserves CRLF, Unicode, a single document marker, comments, and untouched scalar spellings', () => {
    const text = "---\r\n# café\r\nname: 'Ångström'\r\nscientific: 1.200e+03\r\n";
    const plan = planYamlVisualEdit(text, { kind: 'replaceScalar', path: ['name'], nextValue: 'β phase' });
    expect(plan.ok, plan.unsupportedReason).toBe(true);
    expect(plan.nextSource).toBe("---\r\n# café\r\nname: 'β phase'\r\nscientific: 1.200e+03\r\n");
  });
});
