import { useEffect, useState } from 'react';
import type { DocumentEffectTarget } from '../effects/documentEffectCoordinator';
import type { RendererDocumentMetrics } from './useRendererDiagnostics';
import { summarizeSourceTextForDiagnostics } from './useRendererDiagnostics';
import {
  acquireAnalysisSnapshot,
  analysisSourceFingerprint,
  canonicalFingerprint,
  documentAnalysisRuntime,
} from '../runtime/documentAnalysisRuntime';

const EMPTY_METRICS: RendererDocumentMetrics = {
  sourceTextBytes: 0,
  lineCount: 0,
  imageCount: 0,
  mathCount: 0,
};

export function useRevisionedDocumentMetrics(target: DocumentEffectTarget, sourceText: string): RendererDocumentMetrics {
  const sourceFingerprint = analysisSourceFingerprint(target, sourceText);
  const [state, setState] = useState({
    documentId: target.documentId,
    sourceFingerprint: '',
    metrics: EMPTY_METRICS,
  });

  useEffect(() => {
    const token = target.effects.begin(target.documentId, 'document-metrics');
    if (!token) return undefined;
    documentAnalysisRuntime.cancelDocument(target.documentId, token.sourceRevision);
    void documentAnalysisRuntime.request<RendererDocumentMetrics>({
      key: {
        documentId: target.documentId,
        sourceRevision: token.sourceRevision,
        analyzer: 'document-metrics',
        optionsFingerprint: canonicalFingerprint({ analyzer: 'document-metrics:v1', sourceFingerprint }),
        dependencyFingerprint: '',
      },
      priority: 'active',
      acquireSnapshot: () => acquireAnalysisSnapshot(target, token, sourceText),
      run: async (snapshot, signal) => {
        if (signal.aborted) throw new Error('Document metrics were cancelled.');
        return summarizeSourceTextForDiagnostics(snapshot);
      },
    }).then((metrics) => {
      target.effects.commit(token, () => setState({ documentId: target.documentId, sourceFingerprint, metrics }));
    }).catch((error) => {
      if (!target.effects.isCurrent(token)) return;
      console.warn('Document metrics could not complete.', error);
      target.effects.commit(token, () => undefined);
    });
    return () => { target.effects.cancel(token); };
  }, [sourceFingerprint, sourceText, target.documentId, target.effects, target.leaseSource]);

  return state.documentId === target.documentId ? state.metrics : EMPTY_METRICS;
}
