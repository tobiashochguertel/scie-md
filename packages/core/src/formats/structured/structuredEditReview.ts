import type {
  DocumentFormat,
  FormatDiagnostic,
  StructuredPathSegment,
} from '../documentFormat.js';
import { parseDocument } from 'yaml';
import type {
  JsonTextEdit,
  JsonVisualEditIntent,
  JsonVisualEditPlan,
} from '../json/jsonEdits.js';
import { jsonSourceHash } from '../json/jsonEdits.js';
import type {
  JsonlTextEdit,
  JsonlVisualEditIntent,
  JsonlVisualEditPlan,
} from '../jsonl/jsonlEdits.js';
import { jsonlSourceHash } from '../jsonl/jsonlEdits.js';
import type {
  TabularTextEdit,
  TabularVisualEditIntent,
  TabularVisualEditPlan,
} from '../tabular/tabularEdits.js';
import { tabularSourceHash } from '../tabular/tabularEdits.js';
import type { YamlTextEdit, YamlVisualEditIntent, YamlVisualEditPlan } from '../yaml/yamlEdits.js';
import { yamlSourceHash } from '../yaml/yamlEdits.js';
import type { TomlNativeMutationIntent, TomlNativeMutationPlanReport } from '../toml/tomlNative.js';
import type { XmlVisualEditIntent, XmlVisualEditPlan } from '../xml/xmlEdits.js';
import { xmlSourceHash } from '../xml/xmlEdits.js';
import { displayPathFromPath, pointerFromPath } from './sourceMap.js';

export type StructuredEditableFormat = Extract<DocumentFormat, 'json' | 'jsonl' | 'csv' | 'tsv' | 'yaml' | 'toml' | 'xml'>;
export type StructuredClipboardReplaceFormat = Extract<StructuredEditableFormat, 'json' | 'jsonl'>;
export type StructuredEditTargetKind = 'document' | 'path' | 'record' | 'cell' | 'row';
export type StructuredPostApplyValidation = 'parse' | 'schema' | 'none';
export type StructuredReviewPlanKind = 'edit' | 'conflict';

export interface StructuredEditTextEdit {
  offset: number;
  length: number;
  content: string;
}

export interface StructuredEditTarget {
  kind: StructuredEditTargetKind;
  label: string;
  path?: StructuredPathSegment[];
  pointer?: string;
  lineNumber?: number;
  rowIndex?: number;
  columnIndex?: number;
}

export interface StructuredEditTransaction {
  id: string;
  format: StructuredEditableFormat;
  operationId: string;
  operationLabel: string;
  target: StructuredEditTarget;
  sourceHash: string;
  previewLabel: string;
  undoLabel: string;
  riskLabel: string;
  edits: StructuredEditTextEdit[];
  diagnostics: FormatDiagnostic[];
  nextSource: string;
  destructive: boolean;
  requiresReview: boolean;
  postApplyValidation: StructuredPostApplyValidation;
  semanticAssertions: StructuredSemanticAssertion[];
}

export interface StructuredSemanticAssertion {
  path: StructuredPathSegment[];
  expectation: 'present' | 'absent';
  valueHash?: string;
}

export interface StructuredEditSourcePreviewRange {
  offset: number;
  length: number;
  endOffset: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  insertedLength: number;
  removedLength: number;
}

export interface StructuredEditSourcePreview {
  previewLabel: string;
  riskLabel: string;
  editCount: number;
  range: StructuredEditSourcePreviewRange;
  beforeSnippet: string;
  afterSnippet: string;
  beforeTruncated: boolean;
  afterTruncated: boolean;
}

export interface StructuredEditSourcePreviewOptions {
  contextCharacters?: number;
  maxSnippetCharacters?: number;
}

export interface StructuredReviewPlan {
  id: string;
  kind: StructuredReviewPlanKind;
  format: StructuredEditableFormat;
  title: string;
  summary: string;
  actionLabel: string;
  riskLabel: string;
  sourceHash: string;
  documentEpoch: number;
  transaction: StructuredEditTransaction;
  sourcePreview: StructuredEditSourcePreview;
  notes: string[];
}

