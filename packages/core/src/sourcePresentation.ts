export const SOURCE_SEMANTIC_TOKEN_CONTRACT = {
  heading: '--source-syntax-heading',
  strong: '--source-syntax-strong',
  emphasis: '--source-syntax-emphasis',
  link: '--source-syntax-link',
  code: '--source-syntax-code',
  list: '--source-syntax-list',
  quote: '--source-syntax-quote',
  meta: '--source-syntax-meta',
  comment: '--source-syntax-comment',
  punctuation: '--source-syntax-punctuation',
  property: '--source-syntax-property',
  tag: '--source-syntax-tag',
  attribute: '--source-syntax-attribute',
  string: '--source-syntax-string',
  number: '--source-syntax-number',
  bool: '--source-syntax-bool',
  keyword: '--source-syntax-keyword',
  invalid: '--source-syntax-invalid',
} as const;

export type SourceSemanticTokenName = keyof typeof SOURCE_SEMANTIC_TOKEN_CONTRACT;
export type SourceSemanticPresentationMode = 'enabled' | 'large-file-fallback' | 'unsupported-plain';

export function sourceSemanticPresentationMode(input: {
  byteLength: number;
  sourceOnlyThresholdBytes: number;
  languageAvailable: boolean;
}): SourceSemanticPresentationMode {
  if (!input.languageAvailable) return 'unsupported-plain';
  if (input.byteLength > input.sourceOnlyThresholdBytes) return 'large-file-fallback';
  return 'enabled';
}
