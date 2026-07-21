import type { DocumentFormat } from '@sciemd/core';

export interface WorkspaceManifestRecoveryReference {
  id: string;
  generation: number;
  sourceRevision: number;
}

export type WorkspaceManifestLocator =
  | { kind: 'untitled'; untitledId: string }
  | {
      kind: 'file';
      displayPath: string;
      comparisonKey: string;
      stableFileId?: string;
      identityConfidence: 'stableFileId' | 'pathOnly';
      aliases: string[];
    };

export interface WorkspaceManifestDocument {
  documentId: string;
  locator: WorkspaceManifestLocator;
  format: DocumentFormat;
  view: {
    mode: 'visual' | 'source';
    preferredStructuredSurface: 'markdown-visual' | 'source' | 'tree' | 'records' | 'table' | 'cards' | 'health' | null;
    selectedStructuredPath: string | null;
    activeStructuredNavigationTargetKey: string | null;
    explicitJsonSchemaPath: string | null;
    selectedVariableName: string | null;
    authorshipMarks: Array<{ id: string; start: number; end: number; createdAt: number; label: string }>;
    structuredEditJournal: Array<{
      id: string;
      format: 'json' | 'jsonl' | 'csv' | 'tsv';
      operationLabel: string;
      targetLabel: string;
      previewLabel: string;
      riskLabel: string;
      appliedAt: number;
      line: number | null;
      column: number | null;
    }>;
  };
  presentation: {
    visualStyle: string | null;
    documentType: 'lab-note' | 'report' | 'memo' | 'notes' | 'other' | null;
  };
  recoveryReference: WorkspaceManifestRecoveryReference | null;
}

export interface WorkspaceManifestPayload {
  tabOrder: string[];
  activeDocumentId: string | null;
  recentlyActiveDocumentIds: string[];
  documents: WorkspaceManifestDocument[];
  recoveryReferences: WorkspaceManifestRecoveryReference[];
  invalidEntries: Array<{ documentId: string | null; reason: 'invalid-shape' }>;
  savedAt: number;
}

export interface LegacyWorkspaceManifestV1 {
  tabOrder: string[];
  activeDocumentId: string | null;
  recoveryReferences: Array<{ id: string; generation: number }>;
}

const FORMATS = new Set<DocumentFormat>(['markdown', 'json', 'jsonl', 'yaml', 'toml', 'xml', 'csv', 'tsv', 'plainText']);
const SURFACES = new Set(['markdown-visual', 'source', 'tree', 'records', 'table', 'cards', 'health']);
const DOCUMENT_TYPES = new Set(['lab-note', 'report', 'memo', 'notes', 'other']);

export function migrateWorkspaceManifestV1(value: unknown): WorkspaceManifestPayload | unknown {
  const record = asRecord(value);
  if (!record || !stringArray(record.tabOrder) || !Array.isArray(record.recoveryReferences)) return value;
  const activeDocumentId = record.activeDocumentId === null || typeof record.activeDocumentId === 'string'
    ? record.activeDocumentId
    : null;
  const references = record.recoveryReferences.flatMap((entry) => {
    const reference = asRecord(entry);
    return reference && typeof reference.id === 'string' && positiveInteger(reference.generation)
      ? [{ id: reference.id, generation: reference.generation, sourceRevision: 0 }]
      : [];
  });
  const byId = new Map(references.map((reference) => [reference.id, reference]));
  return {
    tabOrder: record.tabOrder.slice(),
    activeDocumentId,
    recentlyActiveDocumentIds: activeDocumentId
      ? [activeDocumentId, ...record.tabOrder.filter((id) => id !== activeDocumentId)]
      : record.tabOrder.slice(),
    documents: record.tabOrder.map((documentId) => ({
      documentId,
      locator: { kind: 'untitled' as const, untitledId: `legacy-${documentId}` },
      format: 'markdown' as const,
      view: defaultManifestView(),
      presentation: { visualStyle: null, documentType: null },
      recoveryReference: byId.get(documentId) ?? null,
    })),
    recoveryReferences: references,
    invalidEntries: [],
    savedAt: 0,
  };
}

