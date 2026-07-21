import { requiredFormatContributionFor, type DocumentFormat } from '@sciemd/core';
import {
  createUntitledLocator,
  fallbackFileLocator,
  sourceRevision,
  type DocumentId,
  type DocumentLocator,
  type SourceRevision,
} from '../app/documentIdentity';
import {
  checkpointRecoveryEntry,
  checkpointRecoveryEntrySync,
  flushRecoveryCatalogForTests,
  loadRecoveryCatalog,
} from './recoveryCatalog';

export interface RawDocumentRescueSnapshot {
  documentId: DocumentId;
  sourceText: string;
  /** @deprecated Use sourceText. */
  markdown: string;
  filePath: string | null;
  format: DocumentFormat;
  sourceRevision: SourceRevision;
  updatedAt: number;
}

const SESSION_CATALOG_KEY = 'scie-md:raw-document-rescue-catalog:v1';
const LEGACY_SESSION_SNAPSHOT_KEY = 'scie-md:raw-document-rescue';
export const RAW_RESCUE_SESSION_STORAGE_MAX_BYTES = 512 * 1024;
export const RAW_RESCUE_NATIVE_MAX_BYTES = 64 * 1024 * 1024;
const RAW_RESCUE_TRUNCATED_SECTION_CHARS = 1024 * 1024;

export function updateRawDocumentRescue(
  sourceText: string,
  filePath: string | null,
  options: {
    documentId?: DocumentId;
    locator?: DocumentLocator;
    format?: DocumentFormat;
    sourceRevision?: SourceRevision;
  } = {},
): void {
  const documentId = options.documentId ?? compatibilityDocumentId(filePath);
  const locator = options.locator ?? (filePath ? fallbackFileLocator(filePath) : compatibilityUntitledLocator());
  const format = options.format ?? 'markdown';
  const revision = options.sourceRevision ?? sourceRevision(0);
  const updatedAt = Date.now();
  const policy = rawDocumentRescuePolicy(sourceText);
  const snapshot: RawDocumentRescueSnapshot = {
    documentId,
    sourceText,
    markdown: sourceText,
    filePath,
    format,
    sourceRevision: revision,
    updatedAt,
  };
  writeSessionCatalogSnapshot(snapshot, policy);
  checkpointRecoveryEntrySync({ documentId, sourceRevision: revision, locator, sourceText, format, savedAt: updatedAt });
  void checkpointRecoveryEntry({
    documentId,
    sourceRevision: revision,
    locator,
    sourceText,
    format,
    savedAt: updatedAt,
    nativeSourceText: nativeRescueMarkdown(sourceText),
  });
}

export function getRawDocumentRescueSnapshot(documentId?: DocumentId): RawDocumentRescueSnapshot | null {
  const snapshots = readSessionCatalogSnapshots();
  if (documentId) return snapshots.find((snapshot) => snapshot.documentId === documentId) ?? null;
  return snapshots.sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
}

export function listRawDocumentRescueSnapshots(): RawDocumentRescueSnapshot[] {
  return readSessionCatalogSnapshots().sort((left, right) => right.updatedAt - left.updatedAt);
}

export function hasRawDocumentRescueMarkdown(): boolean {
  return listRawDocumentRescueSnapshots().some((snapshot) => snapshot.sourceText.length > 0);
}

/** Compatibility name retained for AppErrorBoundary; exports the requested/latest generic source entry. */
export async function exportRawDocumentRescueMarkdown(documentId?: DocumentId): Promise<boolean> {
  const entries = await loadRecoveryCatalog();
  const entry = documentId
    ? entries.find((candidate) => candidate.documentId === documentId)
    : entries[0];
  const sessionFallback = getRawDocumentRescueSnapshot(documentId);
  const sourceText = entry?.sourceText ?? sessionFallback?.sourceText;
  const format = entry?.format ?? sessionFallback?.format;
  const filePath = entry?.locator.kind === 'file' ? entry.locator.displayPath : sessionFallback?.filePath ?? null;
  if (sourceText === undefined || !format) return false;
  try {
    downloadSource(sourceText, rescueFileName(filePath, format), mediaTypeForFormat(format));
    return true;
  } catch {
    return false;
  }
}

export async function flushRawDocumentRescueSnapshotForTests(): Promise<void> {
  await flushRecoveryCatalogForTests();
}

