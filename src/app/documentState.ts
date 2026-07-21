import type { DocumentFormat } from '@sciemd/core';

export type EditorMode = 'visual' | 'source';

export type AutosaveStatus = 'idle' | 'pending' | 'paused' | 'saving' | 'saved' | 'error' | 'conflict';

export type LineEnding = 'lf' | 'crlf' | 'cr';
export type SourceLineEndings = LineEnding | 'mixed';
export type TextEncoding = 'utf8' | 'utf16le' | 'utf16be' | 'windows1252';
export type CloudFileState = 'local' | 'cloud-placeholder' | 'cloud-recall-on-open' | 'cloud-pinned' | 'unknown';
export type LosslessWriteStatus = 'yes' | 'no' | 'unknown';
export type SourceFidelityLossReason =
  | 'mixed-line-endings-without-map'
  | 'decode-replacement'
  | 'encoding-unrepresentable';

export interface FileMetadata {
  lineEnding: LineEnding;
  encoding: TextEncoding;
  hasBom: boolean;
  hasMixedLineEndings: boolean;
  lineEndings?: SourceLineEndings;
  decodeLossy?: boolean;
  losslessWrite?: LosslessWriteStatus;
  lossReasons?: SourceFidelityLossReason[];
  originalByteHash?: string | null;
  lastKnownMtimeMs: number;
  lastKnownSizeBytes: number;
  contentHash: string | null;
  cloudState: CloudFileState;
  /** Host-observed filesystem write protection; omitted by legacy/browser hosts. */
  readOnly?: boolean;
}

export interface ReadTextFileResponse {
  sourceEnvelope?: SourceEnvelope;
  sourceText?: string;
  /** @deprecated Native compatibility alias. Use sourceEnvelope.sourceText. */
  content: string;
  metadata: FileMetadata;
}

export interface SourceEnvelope {
  sourceText: string;
  savedSourceText: string;
  encoding: TextEncoding;
  bom: boolean;
  lineEndings: SourceLineEndings;
  dominantLineEnding: LineEnding;
  originalByteHash: string | null;
  losslessWrite: LosslessWriteStatus;
  lossReasons: readonly SourceFidelityLossReason[];
}

export type NormalizedFileMetadata = FileMetadata & Required<Pick<
  FileMetadata,
  'lineEndings' | 'decodeLossy' | 'losslessWrite' | 'lossReasons' | 'originalByteHash'
>>;

export interface CopyImageResponse {
  markdownPath: string;
  fileName: string;
  altText: string;
}

export const DEFAULT_METADATA: FileMetadata = {
  lineEnding: 'lf',
  encoding: 'utf8',
  hasBom: false,
  hasMixedLineEndings: false,
  lineEndings: 'lf',
  decodeLossy: false,
  losslessWrite: 'yes',
  lossReasons: [],
  originalByteHash: null,
  lastKnownMtimeMs: 0,
  lastKnownSizeBytes: 0,
  contentHash: null,
  cloudState: 'local',
  readOnly: false,
};

export function normalizeFileMetadata(metadata: Partial<FileMetadata>): NormalizedFileMetadata {
  const lineEnding = metadata.lineEnding === 'crlf' || metadata.lineEnding === 'cr'
    ? metadata.lineEnding
    : 'lf';
  const hasMixedLineEndings = metadata.hasMixedLineEndings ?? metadata.lineEndings === 'mixed';
  const decodeLossy = metadata.decodeLossy ?? false;
  const lossReasons = [...(metadata.lossReasons ?? [])] as SourceFidelityLossReason[];
  if (hasMixedLineEndings && !lossReasons.includes('mixed-line-endings-without-map')) {
    lossReasons.push('mixed-line-endings-without-map');
  }
  if (decodeLossy && !lossReasons.includes('decode-replacement')) {
    lossReasons.push('decode-replacement');
  }
  return {
    ...DEFAULT_METADATA,
    ...metadata,
    lineEnding,
    hasMixedLineEndings,
    lineEndings: hasMixedLineEndings ? 'mixed' : (metadata.lineEndings ?? lineEnding),
    decodeLossy,
    losslessWrite: metadata.losslessWrite ?? (lossReasons.length > 0 ? 'no' : 'unknown'),
    lossReasons,
    originalByteHash: metadata.originalByteHash ?? metadata.contentHash ?? null,
  };
}

