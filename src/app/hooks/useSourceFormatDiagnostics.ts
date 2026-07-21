import { useDeferredValue, useEffect, useState } from 'react';
import type { DocumentFormat } from '@sciemd/core';
import { cancelFormatDocumentParse, isTransientFormatParserWorkerFailure, parseFormatDocumentAsync } from '../../domain/formats/formatParserWorker';
import type { DocumentEffectTarget } from '../effects/documentEffectCoordinator';
import {
  createFormatParserFailureDiagnosticState,
  parseSourceFormatDiagnostics,
  shouldUseSourceOnlyFormatParsing,
  sourceFormatDiagnosticsFromParseResult,
} from '../formatDiagnostics';
import type { SourceFormatDiagnosticState, SourceFormatDiagnosticsOptions } from '../formatDiagnostics';

export interface AsyncSourceFormatDiagnosticState extends SourceFormatDiagnosticState {
  parsingPending: boolean;
}

interface ParsedSourceFormatState {
  documentId: DocumentEffectTarget['documentId'];
  format: DocumentFormat;
  text: string;
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
  options: SourceFormatDiagnosticsOptions = {},
): AsyncSourceFormatDiagnosticState {
  const deferredText = useDeferredValue(text);
  const deferredJsonSchema = useDeferredValue(options.jsonSchema ?? null);
  const [parsedState, setParsedState] = useState<ParsedSourceFormatState>(() => ({
    documentId: target.documentId,
    format: 'markdown',
    text: '',
    path: null,
    schemaKey: '',
    diagnostics: EMPTY_SOURCE_DIAGNOSTICS,
    parsingPending: false,
  }));

  useEffect(() => {
    const token = target.effects.begin(target.documentId, 'source-format-diagnostics');
    if (!token) return undefined;
    const schemaKey = jsonSchemaKey(deferredJsonSchema);
    if (format === 'markdown') {
      target.effects.commit(token, () => setParsedState((current) => current.documentId === target.documentId && current.format === 'markdown' && !current.parsingPending
        ? current
        : {
          documentId: target.documentId,
          format,
          text: deferredText,
          path,
          schemaKey,
          diagnostics: EMPTY_SOURCE_DIAGNOSTICS,
          parsingPending: false,
        }));
      return undefined;
    }

    if (shouldUseSourceOnlyFormatParsing(format, deferredText)) {
      target.effects.commit(token, () => setParsedState({
        documentId: target.documentId,
        format,
        text: deferredText,
        path,
        schemaKey,
        diagnostics: parseSourceFormatDiagnostics(format, deferredText, path, { jsonSchema: deferredJsonSchema }),
        parsingPending: false,
      }));
      return undefined;
    }

    target.effects.apply(token, () => setParsedState((current) => ({
      documentId: target.documentId,
      format,
      text: deferredText,
      path,
      schemaKey,
      diagnostics: canReusePendingDiagnostics(current, target.documentId, format, path, schemaKey)
        ? current.diagnostics
        : EMPTY_SOURCE_DIAGNOSTICS,
      parsingPending: true,
    })));
    const parsePromise = format === 'json'
      ? parseFormatDocumentAsync(format, deferredText, path, { schema: deferredJsonSchema }, token)
      : parseFormatDocumentAsync(format, deferredText, path, {}, token);
    void parsePromise
      .then((parseResult) => {
        target.effects.commit(token, () => setParsedState({
          documentId: target.documentId,
          format,
          text: deferredText,
          path,
          schemaKey,
          diagnostics: sourceFormatDiagnosticsFromParseResult(parseResult),
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
            text: deferredText,
            path,
            schemaKey,
            diagnostics: createFormatParserFailureDiagnosticState(format, deferredText, path, error),
            parsingPending: false,
          }));
          return;
        }
        console.warn('Format parser worker failed; falling back to synchronous diagnostics.', error);
        target.effects.commit(token, () => setParsedState({
          documentId: target.documentId,
          format,
          text: deferredText,
          path,
          schemaKey,
          diagnostics: parseSourceFormatDiagnostics(format, deferredText, path, { jsonSchema: deferredJsonSchema }),
          parsingPending: false,
        }));
      });
    return () => {
      cancelFormatDocumentParse(token);
      target.effects.cancel(token);
    };
  }, [deferredJsonSchema, deferredText, format, path, target.documentId, target.effects]);

  if (format === 'markdown') return { ...EMPTY_SOURCE_DIAGNOSTICS, parsingPending: false };
  const schemaKey = jsonSchemaKey(options.jsonSchema ?? null);
  const sameDocument = parsedState.documentId === target.documentId
    && parsedState.format === format
    && parsedState.path === path
    && parsedState.schemaKey === schemaKey;
  if (!sameDocument) return { ...EMPTY_SOURCE_DIAGNOSTICS, parsingPending: true };
  const current = parsedState.text === text;
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
  return `${schema.kind}:${schema.path ?? ''}:${schema.text.length}:${schema.text.slice(0, 128)}`;
}
