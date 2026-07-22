import { useEffect, useState } from 'react';
import { createTomlContent, parseTomlNativeReport, type DocumentFormat, type TomlNativeSourceMapReport } from '@sciemd/core';
import { cancelFormatDocumentParse, isTransientFormatParserWorkerFailure, parseFormatDocumentAsync } from '../../domain/formats/formatParserWorker';
import type { DocumentEffectTarget } from '../effects/documentEffectCoordinator';
import {
  createFormatParserFailureDiagnosticState,
  parseSourceFormatDiagnostics,
  shouldUseSourceOnlyFormatParsing,
  sourceFormatDiagnosticsFromParseResult,
} from '../formatDiagnostics';
import type { SourceFormatDiagnosticState, SourceFormatDiagnosticsOptions } from '../formatDiagnostics';
import {
  acquireAnalysisSnapshot,
  analysisSourceFingerprint,
  canonicalFingerprint,
  documentAnalysisRuntime,
} from '../runtime/documentAnalysisRuntime';
import { documentAnalysisPolicy } from '../runtime/documentAnalysisPolicy';
import { projectSourceFormatDiagnosticState } from '../runtime/analysisArtifactProjection';

export interface AsyncSourceFormatDiagnosticState extends SourceFormatDiagnosticState {
  parsingPending: boolean;
}

export interface SourceFormatDiagnosticsHostOptions extends SourceFormatDiagnosticsOptions {
  inspectToml?: (sourceText: string) => Promise<TomlNativeSourceMapReport>;
}

interface ParsedSourceFormatState {
  documentId: DocumentEffectTarget['documentId'];
  format: DocumentFormat;
  sourceFingerprint: string;
  path: string | null;
  schemaKey: string;
  diagnostics: SourceFormatDiagnosticState;
  parsingPending: boolean;
}

const EMPTY_SOURCE_DIAGNOSTICS: SourceFormatDiagnosticState = {
  diagnostics: [],
  structuredModel: null,
  jsonAnalysis: null,
  jsonlAnalysis: null,
  structuredAnalysis: null,
  tabularAnalysis: null,
};

