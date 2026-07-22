import type { FormatParseResult, ParsedScienfyDocument } from '@sciemd/core';
import type { SourceFormatDiagnosticState } from '../formatDiagnostics';

const MAX_FRONTMATTER_RAW_BYTES = 64 * 1024;

export function projectParsedScienfyDocument(document: ParsedScienfyDocument): ParsedScienfyDocument {
  const raw = utf8Bytes(document.frontmatter.raw) <= MAX_FRONTMATTER_RAW_BYTES ? document.frontmatter.raw : '';
  return {
    ...document,
    frontmatter: {
      ...document.frontmatter,
      raw,
      body: '',
      sourcePrefix: '',
    },
  };
}

export function projectFormatParseResult<T>(result: FormatParseResult<T>): FormatParseResult<T> {
  return {
    ...result,
    content: {
      ...result.content,
      text: '',
    },
  };
}

export function projectSourceFormatDiagnosticState(state: SourceFormatDiagnosticState): SourceFormatDiagnosticState {
  const projectAnalysis = <T extends { parseResult: FormatParseResult } | null>(analysis: T): T => {
    if (!analysis) return analysis;
    return { ...analysis, parseResult: projectFormatParseResult(analysis.parseResult) } as T;
  };
  return {
    ...state,
    jsonAnalysis: projectAnalysis(state.jsonAnalysis),
    jsonlAnalysis: projectAnalysis(state.jsonlAnalysis),
    structuredAnalysis: projectAnalysis(state.structuredAnalysis),
    tabularAnalysis: projectAnalysis(state.tabularAnalysis),
    structuredModel: state.structuredModel
      ? { ...state.structuredModel, parseResult: projectFormatParseResult(state.structuredModel.parseResult) }
      : null,
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
