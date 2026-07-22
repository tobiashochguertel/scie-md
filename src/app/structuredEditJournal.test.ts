import { describe, expect, it } from 'vitest';
import { createStructuredMutationPlan, planJsonVisualEdit, structuredEditTransactionFromJsonEdit, structuredMutationFingerprint } from '@sciemd/core';
import {
  appendStructuredEditJournalEntry,
  createStructuredEditJournalEntry,
  migrateStructuredEditJournalEntry,
} from './structuredEditJournal';

describe('structuredEditJournal', () => {
  it('creates compact journal entries from structured edit transactions', () => {
    const source = '{\n  "name": "A"\n}\n';
    const intent = {
      kind: 'replaceScalar' as const,
      path: ['name'],
      nextValue: 'B',
    };
    const editPlan = planJsonVisualEdit(source, intent);
    const transaction = structuredEditTransactionFromJsonEdit(source, intent, editPlan);

    expect(transaction).not.toBeNull();
    const entry = createStructuredEditJournalEntry({
      plan: createStructuredMutationPlan({ documentId: 'doc', sourceRevision: 0, source, transaction: transaction!, validatorFingerprint: structuredMutationFingerprint('validator') }),
      sourceBefore: source,
      appliedAt: 1000,
    });

    expect(entry).toMatchObject({
      format: 'json',
      operationLabel: 'Edit JSON value',
      targetLabel: '$.name',
      previewLabel: 'Updated $.name.',
      riskLabel: 'Replace source range',
      appliedAt: 1000,
      line: 2,
    });
  });

  it('keeps newest entries first and bounds the journal', () => {
    const entries = Array.from({ length: 4 }, (_, index) => ({
      schemaVersion: 2 as const,
      id: String(index),
      format: 'json' as const,
      operationId: 'replaceScalar',
      transactionId: `transaction-${index}`,
      sourceRevision: index,
      sourceFingerprint: structuredMutationFingerprint(`source-${index}`),
      planFingerprint: structuredMutationFingerprint(`plan-${index}`),
      operationLabel: `Edit ${index}`,
      targetLabel: '$',
      previewLabel: `Updated ${index}`,
      riskLabel: 'Replace source range',
      appliedAt: index,
      line: index,
      column: 1,
    }));

    const next = appendStructuredEditJournalEntry(entries.slice(0, 2), entries[3]!, 2);

    expect(next.map((entry) => entry.id)).toEqual(['3', '0']);
  });

  it('accepts current YAML journal entries without changing legacy migration semantics', () => {
    const fingerprint = structuredMutationFingerprint('yaml-entry');
    expect(migrateStructuredEditJournalEntry({
      schemaVersion: 2, id: 'yaml-1', format: 'yaml', operationId: 'replaceScalar', transactionId: 'yaml-tx',
      sourceRevision: 3, sourceFingerprint: fingerprint, planFingerprint: fingerprint,
      operationLabel: 'Edit YAML value', targetLabel: '$.title', previewLabel: 'Replace YAML value',
      riskLabel: 'Replace source range', appliedAt: 1000, line: 1, column: 8,
    })).toMatchObject({ format: 'yaml', operationId: 'replaceScalar', schemaVersion: 2 });
  });

  it('accepts current native TOML journal entries without changing the stored schema version', () => {
    const fingerprint = structuredMutationFingerprint('toml-entry');
    expect(migrateStructuredEditJournalEntry({
      schemaVersion: 2, id: 'toml-1', format: 'toml', operationId: 'replaceScalar', transactionId: 'toml-tx',
      sourceRevision: 4, sourceFingerprint: fingerprint, planFingerprint: fingerprint,
      operationLabel: 'Edit TOML value', targetLabel: '$.title', previewLabel: 'Replace TOML value',
      riskLabel: 'Replace source range', appliedAt: 1000, line: 1, column: 9,
    })).toMatchObject({ format: 'toml', operationId: 'replaceScalar', schemaVersion: 2 });
  });

  it('accepts current XML journal entries without changing the stored schema version', () => {
    const fingerprint = structuredMutationFingerprint('xml-entry');
    expect(migrateStructuredEditJournalEntry({
      schemaVersion: 2, id: 'xml-1', format: 'xml', operationId: 'replaceScalar', transactionId: 'xml-tx',
      sourceRevision: 5, sourceFingerprint: fingerprint, planFingerprint: fingerprint,
      operationLabel: 'Edit XML value', targetLabel: '$.children[0].text', previewLabel: 'Replace XML value',
      riskLabel: 'Replace source range', appliedAt: 1000, line: 1, column: 12,
    })).toMatchObject({ format: 'xml', operationId: 'replaceScalar', schemaVersion: 2 });
  });
});