export function validateWorkspaceManifestPayload(value: unknown): WorkspaceManifestPayload | null {
  const record = asRecord(value);
  if (!record || !stringArray(record.tabOrder) || !stringArray(record.recentlyActiveDocumentIds) || !Array.isArray(record.documents)) return null;
  if (!(record.activeDocumentId === null || typeof record.activeDocumentId === 'string')) return null;
  if (typeof record.savedAt !== 'number' || !Number.isFinite(record.savedAt)) return null;
  if (new Set(record.tabOrder).size !== record.tabOrder.length || new Set(record.recentlyActiveDocumentIds).size !== record.recentlyActiveDocumentIds.length) return null;
  const validatedDocuments = record.documents.map((value) => ({ value, document: validateManifestDocument(value) }));
  const typedDocuments = validatedDocuments.flatMap((entry) => entry.document ? [entry.document] : []);
  const preservedInvalidEntries = Array.isArray(record.invalidEntries)
    ? record.invalidEntries.flatMap((entry) => {
        const invalid = asRecord(entry);
        return invalid
          && (invalid.documentId === null || typeof invalid.documentId === 'string')
          && invalid.reason === 'invalid-shape'
          ? [{ documentId: invalid.documentId as string | null, reason: 'invalid-shape' as const }]
          : [];
      })
    : [];
  const invalidEntries = [...preservedInvalidEntries, ...validatedDocuments.flatMap((entry) => entry.document ? [] : [{
    documentId: typeof asRecord(entry.value)?.documentId === 'string' ? asRecord(entry.value)!.documentId as string : null,
    reason: 'invalid-shape' as const,
  }])];
  const ids = typedDocuments.map((entry) => entry.documentId);
  if (new Set(ids).size !== ids.length) return null;
  const tabOrder = record.tabOrder.filter((id) => ids.includes(id));
  for (const id of ids) if (!tabOrder.includes(id)) tabOrder.push(id);
  const recentlyActiveDocumentIds = record.recentlyActiveDocumentIds.filter((id) => ids.includes(id));
  for (const id of tabOrder) if (!recentlyActiveDocumentIds.includes(id)) recentlyActiveDocumentIds.push(id);
  const allRecoveryReferences = Array.isArray(record.recoveryReferences)
    ? record.recoveryReferences.map(validateRecoveryReference)
    : [];
  if (allRecoveryReferences.some((entry) => entry === null)) return null;
  const recoveryReferences = (allRecoveryReferences as WorkspaceManifestRecoveryReference[]).filter((entry) => ids.includes(entry.id));
  const expectedReferences = typedDocuments.flatMap((entry) => entry.recoveryReference ? [entry.recoveryReference] : []);
  if (!sameReferences(recoveryReferences, expectedReferences)) return null;
  return {
    tabOrder,
    activeDocumentId: record.activeDocumentId !== null && ids.includes(record.activeDocumentId) ? record.activeDocumentId : null,
    recentlyActiveDocumentIds,
    documents: typedDocuments,
    recoveryReferences,
    invalidEntries,
    savedAt: record.savedAt,
  };
}

export function defaultManifestView(): WorkspaceManifestDocument['view'] {
  return {
    mode: 'visual',
    preferredStructuredSurface: null,
    selectedStructuredPath: '$',
    activeStructuredNavigationTargetKey: null,
    explicitJsonSchemaPath: null,
    selectedVariableName: null,
    authorshipMarks: [],
    structuredEditJournal: [],
  };
}

function validateManifestDocument(value: unknown): WorkspaceManifestDocument | null {
  const record = asRecord(value);
  if (!record || typeof record.documentId !== 'string' || !FORMATS.has(record.format as DocumentFormat)) return null;
  const locator = validateLocator(record.locator);
  const view = validateView(record.view);
  const presentation = validatePresentation(record.presentation);
  const recoveryReference = record.recoveryReference === null ? null : validateRecoveryReference(record.recoveryReference);
  if (!locator || !view || !presentation || recoveryReference === null && record.recoveryReference !== null) return null;
  if (recoveryReference && recoveryReference.id !== record.documentId) return null;
  return { documentId: record.documentId, locator, format: record.format as DocumentFormat, view, presentation, recoveryReference };
}