export function createStructuredEditTransaction(input: {
  format: StructuredEditableFormat;
  source: string;
  operationId: string;
  operationLabel: string;
  target: StructuredEditTarget;
  edits: readonly StructuredEditTextEdit[];
  nextSource: string;
  diagnostics?: readonly FormatDiagnostic[];
  previewLabel: string;
  undoLabel?: string;
  destructive?: boolean;
  requiresReview?: boolean;
  postApplyValidation?: StructuredPostApplyValidation;
  semanticAssertions?: readonly StructuredSemanticAssertion[];
}): StructuredEditTransaction {
  const sourceHash = structuredSourceHashForFormat(input.format, input.source);
  const edits = input.edits.map((edit) => ({ ...edit }));
  const riskLabel = structuredEditRiskLabel(edits);
  return {
    id: stableStructuredTransactionId(input.format, input.operationId, sourceHash, edits),
    format: input.format,
    operationId: input.operationId,
    operationLabel: input.operationLabel,
    target: input.target,
    sourceHash,
    previewLabel: input.previewLabel,
    undoLabel: input.undoLabel ?? input.operationLabel,
    riskLabel,
    edits,
    diagnostics: [...(input.diagnostics ?? [])],
    nextSource: input.nextSource,
    destructive: input.destructive ?? false,
    requiresReview: input.requiresReview ?? false,
    postApplyValidation: input.postApplyValidation ?? 'parse',
    semanticAssertions: (input.semanticAssertions ?? []).map((assertion) => ({ ...assertion, path: [...assertion.path] })),
  };
}

export function createStructuredEditSourcePreview(
  source: string,
  transaction: StructuredEditTransaction,
  options: StructuredEditSourcePreviewOptions = {},
): StructuredEditSourcePreview | null {
  const contextCharacters = Math.max(0, options.contextCharacters ?? 120);
  const maxSnippetCharacters = Math.max(80, options.maxSnippetCharacters ?? 520);
  const range = sourcePreviewRange(source, transaction.edits);
  const afterEndOffset = range.offset + range.insertedLength;
  const before = boundedSnippet(source, range.offset, range.endOffset, contextCharacters, maxSnippetCharacters);
  const after = boundedSnippet(transaction.nextSource, range.offset, afterEndOffset, contextCharacters, maxSnippetCharacters);
  return {
    previewLabel: transaction.previewLabel,
    riskLabel: transaction.riskLabel,
    editCount: transaction.edits.length,
    range,
    beforeSnippet: before.text,
    afterSnippet: after.text,
    beforeTruncated: before.truncated,
    afterTruncated: after.truncated,
  };
}

export function createStructuredEditReviewPlan(input: {
  source: string;
  transaction: StructuredEditTransaction;
  documentEpoch: number;
  notes?: readonly string[];
}): StructuredReviewPlan | null {
  const sourcePreview = createStructuredEditSourcePreview(input.source, input.transaction);
  if (!sourcePreview) return null;
  return {
    id: `${input.transaction.id}:review:${input.documentEpoch}`,
    kind: 'edit',
    format: input.transaction.format,
    title: `Review ${formatLabel(input.transaction.format)} Source Change`,
    summary: input.transaction.previewLabel,
    actionLabel: `Apply ${formatLabel(input.transaction.format)} change`,
    riskLabel: input.transaction.riskLabel,
    sourceHash: input.transaction.sourceHash,
    documentEpoch: input.documentEpoch,
    transaction: input.transaction,
    sourcePreview,
    notes: [...(input.notes ?? [])],
  };
}

export function resolveStructuredEditReviewApply(
  currentSource: string,
  currentDocumentEpoch: number,
  review: StructuredReviewPlan,
): { ok: true; nextSource: string; previewLabel: string; transaction: StructuredEditTransaction } | { ok: false; reason: string } {
  const currentHash = structuredSourceHashForFormat(review.format, currentSource);
  if (review.documentEpoch !== currentDocumentEpoch || review.sourceHash !== currentHash) {
    return {
      ok: false,
      reason: `${formatLabel(review.format)} source changed before the reviewed edit could be applied. Re-select the target and try again.`,
    };
  }
  return {
    ok: true,
    nextSource: review.transaction.nextSource,
    previewLabel: review.transaction.previewLabel,
    transaction: review.transaction,
  };
}

