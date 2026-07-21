import type { DocumentFormat, FormatAdapter, SourceEditorCapabilities } from './documentFormat';
import type { FormatContributionCatalog, FormatRuntimeBindingId } from './formatDefinitions';
import { formatContributionCatalog, formatContributionFor } from './formatDefinitions';
import { jsonAdapter } from './json/jsonAdapter';
import { jsonlAdapter } from './jsonl/jsonlAdapter';
import { markdownAdapter } from './markdown/markdownAdapter';
import { csvAdapter, tsvAdapter } from './tabular/tabularAdapter';
import { tomlAdapter } from './toml/tomlAdapter';
import { xmlAdapter } from './xml/xmlAdapter';
import { yamlAdapter } from './yaml/yamlAdapter';

export type { DocumentFormatDefinition, FormatContribution } from './formatDefinitions';
export {
  documentFormatDefinitions,
  extensionFromPath,
  formatContributionCatalog,
  formatContributionFor,
  formatDefinitionFor,
  formatFromMediaType,
  formatFromPath,
  isMarkdownFormat,
  isStructuredFormat,
  knownDocumentExtensions,
  validateFormatContributionCatalog,
} from './formatDefinitions';

export interface FormatRuntimeBinding {
  id: FormatRuntimeBindingId;
  format: DocumentFormat;
  adapter: FormatAdapter | null;
  sourceEditor: SourceEditorCapabilities;
}

const plainTextSourceEditor: SourceEditorCapabilities = {
  languageId: 'plainText',
  codeMirrorLanguage: 'plainText',
  codeMirrorLanguageAvailable: false,
  formatter: 'none',
  lintProfile: 'none',
  diagnosticsRangeSupport: 'none',
  commentSyntax: 'none',
  contextMenuOperations: ['copyText', 'copyLine', 'selectLine'],
  plainTextReason: 'Plain text has no parser-backed source metadata.',
};

export const formatRuntimeBindings: Readonly<Record<FormatRuntimeBindingId, FormatRuntimeBinding>> = {
  'markdown-adapter': binding('markdown-adapter', markdownAdapter),
  'json-adapter': binding('json-adapter', jsonAdapter),
  'jsonl-adapter': binding('jsonl-adapter', jsonlAdapter),
  'yaml-adapter': binding('yaml-adapter', yamlAdapter),
  'toml-adapter': binding('toml-adapter', tomlAdapter),
  'xml-adapter': binding('xml-adapter', xmlAdapter),
  'csv-adapter': binding('csv-adapter', csvAdapter),
  'tsv-adapter': binding('tsv-adapter', tsvAdapter),
  'plain-text-source': {
    id: 'plain-text-source',
    format: 'plainText',
    adapter: null,
    sourceEditor: plainTextSourceEditor,
  },
};

validateFormatRuntimeBindings(formatContributionCatalog, formatRuntimeBindings);

