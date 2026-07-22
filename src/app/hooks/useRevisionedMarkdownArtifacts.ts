import { useEffect, useState } from 'react';
import { extractHeadings, parseEditorComments, parseProtectedBlocks, parseTargetedInstructions, parseVariantGroups } from '@sciemd/core';
import { analyzeMarkdownDocument } from '../../markdown/documentIntelligence';
import type { DocumentEffectTarget } from '../effects/documentEffectCoordinator';
import {
  acquireAnalysisSnapshot,
  analysisSourceFingerprint,
  canonicalFingerprint,
  documentAnalysisRuntime,
} from '../runtime/documentAnalysisRuntime';
import { documentAnalysisPolicy } from '../runtime/documentAnalysisPolicy';

interface MarkdownArtifactCapabilities {
  manuscript: boolean;
  annotations: boolean;
}

export interface RevisionedMarkdownArtifacts {
  baseDocumentInsights: ReturnType<typeof analyzeMarkdownDocument>;
  navigationHeadings: ReturnType<typeof extractHeadings>;
  editorComments: ReturnType<typeof parseEditorComments>;
  targetedInstructions: ReturnType<typeof parseTargetedInstructions>;
  protectedBlocks: ReturnType<typeof parseProtectedBlocks>;
  variantGroups: ReturnType<typeof parseVariantGroups>;
}

const EMPTY_ARTIFACTS: RevisionedMarkdownArtifacts = {
  baseDocumentInsights: analyzeMarkdownDocument(''),
  navigationHeadings: [],
  editorComments: [],
  targetedInstructions: [],
  protectedBlocks: [],
  variantGroups: [],
};

export function useRevisionedMarkdownArtifacts(
  target: DocumentEffectTarget,
  sourceText: string,
  capabilities: MarkdownArtifactCapabilities,
): RevisionedMarkdownArtifacts {
  const sourceFingerprint = analysisSourceFingerprint(target, sourceText);
  const dependencyFingerprint = canonicalFingerprint(capabilities);
  const [state, setState] = useState({
    documentId: target.documentId,
    sourceFingerprint: '',
    dependencyFingerprint: '',
    artifacts: EMPTY_ARTIFACTS,
  });

  useEffect(() => {
    const token = target.effects.begin(target.documentId, 'markdown-artifacts');
    if (!token) return undefined;
    documentAnalysisRuntime.cancelDocument(target.documentId, token.sourceRevision);
    const policy = documentAnalysisPolicy('markdown', 'document-parse', sourceText);
    if (policy.mode === 'unavailable') {
      target.effects.commit(token, () => setState({
        documentId: target.documentId,
        sourceFingerprint,
        dependencyFingerprint,
        artifacts: EMPTY_ARTIFACTS,
      }));
      return () => { target.effects.cancel(token); };
    }
    void documentAnalysisRuntime.request<RevisionedMarkdownArtifacts>({
      key: {
        documentId: target.documentId,
        sourceRevision: token.sourceRevision,
        analyzer: 'markdown-presentation',
        optionsFingerprint: canonicalFingerprint({ analyzer: 'markdown-presentation:v1', sourceFingerprint }),
        dependencyFingerprint,
      },
      priority: 'active',
      acquireSnapshot: () => acquireAnalysisSnapshot(target, token, sourceText),
      run: async (snapshot, signal) => {
        if (signal.aborted) throw new Error('Markdown presentation analysis was cancelled.');
        return {
          baseDocumentInsights: capabilities.manuscript ? analyzeMarkdownDocument(snapshot) : EMPTY_ARTIFACTS.baseDocumentInsights,
          navigationHeadings: capabilities.manuscript ? extractHeadings(snapshot) : [],
          editorComments: capabilities.annotations ? parseEditorComments(snapshot) : [],
          targetedInstructions: capabilities.annotations ? parseTargetedInstructions(snapshot) : [],
          protectedBlocks: capabilities.annotations ? parseProtectedBlocks(snapshot) : [],
          variantGroups: capabilities.annotations ? parseVariantGroups(snapshot) : [],
        };
      },
      budget: { maxArtifactBytes: 8 * 1024 * 1024, maxCollectionEntries: 16_000 },
    }).then((artifacts) => {
      target.effects.commit(token, () => setState({
        documentId: target.documentId,
        sourceFingerprint,
        dependencyFingerprint,
        artifacts,
      }));
    }).catch((error) => {
      if (!target.effects.isCurrent(token)) return;
      console.warn('Markdown presentation analysis could not complete.', error);
      target.effects.commit(token, () => undefined);
    });
    return () => { target.effects.cancel(token); };
  }, [capabilities.annotations, capabilities.manuscript, dependencyFingerprint, sourceFingerprint, sourceText, target.documentId, target.effects, target.leaseSource]);

  return state.documentId === target.documentId
    && state.sourceFingerprint === sourceFingerprint
    && state.dependencyFingerprint === dependencyFingerprint
    ? state.artifacts
    : state.documentId === target.documentId ? state.artifacts : EMPTY_ARTIFACTS;
}
