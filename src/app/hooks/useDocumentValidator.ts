import { useCallback, useEffect, useState } from 'react';
import type { MarkdownValidation } from '../../markdown/markdownValidation';
import { validateMarkdown } from '../../markdown/markdownValidation';
import type { ParsedScienfyDocument } from '@sciemd/core';
import type { DocumentEffectTarget } from '../effects/documentEffectCoordinator';

interface ValidationState {
  documentId: DocumentEffectTarget['documentId'];
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
  const [state, setState] = useState<ValidationState>(() => ({
    documentId: target.documentId,
    validation: validateMarkdown(markdown, undefined, currentParsedDocument),
    pending: false,
  }));

  useEffect(() => {
    const token = target.effects.begin(target.documentId, 'document-validation');
    if (!token) return undefined;
    target.effects.apply(token, () => setState((current) => ({ ...current, documentId: target.documentId, pending: true })));
    const timer = window.setTimeout(() => {
      target.effects.commit(token, () => setState({
        documentId: target.documentId,
        validation: validateMarkdown(markdown, undefined, currentParsedDocument),
        pending: false,
      }));
    }, 500);
    return () => {
      window.clearTimeout(timer);
      target.effects.cancel(token);
    };
  }, [currentParsedDocument, markdown, target.documentId, target.effects]);

  const validateNow = useCallback((nextMarkdown = markdown, sizeBytes?: number, nextParsedDocument?: ParsedScienfyDocument) => {
    const nextValidation = validateMarkdown(nextMarkdown, sizeBytes, nextParsedDocument ?? (
      nextMarkdown === markdown ? currentParsedDocument : undefined
    ));
    const token = target.effects.begin(target.documentId, 'document-validation');
    if (token) target.effects.commit(token, () => setState({ documentId: target.documentId, validation: nextValidation, pending: false }));
    return nextValidation;
  }, [currentParsedDocument, markdown, target.documentId, target.effects]);

  const current = state.documentId === target.documentId;
  return {
    validation: current ? state.validation : validateMarkdown(markdown, undefined, currentParsedDocument),
    validateNow,
    validationPending: current ? state.pending : true,
  };
}