export function structuredEditTransactionFromJsonEdit(
  source: string,
  intent: JsonVisualEditIntent,
  plan: JsonVisualEditPlan,
): StructuredEditTransaction | null {
  if (!plan.ok || plan.nextSource === undefined) return null;
  return createStructuredEditTransaction({
    format: 'json',
    source,
    operationId: intent.kind,
    operationLabel: jsonOperationLabel(intent),
    target: jsonTarget(intent),
    edits: plan.edits.map(jsonEditToStructuredEdit),
    nextSource: plan.nextSource,
    diagnostics: plan.diagnostics,
    previewLabel: plan.previewLabel,
    undoLabel: jsonUndoLabel(intent),
    destructive: intent.kind === 'deleteObjectField' || intent.kind === 'deleteArrayItem',
    requiresReview: intent.kind !== 'replaceScalar',
    postApplyValidation: 'schema',
  });
}

export function structuredEditTransactionFromJsonlEdit(
  source: string,
  intent: JsonlVisualEditIntent,
  plan: JsonlVisualEditPlan,
): StructuredEditTransaction | null {
  if (!plan.ok || plan.nextSource === undefined) return null;
  return createStructuredEditTransaction({
    format: 'jsonl',
    source,
    operationId: intent.kind,
    operationLabel: jsonlOperationLabel(intent),
    target: jsonlTarget(intent),
    edits: plan.edits.map(jsonlEditToStructuredEdit),
    nextSource: plan.nextSource,
    diagnostics: plan.diagnostics,
    previewLabel: plan.previewLabel,
    undoLabel: jsonlOperationLabel(intent),
    destructive: intent.kind === 'deleteRecord',
    requiresReview: true,
    postApplyValidation: 'parse',
  });
}

export function structuredEditTransactionFromTabularEdit(
  source: string,
  intent: TabularVisualEditIntent,
  plan: TabularVisualEditPlan,
): StructuredEditTransaction | null {
  if (!plan.ok || plan.nextSource === undefined) return null;
  return createStructuredEditTransaction({
    format: intent.format,
    source,
    operationId: intent.kind,
    operationLabel: tabularOperationLabel(intent),
    target: tabularTarget(intent),
    edits: plan.edits.map(tabularEditToStructuredEdit),
    nextSource: plan.nextSource,
    diagnostics: plan.diagnostics,
    previewLabel: plan.previewLabel,
    undoLabel: tabularOperationLabel(intent),
    destructive: false,
    requiresReview: intent.kind === 'appendRow',
    postApplyValidation: 'parse',
  });
}

export function structuredEditTransactionFromYamlEdit(
  source: string,
  intent: YamlVisualEditIntent,
  plan: YamlVisualEditPlan,
): StructuredEditTransaction | null {
  if (!plan.ok || plan.nextSource === undefined) return null;
  return createStructuredEditTransaction({
    format: 'yaml',
    source,
    operationId: intent.kind,
    operationLabel: yamlOperationLabel(intent),
    target: { kind: 'path', label: displayPathFromPath(intent.path), path: [...intent.path], pointer: pointerFromPath(intent.path) },
    edits: plan.edits.map(yamlEditToStructuredEdit),
    nextSource: plan.nextSource,
    diagnostics: plan.diagnostics,
    previewLabel: plan.previewLabel,
    undoLabel: `Undo ${yamlOperationLabel(intent).toLowerCase()}`,
    destructive: intent.kind === 'deleteObjectField' || intent.kind === 'deleteArrayItem',
    requiresReview: true,
    postApplyValidation: 'parse',
    semanticAssertions: yamlSemanticAssertions(plan.nextSource, intent),
  });
}

