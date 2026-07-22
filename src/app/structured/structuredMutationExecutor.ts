import {
  parseDelimitedText,
  parseJsonDocument,
  parseJsonlDocument,
  parseTomlDocument,
  parseXmlDocument,
  parseYamlDocument,
  effectiveStructuredMutationCapability,
  STRUCTURED_MUTATION_ADAPTER_VERSION,
  STRUCTURED_MUTATION_POLICY_VERSION,
  STRUCTURED_MUTATION_PROTOCOL_VERSION,
  structuredMutationFingerprint,
  structuredMutationPlanFingerprint,
  structuredSemanticValueHash,
  structuredVisualOperationRegistration,
  type StructuredMutationFingerprint,
  type StructuredMutationPlan,
} from '@sciemd/core';
import type { StructuredEditJournalEntry } from '../structuredEditJournal';

export interface StructuredMutationAuthoritySnapshot {
  readonly documentId: string;
  readonly sourceRevision: number;
  readonly source: string;
  readonly validatorFingerprint: StructuredMutationFingerprint;
  readonly catalogAdvertised: boolean;
  readonly plannerAvailable: boolean;
  readonly hostWriteAvailable: boolean;
  readonly runtimeAllowsVisualEditing: boolean;
  readonly nodeAllowsEditing: boolean;
}

export interface StructuredMutationApproval {
  readonly planFingerprint: StructuredMutationFingerprint;
  readonly sourceFingerprint: StructuredMutationFingerprint;
  readonly validatorFingerprint: StructuredMutationFingerprint;
  readonly approvedAt: number;
}

export type StructuredMutationExecutionResult =
  | { readonly status: 'review-required'; readonly approval: StructuredMutationApproval }
  | { readonly status: 'committed'; readonly revision: number }
  | { readonly status: 'rejected'; readonly reason: string };

export interface StructuredMutationCommitPort {
  commit(plan: StructuredMutationPlan, journalEntry: StructuredEditJournalEntry):
    | { status: 'accepted'; revision: number }
    | { status: 'rejected'; reason: string };
}

export function requestStructuredMutationApproval(plan: StructuredMutationPlan): StructuredMutationApproval {
  return {
    planFingerprint: plan.planFingerprint,
    sourceFingerprint: plan.sourceFingerprint,
    validatorFingerprint: plan.validatorFingerprint,
    approvedAt: Date.now(),
  };
}

export function executeStructuredMutation(input: {
  plan: StructuredMutationPlan;
  current: StructuredMutationAuthoritySnapshot;
  approval?: StructuredMutationApproval;
  journalEntry: StructuredEditJournalEntry;
  commitPort: StructuredMutationCommitPort;
  validateSchema?: (source: string) => boolean;
}): StructuredMutationExecutionResult {
  const { plan, current } = input;
  const registration = structuredVisualOperationRegistration(plan.format, plan.operationId);
  if (!registration || registration.plannerId !== plan.plannerVersion || registration.review !== plan.review || registration.destructive !== plan.destructive) {
    return reject('The mutation registry changed after this edit was planned.');
  }
  if (plan.protocolVersion !== STRUCTURED_MUTATION_PROTOCOL_VERSION || plan.adapterVersion !== STRUCTURED_MUTATION_ADAPTER_VERSION
    || plan.policyVersion !== STRUCTURED_MUTATION_POLICY_VERSION || structuredMutationPlanFingerprint(plan) !== plan.planFingerprint) {
    return reject('The mutation plan or one of its authority versions changed after planning.');
  }
  const capability = effectiveStructuredMutationCapability({
    format: plan.format, operationId: plan.operationId,
    catalogAdvertised: current.catalogAdvertised, plannerAvailable: current.plannerAvailable,
    hostWriteAvailable: current.hostWriteAvailable, runtimeAllowsVisualEditing: current.runtimeAllowsVisualEditing,
    nodePreservationProven: current.nodeAllowsEditing,
  });
  if (!capability.enabled) return reject(capability.reason ?? 'Visual editing is no longer authorized for this target.');
  if (current.documentId !== plan.documentId) return reject('The edit belongs to another document.');
  if (current.sourceRevision !== plan.sourceRevision) return reject('The document changed after this edit was planned.');
  if (structuredMutationFingerprint(current.source) !== plan.sourceFingerprint) return reject('The source fingerprint changed after this edit was planned.');
  if (current.validatorFingerprint !== plan.validatorFingerprint) return reject('The active validator or schema changed after this edit was planned.');
  if (plan.patches.length === 0 || plan.patches.length > plan.limits.maxPatches) return reject('The edit exceeds its authorized patch count.');
  const inserted = plan.patches.reduce((total, patch) => total + patch.insert.length, 0);
  if (inserted > plan.limits.maxInsertedUtf16) return reject('The edit exceeds its authorized insertion limit.');
  if (plan.patches.some((patch) => patch.expectedText.length > plan.limits.maxGuardUtf16)) return reject('The edit exceeds its authorized guard limit.');
  if (plan.patches.some((patch, index) => index > 0 && patch.from < plan.patches[index - 1]!.to)) return reject('The edit contains overlapping authorized spans.');
  if (!guardsMatch(current.source, plan)) return reject('An authorized source span no longer matches its guard.');
  if (plan.review === 'required') {
    if (!input.approval) return { status: 'review-required', approval: requestStructuredMutationApproval(plan) };
    if (input.approval.planFingerprint !== plan.planFingerprint
      || input.approval.sourceFingerprint !== plan.sourceFingerprint
      || input.approval.validatorFingerprint !== plan.validatorFingerprint) {
      return reject('Approval does not match this exact mutation plan.');
    }
  }
  const nextSource = applyAuthorizedPatches(current.source, plan);
  if (nextSource !== plan.transaction.nextSource || structuredMutationFingerprint(nextSource) !== plan.resultFingerprint) {
    return reject('The mutation result failed its planned postcondition.');
  }
  if (!untouchedRegionsAreExact(current.source, nextSource, plan)) return reject('The mutation changed source outside its authorized spans.');
  if (!postPatchParseIsValid(plan, nextSource)) return reject('The edited source failed authoritative post-patch parsing.');
  if (!semanticAssertionsHold(plan, nextSource)) return reject('The edited source failed its operation-specific semantic postcondition.');
  if (plan.transaction.postApplyValidation === 'schema' && input.validateSchema && !input.validateSchema(nextSource)) {
    return reject('The edited source failed active schema validation.');
  }
  const committed = input.commitPort.commit(plan, input.journalEntry);
  return committed.status === 'accepted'
    ? { status: 'committed', revision: committed.revision }
    : reject(committed.reason);
}