export function createSourceEnvelope(
  sourceText: string,
  savedSourceText: string,
  metadata: FileMetadata,
): SourceEnvelope {
  const normalized = normalizeFileMetadata(metadata);
  const assessed = assessSourceWriteFidelity(sourceText, normalized);
  return {
    sourceText,
    savedSourceText,
    encoding: normalized.encoding,
    bom: normalized.hasBom,
    lineEndings: normalized.lineEndings ?? normalized.lineEnding,
    dominantLineEnding: normalized.lineEnding,
    originalByteHash: normalized.originalByteHash ?? null,
    losslessWrite: assessed.losslessWrite,
    lossReasons: assessed.lossReasons,
  };
}

export function readSourceEnvelope(response: ReadTextFileResponse): SourceEnvelope {
  return response.sourceEnvelope ?? createSourceEnvelope(
    response.sourceText ?? response.content,
    response.sourceText ?? response.content,
    normalizeFileMetadata(response.metadata),
  );
}

export function assessSourceWriteFidelity(
  sourceText: string,
  metadata: FileMetadata,
): Pick<SourceEnvelope, 'losslessWrite' | 'lossReasons'> {
  const normalized = normalizeFileMetadata(metadata);
  const reasons = [...(normalized.lossReasons ?? [])];
  if (normalized.hasMixedLineEndings && !reasons.includes('mixed-line-endings-without-map')) {
    reasons.push('mixed-line-endings-without-map');
  }
  if (normalized.decodeLossy && !reasons.includes('decode-replacement')) {
    reasons.push('decode-replacement');
  }
  if (normalized.encoding === 'windows1252'
    && !isWindows1252Representable(sourceText)
    && !reasons.includes('encoding-unrepresentable')) {
    reasons.push('encoding-unrepresentable');
  }
  return {
    losslessWrite: reasons.length > 0 ? 'no' : (normalized.losslessWrite ?? 'unknown'),
    lossReasons: reasons,
  };
}

export function metadataForUtf8Conversion(metadata: FileMetadata): FileMetadata {
  const normalized = normalizeFileMetadata(metadata);
  const lossReasons = (normalized.lossReasons ?? []).filter((reason) => reason !== 'encoding-unrepresentable');
  return {
    ...normalized,
    encoding: 'utf8',
    hasBom: false,
    losslessWrite: lossReasons.length > 0 ? 'no' : 'yes',
    lossReasons,
  };
}

function isWindows1252Representable(sourceText: string): boolean {
  for (const character of sourceText) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0xff) continue;
    if ([0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
      0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013,
      0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178].includes(codePoint)) continue;
    return false;
  }
  return true;
}

export const UNTITLED_NAME = 'Untitled.md';

const UNTITLED_EXTENSION_BY_FORMAT: Record<DocumentFormat, string> = {
  markdown: 'md',
  json: 'json',
  jsonl: 'jsonl',
  yaml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  csv: 'csv',
  tsv: 'tsv',
  plainText: 'txt',
};

export function isDirty(sourceText: string, lastSavedSourceText: string): boolean {
  return sourceText !== lastSavedSourceText;
}

export const isSourceDirty = isDirty;

export function untitledNameForFormat(format: DocumentFormat | null | undefined = 'markdown'): string {
  return `Untitled.${UNTITLED_EXTENSION_BY_FORMAT[format ?? 'markdown']}`;
}

export function displayNameForPath(
  filePath: string | null,
  format: DocumentFormat | null | undefined = 'markdown',
): string {
  if (!filePath) return untitledNameForFormat(format);
  return filePath.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? untitledNameForFormat(format);
}

export function basename(filePath: string | null): string {
  return displayNameForPath(filePath, 'markdown');
}

export interface WindowTitleProjection {
  filePath: string | null;
  format?: DocumentFormat | null;
  activeDirty: boolean;
  unsavedCount: number;
}

export function createWindowTitle(projection: WindowTitleProjection): string {
  const activeName = `${projection.activeDirty ? '* ' : ''}${displayNameForPath(projection.filePath, projection.format)}`;
  const aggregate = projection.unsavedCount > 0 ? ` · ${projection.unsavedCount} unsaved` : '';
  return `${activeName}${aggregate} - ScieMD`;
}

export function metadataChanged(
  known: FileMetadata | null,
  current: FileMetadata | null,
  toleranceMs = 0,
): boolean {
  if (!known || !current || known.lastKnownMtimeMs === 0) return false;
  if (known.contentHash && current.contentHash && known.contentHash !== current.contentHash) return true;
  const mtimeChanged = Math.abs(current.lastKnownMtimeMs - known.lastKnownMtimeMs) > toleranceMs;
  const sizeChanged = current.lastKnownSizeBytes !== known.lastKnownSizeBytes;
  return mtimeChanged || sizeChanged;
}

export function normalizeMarkdownInput(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
