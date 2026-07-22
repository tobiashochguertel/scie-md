import rawMatrix from './structuredVisualOperationMatrix.v1.json';
import type { DocumentFormat } from '../documentFormat';
import type { StructuredEditTransaction, StructuredEditableFormat } from './structuredEditReview';

export const STRUCTURED_MUTATION_PROTOCOL_VERSION = 'structured-mutation-v1' as const;
export const STRUCTURED_MUTATION_ADAPTER_VERSION = 'source-preservation:v1' as const;
export const STRUCTURED_MUTATION_POLICY_VERSION = 'structured-review:v1' as const;
export const STRUCTURED_MUTATION_FINGERPRINT_VERSION = 'sha256:v1' as const;

export type StructuredMutationFingerprint = `sha256:v1:${string}`;
export type StructuredMutationReviewPolicy = 'direct' | 'required';

export interface StructuredVisualOperationRegistration {
  readonly format: StructuredEditableFormat;
  readonly nodeClass: string;
  readonly operationId: string;
  readonly state: 'enabled' | 'review' | 'source-only' | 'unsupported';
  readonly plannerId: string;
  readonly handlerId: typeof STRUCTURED_MUTATION_PROTOCOL_VERSION;
  readonly review: StructuredMutationReviewPolicy;
  readonly destructive: boolean;
  readonly fixtureId: string;
}

export interface StructuredVisualOperationMatrix {
  readonly version: 1;
  readonly operations: readonly StructuredVisualOperationRegistration[];
}

export interface StructuredMutationPatch {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  readonly expectedText: string;
}

export interface StructuredMutationPlan {
  readonly protocolVersion: typeof STRUCTURED_MUTATION_PROTOCOL_VERSION;
  readonly documentId: string;
  readonly sourceRevision: number;
  readonly sourceFingerprint: StructuredMutationFingerprint;
  readonly resultFingerprint: StructuredMutationFingerprint;
  readonly planFingerprint: StructuredMutationFingerprint;
  readonly format: StructuredEditableFormat;
  readonly operationId: string;
  readonly transactionId: string;
  readonly plannerVersion: string;
  readonly adapterVersion: typeof STRUCTURED_MUTATION_ADAPTER_VERSION;
  readonly policyVersion: typeof STRUCTURED_MUTATION_POLICY_VERSION;
  readonly validatorFingerprint: StructuredMutationFingerprint;
  readonly review: StructuredMutationReviewPolicy;
  readonly destructive: boolean;
  readonly patches: readonly StructuredMutationPatch[];
  readonly limits: { readonly maxPatches: number; readonly maxInsertedUtf16: number; readonly maxGuardUtf16: number };
  readonly postconditions: { readonly parseRequired: true; readonly resultFingerprint: StructuredMutationFingerprint; readonly semanticAssertions: StructuredEditTransaction['semanticAssertions'] };
  readonly preservation: { readonly untouchedRegionsExact: true };
  readonly transaction: StructuredEditTransaction;
}

const editableFormats = new Set<StructuredEditableFormat>(['json', 'jsonl', 'csv', 'tsv', 'yaml', 'toml', 'xml']);

export const structuredVisualOperationMatrix = validateStructuredVisualOperationMatrix(rawMatrix);
export const structuredMutationFormats = Object.freeze(Array.from(new Set(structuredVisualOperationMatrix.operations.map((entry) => entry.format))));

export function structuredVisualOperationRegistration(
  format: StructuredEditableFormat,
  operationId: string,
): StructuredVisualOperationRegistration | null {
  return structuredVisualOperationMatrix.operations.find((entry) => entry.format === format && entry.operationId === operationId) ?? null;
}

