import {
  formatContributionFor,
  sourceEditorCapabilitiesFor,
  type DocumentFormat,
  type SourceEditorCapabilities,
} from '@sciemd/core';

export type SourceEditorLanguage = DocumentFormat;

export interface FormatUiCapabilities {
  canUseMarkdownToolbar: boolean;
  canUseVisualMarkdown: boolean;
  canUseReadonlyTree: boolean;
  canUseStructuredVisualMode: boolean;
  canEditStructuredVisualTree: boolean;
  canUseRecordList: boolean;
  canUseTablePreview: boolean;
  canUseManuscriptReadiness: boolean;
  canUseCitations: boolean;
  canUseVariablesPanel: boolean;
  canUseMarkdownExports: boolean;
  canUseImageInsertion: boolean;
  canUseLLMMarkdownMarkers: boolean;
  sourceLanguage: SourceEditorLanguage;
  sourceEditor: SourceEditorCapabilities;
}

export function formatCapabilitiesFor(
  format: DocumentFormat,
  hostCapabilities: { tomlNativePlanning?: boolean } = {},
): FormatUiCapabilities {
  const contribution = formatContributionFor(format);
  if (!contribution) throw new Error(`Missing format contribution for ${format}.`);
  const surfaces = new Set(contribution.workbench.surfaces);
  const editableSurfaces = new Set(contribution.workbench.editableSurfaces);
  const features = new Set(contribution.workbench.features);
  return {
    canUseMarkdownToolbar: features.has('markdownToolbar'),
    canUseVisualMarkdown: surfaces.has('markdownVisual'),
    canUseReadonlyTree: surfaces.has('structuredTree'),
    canUseStructuredVisualMode: surfaces.has('structuredTree'),
    canEditStructuredVisualTree: editableSurfaces.has('structuredTree')
      && (format !== 'toml' || hostCapabilities.tomlNativePlanning === true),
    canUseRecordList: surfaces.has('recordList'),
    canUseTablePreview: surfaces.has('tablePreview'),
    canUseManuscriptReadiness: features.has('manuscriptReadiness'),
    canUseCitations: features.has('citations'),
    canUseVariablesPanel: features.has('variablesPanel'),
    canUseMarkdownExports: features.has('markdownExports'),
    canUseImageInsertion: features.has('imageInsertion'),
    canUseLLMMarkdownMarkers: features.has('llmMarkdownMarkers'),
    sourceLanguage: contribution.sourceLanguageId,
    sourceEditor: sourceEditorCapabilitiesFor(contribution.sourceLanguageId),
  };
}

export const MARKDOWN_UI_CAPABILITIES: FormatUiCapabilities = formatCapabilitiesFor('markdown');
