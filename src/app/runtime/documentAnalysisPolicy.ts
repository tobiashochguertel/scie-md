import type { DocumentFormat } from '@sciemd/core';

export type AnalysisCapability =
  | 'document-parse'
  | 'format-parse'
  | 'validation'
  | 'metrics'
  | 'source-highlighting';

export type AnalysisMode = 'immediate' | 'incremental' | 'viewport' | 'background' | 'onDemand' | 'unavailable';

export type AnalysisSizeUnit = 'rawFileBytes' | 'utf8SourceBytes' | 'utf16CodeUnits' | 'estimatedRuntimeBytes';

export interface AnalysisPolicyDecision {
  capability: AnalysisCapability;
  mode: AnalysisMode;
  measuredUnit: AnalysisSizeUnit;
  measuredValue: number;
  limit: number | null;
  reason: string;
}

const MIB = 1024 * 1024;
const MARKDOWN_DEEP_ANALYSIS_BYTES = 5 * MIB;
const FORMAT_DEEP_ANALYSIS_BYTES: Partial<Record<DocumentFormat, number>> = {
  json: 1 * MIB,
  jsonl: 5 * MIB,
  csv: 5 * MIB,
  tsv: 5 * MIB,
  yaml: 1 * MIB,
  toml: 1 * MIB,
  xml: 1 * MIB,
};

export function utf8SourceBytes(source: string): number {
  let bytes = 0;
  for (let index = 0; index < source.length; index += 1) {
    const codeUnit = source.charCodeAt(index);
    if (codeUnit < 0x80) bytes += 1;
    else if (codeUnit < 0x800) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < source.length
      && source.charCodeAt(index + 1) >= 0xdc00 && source.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function documentAnalysisPolicy(
  format: DocumentFormat,
  capability: AnalysisCapability,
  source: string,
): AnalysisPolicyDecision {
  const measuredValue = utf8SourceBytes(source);
  if (capability === 'source-highlighting') {
    return {
      capability,
      mode: 'viewport',
      measuredUnit: 'utf8SourceBytes',
      measuredValue,
      limit: null,
      reason: 'Viewport syntax presentation remains available independently of deep analysis.',
    };
  }
  const limit = format === 'markdown' ? MARKDOWN_DEEP_ANALYSIS_BYTES : (FORMAT_DEEP_ANALYSIS_BYTES[format] ?? 1 * MIB);
  if (measuredValue > limit) {
    return {
      capability,
      mode: capability === 'metrics' ? 'incremental' : capability === 'validation' ? 'background' : 'unavailable',
      measuredUnit: 'utf8SourceBytes',
      measuredValue,
      limit,
      reason: 'The source exceeds the format capability budget; source editing and viewport highlighting remain available.',
    };
  }
  return {
    capability,
    mode: capability === 'metrics' ? 'incremental' : 'background',
    measuredUnit: 'utf8SourceBytes',
    measuredValue,
    limit,
    reason: 'The source is within the declared capability budget.',
  };
}
