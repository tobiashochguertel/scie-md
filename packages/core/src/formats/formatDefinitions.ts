import rawFormatCatalog from './formatCatalog.v1.json';
import type { DocumentFormat } from './documentFormat';
import { validateStructuredMutationCoverage } from './structured/structuredMutation';

export type FormatRuntimeBindingId =
  | 'markdown-adapter'
  | 'json-adapter'
  | 'jsonl-adapter'
  | 'yaml-adapter'
  | 'toml-adapter'
  | 'xml-adapter'
  | 'csv-adapter'
  | 'tsv-adapter'
  | 'plain-text-source';

export type FormatWorkbenchSurface = 'markdownVisual' | 'structuredTree' | 'recordList' | 'tablePreview';
export type FormatWorkbenchFeature =
  | 'markdownToolbar'
  | 'manuscriptReadiness'
  | 'citations'
  | 'variablesPanel'
  | 'markdownExports'
  | 'imageInsertion'
  | 'llmMarkdownMarkers';
export type FormatNativePolicy = 'include' | 'exclude';

export interface FormatContributionRuntimePolicy {
  defaultMode: 'visual' | 'source';
  parseBudgetBytes: number | null;
  sourceOnlyFileBytes: number | null;
  canOpenAsDocument: boolean;
  canPreview: boolean;
  canImport: boolean;
  canApplyClipboardReplace: boolean;
  sourceOnlyByDefault: boolean;
}

export interface FormatContribution {
  format: DocumentFormat;
  label: string;
  extensions: readonly string[];
  mediaTypes: readonly string[];
  structured: boolean;
  runtimeBindingId: FormatRuntimeBindingId;
  sourceLanguageId: DocumentFormat;
  runtimePolicy: FormatContributionRuntimePolicy;
  workbench: {
    surfaces: readonly FormatWorkbenchSurface[];
    editableSurfaces: readonly FormatWorkbenchSurface[];
    features: readonly FormatWorkbenchFeature[];
  };
  native: {
    openPicker: FormatNativePolicy;
    launch: FormatNativePolicy;
    osAssociation: FormatNativePolicy;
    exclusionReason?: string;
  };
}

export interface FormatContributionCatalog {
  version: 1;
  formats: readonly FormatContribution[];
}

/** @deprecated Use FormatContribution. */
export type DocumentFormatDefinition = FormatContribution;

const DOCUMENT_FORMATS: readonly DocumentFormat[] = [
  'markdown',
  'json',
  'jsonl',
  'yaml',
  'toml',
  'xml',
  'csv',
  'tsv',
  'plainText',
];
const RUNTIME_BINDING_IDS: readonly FormatRuntimeBindingId[] = [
  'markdown-adapter', 'json-adapter', 'jsonl-adapter', 'yaml-adapter', 'toml-adapter',
  'xml-adapter', 'csv-adapter', 'tsv-adapter', 'plain-text-source',
];
const WORKBENCH_SURFACES: readonly FormatWorkbenchSurface[] = ['markdownVisual', 'structuredTree', 'recordList', 'tablePreview'];
const WORKBENCH_FEATURES: readonly FormatWorkbenchFeature[] = [
  'markdownToolbar', 'manuscriptReadiness', 'citations', 'variablesPanel',
  'markdownExports', 'imageInsertion', 'llmMarkdownMarkers',
];

export const formatContributionCatalog = validateFormatContributionCatalog(rawFormatCatalog);
export const documentFormatDefinitions = formatContributionCatalog.formats;

export const knownDocumentExtensions = Object.freeze(
  Array.from(new Set(documentFormatDefinitions.flatMap((definition) => definition.extensions))).sort(),
);

const formatById = new Map(documentFormatDefinitions.map((definition) => [definition.format, definition]));
const formatByExtension = new Map<string, DocumentFormat>();
const formatByMediaType = new Map<string, DocumentFormat>();

for (const definition of documentFormatDefinitions) {
  for (const extension of definition.extensions) formatByExtension.set(extension, definition.format);
  for (const mediaType of definition.mediaTypes) formatByMediaType.set(mediaType, definition.format);
}