export function effectiveStructuredMutationCapability(input: {
  format: StructuredEditableFormat;
  operationId: string;
  catalogAdvertised: boolean;
  plannerAvailable: boolean;
  hostWriteAvailable: boolean;
  runtimeAllowsVisualEditing: boolean;
  nodePreservationProven: boolean;
}): { enabled: boolean; review: StructuredMutationReviewPolicy | null; reason: string | null } {
  const registration = structuredVisualOperationRegistration(input.format, input.operationId);
  if (!registration) return { enabled: false, review: null, reason: 'Operation is not registered.' };
  if (registration.state === 'source-only') return { enabled: false, review: null, reason: 'This operation is source-only.' };
  if (registration.state === 'unsupported') return { enabled: false, review: null, reason: 'This node or operation is unsupported.' };
  if (!input.catalogAdvertised) return { enabled: false, review: null, reason: 'The format catalog does not advertise this writer.' };
  if (!input.plannerAvailable) return { enabled: false, review: null, reason: 'The production planner is unavailable.' };
  if (!input.hostWriteAvailable) return { enabled: false, review: null, reason: 'The current host cannot commit document changes.' };
  if (!input.runtimeAllowsVisualEditing) return { enabled: false, review: null, reason: 'The current parser or size mode is source-only.' };
  if (!input.nodePreservationProven) return { enabled: false, review: null, reason: 'Source preservation is not proven for this node.' };
  return { enabled: true, review: registration.review, reason: null };
}

export function validateStructuredVisualOperationMatrix(value: unknown): StructuredVisualOperationMatrix {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.operations)) {
    throw new Error('Structured visual operation matrix must be a version 1 object.');
  }
  const seen = new Set<string>();
  for (const operation of value.operations) {
    if (!isRecord(operation) || typeof operation.format !== 'string' || !editableFormats.has(operation.format as StructuredEditableFormat)) {
      throw new Error('Structured visual operation matrix contains an unsupported format.');
    }
    for (const key of ['nodeClass', 'operationId', 'plannerId', 'handlerId', 'fixtureId'] as const) {
      if (typeof operation[key] !== 'string' || operation[key].length === 0) throw new Error(`Structured operation ${key} is required.`);
    }
    if (operation.handlerId !== STRUCTURED_MUTATION_PROTOCOL_VERSION) throw new Error(`${operation.format}.${operation.operationId} has no production executor.`);
    if (operation.review !== 'direct' && operation.review !== 'required') throw new Error(`${operation.format}.${operation.operationId} has no review policy.`);
    if (!['enabled', 'review', 'source-only', 'unsupported'].includes(operation.state as string)
      || (operation.state === 'enabled') !== (operation.review === 'direct')) throw new Error(`${operation.format}.${operation.operationId} has inconsistent availability and review policy.`);
    if (typeof operation.destructive !== 'boolean') throw new Error(`${operation.format}.${operation.operationId} has no destructive policy.`);
    const key = `${operation.format}:${operation.operationId}`;
    if (seen.has(key)) throw new Error(`Structured operation is duplicated: ${key}.`);
    seen.add(key);
  }
  return value as unknown as StructuredVisualOperationMatrix;
}

export function validateStructuredMutationCoverage(
  contributions: readonly { format: DocumentFormat; workbench: { editableSurfaces: readonly string[] } }[],
): void {
  for (const contribution of contributions) {
    if (!editableFormats.has(contribution.format as StructuredEditableFormat) || contribution.workbench.editableSurfaces.length === 0) continue;
    if (!structuredVisualOperationMatrix.operations.some((operation) => operation.format === contribution.format)) {
      throw new Error(`${contribution.format} advertises visual editing without registered structured mutation operations.`);
    }
  }
}