function validateLocator(value: unknown): WorkspaceManifestLocator | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.kind === 'untitled' && typeof record.untitledId === 'string' && record.untitledId.length > 0) {
    return { kind: 'untitled', untitledId: record.untitledId };
  }
  if (
    record.kind !== 'file'
    || typeof record.displayPath !== 'string'
    || record.displayPath.trim() === ''
    || typeof record.comparisonKey !== 'string'
    || !(record.identityConfidence === 'stableFileId' || record.identityConfidence === 'pathOnly')
    || !stringArray(record.aliases)
    || !(record.stableFileId === undefined || typeof record.stableFileId === 'string')
  ) return null;
  return {
    kind: 'file',
    displayPath: record.displayPath,
    comparisonKey: record.comparisonKey,
    ...(typeof record.stableFileId === 'string' ? { stableFileId: record.stableFileId } : {}),
    identityConfidence: record.identityConfidence,
    aliases: record.aliases.slice(),
  };
}

function validateView(value: unknown): WorkspaceManifestDocument['view'] | null {
  const record = asRecord(value);
  if (!record || !(record.mode === 'visual' || record.mode === 'source')) return null;
  if (!(record.preferredStructuredSurface === null || typeof record.preferredStructuredSurface === 'string' && SURFACES.has(record.preferredStructuredSurface))) return null;
  for (const key of ['selectedStructuredPath', 'activeStructuredNavigationTargetKey', 'explicitJsonSchemaPath', 'selectedVariableName'] as const) {
    if (!(record[key] === null || typeof record[key] === 'string')) return null;
  }
  if (!Array.isArray(record.authorshipMarks) || !record.authorshipMarks.every(validAuthorshipMark)) return null;
  if (!Array.isArray(record.structuredEditJournal) || !record.structuredEditJournal.every(validJournalEntry)) return null;
  return record as unknown as WorkspaceManifestDocument['view'];
}

function validatePresentation(value: unknown): WorkspaceManifestDocument['presentation'] | null {
  const record = asRecord(value);
  if (!record || !(record.visualStyle === null || typeof record.visualStyle === 'string')) return null;
  if (!(record.documentType === null || typeof record.documentType === 'string' && DOCUMENT_TYPES.has(record.documentType))) return null;
  return { visualStyle: record.visualStyle, documentType: record.documentType as WorkspaceManifestDocument['presentation']['documentType'] };
}

function validateRecoveryReference(value: unknown): WorkspaceManifestRecoveryReference | null {
  const record = asRecord(value);
  return record
    && typeof record.id === 'string'
    && positiveInteger(record.generation)
    && nonNegativeInteger(record.sourceRevision)
    ? { id: record.id, generation: record.generation, sourceRevision: record.sourceRevision }
    : null;
}

function validAuthorshipMark(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(record && typeof record.id === 'string' && nonNegativeInteger(record.start) && nonNegativeInteger(record.end)
    && typeof record.createdAt === 'number' && typeof record.label === 'string');
}

function validJournalEntry(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(record && typeof record.id === 'string' && (record.format === 'json' || record.format === 'jsonl' || record.format === 'csv' || record.format === 'tsv')
    && typeof record.operationLabel === 'string' && typeof record.targetLabel === 'string' && typeof record.previewLabel === 'string'
    && typeof record.riskLabel === 'string' && typeof record.appliedAt === 'number'
    && (record.line === null || nonNegativeInteger(record.line)) && (record.column === null || nonNegativeInteger(record.column)));
}

function sameReferences(left: WorkspaceManifestRecoveryReference[], right: WorkspaceManifestRecoveryReference[]): boolean {
  const key = (entry: WorkspaceManifestRecoveryReference) => `${entry.id}:${entry.generation}:${entry.sourceRevision}`;
  return left.length === right.length && new Set(left.map(key)).size === left.length
    && left.every((entry) => right.some((candidate) => key(candidate) === key(entry)));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