export function validateFormatContributionCatalog(input: unknown): FormatContributionCatalog {
  if (!isRecord(input) || input.version !== 1 || !Array.isArray(input.formats)) {
    throw new Error('Format contribution catalog must be a version 1 object with a formats array.');
  }

  const formats = input.formats as unknown[];
  const seenFormats = new Set<string>();
  const seenExtensions = new Set<string>();
  const seenMediaTypes = new Set<string>();

  for (const raw of formats) {
    if (!isRecord(raw) || typeof raw.format !== 'string' || !DOCUMENT_FORMATS.includes(raw.format as DocumentFormat)) {
      throw new Error(`Format contribution has an unknown format ID: ${String(isRecord(raw) ? raw.format : raw)}.`);
    }
    const format = raw.format;
    if (seenFormats.has(format)) throw new Error(`Format contribution is duplicated: ${format}.`);
    seenFormats.add(format);
    assertNonEmptyString(raw.label, `${format}.label`);
    assertUniqueStrings(raw.extensions, `${format}.extensions`, seenExtensions);
    assertUniqueStrings(raw.mediaTypes, `${format}.mediaTypes`, seenMediaTypes);
    if (typeof raw.structured !== 'boolean') throw new Error(`${format}.structured must be boolean.`);
    if (typeof raw.runtimeBindingId !== 'string' || !RUNTIME_BINDING_IDS.includes(raw.runtimeBindingId as FormatRuntimeBindingId)) {
      throw new Error(`${format}.runtimeBindingId is invalid.`);
    }
    if (raw.sourceLanguageId !== format) throw new Error(`${format}.sourceLanguageId must match its format ID.`);
    validateRuntimePolicy(format, raw.runtimePolicy);
    validateWorkbenchPolicy(format, raw.workbench, raw.runtimePolicy);
    validateNativePolicy(format, raw.native);
  }

  const missing = DOCUMENT_FORMATS.filter((format) => !seenFormats.has(format));
  if (missing.length > 0) throw new Error(`Format contribution catalog is missing: ${missing.join(', ')}.`);
  if (formats.length !== DOCUMENT_FORMATS.length) throw new Error('Format contribution catalog contains unsupported entries.');
  validateStructuredMutationCoverage(formats as unknown as FormatContribution[]);
  return input as unknown as FormatContributionCatalog;
}

export function formatDefinitionFor(format: DocumentFormat | null | undefined): FormatContribution | null {
  if (!format) return null;
  return formatById.get(format) ?? null;
}

export const formatContributionFor = formatDefinitionFor;

export function requiredFormatContributionFor(format: DocumentFormat): FormatContribution {
  const contribution = formatContributionFor(format);
  if (!contribution) throw new Error(`Missing canonical format contribution for ${format}.`);
  return contribution;
}

export function formatAdapterIdentity(format: DocumentFormat): Pick<FormatContribution, 'format' | 'label' | 'extensions' | 'mediaTypes'> {
  const { label, extensions, mediaTypes } = requiredFormatContributionFor(format);
  return { format, label, extensions, mediaTypes };
}

export function requiredFormatParseBudgetBytes(format: DocumentFormat): number {
  const budget = requiredFormatContributionFor(format).runtimePolicy.parseBudgetBytes;
  if (budget === null) throw new Error(`${format} does not declare a parse budget.`);
  return budget;
}

export function formatFromPath(path: string | null | undefined): DocumentFormat | null {
  const extension = extensionFromPath(path);
  if (!extension) return null;
  return formatByExtension.get(extension) ?? null;
}

export function formatFromMediaType(mediaType: string | null | undefined): DocumentFormat | null {
  const normalized = normalizeMediaType(mediaType);
  if (!normalized) return null;
  if (normalized.endsWith('+json')) return 'json';
  if (normalized.endsWith('+xml')) return 'xml';
  return formatByMediaType.get(normalized) ?? null;
}

export function isMarkdownFormat(format: DocumentFormat | null | undefined): boolean {
  return format === 'markdown';
}

export function isStructuredFormat(format: DocumentFormat | null | undefined): boolean {
  return formatDefinitionFor(format)?.structured === true;
}

export function extensionFromPath(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, '/').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const fileName = normalized.split('/').at(-1) ?? '';
  if (!fileName || (fileName.startsWith('.') && !fileName.slice(1).includes('.'))) return null;
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return null;
  return fileName.slice(dotIndex + 1).toLowerCase();
}