export function createStructuredMutationPlan(input: {
  documentId: string;
  sourceRevision: number;
  source: string;
  transaction: StructuredEditTransaction;
  validatorFingerprint: StructuredMutationFingerprint;
}): StructuredMutationPlan {
  const registration = structuredVisualOperationRegistration(input.transaction.format, input.transaction.operationId);
  if (!registration) throw new Error(`Unregistered structured mutation: ${input.transaction.format}.${input.transaction.operationId}.`);
  if (registration.state !== 'enabled' && registration.state !== 'review') throw new Error(`Structured mutation is not writable: ${input.transaction.format}.${input.transaction.operationId}.`);
  const patches = input.transaction.edits.map((edit) => ({
    from: edit.offset,
    to: edit.offset + edit.length,
    insert: edit.content,
    expectedText: input.source.slice(edit.offset, edit.offset + edit.length),
  })).sort((left, right) => left.from - right.from);
  const sourceFingerprint = structuredMutationFingerprint(input.source);
  const resultFingerprint = structuredMutationFingerprint(input.transaction.nextSource);
  const unsigned = {
    protocolVersion: STRUCTURED_MUTATION_PROTOCOL_VERSION,
    documentId: input.documentId,
    sourceRevision: input.sourceRevision,
    sourceFingerprint,
    resultFingerprint,
    format: input.transaction.format,
    operationId: input.transaction.operationId,
    transactionId: input.transaction.id,
    plannerVersion: registration.plannerId,
    adapterVersion: STRUCTURED_MUTATION_ADAPTER_VERSION,
    policyVersion: STRUCTURED_MUTATION_POLICY_VERSION,
    validatorFingerprint: input.validatorFingerprint,
    review: registration.review,
    destructive: registration.destructive,
    patches,
  };
  const draft = {
    ...unsigned,
    limits: { maxPatches: 256, maxInsertedUtf16: 4 * 1024 * 1024, maxGuardUtf16: 64 * 1024 },
    postconditions: { parseRequired: true, resultFingerprint, semanticAssertions: input.transaction.semanticAssertions },
    preservation: { untouchedRegionsExact: true },
    transaction: input.transaction,
  } as const;
  return { ...draft, planFingerprint: structuredMutationPlanFingerprint(draft) };
}

export function structuredMutationPlanFingerprint(
  plan: Omit<StructuredMutationPlan, 'planFingerprint'> | StructuredMutationPlan,
): StructuredMutationFingerprint {
  return structuredMutationFingerprint(stableStringify({
    protocolVersion: plan.protocolVersion,
    documentId: plan.documentId,
    sourceRevision: plan.sourceRevision,
    sourceFingerprint: plan.sourceFingerprint,
    resultFingerprint: plan.resultFingerprint,
    format: plan.format,
    operationId: plan.operationId,
    transactionId: plan.transactionId,
    plannerVersion: plan.plannerVersion,
    adapterVersion: plan.adapterVersion,
    policyVersion: plan.policyVersion,
    validatorFingerprint: plan.validatorFingerprint,
    review: plan.review,
    destructive: plan.destructive,
    patches: plan.patches,
    limits: plan.limits,
    postconditions: plan.postconditions,
    preservation: plan.preservation,
    target: plan.transaction.target,
    postApplyValidation: plan.transaction.postApplyValidation,
  }));
}

export function structuredMutationFingerprint(value: string): StructuredMutationFingerprint {
  return `${STRUCTURED_MUTATION_FINGERPRINT_VERSION}:${sha256Hex(value)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value.normalize('NFC'));
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLength); padded.set(bytes); padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer); view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000)); view.setUint32(padded.length - 4, bitLength >>> 0);
  let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
  let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = add32(words[index - 16], s0, words[index - 7], s1);
    }
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4; let f = h5; let g = h6; let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25); const ch = (e & f) ^ (~e & g);
      const temp1 = add32(h, s1, ch, SHA256_K[index], words[index]); const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const temp2 = add32(s0, (a & b) ^ (a & c) ^ (b & c)); h = g; g = f; f = e; e = add32(d, temp1); d = c; c = b; b = a; a = add32(temp1, temp2);
    }
    h0 = add32(h0, a); h1 = add32(h1, b); h2 = add32(h2, c); h3 = add32(h3, d); h4 = add32(h4, e); h5 = add32(h5, f); h6 = add32(h6, g); h7 = add32(h7, h);
  }
  return [h0,h1,h2,h3,h4,h5,h6,h7].map((part) => part.toString(16).padStart(8, '0')).join('');
}
function rotateRight(value: number, shift: number): number { return (value >>> shift) | (value << (32 - shift)); }
function add32(...values: number[]): number { return values.reduce((sum, value) => (sum + value) >>> 0, 0); }
const SHA256_K = Uint32Array.from([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