export function validateFormatRuntimeBindings(
  catalog: FormatContributionCatalog,
  bindings: Partial<Record<FormatRuntimeBindingId, FormatRuntimeBinding>>,
): void {
  const usedBindings = new Set<FormatRuntimeBindingId>();
  for (const contribution of catalog.formats) {
    const runtimeBinding = bindings[contribution.runtimeBindingId];
    if (!runtimeBinding) throw new Error(`Missing runtime binding ${contribution.runtimeBindingId} for ${contribution.format}.`);
    if (usedBindings.has(runtimeBinding.id)) throw new Error(`Runtime binding ${runtimeBinding.id} is used by more than one format.`);
    usedBindings.add(runtimeBinding.id);
    if (runtimeBinding.format !== contribution.format) {
      throw new Error(`Runtime binding ${runtimeBinding.id} targets ${runtimeBinding.format}, not ${contribution.format}.`);
    }
    if (runtimeBinding.sourceEditor.languageId !== contribution.sourceLanguageId) {
      throw new Error(`Runtime binding ${runtimeBinding.id} has the wrong source language ID.`);
    }
    const adapter = runtimeBinding.adapter;
    if (!adapter) {
      if (contribution.format !== 'plainText') throw new Error(`${contribution.format} requires a parser adapter.`);
      continue;
    }
    if (adapter.format !== contribution.format) throw new Error(`Adapter format disagrees with ${contribution.format}.`);
    if (adapter.label !== contribution.label) throw new Error(`Adapter label disagrees with ${contribution.format}.`);
    assertSameValues(adapter.extensions, contribution.extensions, `${contribution.format} extensions`);
    assertSameValues(adapter.mediaTypes, contribution.mediaTypes, `${contribution.format} media types`);
    const policy = contribution.runtimePolicy;
    if (adapter.capabilities.defaultMode !== policy.defaultMode) throw new Error(`${contribution.format} default mode disagrees with its adapter.`);
    if ((adapter.capabilities.parseBudgetBytes ?? null) !== policy.parseBudgetBytes) throw new Error(`${contribution.format} parse budget disagrees with its adapter.`);
    if ((adapter.capabilities.sourceOnlyFileBytes ?? adapter.capabilities.parseBudgetBytes ?? null) !== policy.sourceOnlyFileBytes) {
      throw new Error(`${contribution.format} source-only budget disagrees with its adapter.`);
    }
    const editableKinds = adapter.capabilities.visualSurfaces.filter((surface) => surface.editable && !surface.readonly).map(surfaceKindToContributionSurface);
    assertSameValues(editableKinds, contribution.workbench.editableSurfaces, `${contribution.format} editable surfaces`);
  }
}

export function runtimeBindingForFormat(format: DocumentFormat | null | undefined): FormatRuntimeBinding {
  const normalizedFormat = format ?? 'plainText';
  const contribution = formatContributionFor(normalizedFormat) ?? formatContributionFor('plainText');
  if (!contribution) throw new Error('The canonical format contribution catalog is missing plain text.');
  const runtimeBinding = formatRuntimeBindings[contribution.runtimeBindingId];
  if (!runtimeBinding) throw new Error(`Missing runtime binding ${contribution.runtimeBindingId} for ${contribution.format}.`);
  return runtimeBinding;
}

export function adapterForFormat(format: DocumentFormat | null | undefined): FormatAdapter | null {
  return runtimeBindingForFormat(format).adapter;
}

/**
 * @deprecated Runtime bindings are canonical and immutable. Retained so callers
 * that defensively register the already-bound adapter remain compatible.
 */
export function registerFormatAdapter(adapter: FormatAdapter): void {
  const canonicalAdapter = runtimeBindingForFormat(adapter.format).adapter;
  if (canonicalAdapter !== adapter) {
    throw new Error(`Format adapter ${adapter.format} must be declared by the canonical runtime bindings.`);
  }
}

export function sourceEditorCapabilitiesFor(format: DocumentFormat | null | undefined): SourceEditorCapabilities {
  return runtimeBindingForFormat(format).sourceEditor;
}

export function registeredFormatAdapters(): FormatAdapter[] {
  return formatContributionCatalog.formats
    .map((contribution) => formatRuntimeBindings[contribution.runtimeBindingId].adapter)
    .filter((adapter): adapter is FormatAdapter => adapter !== null);
}

function binding(id: FormatRuntimeBindingId, adapter: FormatAdapter): FormatRuntimeBinding {
  return { id, format: adapter.format, adapter, sourceEditor: adapter.capabilities.sourceEditor };
}

function surfaceKindToContributionSurface(surface: { kind: string }): 'markdownVisual' | 'structuredTree' | 'recordList' | 'tablePreview' {
  if (surface.kind === 'markdown') return 'markdownVisual';
  if (surface.kind === 'tree') return 'structuredTree';
  if (surface.kind === 'records') return 'recordList';
  if (surface.kind === 'table') return 'tablePreview';
  throw new Error(`Unknown adapter surface kind: ${surface.kind}.`);
}

function assertSameValues(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} disagree between the canonical contribution and runtime binding.`);
  }
}