function validateRuntimePolicy(format: string, value: unknown): asserts value is FormatContributionRuntimePolicy {
  if (!isRecord(value)) throw new Error(`${format}.runtimePolicy must be an object.`);
  if (value.defaultMode !== 'visual' && value.defaultMode !== 'source') {
    throw new Error(`${format}.runtimePolicy.defaultMode is invalid.`);
  }
  for (const key of ['parseBudgetBytes', 'sourceOnlyFileBytes'] as const) {
    const budget = value[key];
    if (budget !== null && (typeof budget !== 'number' || !Number.isInteger(budget) || budget <= 0)) {
      throw new Error(`${format}.runtimePolicy.${key} must be null or a positive integer.`);
    }
  }
  for (const key of ['canOpenAsDocument', 'canPreview', 'canImport', 'canApplyClipboardReplace', 'sourceOnlyByDefault'] as const) {
    if (typeof value[key] !== 'boolean') throw new Error(`${format}.runtimePolicy.${key} must be boolean.`);
  }
  if (value.canImport && !value.canOpenAsDocument) {
    throw new Error(`${format} cannot allow import while document opening is disabled.`);
  }
  if (value.sourceOnlyByDefault && value.defaultMode !== 'source') {
    throw new Error(`${format} cannot be source-only while defaulting to visual mode.`);
  }
}

function validateWorkbenchPolicy(format: string, value: unknown, runtimePolicy: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.surfaces) || !Array.isArray(value.editableSurfaces) || !Array.isArray(value.features)) {
    throw new Error(`${format}.workbench must declare surfaces, editableSurfaces, and features.`);
  }
  assertAllowedStrings(value.surfaces, WORKBENCH_SURFACES, `${format}.workbench.surfaces`);
  assertAllowedStrings(value.editableSurfaces, WORKBENCH_SURFACES, `${format}.workbench.editableSurfaces`);
  assertAllowedStrings(value.features, WORKBENCH_FEATURES, `${format}.workbench.features`);
  const surfaces = new Set(value.surfaces);
  for (const surface of value.editableSurfaces) {
    if (!surfaces.has(surface)) throw new Error(`${format} declares editable surface ${String(surface)} without exposing it.`);
  }
  if (isRecord(runtimePolicy)) {
    if (value.surfaces.length > 0 && runtimePolicy.canPreview !== true) {
      throw new Error(`${format} exposes workbench surfaces while preview is disabled.`);
    }
    if (value.editableSurfaces.length > 0 && runtimePolicy.sourceOnlyByDefault === true) {
      throw new Error(`${format} cannot expose editable visual surfaces while source-only by default.`);
    }
    if (runtimePolicy.defaultMode === 'visual' && value.surfaces.length === 0) {
      throw new Error(`${format} defaults to visual mode without a workbench surface.`);
    }
    if (runtimePolicy.canApplyClipboardReplace === true && value.editableSurfaces.length === 0) {
      throw new Error(`${format} allows clipboard replacement without an editable surface.`);
    }
  }
}

function validateNativePolicy(format: string, value: unknown): void {
  if (!isRecord(value)) throw new Error(`${format}.native must be an object.`);
  for (const key of ['openPicker', 'launch', 'osAssociation'] as const) {
    if (value[key] !== 'include' && value[key] !== 'exclude') throw new Error(`${format}.native.${key} is invalid.`);
  }
  const hasExclusion = value.openPicker === 'exclude' || value.launch === 'exclude' || value.osAssociation === 'exclude';
  if (hasExclusion && (typeof value.exclusionReason !== 'string' || value.exclusionReason.trim() === '')) {
    throw new Error(`${format}.native exclusions require an exclusionReason.`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string.`);
}

function assertUniqueStrings(value: unknown, label: string, globalValues: Set<string>): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty string array.`);
  const localValues = new Set<string>();
  for (const item of value) {
    assertNonEmptyString(item, label);
    if (item !== item.toLowerCase()) throw new Error(`${label} values must be lowercase: ${item}.`);
    if (localValues.has(item) || globalValues.has(item)) throw new Error(`${label} contains duplicate value: ${item}.`);
    localValues.add(item);
    globalValues.add(item);
  }
}

function assertAllowedStrings<T extends string>(value: unknown[], allowed: readonly T[], label: string): asserts value is T[] {
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.includes(item as T)) throw new Error(`${label} contains invalid value: ${String(item)}.`);
    if (seen.has(item)) throw new Error(`${label} contains duplicate value: ${item}.`);
    seen.add(item);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeMediaType(mediaType: string | null | undefined): string | null {
  const normalized = mediaType?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized || null;
}
