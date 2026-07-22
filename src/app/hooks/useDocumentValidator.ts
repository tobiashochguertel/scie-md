import { useCallback, useEffect, useState } from 'react';
import type { MarkdownValidation } from '../../markdown/markdownValidation';
import { validateMarkdown } from '../../markdown/markdownValidation';
import type { ParsedScienfyDocument } from '@sciemd/core';
import type { DocumentEffectTarget } from '../effects/documentEffectCoordinator';
import {
  acquireAnalysisSnapshot,
  analysisSourceFingerprint,
  canonicalFingerprint,
  documentAnalysisRuntime,
} from '../runtime/documentAnalysisRuntime';

interface ValidationState {
  documentId: DocumentEffectTarget['documentId'];
  sourceFingerprint: string;
  validation: MarkdownValidation;
  pending: boolean;
}

export function useDocumentValidator(
  target: DocumentEffectTarget,
  markdown: string,
  parsedDocument: ParsedScienfyDocument,
  parsedMarkdown = markdown,
) {
  const currentParsedDocument = parsedMarkdown === markdown ? parsedDocument : undefined;
  const sourceFingerprint = analysisSourceFingerprint(target, markdown);
  const parsedFingerprint = currentParsedDocument
    ? canonicalFingerprint({
        diagnostics: currentParsedDocument.diagnostics,
        directives: currentParsedDocument.directives,
      })
    : 'parsed:pending';
  const [state, setState] = useState<ValidationState>(() => ({
    documentId: target.documentId,
    sourceFingerprint: '',
    validation: validateMarkdown('', 0),
    pending: true,
  }));

  useEffect(() => {
    const token = target.effects.begin(target.documentId, 'document-validation');
    if (!token) return undefined;
    documentAnalysisRuntime.cancelDocument(target.documentId, token.sourceRevision);
    target.effects.apply(token, () => setState((current) => ({
      ...current,
      documentId: target.documentId,
      sourceFingerprint,
      pending: true,
    })));
    const timer = window.setTimeout(() => {
      void documentAnalysisRuntime.request<MarkdownValidation>({
        key: {
          documentId: target.documentId,
          sourceRevision: token.sourceRevision,
          analyzer: 'markdown-validation',
          optionsFingerprint: canonicalFingerprint({ analyzer: 'markdown-validation:v1', sourceFingerprint }),
          dependencyFingerprint: parsedFingerprint,
        },
        priority: 'active',
        acquireSnapshot: () => acquireAnalysisSnapshot(target, token, markdown),
        run: async (sourceText, signal) => {
          if (signal.aborted) throw new Error('Markdown validation was cancelled.');
          return validateMarkdown(sourceText, undefined, currentParsedDocument);
        },
      }).then((validation) => {
        target.effects.commit(token, () => setState({
          documentId: target.documentId,
          sourceFingerprint,
          validation,
          pending: false,
        }));
      }).catch((error) => {
        if (!target.effects.isCurrent(token)) return;
        console.warn('Markdown validation could not complete; source editing remains available.', error);
        target.effects.commit(token, () => setState((current) => ({ ...current, pending: false })));
      });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      target.effects.cancel(token);
    };
  }, [currentParsedDocument, markdown, parsedFingerprint, sourceFingerprint, target.documentId, target.effects, target.leaseSource]);

  const validateNow = useCallback((nextMarkdown = markdown, sizeBytes?: number, nextParsedDocument?: ParsedScienfyDocument) => {
    const nextValidation = validateMarkdown(nextMarkdown, sizeBytes, nextParsedDocument ?? (
      nextMarkdown === markdown ? currentParsedDocument : undefined
    ));
    const token = target.effects.begin(target.documentId, 'document-validation');
    if (token) target.effects.commit(token, () => setState({
      documentId: target.documentId,
      sourceFingerprint: canonicalFingerprint(nextMarkdown),
      validation: nextValidation,
      pending: false,
    }));
    return nextValidation;
  }, [currentParsedDocument, markdown, target.documentId, target.effects]);

  const current = state.documentId === target.documentId && state.sourceFingerprint === sourceFingerprint;
  return {
    validation: state.documentId === target.documentId ? state.validation : validateMarkdown('', 0),
    validateNow,
    validationPending: current ? state.pending : true,
  };
}