export function rawDocumentRescuePolicy(sourceText: string, nativeMaxBytes = RAW_RESCUE_NATIVE_MAX_BYTES): {
  markdownBytes: number;
  sourceTextBytes: number;
  sessionStorage: 'full' | 'skipped';
  nativeStorage: 'full' | 'truncated';
} {
  const sourceTextBytes = byteLength(sourceText);
  return {
    markdownBytes: sourceTextBytes,
    sourceTextBytes,
    sessionStorage: sourceTextBytes <= RAW_RESCUE_SESSION_STORAGE_MAX_BYTES ? 'full' : 'skipped',
    nativeStorage: sourceTextBytes <= nativeMaxBytes ? 'full' : 'truncated',
  };
}

/** Compatibility name retained; truncation is format-neutral source text. */
export function nativeRescueMarkdown(sourceText: string, nativeMaxBytes = RAW_RESCUE_NATIVE_MAX_BYTES): string {
  const policy = rawDocumentRescuePolicy(sourceText, nativeMaxBytes);
  if (policy.nativeStorage === 'full') return sourceText;
  const head = sourceText.slice(0, RAW_RESCUE_TRUNCATED_SECTION_CHARS);
  const tail = sourceText.slice(Math.max(head.length, sourceText.length - RAW_RESCUE_TRUNCATED_SECTION_CHARS));
  return [
    'ScieMD rescue snapshot truncated.',
    `Original markdown bytes: ${policy.sourceTextBytes}.`,
    `Native rescue cap bytes: ${nativeMaxBytes}.`,
    'The beginning and end are preserved; the middle was omitted from the bounded native fallback.',
    '',
    head,
    '',
    '[ScieMD rescue snapshot middle omitted]',
    '',
    tail,
  ].join('\n');
}

function writeSessionCatalogSnapshot(snapshot: RawDocumentRescueSnapshot, policy: ReturnType<typeof rawDocumentRescuePolicy>): void {
  if (typeof window === 'undefined') return;
  const existing = readSessionCatalogSnapshots().filter((entry) => entry.documentId !== snapshot.documentId);
  const stored = policy.sessionStorage === 'full'
    ? snapshot
    : { ...snapshot, sourceText: '', markdown: '' };
  try {
    window.sessionStorage.setItem(SESSION_CATALOG_KEY, JSON.stringify({ schemaVersion: 1, entries: [...existing, stored] }));
    window.sessionStorage.setItem(LEGACY_SESSION_SNAPSHOT_KEY, JSON.stringify(
      policy.sessionStorage === 'full'
        ? snapshot
        : { ...snapshot, sourceText: '', markdown: '', nativeFallbackOnly: true },
    ));
  } catch {
    // The versioned browser/native recovery catalog remains authoritative.
  }
}

function readSessionCatalogSnapshots(): RawDocumentRescueSnapshot[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(SESSION_CATALOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown; entries?: unknown };
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.flatMap((value) => normalizeSessionSnapshot(value));
  } catch {
    return [];
  }
}

function normalizeSessionSnapshot(value: unknown): RawDocumentRescueSnapshot[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Partial<RawDocumentRescueSnapshot>;
  const sourceText = typeof record.sourceText === 'string' ? record.sourceText : record.markdown;
  if (
    typeof record.documentId !== 'string'
    || typeof sourceText !== 'string'
    || typeof record.updatedAt !== 'number'
    || typeof record.sourceRevision !== 'number'
    || !isDocumentFormat(record.format)
  ) return [];
  return [{
    documentId: record.documentId as DocumentId,
    sourceText,
    markdown: sourceText,
    filePath: typeof record.filePath === 'string' ? record.filePath : null,
    format: record.format,
    sourceRevision: record.sourceRevision as SourceRevision,
    updatedAt: record.updatedAt,
  }];
}

function compatibilityDocumentId(filePath: string | null): DocumentId {
  return `legacy-raw-rescue:${filePath ?? 'untitled'}` as DocumentId;
}

function compatibilityUntitledLocator(): DocumentLocator {
  return { kind: 'untitled', untitledId: 'legacy-raw-rescue' as never };
}

function downloadSource(sourceText: string, fileName: string, mediaType: string): void {
  const blob = new Blob([sourceText], { type: `${mediaType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function rescueFileName(filePath: string | null, format: DocumentFormat): string {
  const extension = requiredFormatContributionFor(format).extensions[0];
  if (!filePath) return `scie-md-rescue.${extension}`;
  const baseName = filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? `document.${extension}`;
  const stem = baseName.replace(/\.[^.]+$/, '') || 'document';
  return `${stem}.rescue.${extension}`;
}

function mediaTypeForFormat(format: DocumentFormat): string {
  return requiredFormatContributionFor(format).mediaTypes[0];
}

function isDocumentFormat(value: unknown): value is DocumentFormat {
  return value === 'markdown' || value === 'json' || value === 'jsonl' || value === 'yaml'
    || value === 'toml' || value === 'xml' || value === 'csv' || value === 'tsv' || value === 'plainText';
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
