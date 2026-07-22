import {
  createStructuredEditReviewPlan,
  type StructuredEditSourcePreview,
  type StructuredMutationPlan,
  type StructuredReviewPlan,
} from '@sciemd/core';
import { requestStructuredMutationApproval, type StructuredMutationApproval } from './structuredMutationExecutor';

export interface StructuredMutationReviewState {
  readonly plan: StructuredMutationPlan;
  readonly preview: StructuredEditSourcePreview;
  readonly reviewPlan: StructuredReviewPlan;
  readonly approval: StructuredMutationApproval;
  readonly schemaGeneratedValueExplanation?: string;
}

export function createStructuredMutationReviewState(input: {
  source: string;
  documentEpoch: number;
  plan: StructuredMutationPlan;
  schemaGeneratedValueExplanation?: string;
}): StructuredMutationReviewState | null {
  const reviewPlan = createStructuredEditReviewPlan({
    source: input.source,
    transaction: input.plan.transaction,
    documentEpoch: input.documentEpoch,
    notes: input.schemaGeneratedValueExplanation ? [input.schemaGeneratedValueExplanation] : [],
  });
  if (!reviewPlan) return null;
  return {
    plan: input.plan,
    preview: reviewPlan.sourcePreview,
    reviewPlan,
    approval: requestStructuredMutationApproval(input.plan),
    ...(input.schemaGeneratedValueExplanation ? { schemaGeneratedValueExplanation: input.schemaGeneratedValueExplanation } : {}),
  };
}