export function structuredEditTransactionFromTomlNativePlan(
  source: string,
  intent: TomlNativeMutationIntent,
  plan: TomlNativeMutationPlanReport,
): StructuredEditTransaction | null {
  if (plan.status !== 'planned' || plan.nextSource === null || plan.nextValue === null || plan.patches.length !== 1) return null;
  const label = tomlOperationLabel(intent.kind);
  return createStructuredEditTransaction({
    format: 'toml', source, operationId: intent.kind, operationLabel: label,
    target: { kind: 'path', label: displayPathFromPath(intent.path), path: [...intent.path], pointer: pointerFromPath(intent.path) },
    edits: plan.patches.map((patch) => ({ offset: patch.from, length: patch.to - patch.from, content: patch.insert })),
    nextSource: plan.nextSource,
    diagnostics: plan.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity, code: diagnostic.code, message: diagnostic.message, source: 'toml', category: 'edit',
      span: diagnostic.span ?? undefined, line: diagnostic.line ?? undefined, column: diagnostic.column ?? undefined,
      blocking: diagnostic.severity === 'error',
    })),
    previewLabel: `${label} with one native guarded source patch.`, undoLabel: `Undo ${label.toLowerCase()}`,
    destructive: intent.kind === 'deleteObjectField' || intent.kind === 'deleteArrayItem', requiresReview: true,
    postApplyValidation: 'parse', semanticAssertions: semanticAssertionsForIntent(plan.nextValue, intent),
  });
}

export function structuredEditTransactionFromXmlEdit(
  source: string,
  intent: XmlVisualEditIntent,
  plan: XmlVisualEditPlan,
): StructuredEditTransaction | null {
  if (!plan.ok || plan.nextSource === undefined || !plan.targetIdentity || plan.semanticTargetValue === undefined) return null;
  return createStructuredEditTransaction({
    format: 'xml',
    source,
    operationId: intent.kind,
    operationLabel: plan.targetIdentity.kind === 'attribute-value' ? 'Edit XML attribute value' : 'Edit XML element text',
    target: {
      kind: 'path',
      label: displayPathFromPath(intent.path),
      path: [...intent.path],
      pointer: pointerFromPath(intent.path),
    },
    edits: plan.edits.map((edit) => ({ ...edit })),
    nextSource: plan.nextSource,
    diagnostics: plan.diagnostics,
    previewLabel: plan.previewLabel,
    undoLabel: plan.targetIdentity.kind === 'attribute-value' ? 'Undo XML attribute edit' : 'Undo XML text edit',
    destructive: false,
    requiresReview: true,
    postApplyValidation: 'parse',
    semanticAssertions: [{
      path: [...plan.targetIdentity.elementPath],
      expectation: 'present',
      valueHash: structuredSemanticValueHash(plan.semanticTargetValue),
    }],
  });
}

export function structuredEditTransactionFromClipboardReplace(input: {
  format: StructuredClipboardReplaceFormat;
  source: string;
  replacement: string;
  diagnostics?: readonly FormatDiagnostic[];
}): StructuredEditTransaction | null {
  if (input.source === input.replacement) return null;
  const label = formatLabel(input.format);
  return createStructuredEditTransaction({
    format: input.format,
    source: input.source,
    operationId: 'applyClipboardReplace',
    operationLabel: `Apply ${label} clipboard replacement`,
    target: {
      kind: 'document',
      label: `${label} document`,
    },
    edits: [{
      offset: 0,
      length: input.source.length,
      content: input.replacement,
    }],
    nextSource: input.replacement,
    diagnostics: input.diagnostics,
    previewLabel: `Replace ${label} document from clipboard.`,
    undoLabel: `Undo ${label} clipboard replacement`,
    destructive: true,
    requiresReview: true,
    postApplyValidation: input.format === 'json' ? 'schema' : 'parse',
  });
}

export function createStructuredClipboardReplaceReviewPlan(input: {
  format: StructuredClipboardReplaceFormat;
  source: string;
  replacement: string;
  documentEpoch: number;
  diagnostics?: readonly FormatDiagnostic[];
  notes?: readonly string[];
}): StructuredReviewPlan | null {
  const transaction = structuredEditTransactionFromClipboardReplace(input);
  if (!transaction) return null;
  return createStructuredEditReviewPlan({
    source: input.source,
    transaction,
    documentEpoch: input.documentEpoch,
    notes: input.notes,
  });
}

