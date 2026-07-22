import { describe, expect, it } from 'vitest';
import { formatContributionCatalog } from '../formatDefinitions';
import { planJsonVisualEdit } from '../json/jsonEdits';
import { structuredEditTransactionFromJsonEdit } from './structuredEditReview';
import {
  createStructuredMutationPlan,
  structuredMutationFingerprint,
  structuredVisualOperationMatrix,
  validateStructuredMutationCoverage,
} from './structuredMutation';

describe('structured mutation protocol', () => {
  it('binds every advertised editable structured format to planner, executor, review policy, and fixture evidence', () => {
    expect(() => validateStructuredMutationCoverage(formatContributionCatalog.formats)).not.toThrow();
    expect(new Set(structuredVisualOperationMatrix.operations.map((entry) => entry.format))).toEqual(new Set(['json', 'jsonl', 'csv', 'tsv', 'yaml', 'toml', 'xml']));
    expect(structuredVisualOperationMatrix.operations.every((entry) => entry.plannerId && entry.handlerId && entry.fixtureId)).toBe(true);
    expect(structuredVisualOperationMatrix.operations.every((entry) => entry.nodeClass && (entry.state === 'enabled' || entry.state === 'review'))).toBe(true);
  });

  it('creates collision-resistant, revision-bound guarded plans', () => {
    const source = '{"value":1}\n';
    const intent = { kind: 'replaceScalar' as const, path: ['value'], nextValue: 2 };
    const edit = planJsonVisualEdit(source, intent);
    const transaction = structuredEditTransactionFromJsonEdit(source, intent, edit)!;
    const plan = createStructuredMutationPlan({
      documentId: 'document-1', sourceRevision: 7, source, transaction,
      validatorFingerprint: structuredMutationFingerprint('validator'),
    });
    expect(plan.sourceFingerprint).toMatch(/^sha256:v1:[0-9a-f]{64}$/);
    expect(plan.planFingerprint).toMatch(/^sha256:v1:[0-9a-f]{64}$/);
    expect(plan.patches[0]?.expectedText).toBe('1');
    expect(plan.review).toBe('direct');
    expect(plan.preservation.untouchedRegionsExact).toBe(true);
  });
});
