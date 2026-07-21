export const DOCUMENT_HOST_ERROR_CONTRACT_VERSION = 1 as const;

export const DOCUMENT_HOST_ERROR_CODES = [
  'FILE_CHANGED',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'CLOUD_UNAVAILABLE',
  'BACKUP_FAILED',
  'LOSSY_WRITE_REQUIRED',
  'UNKNOWN_HOST_ERROR',
] as const;

export type DocumentHostErrorCode = (typeof DOCUMENT_HOST_ERROR_CODES)[number];

export interface DocumentHostErrorPayload {
  contractVersion: number;
  code: string;
  message: string;
}

const knownCodes = new Set<string>(DOCUMENT_HOST_ERROR_CODES);

export class DocumentHostError extends Error {
  readonly contractVersion = DOCUMENT_HOST_ERROR_CONTRACT_VERSION;
  readonly code: DocumentHostErrorCode;

  constructor(code: DocumentHostErrorCode, message: string) {
    super(message || 'The document host reported an error.');
    this.name = 'DocumentHostError';
    this.code = code;
  }
}

export function normalizeDocumentHostError(error: unknown): DocumentHostError {
  if (error instanceof DocumentHostError) return error;

  if (isPayload(error)) {
    const code = error.contractVersion === DOCUMENT_HOST_ERROR_CONTRACT_VERSION && knownCodes.has(error.code)
      ? error.code as DocumentHostErrorCode
      : 'UNKNOWN_HOST_ERROR';
    return new DocumentHostError(code, error.message);
  }

  if (error instanceof Error) return new DocumentHostError('UNKNOWN_HOST_ERROR', error.message);
  if (typeof error === 'string') return new DocumentHostError('UNKNOWN_HOST_ERROR', error);
  return new DocumentHostError('UNKNOWN_HOST_ERROR', 'The document host reported an unknown error.');
}

export function isDocumentHostError(
  error: unknown,
  code?: DocumentHostErrorCode,
): error is DocumentHostError {
  return error instanceof DocumentHostError && (code === undefined || error.code === code);
}

function isPayload(value: unknown): value is DocumentHostErrorPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DocumentHostErrorPayload>;
  return typeof candidate.contractVersion === 'number'
    && typeof candidate.code === 'string'
    && typeof candidate.message === 'string';
}
