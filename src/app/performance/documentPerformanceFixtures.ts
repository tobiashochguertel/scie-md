export interface DocumentPerformanceFixtureClass {
  id: string;
  bytes: number;
  lineShape: 'many-line' | 'long-line';
  unicode: boolean;
  cleanStates: readonly ('clean' | 'dirty')[];
}

export const DOCUMENT_PERFORMANCE_FIXTURES: readonly DocumentPerformanceFixtureClass[] = [
  { id: 'unicode-below-threshold', bytes: (5 * 1024 * 1024) - 1, lineShape: 'many-line', unicode: true, cleanStates: ['clean'] },
  { id: 'unicode-at-threshold', bytes: 5 * 1024 * 1024, lineShape: 'many-line', unicode: true, cleanStates: ['clean'] },
  { id: 'unicode-above-threshold', bytes: (5 * 1024 * 1024) + 1, lineShape: 'many-line', unicode: true, cleanStates: ['clean'] },
  { id: 'markdown-1mib-many-line', bytes: 1024 * 1024, lineShape: 'many-line', unicode: true, cleanStates: ['clean', 'dirty'] },
  { id: 'markdown-5mib-many-line', bytes: 5 * 1024 * 1024, lineShape: 'many-line', unicode: true, cleanStates: ['clean', 'dirty'] },
  { id: 'markdown-10mib-many-line', bytes: 10 * 1024 * 1024, lineShape: 'many-line', unicode: true, cleanStates: ['clean', 'dirty'] },
  { id: 'markdown-24mib-long-line', bytes: 24 * 1024 * 1024, lineShape: 'long-line', unicode: true, cleanStates: ['clean', 'dirty'] },
] as const;

export const DOCUMENT_PERFORMANCE_WORKSPACE_FIXTURES = {
  fiveByTenMiB: { documentCount: 5, bytesPerDocument: 10 * 1024 * 1024 },
  severalByTwentyFourMiB: { documentCount: 3, bytesPerDocument: 24 * 1024 * 1024 },
  mixedStructuredFormats: ['json', 'jsonl', 'yaml', 'toml', 'xml', 'csv', 'tsv'] as const,
};

export function createDocumentPerformanceFixture(fixture: DocumentPerformanceFixtureClass): string {
  const heading = '# ScieMD performance fixture\n\n';
  const unit = fixture.lineShape === 'long-line'
    ? `${fixture.unicode ? 'αβγ ' : ''}0123456789abcdef`
    : `${fixture.unicode ? 'αβγ ' : ''}${'0123456789abcdef'.repeat(64)}\n`;
  const encoder = new TextEncoder();
  const headingBytes = encoder.encode(heading).byteLength;
  const unitBytes = encoder.encode(unit).byteLength;
  const repeatCount = Math.floor((fixture.bytes - headingBytes) / unitBytes);
  const remaining = fixture.bytes - headingBytes - (repeatCount * unitBytes);
  return heading + unit.repeat(repeatCount) + 'x'.repeat(remaining);
}
