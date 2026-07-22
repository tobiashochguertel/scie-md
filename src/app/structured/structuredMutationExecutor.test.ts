import { describe, expect, it, vi } from 'vitest';
import {
  createStructuredMutationPlan,
  planJsonVisualEdit,
  planYamlVisualEdit,
  planXmlVisualEdit,
  structuredEditTransactionFromJsonEdit,
  structuredEditTransactionFromYamlEdit,
  structuredEditTransactionFromXmlEdit,
  structuredMutationFingerprint,
  type JsonVisualEditIntent,
} from '@sciemd/core';
import { createStructuredEditJournalEntry } from '../structuredEditJournal';
import { executeStructuredMutation, requestStructuredMutationApproval } from './structuredMutationExecutor';

function fixture(kind: 'replaceScalar' | 'deleteObjectField' = 'replaceScalar') {
  const source = '{"value":1,"keep":2}\n';
  const intent: JsonVisualEditIntent = kind === 'replaceScalar'
    ? { kind, path: ['value'], nextValue: 3 }
    : { kind, path: ['value'] };
  const edit = planJsonVisualEdit(source, intent);
  const transaction = structuredEditTransactionFromJsonEdit(source, intent, edit)!;
  const validatorFingerprint = structuredMutationFingerprint('validator');
  const plan = createStructuredMutationPlan({ documentId: 'doc', sourceRevision: 4, source, transaction, validatorFingerprint });
  return { source, plan, validatorFingerprint, journalEntry: createStructuredEditJournalEntry({ plan, sourceBefore: source, appliedAt: 1 }) };
}