export function structuredSourceHashForFormat(format: StructuredEditableFormat, source: string): string {
  if (format === 'json') return jsonSourceHash(source);
  if (format === 'jsonl') return jsonlSourceHash(source);
  if (format === 'csv' || format === 'tsv') return tabularSourceHash(source);
  if (format === 'yaml') return yamlSourceHash(source);
  if (format === 'xml') return xmlSourceHash(source);
  return fallbackSourceHash(source);
}

function semanticAssertionsForIntent(value: unknown, intent: TomlNativeMutationIntent): StructuredSemanticAssertion[] {
  if (intent.kind === 'deleteObjectField') return [{ path: [...intent.path], expectation: 'absent' }];
  if (intent.kind === 'deleteArrayItem') {
    const parent = intent.path.slice(0, -1); const actual = semanticValueAtPath(value, parent);
    return actual.found ? [{ path: parent, expectation: 'present', valueHash: structuredSemanticValueHash(actual.value) }] : [];
  }
  if (intent.kind === 'renameObjectKey' && intent.newKey) {
    const nextPath = [...intent.path.slice(0, -1), intent.newKey]; const actual = semanticValueAtPath(value, nextPath);
    return actual.found ? [{ path: [...intent.path], expectation: 'absent' }, { path: nextPath, expectation: 'present', valueHash: structuredSemanticValueHash(actual.value) }] : [];
  }
  let path = intent.kind === 'addObjectField' && intent.key ? [...intent.path, intent.key] : [...intent.path];
  if (intent.kind === 'addArrayItem') {
    const array = semanticValueAtPath(value, intent.path);
    if (!array.found || !Array.isArray(array.value) || array.value.length === 0) return [];
    path = [...intent.path, array.value.length - 1];
  }
  const actual = semanticValueAtPath(value, path);
  return actual.found ? [{ path, expectation: 'present', valueHash: structuredSemanticValueHash(actual.value) }] : [];
}

function tomlOperationLabel(kind: TomlNativeMutationIntent['kind']): string {
  if (kind === 'replaceScalar') return 'Edit TOML value';
  if (kind === 'renameObjectKey') return 'Rename TOML key';
  if (kind === 'addObjectField') return 'Add TOML field';
  if (kind === 'deleteObjectField') return 'Delete TOML field';
  if (kind === 'addArrayItem') return 'Append TOML item';
  return 'Delete TOML item';
}

function yamlEditToStructuredEdit(edit: YamlTextEdit): StructuredEditTextEdit {
  return { offset: edit.offset, length: edit.length, content: edit.content };
}

function yamlOperationLabel(intent: YamlVisualEditIntent): string {
  if (intent.kind === 'replaceScalar') return 'Edit YAML value';
  if (intent.kind === 'renameObjectKey') return 'Rename YAML key';
  if (intent.kind === 'addObjectField') return 'Add YAML field';
  if (intent.kind === 'deleteObjectField') return 'Delete YAML field';
  if (intent.kind === 'addArrayItem') return 'Append YAML item';
  return 'Delete YAML item';
}

function yamlSemanticAssertions(nextSource: string, intent: YamlVisualEditIntent): StructuredSemanticAssertion[] {
  const parsed = parseYamlSemanticValue(nextSource);
  if (!parsed.ok) return [];
  if (intent.kind === 'deleteObjectField') {
    return [{ path: [...intent.path], expectation: 'absent' }];
  }
  if (intent.kind === 'deleteArrayItem') {
    const parentPath = intent.path.slice(0, -1);
    const parent = semanticValueAtPath(parsed.value, parentPath);
    return parent.found ? [{ path: parentPath, expectation: 'present', valueHash: structuredSemanticValueHash(parent.value) }] : [];
  }
  if (intent.kind === 'renameObjectKey') {
    const nextPath = [...intent.path.slice(0, -1), intent.newKey];
    const value = semanticValueAtPath(parsed.value, nextPath);
    return value.found ? [
      { path: [...intent.path], expectation: 'absent' },
      { path: nextPath, expectation: 'present', valueHash: structuredSemanticValueHash(value.value) },
    ] : [];
  }
  let path = intent.kind === 'addObjectField' ? [...intent.path, intent.key] : [...intent.path];
  if (intent.kind === 'addArrayItem') {
    const sequence = semanticValueAtPath(parsed.value, intent.path);
    if (!sequence.found || !Array.isArray(sequence.value) || sequence.value.length === 0) return [];
    path = [...intent.path, sequence.value.length - 1];
  }
  const value = semanticValueAtPath(parsed.value, path);
  return value.found ? [{ path, expectation: 'present', valueHash: structuredSemanticValueHash(value.value) }] : [];
}

