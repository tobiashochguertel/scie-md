import {
  createStructuredEditSourcePreview,
  structuredMutationFingerprint,
  type StructuredEditTransaction,
  type StructuredMutationPlan,
} from '@sciemd/core';

export interface StructuredEditJournalEntry {
  schemaVersion: 2;
  id: string;
  format: StructuredMutationPlan['format'];
  operationId: string;
  transactionId: string;
  sourceRevision: number;
  sourceFingerprint: string;
  planFingerprint: string;
  operationLabel: string;
  targetLabel: string;
  previewLabel: string;
  riskLabel: string;
  appliedAt: number;
  line: number | null;
  column: number | null;
}

export function createStructuredEditJournalEntry({
  plan,
  sourceBefore,
  appliedAt = Date.now(),
}: {
  plan: StructuredMutationPlan;
  sourceBefore: string;
  appliedAt?: number;
}): StructuredEditJournalEntry {
  const transaction: StructuredEditTransaction = plan.transaction;
  const preview = createStructuredEditSourcePreview(sourceBefore, transaction);
  return {
    schemaVersion: 2,
    id: `${transaction.id}:${appliedAt}`,
    format: transaction.format,
    operationId: transaction.operationId,
    transactionId: transaction.id,
    sourceRevision: plan.sourceRevision,
    sourceFingerprint: plan.sourceFingerprint,
    planFingerprint: plan.planFingerprint,
    operationLabel: transaction.operationLabel,
    targetLabel: transaction.target.label,
    previewLabel: transaction.previewLabel,
    riskLabel: transaction.riskLabel,
    appliedAt,
    line: preview?.range.line ?? null,
    column: preview?.range.column ?? null,
  };
}

export function migrateStructuredEditJournalEntry(value: unknown): StructuredEditJournalEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!(record.format === 'json' || record.format === 'jsonl' || record.format === 'csv' || record.format === 'tsv' || record.format === 'yaml' || record.format === 'toml' || record.format === 'xml')
    || typeof record.id !== 'string' || typeof record.operationLabel !== 'string' || typeof record.targetLabel !== 'string'
    || typeof record.previewLabel !== 'string' || typeof record.riskLabel !== 'string' || typeof record.appliedAt !== 'number'
    || !(record.line === null || Number.isSafeInteger(record.line)) || !(record.column === null || Number.isSafeInteger(record.column))) return null;
  if (record.schemaVersion === 2 && typeof record.operationId === 'string' && typeof record.transactionId === 'string'
    && Number.isSafeInteger(record.sourceRevision) && typeof record.sourceFingerprint === 'string' && typeof record.planFingerprint === 'string') {
    return record as unknown as StructuredEditJournalEntry;
  }
  const legacyFingerprint = structuredMutationFingerprint(JSON.stringify(record));
  return {
    schemaVersion: 2,
    id: record.id,
    format: record.format,
    operationId: 'legacy-unknown',
    transactionId: record.id.split(':')[0] || record.id,
    sourceRevision: 0,
    sourceFingerprint: legacyFingerprint,
    planFingerprint: legacyFingerprint,
    operationLabel: record.operationLabel,
    targetLabel: record.targetLabel,
    previewLabel: record.previewLabel,
    riskLabel: record.riskLabel,
    appliedAt: record.appliedAt,
    line: record.line as number | null,
    column: record.column as number | null,
  };
}

export function appendStructuredEditJournalEntry(
  current: readonly StructuredEditJournalEntry[],
  entry: StructuredEditJournalEntry,
  limit = 12,
): StructuredEditJournalEntry[] {
  return [entry, ...current].slice(0, Math.max(1, limit));
}