export function useSourceFormatDiagnostics(
  target: DocumentEffectTarget,
  format: DocumentFormat,
  text: string,
  path: string | null,
  options: SourceFormatDiagnosticsHostOptions = {},
): AsyncSourceFormatDiagnosticState {
  const sourceFingerprint = analysisSourceFingerprint(target, text);
  const jsonSchema = options.jsonSchema ?? null;
  const schemaKey = jsonSchemaKey(jsonSchema);
  const [parsedState, setParsedState] = useState<ParsedSourceFormatState>(() => ({
    documentId: target.documentId,
    format: 'markdown',
    sourceFingerprint: '',
    path: null,
    schemaKey: '',
    diagnostics: EMPTY_SOURCE_DIAGNOSTICS,
    parsingPending: false,
  }));

  useEffect(() => {
    const token = target.effects.begin(target.documentId, 'source-format-diagnostics');
    if (!token) return undefined;
    documentAnalysisRuntime.cancelDocument(target.documentId, token.sourceRevision);
    if (format === 'markdown') {
      target.effects.commit(token, () => setParsedState((current) => current.documentId === target.documentId && current.format === 'markdown' && !current.parsingPending
        ? current
        : {
          documentId: target.documentId,
          format,
          sourceFingerprint,
          path,
          schemaKey,
          diagnostics: EMPTY_SOURCE_DIAGNOSTICS,
          parsingPending: false,
        }));
      return undefined;
    }

    target.effects.apply(token, () => setParsedState((current) => ({
      documentId: target.documentId,
      format,
      sourceFingerprint,
      path,
      schemaKey,
      diagnostics: canReusePendingDiagnostics(current, target.documentId, format, path, schemaKey)
        ? current.diagnostics
        : EMPTY_SOURCE_DIAGNOSTICS,
      parsingPending: true,
    })));
    const policy = documentAnalysisPolicy(format, 'format-parse', text);
    void documentAnalysisRuntime.request<SourceFormatDiagnosticState>({
      key: {
        documentId: target.documentId,
        sourceRevision: token.sourceRevision,
        analyzer: 'format-parse',
        optionsFingerprint: canonicalFingerprint({ format, path, sourceFingerprint }),
        dependencyFingerprint: schemaKey,
      },
      priority: 'active',
      transport: 'worker-structured-clone',
      acquireSnapshot: () => acquireAnalysisSnapshot(target, token, text),
      run: async (sourceText, signal) => {
        if (signal.aborted) throw new Error('Format analysis was cancelled.');
        if (policy.mode === 'unavailable' || shouldUseSourceOnlyFormatParsing(format, sourceText)) {
          return parseSourceFormatDiagnostics(format, sourceText, path, { jsonSchema });
        }
        const parseResult = format === 'toml' && options.inspectToml
          ? parseTomlNativeReport(createTomlContent(sourceText, path), await options.inspectToml(sourceText))
          : format === 'json'
          ? await parseFormatDocumentAsync(format, sourceText, path, { schema: jsonSchema }, token)
          : await parseFormatDocumentAsync(format, sourceText, path, {}, token);
        return sourceFormatDiagnosticsFromParseResult(parseResult);
      },
      project: projectSourceFormatDiagnosticState,
      cancel: () => { cancelFormatDocumentParse(token); },
    })
      .then((diagnostics) => {
        target.effects.commit(token, () => setParsedState({
          documentId: target.documentId,
          format,
          sourceFingerprint,
          path,
          schemaKey,
          diagnostics,
          parsingPending: false,
        }));
      })
      .catch((error) => {
        if (!target.effects.isCurrent(token)) return;
        if (isTransientFormatParserWorkerFailure(error)) {
          console.warn('Format parser worker could not complete; source editing remains available.', error);
          target.effects.commit(token, () => setParsedState({
            documentId: target.documentId,
            format,
            sourceFingerprint,
            path,
            schemaKey,
            diagnostics: projectSourceFormatDiagnosticState(createFormatParserFailureDiagnosticState(format, text, path, error)),
            parsingPending: false,
          }));
          return;
        }
        console.warn('Format parser worker failed; keeping source editing available without a synchronous deep fallback.', error);
        target.effects.commit(token, () => setParsedState({
          documentId: target.documentId,
          format,
          sourceFingerprint,
          path,
          schemaKey,
          diagnostics: projectSourceFormatDiagnosticState(createFormatParserFailureDiagnosticState(format, text, path, error)),
          parsingPending: false,
        }));
      });
    return () => {
      target.effects.cancel(token);
    };
  }, [format, options.inspectToml, path, schemaKey, sourceFingerprint, target.documentId, target.effects, target.leaseSource, text]);

  if (format === 'markdown') return { ...EMPTY_SOURCE_DIAGNOSTICS, parsingPending: false };
  const sameDocument = parsedState.documentId === target.documentId
    && parsedState.format === format
    && parsedState.path === path
    && parsedState.schemaKey === schemaKey;
  if (!sameDocument) return { ...EMPTY_SOURCE_DIAGNOSTICS, parsingPending: true };
  const current = parsedState.sourceFingerprint === sourceFingerprint;
  if (!current) {
    return {
      ...parsedState.diagnostics,
      parsingPending: true,
    };
  }
  return {
    ...parsedState.diagnostics,
    parsingPending: parsedState.parsingPending,
  };
}

function canReusePendingDiagnostics(
  current: ParsedSourceFormatState,
  documentId: DocumentEffectTarget['documentId'],
  format: DocumentFormat,
  path: string | null,
  schemaKey: string,
): boolean {
  return current.documentId === documentId
    && current.format === format
    && current.path === path
    && current.schemaKey === schemaKey;
}

function jsonSchemaKey(schema: SourceFormatDiagnosticsOptions['jsonSchema']): string {
  if (!schema) return '';
  return canonicalFingerprint({ kind: schema.kind, source: schema.text });
}