export function structuredSemanticValueHash(value: unknown): string {
  return fallbackSourceHash(stableSemanticStringify(value));
}

function stableSemanticStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSemanticStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSemanticStringify(record[key])}`).join(',')}}`;
}

function parseYamlSemanticValue(source: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const document = parseDocument(source, { strict: true, uniqueKeys: true });
    return document.errors.length === 0 ? { ok: true, value: document.toJS() } : { ok: false };
  } catch { return { ok: false }; }
}

function semanticValueAtPath(value: unknown, path: readonly StructuredPathSegment[]): { found: boolean; value: unknown } {
  let current = value;
  for (const segment of path) {
    if (typeof segment === 'number' && Array.isArray(current) && segment >= 0 && segment < current.length) current = current[segment];
    else if (typeof segment === 'string' && current !== null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, segment)) current = (current as Record<string, unknown>)[segment];
    else return { found: false, value: undefined };
  }
  return { found: true, value: current };
}

function jsonEditToStructuredEdit(edit: JsonTextEdit): StructuredEditTextEdit {
  return { offset: edit.offset, length: edit.length, content: edit.content };
}

function jsonlEditToStructuredEdit(edit: JsonlTextEdit): StructuredEditTextEdit {
  return { offset: edit.offset, length: edit.length, content: edit.content };
}

function tabularEditToStructuredEdit(edit: TabularTextEdit): StructuredEditTextEdit {
  return { offset: edit.offset, length: edit.length, content: edit.content };
}

function jsonTarget(intent: JsonVisualEditIntent): StructuredEditTarget {
  const path = 'path' in intent ? [...intent.path] : [];
  return {
    kind: 'path',
    label: displayPathFromPath(path),
    path,
    pointer: pointerFromPath(path),
  };
}

function jsonlTarget(intent: JsonlVisualEditIntent): StructuredEditTarget {
  if (intent.kind === 'appendRecord') {
    return { kind: 'record', label: 'New JSONL record' };
  }
  return {
    kind: 'record',
    label: `JSONL line ${intent.lineNumber}`,
    lineNumber: intent.lineNumber,
  };
}

function tabularTarget(intent: TabularVisualEditIntent): StructuredEditTarget {
  if (intent.kind === 'appendRow') {
    return {
      kind: 'row',
      label: `New ${formatLabel(intent.format)} row`,
    };
  }
  return {
    kind: 'cell',
    label: `${formatLabel(intent.format)} row ${intent.dataRowIndex + 1}, column ${intent.columnIndex + 1}`,
    rowIndex: intent.dataRowIndex,
    columnIndex: intent.columnIndex,
  };
}

function jsonOperationLabel(intent: JsonVisualEditIntent): string {
  switch (intent.kind) {
    case 'replaceScalar':
      return 'Edit JSON value';
    case 'renameObjectKey':
      return 'Rename JSON key';
    case 'addObjectField':
      return 'Add JSON field';
    case 'deleteObjectField':
      return 'Delete JSON field';
    case 'addArrayItem':
      return 'Add JSON item';
    case 'deleteArrayItem':
      return 'Delete JSON item';
  }
}

function jsonUndoLabel(intent: JsonVisualEditIntent): string {
  switch (intent.kind) {
    case 'replaceScalar':
      return 'Undo JSON value edit';
    case 'renameObjectKey':
      return 'Undo JSON key rename';
    case 'addObjectField':
      return 'Undo JSON field add';
    case 'deleteObjectField':
      return 'Undo JSON field delete';
    case 'addArrayItem':
      return 'Undo JSON item add';
    case 'deleteArrayItem':
      return 'Undo JSON item delete';
  }
}

function jsonlOperationLabel(intent: JsonlVisualEditIntent): string {
  switch (intent.kind) {
    case 'appendRecord':
      return 'Append JSONL record';
    case 'duplicateRecord':
      return 'Duplicate JSONL record';
    case 'deleteRecord':
      return 'Delete JSONL record';
    case 'replaceRecord':
      return 'Replace JSONL record';
  }
}