function guardsMatch(source: string, plan: StructuredMutationPlan): boolean {
  return plan.patches.every((patch) => Number.isSafeInteger(patch.from) && Number.isSafeInteger(patch.to)
    && patch.from >= 0 && patch.to >= patch.from && patch.to <= source.length
    && source.slice(patch.from, patch.to) === patch.expectedText);
}

function applyAuthorizedPatches(source: string, plan: StructuredMutationPlan): string {
  return [...plan.patches].sort((a, b) => b.from - a.from).reduce(
    (current, patch) => current.slice(0, patch.from) + patch.insert + current.slice(patch.to),
    source,
  );
}

function untouchedRegionsAreExact(source: string, nextSource: string, plan: StructuredMutationPlan): boolean {
  const patches = [...plan.patches].sort((a, b) => a.from - b.from);
  let sourceCursor = 0;
  let nextCursor = 0;
  for (const patch of patches) {
    const untouched = source.slice(sourceCursor, patch.from);
    if (nextSource.slice(nextCursor, nextCursor + untouched.length) !== untouched) return false;
    nextCursor += untouched.length + patch.insert.length;
    sourceCursor = patch.to;
  }
  return nextSource.slice(nextCursor) === source.slice(sourceCursor);
}

function postPatchParseIsValid(plan: StructuredMutationPlan, source: string): boolean {
  if (plan.format === 'json') return parseJsonDocument({ format: 'json', text: source, path: null }).parsed !== null;
  if (plan.format === 'jsonl') return parseJsonlDocument({ format: 'jsonl', text: source, path: null }).parsed !== null;
  if (plan.format === 'yaml') return parseYamlDocument({ format: 'yaml', text: source, path: null }).parsed !== null;
  if (plan.format === 'toml') return parseTomlDocument({ format: 'toml', text: source, path: null }).parsed !== null;
  if (plan.format === 'xml') return parseXmlDocument({ format: 'xml', text: source, path: null }).parsed !== null;
  const parsed = parseDelimitedText(source, { delimiter: plan.format === 'tsv' ? '\t' : ',' });
  return !parsed.diagnostics.some((diagnostic) => diagnostic.blocking || diagnostic.severity === 'error');
}

function semanticAssertionsHold(plan: StructuredMutationPlan, source: string): boolean {
  if (plan.postconditions.semanticAssertions.length === 0) return plan.format !== 'yaml' && plan.format !== 'xml';
  const parsed = plan.format === 'yaml'
    ? parseYamlDocument({ format: 'yaml', text: source, path: null }).parsed?.value
    : plan.format === 'toml'
      ? parseTomlDocument({ format: 'toml', text: source, path: null }).parsed?.value
      : plan.format === 'xml'
        ? parseXmlDocument({ format: 'xml', text: source, path: null }).parsed?.value
      : undefined;
  if ((plan.format === 'yaml' || plan.format === 'toml' || plan.format === 'xml') && parsed === undefined) return false;
  return plan.postconditions.semanticAssertions.every((assertion) => {
    const actual = semanticValueAtPath(parsed, assertion.path);
    if (assertion.expectation === 'absent') return !actual.found;
    return actual.found && assertion.valueHash !== undefined && structuredSemanticValueHash(actual.value) === assertion.valueHash;
  });
}

function semanticValueAtPath(value: unknown, path: readonly (string | number)[]): { found: boolean; value: unknown } {
  let current = value;
  for (const segment of path) {
    if (typeof segment === 'number' && Array.isArray(current) && segment >= 0 && segment < current.length) current = current[segment];
    else if (typeof segment === 'string' && current !== null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, segment)) current = (current as Record<string, unknown>)[segment];
    else return { found: false, value: undefined };
  }
  return { found: true, value: current };
}

function reject(reason: string): StructuredMutationExecutionResult { return { status: 'rejected', reason }; }
