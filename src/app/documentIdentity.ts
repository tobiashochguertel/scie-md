export type DocumentId = string & { readonly __brand: 'DocumentId' };
export type UntitledId = string & { readonly __brand: 'UntitledId' };
export type SourceRevision = number & { readonly __brand: 'SourceRevision' };

export type IdentityConfidence = 'stableFileId' | 'pathOnly';

export interface FileDocumentLocator {
  kind: 'file';
  displayPath: string;
  comparisonKey: string;
  stableFileId?: string;
  identityConfidence: IdentityConfidence;
  aliases: readonly string[];
}

export interface UntitledDocumentLocator {
  kind: 'untitled';
  untitledId: UntitledId;
}

export type DocumentLocator = FileDocumentLocator | UntitledDocumentLocator;

export interface NativeDocumentLocator {
  displayPath: string;
  comparisonKey: string;
  stableFileId?: string | null;
  identityConfidence: IdentityConfidence;
  aliases?: readonly string[];
}

let fallbackSequence = 0;

function uniqueToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  fallbackSequence += 1;
  return `${Date.now().toString(36)}-${fallbackSequence.toString(36)}`;
}

export function createDocumentId(): DocumentId {
  return `document:${uniqueToken()}` as DocumentId;
}

export function createUntitledId(): UntitledId {
  return `untitled:${uniqueToken()}` as UntitledId;
}

export function sourceRevision(value: number): SourceRevision {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('SourceRevision must be a non-negative safe integer.');
  return value as SourceRevision;
}

export function createUntitledLocator(): UntitledDocumentLocator {
  return { kind: 'untitled', untitledId: createUntitledId() };
}

export function canonicalComparisonKey(path: string): string {
  let normalized = path.trim();
  const windowsPath = isWindowsPath(normalized);
  if (/^\\\\\?\\UNC\\/i.test(normalized)) {
    normalized = `\\\\${normalized.slice('\\\\?\\UNC\\'.length)}`;
  } else if (/^\\\\\?\\/i.test(normalized)) {
    normalized = normalized.slice('\\\\?\\'.length);
  }
  normalized = normalized.replace(/\\/g, '/');
  const unc = normalized.startsWith('//');
  normalized = normalized.replace(/\/+/g, '/');
  if (unc && !normalized.startsWith('//')) normalized = `/${normalized}`;
  if (normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized)) normalized = normalized.replace(/\/$/, '');
  return windowsPath ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function fallbackFileLocator(path: string): FileDocumentLocator {
  const displayPath = path.trim();
  return {
    kind: 'file',
    displayPath,
    comparisonKey: canonicalComparisonKey(displayPath),
    identityConfidence: 'pathOnly',
    aliases: [],
  };
}

export async function resolveFileLocator(
  identityHost: { resolveFileLocator(path: string, options?: { allowMissing?: boolean }): Promise<FileDocumentLocator> } | undefined,
  path: string,
  options: { allowMissing?: boolean } = {},
): Promise<FileDocumentLocator> {
  if (!identityHost) return fallbackFileLocator(path);
  try {
    return await identityHost.resolveFileLocator(path, options);
  } catch {
    // Browser/test compatibility hosts and unavailable native identity APIs use
    // the declared path-only policy. No cross-key identity is guessed.
    return fallbackFileLocator(path);
  }
}

export function normalizeNativeLocator(locator: NativeDocumentLocator, requestedPath: string): FileDocumentLocator {
  const displayPath = locator.displayPath.trim() || requestedPath.trim();
  const stableFileId = locator.stableFileId?.trim() || undefined;
  return {
    kind: 'file',
    displayPath,
    comparisonKey: locator.comparisonKey || canonicalComparisonKey(displayPath),
    stableFileId,
    identityConfidence: stableFileId ? 'stableFileId' : 'pathOnly',
    aliases: uniqueAliases(displayPath, [...(locator.aliases ?? []), requestedPath]),
  };
}

export function sameDocumentLocator(left: DocumentLocator, right: DocumentLocator): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'untitled' && right.kind === 'untitled') return left.untitledId === right.untitledId;
  if (left.kind !== 'file' || right.kind !== 'file') return false;
  if (left.stableFileId && right.stableFileId) return left.stableFileId === right.stableFileId;
  return left.comparisonKey === right.comparisonKey;
}

export function mergeFileLocatorAliases(current: FileDocumentLocator, observed: FileDocumentLocator): FileDocumentLocator {
  const stableFileId = observed.stableFileId ?? current.stableFileId;
  return {
    ...current,
    comparisonKey: observed.comparisonKey,
    stableFileId,
    identityConfidence: stableFileId ? 'stableFileId' : 'pathOnly',
    aliases: uniqueAliases(current.displayPath, [
      ...current.aliases,
      observed.displayPath,
      ...observed.aliases,
    ]),
  };
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path) || path.includes('\\');
}

function uniqueAliases(displayPath: string, candidates: readonly string[]): string[] {
  const displayKey = canonicalComparisonKey(displayPath);
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const candidate of candidates) {
    const alias = candidate.trim();
    const key = canonicalComparisonKey(alias);
    if (!alias || key === displayKey || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return aliases;
}