describe('structuredMutationExecutor', () => {
  it('commits reviewed namespace-aware XML text through the full shared envelope', () => {
    const source = '<lab:study xmlns:lab="urn:lab"><lab:title>Old</lab:title></lab:study>\n';
    const intent = { kind: 'replaceScalar' as const, path: ['children', 0, 'children', 0, 'children', 0, 'text'], nextValue: 'New & verified' };
    const edit = planXmlVisualEdit(source, intent);
    const transaction = structuredEditTransactionFromXmlEdit(source, intent, edit)!;
    const validatorFingerprint = structuredMutationFingerprint('xml-no-schema-security-policy-v1');
    const plan = createStructuredMutationPlan({ documentId: 'xml-doc', sourceRevision: 8, source, transaction, validatorFingerprint });
    const journalEntry = createStructuredEditJournalEntry({ plan, sourceBefore: source, appliedAt: 1 });
    const current = { documentId: 'xml-doc', sourceRevision: 8, source, validatorFingerprint, catalogAdvertised: true, plannerAvailable: true, hostWriteAvailable: true, runtimeAllowsVisualEditing: true, nodeAllowsEditing: true };
    const commit = vi.fn(() => ({ status: 'accepted' as const, revision: 9 }));

    expect(executeStructuredMutation({ plan, current, journalEntry, commitPort: { commit } }).status).toBe('review-required');
    expect(executeStructuredMutation({ plan, current, approval: requestStructuredMutationApproval(plan), journalEntry, commitPort: { commit } }))
      .toEqual({ status: 'committed', revision: 9 });
    expect(plan.plannerVersion).toBe('xml-lezer-source-v1');
    expect(plan.transaction.nextSource).toContain('<lab:title>New &amp; verified</lab:title>');
    expect(plan.postconditions.semanticAssertions).toHaveLength(1);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('rejects XML when the planned namespace/content semantic assertion is invalid', () => {
    const source = '<root xmlns="urn:one"><title>Old</title></root>';
    const intent = { kind: 'replaceScalar' as const, path: ['children', 0, 'children', 0, 'children', 0, 'text'], nextValue: 'New' };
    const edit = planXmlVisualEdit(source, intent);
    const transaction = structuredEditTransactionFromXmlEdit(source, intent, edit)!;
    transaction.semanticAssertions[0] = { ...transaction.semanticAssertions[0]!, valueHash: structuredMutationFingerprint('wrong') };
    const validatorFingerprint = structuredMutationFingerprint('xml-policy');
    const plan = createStructuredMutationPlan({ documentId: 'xml-doc', sourceRevision: 1, source, transaction, validatorFingerprint });
    const current = { documentId: 'xml-doc', sourceRevision: 1, source, validatorFingerprint, catalogAdvertised: true, plannerAvailable: true, hostWriteAvailable: true, runtimeAllowsVisualEditing: true, nodeAllowsEditing: true };
    const journalEntry = createStructuredEditJournalEntry({ plan, sourceBefore: source, appliedAt: 1 });
    const result = executeStructuredMutation({ plan, current, approval: requestStructuredMutationApproval(plan), journalEntry, commitPort: { commit: vi.fn(() => ({ status: 'accepted' as const, revision: 2 })) } });
    expect(result).toEqual({ status: 'rejected', reason: 'The edited source failed its operation-specific semantic postcondition.' });
  });

  it('commits a reviewed YAML CST patch through the production executor and checks its semantic target', () => {
    const source = "title: 'Alpha' # keep\ncount: 2\n";
    const intent = { kind: 'replaceScalar' as const, path: ['title'], nextValue: 'Beta' };
    const edit = planYamlVisualEdit(source, intent);
    const transaction = structuredEditTransactionFromYamlEdit(source, intent, edit)!;
    const validatorFingerprint = structuredMutationFingerprint('yaml-validator');
    const plan = createStructuredMutationPlan({ documentId: 'yaml-doc', sourceRevision: 2, source, transaction, validatorFingerprint });
    const journalEntry = createStructuredEditJournalEntry({ plan, sourceBefore: source, appliedAt: 1 });
    const current = { documentId: 'yaml-doc', sourceRevision: 2, source, validatorFingerprint, catalogAdvertised: true, plannerAvailable: true, hostWriteAvailable: true, runtimeAllowsVisualEditing: true, nodeAllowsEditing: true };
    const commit = vi.fn(() => ({ status: 'accepted' as const, revision: 3 }));
    const approval = requestStructuredMutationApproval(plan);
    expect(executeStructuredMutation({ plan, current, approval, journalEntry, commitPort: { commit } })).toEqual({ status: 'committed', revision: 3 });
    expect(plan.transaction.nextSource).toBe("title: 'Beta' # keep\ncount: 2\n");
    expect(plan.postconditions.semanticAssertions).toHaveLength(1);
  });

  it('commits a bounded direct scalar replacement through the sole commit port', () => {
    const value = fixture();
    const commit = vi.fn(() => ({ status: 'accepted' as const, revision: 5 }));
    const result = executeStructuredMutation({
      ...value, current: { documentId: 'doc', sourceRevision: 4, source: value.source, validatorFingerprint: value.validatorFingerprint, catalogAdvertised: true, plannerAvailable: true, hostWriteAvailable: true, runtimeAllowsVisualEditing: true, nodeAllowsEditing: true },
      commitPort: { commit },
    });
    expect(result).toEqual({ status: 'committed', revision: 5 });
    expect(commit).toHaveBeenCalledOnce();
  });

  it('requires exact-plan approval for destructive mutations', () => {
    const value = fixture('deleteObjectField');
    const current = { documentId: 'doc', sourceRevision: 4, source: value.source, validatorFingerprint: value.validatorFingerprint, catalogAdvertised: true, plannerAvailable: true, hostWriteAvailable: true, runtimeAllowsVisualEditing: true, nodeAllowsEditing: true };
    const commit = vi.fn(() => ({ status: 'accepted' as const, revision: 5 }));
    expect(executeStructuredMutation({ ...value, current, commitPort: { commit } }).status).toBe('review-required');
    const approval = requestStructuredMutationApproval(value.plan);
    expect(executeStructuredMutation({ ...value, current, approval: { ...approval, planFingerprint: structuredMutationFingerprint('other') }, commitPort: { commit } })).toMatchObject({ status: 'rejected' });
    expect(executeStructuredMutation({ ...value, current, approval, commitPort: { commit } })).toEqual({ status: 'committed', revision: 5 });
  });

  it.each([
    ['revision', { sourceRevision: 5 }],
    ['document', { documentId: 'other' }],
    ['fingerprint', { source: '{"value":9,"keep":2}\n' }],
    ['validator', { validatorFingerprint: structuredMutationFingerprint('changed-validator') }],
    ['catalog', { catalogAdvertised: false }],
    ['planner', { plannerAvailable: false }],
    ['host', { hostWriteAvailable: false }],
    ['runtime authority', { runtimeAllowsVisualEditing: false }],
    ['node authority', { nodeAllowsEditing: false }],
  ])('rejects changed %s authority before commit', (_label, change) => {
    const value = fixture();
    const commit = vi.fn(() => ({ status: 'accepted' as const, revision: 5 }));
    const current = { documentId: 'doc', sourceRevision: 4, source: value.source, validatorFingerprint: value.validatorFingerprint, catalogAdvertised: true, plannerAvailable: true, hostWriteAvailable: true, runtimeAllowsVisualEditing: true, nodeAllowsEditing: true, ...change };
    expect(executeStructuredMutation({ ...value, current, commitPort: { commit } })).toMatchObject({ status: 'rejected' });
    expect(commit).not.toHaveBeenCalled();
  });

  it('propagates an atomic commit rejection without acknowledging the mutation', () => {
    const value = fixture();
    const result = executeStructuredMutation({
      ...value,
      current: { documentId: 'doc', sourceRevision: 4, source: value.source, validatorFingerprint: value.validatorFingerprint, catalogAdvertised: true, plannerAvailable: true, hostWriteAvailable: true, runtimeAllowsVisualEditing: true, nodeAllowsEditing: true },
      commitPort: { commit: () => ({ status: 'rejected', reason: 'journal-write-failed' }) },
    });
    expect(result).toEqual({ status: 'rejected', reason: 'journal-write-failed' });
  });

  it('rejects an attached schema validation failure after authoritative parsing', () => {
    const value = fixture();
    const commit = vi.fn(() => ({ status: 'accepted' as const, revision: 5 }));
    const current = { documentId: 'doc', sourceRevision: 4, source: value.source, validatorFingerprint: value.validatorFingerprint, catalogAdvertised: true, plannerAvailable: true, hostWriteAvailable: true, runtimeAllowsVisualEditing: true, nodeAllowsEditing: true };
    expect(executeStructuredMutation({ ...value, current, validateSchema: () => false, commitPort: { commit } })).toEqual({ status: 'rejected', reason: 'The edited source failed active schema validation.' });
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    ['planner version', (plan: ReturnType<typeof fixture>['plan']) => ({ ...plan, plannerVersion: 'json-visual-v2' })],
    ['adapter version', (plan: ReturnType<typeof fixture>['plan']) => ({ ...plan, adapterVersion: 'source-preservation:v2' as typeof plan.adapterVersion })],
    ['policy version', (plan: ReturnType<typeof fixture>['plan']) => ({ ...plan, policyVersion: 'structured-review:v2' as typeof plan.policyVersion })],
    ['authorized span', (plan: ReturnType<typeof fixture>['plan']) => ({ ...plan, patches: [{ ...plan.patches[0]!, from: plan.patches[0]!.from - 1 }] })],
    ['limits', (plan: ReturnType<typeof fixture>['plan']) => ({ ...plan, limits: { ...plan.limits, maxPatches: 0 } })],
    ['postcondition', (plan: ReturnType<typeof fixture>['plan']) => ({ ...plan, postconditions: { ...plan.postconditions, resultFingerprint: structuredMutationFingerprint('other-result') } })],
  ])('rejects a mutated %s after plan sealing', (_label, mutate) => {
    const value = fixture();
    const commit = vi.fn(() => ({ status: 'accepted' as const, revision: 5 }));
    const current = { documentId: 'doc', sourceRevision: 4, source: value.source, validatorFingerprint: value.validatorFingerprint, catalogAdvertised: true, plannerAvailable: true, hostWriteAvailable: true, runtimeAllowsVisualEditing: true, nodeAllowsEditing: true };
    expect(executeStructuredMutation({ ...value, plan: mutate(value.plan) as typeof value.plan, current, commitPort: { commit } })).toMatchObject({ status: 'rejected' });
    expect(commit).not.toHaveBeenCalled();
  });
});
