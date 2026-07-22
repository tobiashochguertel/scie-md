import { describe, expect, it, vi } from 'vitest';
import {
  createStructuredMutationPlan,
  structuredEditTransactionFromTomlNativePlan,
  structuredMutationFingerprint,
  type TomlNativeMutationIntent,
  type TomlNativeMutationPlanReport,
} from '@sciemd/core';
import { createStructuredEditJournalEntry } from '../structuredEditJournal';
import { executeStructuredMutation, requestStructuredMutationApproval } from './structuredMutationExecutor';

describe('native TOML -> shared executor integration', () => {
  it('enforces review, seals, semantic postconditions, and the aggregate commit port', () => {
    const source = 'title = "Old"\n';
    const intent: TomlNativeMutationIntent = { kind: 'replaceScalar', path: ['title'], newValue: 'New' };
    const native: TomlNativeMutationPlanReport = {
      dtoVersion: 'toml-native-dto-v1', plannerVersion: 'toml-edit-native-v1', status: 'planned', operationId: 'replaceScalar', path: ['title'],
      patches: [{ from: 8, to: 13, insert: '"New"', expectedText: '"Old"' }], nextSource: 'title = "New"\n', nextValue: { title: 'New' }, diagnostics: [], untouchedRegionsExact: true,
    };
    const transaction = structuredEditTransactionFromTomlNativePlan(source, intent, native)!;
    const validatorFingerprint = structuredMutationFingerprint('toml:no-schema:native-v1');
    const plan = createStructuredMutationPlan({ documentId: 'doc:toml', sourceRevision: 4, source, transaction, validatorFingerprint });
    const journalEntry = createStructuredEditJournalEntry({ plan, sourceBefore: source });
    const commit = vi.fn(() => ({ status: 'accepted' as const, revision: 5 }));
    const current = { documentId: 'doc:toml', sourceRevision: 4, source, validatorFingerprint, catalogAdvertised: true, plannerAvailable: true, hostWriteAvailable: true, runtimeAllowsVisualEditing: true, nodeAllowsEditing: true };

    expect(executeStructuredMutation({ plan, current, journalEntry, commitPort: { commit } }).status).toBe('review-required');
    const result = executeStructuredMutation({ plan, current, approval: requestStructuredMutationApproval(plan), journalEntry, commitPort: { commit } });
    expect(result).toEqual({ status: 'committed', revision: 5 });
    expect(commit).toHaveBeenCalledOnce();
  });
});
