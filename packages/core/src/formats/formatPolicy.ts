import type {
  DocumentFormat,
  FormatCapabilities,
  FormatDiagnostic,
  FormatParseResult,
  StructuredVisualSurface,
} from './documentFormat.js';
import { createDocumentContent } from './documentFormat.js';
import { formatContributionFor, formatDefinitionFor } from './formatDefinitions.js';

export const DEFAULT_STRUCTURED_PARSE_BUDGET_BYTES = 1 * 1024 * 1024;
export const STRUCTURED_TEXT_INGRESS_BUDGET_BYTES = 5 * 1024 * 1024;
export const STRUCTURED_CLIPBOARD_INGRESS_BUDGET_BYTES = 5 * 1024 * 1024;

export interface CanonicalizedIngressText {
  text: string;
  strippedBom: boolean;
}

export interface FormatRuntimePolicy {
  format: DocumentFormat;
  defaultMode: 'visual' | 'source';
  parseBudgetBytes: number | null;
  sourceOnlyFileBytes: number | null;
  browserTextIngressBudgetBytes: number;
  clipboardIngressBudgetBytes: number;
  canOpenAsDocument: boolean;
  canPreview: boolean;
  canImport: boolean;
  canUseVisualTree: boolean;
  canUseRecordList: boolean;
  canUseTablePreview: boolean;
  canEditVisually: boolean;
  canApplyClipboardReplace: boolean;
  sourceOnlyByDefault: boolean;
}

export function formatRuntimePolicyFor(format: DocumentFormat | null | undefined): FormatRuntimePolicy {
  const normalizedFormat = format ?? 'plainText';
  const contribution = formatContributionFor(normalizedFormat) ?? formatContributionFor('plainText');
  if (!contribution) throw new Error('The canonical format contribution catalog is missing plain text.');
  const declaration = contribution.runtimePolicy;
  const { parseBudgetBytes, sourceOnlyFileBytes } = declaration;
  const surfaces = new Set(contribution.workbench.surfaces);
  return {
    format: normalizedFormat,
    defaultMode: declaration.defaultMode,
    parseBudgetBytes,
    sourceOnlyFileBytes,
    browserTextIngressBudgetBytes: Math.max(sourceOnlyFileBytes ?? 0, STRUCTURED_TEXT_INGRESS_BUDGET_BYTES),
    clipboardIngressBudgetBytes: STRUCTURED_CLIPBOARD_INGRESS_BUDGET_BYTES,
    canOpenAsDocument: declaration.canOpenAsDocument,
    canPreview: declaration.canPreview,
    canImport: declaration.canImport,
    canUseVisualTree: surfaces.has('structuredTree'),
    canUseRecordList: surfaces.has('recordList'),
    canUseTablePreview: surfaces.has('tablePreview'),
    canEditVisually: contribution.workbench.editableSurfaces.length > 0,
    canApplyClipboardReplace: declaration.canApplyClipboardReplace,
    sourceOnlyByDefault: declaration.sourceOnlyByDefault,
  };
}

export function formatParseBudgetBytes(format: DocumentFormat | null | undefined): number | null {
  return formatRuntimePolicyFor(format).parseBudgetBytes;
}

export function formatSourceOnlyFileBytes(format: DocumentFormat | null | undefined): number | null {
  return formatRuntimePolicyFor(format).sourceOnlyFileBytes;
}

export function formatBrowserTextIngressBudgetBytes(format: DocumentFormat | null | undefined): number {
  return formatRuntimePolicyFor(format).browserTextIngressBudgetBytes;
}

export function formatClipboardIngressBudgetBytes(format: DocumentFormat | null | undefined): number {
  return formatRuntimePolicyFor(format).clipboardIngressBudgetBytes;
}

export function formatExceedsParseBudget(format: DocumentFormat | null | undefined, text: string): boolean {
  const budget = formatParseBudgetBytes(format);
  return budget !== null && formatByteLengthUtf8(text) > budget;
}

export function formatByteLengthUtf8(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit < 0x80) bytes += 1;
    else if (codeUnit < 0x800) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${Math.round(bytes / 1024 / 1024)} MiB`;
}

export function canonicalizeStructuredIngressText(text: string): CanonicalizedIngressText {
  return text.charCodeAt(0) === 0xfeff
    ? { text: text.slice(1), strippedBom: true }
    : { text, strippedBom: false };
}

export function createSourceOnlyFormatParseResult<TParsed = unknown>(
  format: DocumentFormat,
  text: string,
  path: string | null,
  message = defaultSourceOnlyMessage(format),
  code = `${format}-source-only-large-file`,
): FormatParseResult<TParsed> {
  const diagnostic: FormatDiagnostic = {
    severity: 'warning',
    code,
    message,
    source: format,
  };
  return {
    format,
    content: createDocumentContent(format, text, path),
    parsed: null,
    diagnostics: [diagnostic],
    sourceOnly: true,
  };
}

export function editableStructuredSurfaces(capabilities: FormatCapabilities | null | undefined): StructuredVisualSurface[] {
  return (capabilities?.visualSurfaces ?? []).filter((surface) => surface.editable && !surface.readonly);
}

function defaultSourceOnlyMessage(format: DocumentFormat): string {
  const budget = formatParseBudgetBytes(format);
  const label = formatDefinitionFor(format)?.label ?? format.toUpperCase();
  return budget === null
    ? `${label} parsing is disabled for this document. Source editing remains available.`
    : `${label} exceeds the ${formatBytes(budget)} background parse budget. Source editing remains available; visual inspection is disabled for this file.`;
}