function tabularOperationLabel(intent: TabularVisualEditIntent): string {
  return intent.kind === 'replaceCell'
    ? `Edit ${formatLabel(intent.format)} cell`
    : `Append ${formatLabel(intent.format)} row`;
}

function structuredEditRiskLabel(edits: readonly StructuredEditTextEdit[]): string {
  if (edits.length === 0) return 'No source change';
  if (edits.length > 1) return 'Multiple source ranges';
  const edit = edits[0];
  if (!edit) return 'No source change';
  if (edit.content.length > 240 || edit.length > 240) return 'Large source range';
  if (edit.content.length > 0 && edit.length > 0) return 'Replace source range';
  if (edit.content.length > 0) return 'Insert source range';
  return 'Delete source range';
}

function sourcePreviewRange(source: string, edits: readonly StructuredEditTextEdit[]): StructuredEditSourcePreviewRange {
  if (edits.length === 0) {
    const position = lineColumnForOffset(source, 0);
    return {
      offset: 0,
      length: 0,
      endOffset: 0,
      line: position.line,
      column: position.column,
      endLine: position.line,
      endColumn: position.column,
      insertedLength: 0,
      removedLength: 0,
    };
  }

  const offset = Math.min(...edits.map((edit) => edit.offset));
  const endOffset = Math.max(...edits.map((edit) => edit.offset + edit.length));
  const start = lineColumnForOffset(source, offset);
  const end = lineColumnForOffset(source, endOffset);
  return {
    offset,
    length: endOffset - offset,
    endOffset,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    insertedLength: edits.reduce((total, edit) => total + edit.content.length, 0),
    removedLength: edits.reduce((total, edit) => total + edit.length, 0),
  };
}

function boundedSnippet(
  source: string,
  startOffset: number,
  endOffset: number,
  contextCharacters: number,
  maxSnippetCharacters: number,
): { text: string; truncated: boolean } {
  const snippetStart = Math.max(0, startOffset - contextCharacters);
  const snippetEnd = Math.min(source.length, endOffset + contextCharacters);
  const prefix = snippetStart > 0 ? '...\n' : '';
  const suffix = snippetEnd < source.length ? '\n...' : '';
  let text = `${prefix}${source.slice(snippetStart, snippetEnd)}${suffix}`;
  let truncated = snippetStart > 0 || snippetEnd < source.length;
  if (text.length <= maxSnippetCharacters) return { text, truncated };

  const headLength = Math.max(20, Math.floor((maxSnippetCharacters - 6) / 2));
  const tailLength = Math.max(20, maxSnippetCharacters - 6 - headLength);
  text = `${text.slice(0, headLength)}\n...\n${text.slice(Math.max(headLength, text.length - tailLength))}`;
  truncated = true;
  return { text, truncated };
}

function lineColumnForOffset(source: string, requestedOffset: number): { line: number; column: number } {
  const offset = Math.max(0, Math.min(requestedOffset, source.length));
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    const char = source[index];
    if (char === '\r') {
      if (source[index + 1] === '\n') index += 1;
      line += 1;
      column = 1;
    } else if (char === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function stableStructuredTransactionId(
  format: StructuredEditableFormat,
  operationId: string,
  sourceHash: string,
  edits: readonly StructuredEditTextEdit[],
): string {
  const editShape = edits.map((edit) => `${edit.offset}:${edit.length}:${edit.content.length}`).join('|');
  return `${format}:${operationId}:${sourceHash}:${fallbackSourceHash(editShape)}`;
}

function fallbackSourceHash(source: string): string {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 16777619) >>> 0;
  }
  return `${source.length.toString(36)}:${hash.toString(36)}`;
}

function formatLabel(format: StructuredEditableFormat): string {
  if (format === 'json') return 'JSON';
  if (format === 'jsonl') return 'JSONL';
  if (format === 'csv') return 'CSV';
  if (format === 'yaml') return 'YAML';
  if (format === 'toml') return 'TOML';
  if (format === 'xml') return 'XML';
  return 'TSV';
}
