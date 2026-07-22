import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  type Document,
  type ParsedNode,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import type { FormatDiagnostic, StructuredPathSegment } from '../documentFormat.js';
import { displayPathFromPath, pointerFromPath } from '../structured/sourceMap.js';

export type YamlScalarValue = string | number | boolean | null;
export type YamlEditValue = YamlScalarValue;
export type YamlVisualEditIntent =
  | { kind: 'replaceScalar'; path: StructuredPathSegment[]; nextValue: YamlScalarValue; expectedSourceHash?: string }
  | { kind: 'renameObjectKey'; path: StructuredPathSegment[]; newKey: string; expectedSourceHash?: string }
  | { kind: 'addObjectField'; path: StructuredPathSegment[]; key: string; value: YamlEditValue; expectedSourceHash?: string }
  | { kind: 'deleteObjectField'; path: StructuredPathSegment[]; expectedSourceHash?: string }
  | { kind: 'addArrayItem'; path: StructuredPathSegment[]; index?: number; value: YamlEditValue; expectedSourceHash?: string }
  | { kind: 'deleteArrayItem'; path: StructuredPathSegment[]; expectedSourceHash?: string };

export interface YamlTextEdit { offset: number; length: number; content: string }
export interface YamlVisualEditPlan {
  ok: boolean;
  edits: YamlTextEdit[];
  diagnostics: FormatDiagnostic[];
  previewLabel: string;
  nextSource?: string;
  unsupportedReason?: string;
  semanticPath?: StructuredPathSegment[];
}

type Located = { node: ParsedNode; parent: YAMLMap | YAMLSeq | null; pair: Pair | null; path: StructuredPathSegment[] };

export function yamlSourceHash(source: string): string {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619) >>> 0;
  return `${source.length.toString(36)}:${hash.toString(36)}`;
}

export function applyYamlEdits(source: string, edits: readonly YamlTextEdit[]): string {
  return [...edits].sort((a, b) => b.offset - a.offset).reduce(
    (text, edit) => text.slice(0, edit.offset) + edit.content + text.slice(edit.offset + edit.length),
    source,
  );
}

export function planYamlVisualEdit(source: string, intent: YamlVisualEditIntent): YamlVisualEditPlan {
  if (intent.expectedSourceHash && intent.expectedSourceHash !== yamlSourceHash(source)) {
    return rejected('yaml-edit-stale-source', 'YAML source changed before this visual edit could be planned.', intent.path);
  }
  if (new TextEncoder().encode(source).length > 1024 * 1024) {
    return rejected('yaml-edit-source-too-large', 'YAML exceeds the 1 MiB visual parse budget and remains source-only.', intent.path);
  }
  if (/^\s*%/m.test(source) || isMultiDocumentStream(source)) {
    return rejected('yaml-edit-document-stream-readonly', 'YAML directives and multi-document streams are source-only.', intent.path);
  }
  const parsed = parseForEdits(source);
  if (!parsed.ok) return rejected('yaml-edit-invalid-source', parsed.reason, intent.path);
  const located = locate(parsed.document, intent.path);
  const planned = planIntent(source, located, intent);
  if (!planned.ok) return rejected(planned.code, planned.reason, intent.path);
  const nextSource = applyYamlEdits(source, [planned.edit]);
  const next = parseForEdits(nextSource);
  if (!next.ok) return rejected('yaml-edit-invalid-result', `The resulting YAML did not parse: ${next.reason}`, intent.path);
  if (!semanticPostconditionHolds(parsed.document.toJS(), next.document.toJS(), intent)) {
    return rejected('yaml-edit-semantic-postcondition', 'The resulting YAML did not satisfy the requested operation.', intent.path);
  }
  return {
    ok: true,
    edits: [planned.edit],
    diagnostics: planned.styleChanged ? [{
      severity: 'warning', code: 'yaml-edit-scalar-style-change', source: 'yaml', category: 'preservation',
      message: 'The requested value could not retain its prior scalar style; review the explicit quoted-style change.',
      path: intent.path, pointer: pointerFromPath(intent.path), displayPath: displayPathFromPath(intent.path), blocking: false,
    }] : [],
    previewLabel: previewLabel(intent),
    nextSource,
    semanticPath: semanticPath(intent),
  };
}

function isMultiDocumentStream(source: string): boolean {
  const markers = Array.from(source.matchAll(/^\s*---(?:\s|$)/gm));
  if (markers.length > 1) return true;
  if (markers.length === 0) return false;
  return source.slice(0, markers[0]!.index ?? 0).trim().length > 0;
}

function parseForEdits(source: string): { ok: true; document: Document.Parsed } | { ok: false; reason: string } {
  const document = parseDocument(source, { keepSourceTokens: true, strict: true, uniqueKeys: true });
  const errors = document.errors;
  if (errors.length > 0 || !document.contents) return { ok: false, reason: errors[0]?.message ?? 'YAML document is empty.' };
  return { ok: true, document: document as Document.Parsed };
}

function locate(document: Document.Parsed, path: StructuredPathSegment[]): Located | null {
  let node: ParsedNode = document.contents as ParsedNode;
  let parent: YAMLMap | YAMLSeq | null = null;
  let pair: Pair | null = null;
  const walked: StructuredPathSegment[] = [];
  for (const segment of path) {
    if (isMap(node) && typeof segment === 'string') {
      const matches = node.items.filter((item) => isPair(item) && isScalar(item.key) && String(item.key.value) === segment);
      if (matches.length !== 1 || !matches[0]!.value || !isNode(matches[0]!.value)) return null;
      parent = node; pair = matches[0]!; node = matches[0]!.value; walked.push(segment); continue;
    }
    if (isSeq(node) && typeof segment === 'number' && Number.isInteger(segment) && segment >= 0) {
      const item = node.items[segment];
      if (!item || !isNode(item)) return null;
      parent = node; pair = null; node = item; walked.push(segment); continue;
    }
    return null;
  }
  return { node, parent, pair, path: walked };
}

function planIntent(source: string, located: Located | null, intent: YamlVisualEditIntent):
  | { ok: true; edit: YamlTextEdit; styleChanged: boolean }
  | { ok: false; code: string; reason: string } {
  if (!located) return fail('yaml-edit-unmapped-node', `No unique YAML source node exists at ${displayPathFromPath(intent.path)}.`);
  const syntaxReason = unsupportedSyntaxReason(located.node, located.parent);
  if (syntaxReason) return fail('yaml-edit-unsupported-syntax', syntaxReason);
  switch (intent.kind) {
    case 'replaceScalar': {
      if (!isScalar(located.node) || !located.node.range) return fail('yaml-edit-nonscalar', 'Only scalar YAML nodes can use value replacement.');
      const serialized = serializeScalar(intent.nextValue, located.node);
      return { ok: true, edit: { offset: located.node.range[0], length: located.node.range[1] - located.node.range[0], content: serialized.text }, styleChanged: serialized.styleChanged };
    }
    case 'renameObjectKey': {
      if (!located.pair || !isMap(located.parent) || !isScalar(located.pair.key) || !located.pair.key.range) return fail('yaml-edit-key-target', 'Select a simple block-mapping field to rename its key.');
      if (!intent.newKey) return fail('yaml-edit-empty-key', 'YAML mapping keys cannot be empty in visual mode.');
      if (located.parent.items.some((item) => isPair(item) && isScalar(item.key) && String(item.key.value) === intent.newKey)) return fail('yaml-edit-duplicate-key', `Key "${intent.newKey}" already exists in this mapping.`);
      const serialized = serializeKey(intent.newKey, located.pair.key);
      return { ok: true, edit: { offset: located.pair.key.range[0], length: located.pair.key.range[1] - located.pair.key.range[0], content: serialized.text }, styleChanged: serialized.styleChanged };
    }
    case 'addObjectField': {
      if (!isMap(located.node) || tokenType(located.node) !== 'block-map' || !located.node.range) return fail('yaml-edit-map-shape', 'Only non-empty block mappings with unambiguous spans support visual field insertion.');
      if (!intent.key || located.node.items.some((item) => isPair(item) && isScalar(item.key) && String(item.key.value) === intent.key)) return fail('yaml-edit-duplicate-key', `Key "${intent.key}" is empty or already exists.`);
      const indent = collectionIndent(source, located.node.range[0]);
      const eol = source.includes('\r\n') ? '\r\n' : '\n';
      const prefix = located.node.range[2] > 0 && !/[\r\n]/.test(source[located.node.range[2] - 1] ?? '') ? eol : '';
      const content = `${prefix}${indent}${serializeNewKey(intent.key)}: ${serializeNewScalar(intent.value)}${eol}`;
      return { ok: true, edit: { offset: located.node.range[2], length: 0, content }, styleChanged: false };
    }
    case 'deleteObjectField': {
      if (!located.pair || !isMap(located.parent) || !located.node.range || !isScalar(located.pair.key) || !located.pair.key.range) return fail('yaml-edit-key-target', 'Select a simple block-mapping field to delete it.');
      if (located.parent.items.length <= 1) return fail('yaml-edit-last-map-field', 'Deleting the final block-mapping field would change the container representation; use source mode.');
      const span = fullLineSpan(source, located.pair.key.range[0], located.node.range[2]);
      if (!span || /#/.test(source.slice(span.offset, span.offset + span.length))) return fail('yaml-edit-comment-owned-span', 'This field shares its deletion span with a comment; delete it in source mode.');
      return { ok: true, edit: { ...span, content: '' }, styleChanged: false };
    }
    case 'addArrayItem': {
      if (!isSeq(located.node) || tokenType(located.node) !== 'block-seq' || !located.node.range) return fail('yaml-edit-sequence-shape', 'Only non-empty block sequences with unambiguous spans support visual item insertion.');
      const index = intent.index ?? located.node.items.length;
      if (index !== located.node.items.length) return fail('yaml-edit-sequence-append-only', 'Visual YAML sequence insertion is append-only; use source mode for positional insertion.');
      const indent = collectionIndent(source, located.node.range[0]);
      const eol = source.includes('\r\n') ? '\r\n' : '\n';
      const prefix = located.node.range[2] > 0 && !/[\r\n]/.test(source[located.node.range[2] - 1] ?? '') ? eol : '';
      return { ok: true, edit: { offset: located.node.range[2], length: 0, content: `${prefix}${indent}- ${serializeNewScalar(intent.value)}${eol}` }, styleChanged: false };
    }
    case 'deleteArrayItem': {
      if (!isSeq(located.parent) || !located.node.range) return fail('yaml-edit-array-target', 'Select a block-sequence item to delete it.');
      if (located.parent.items.length <= 1) return fail('yaml-edit-last-sequence-item', 'Deleting the final block-sequence item would change the container representation; use source mode.');
      const span = fullLineSpan(source, located.node.range[0], located.node.range[2], true);
      if (!span || /#/.test(source.slice(span.offset, span.offset + span.length))) return fail('yaml-edit-comment-owned-span', 'This item shares its deletion span with a comment; delete it in source mode.');
      return { ok: true, edit: { ...span, content: '' }, styleChanged: false };
    }
  }
}

function unsupportedSyntaxReason(node: ParsedNode, parent: YAMLMap | YAMLSeq | null): string | null {
  for (const candidate of [node, parent]) {
    if (!candidate) continue;
    if (isAlias(candidate)) return 'Aliases are source-only because their value is owned by another source token.';
    if ((candidate as { anchor?: string }).anchor) return 'Anchored nodes are source-only to preserve alias identity.';
    if ((candidate as { tag?: string }).tag) return 'Explicitly tagged nodes are source-only to preserve tag semantics.';
    if (isScalar(candidate) && (candidate.type === Scalar.BLOCK_FOLDED || candidate.type === Scalar.BLOCK_LITERAL)) return 'Block scalars are source-only to preserve style, chomping, and indentation.';
    if (tokenType(candidate) === 'flow-collection') return 'Flow collections are source-only until punctuation-aware patches are supported.';
    if (isMap(candidate) && candidate.items.some((item) => isPair(item) && isScalar(item.key) && String(item.key.value) === '<<')) return 'Mappings containing merge keys are source-only because effective values are non-local.';
  }
  return null;
}

function serializeScalar(value: YamlScalarValue, current: Scalar): { text: string; styleChanged: boolean } {
  const type = tokenType(current);
  if (type === 'single-quoted-scalar' && typeof value === 'string') return { text: `'${value.replace(/'/g, "''")}'`, styleChanged: false };
  if (type === 'double-quoted-scalar' && typeof value === 'string') return { text: JSON.stringify(value), styleChanged: false };
  const plain = serializePlain(value);
  if (type === 'scalar' && plain !== null) return { text: plain, styleChanged: false };
  return { text: typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : serializeNewScalar(value), styleChanged: true };
}

function serializeKey(value: string, current: Scalar): { text: string; styleChanged: boolean } {
  const type = tokenType(current);
  if (type === 'single-quoted-scalar') return { text: `'${value.replace(/'/g, "''")}'`, styleChanged: false };
  if (type === 'double-quoted-scalar') return { text: JSON.stringify(value), styleChanged: false };
  const plain = safePlainString(value);
  return plain ? { text: value, styleChanged: false } : { text: `'${value.replace(/'/g, "''")}'`, styleChanged: true };
}

function serializeNewKey(value: string): string { return safePlainString(value) ? value : `'${value.replace(/'/g, "''")}'`; }
function serializeNewScalar(value: YamlScalarValue): string { return serializePlain(value) ?? `'${String(value).replace(/'/g, "''")}'`; }
function serializePlain(value: YamlScalarValue): string | null {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  return safePlainString(value) ? value : null;
}
function safePlainString(value: string): boolean {
  if (!value || /[\r\n:#\[\]{},&*!|>'"%@`]/.test(value) || /^[-?:]\s/.test(value) || /\s$/.test(value)) return false;
  const parsed = parseDocument(value, { strict: true }).toJS();
  return parsed === value;
}

function fullLineSpan(source: string, start: number, requestedEnd: number, sequenceItem = false): { offset: number; length: number } | null {
  const offset = Math.max(source.lastIndexOf('\n', start - 1) + 1, 0);
  const prefix = source.slice(offset, start);
  if (sequenceItem ? !/^\s*-\s*$/.test(prefix) : prefix.trim().length > 0) return null;
  let end = Math.max(start, requestedEnd);
  if (end < source.length && source[end - 1] !== '\n') { const lineEnd = source.indexOf('\n', end); end = lineEnd < 0 ? source.length : lineEnd + 1; }
  return { offset, length: end - offset };
}
function collectionIndent(source: string, start: number): string {
  const lineStart = Math.max(source.lastIndexOf('\n', start - 1) + 1, 0);
  return source.slice(lineStart, start).match(/^\s*/)?.[0] ?? '';
}
function tokenType(node: unknown): string | null { const token = (node as { srcToken?: { type?: unknown } } | null)?.srcToken; return typeof token?.type === 'string' ? token.type : null; }
function isNode(value: unknown): value is ParsedNode { return Boolean(value && typeof value === 'object' && 'range' in value); }
function fail(code: string, reason: string): { ok: false; code: string; reason: string } { return { ok: false, code, reason }; }
function rejected(code: string, reason: string, path: StructuredPathSegment[]): YamlVisualEditPlan {
  return { ok: false, edits: [], diagnostics: [{ severity: 'warning', code, source: 'yaml', category: 'preservation', message: reason, path, pointer: pointerFromPath(path), displayPath: displayPathFromPath(path), blocking: false }], previewLabel: 'YAML visual edit unavailable', unsupportedReason: reason };
}
function semanticPath(intent: YamlVisualEditIntent): StructuredPathSegment[] {
  if (intent.kind === 'renameObjectKey') return [...intent.path.slice(0, -1), intent.newKey];
  if (intent.kind === 'addObjectField') return [...intent.path, intent.key];
  if (intent.kind === 'addArrayItem') return [...intent.path];
  return intent.path;
}
function semanticPostconditionHolds(before: unknown, after: unknown, intent: YamlVisualEditIntent): boolean {
  if (intent.kind === 'deleteObjectField') return valueAtPath(after, intent.path).found === false;
  if (intent.kind === 'deleteArrayItem') {
    const parentPath = intent.path.slice(0, -1); const index = intent.path.at(-1);
    const prior = valueAtPath(before, parentPath); const next = valueAtPath(after, parentPath);
    if (typeof index !== 'number' || !prior.found || !next.found || !Array.isArray(prior.value) || !Array.isArray(next.value)) return false;
    return JSON.stringify(next.value) === JSON.stringify(prior.value.filter((_, itemIndex) => itemIndex !== index));
  }
  if (intent.kind === 'renameObjectKey') {
    const oldValue = valueAtPath(before, intent.path); const nextPath = semanticPath(intent);
    const renamed = valueAtPath(after, nextPath);
    return oldValue.found && !valueAtPath(after, intent.path).found && renamed.found && JSON.stringify(renamed.value) === JSON.stringify(oldValue.value);
  }
  const path = semanticPath(intent);
  if (intent.kind === 'addArrayItem') {
    const prior = valueAtPath(before, intent.path); const next = valueAtPath(after, intent.path);
    return prior.found && next.found && Array.isArray(prior.value) && Array.isArray(next.value)
      && next.value.length === prior.value.length + 1 && Object.is(next.value.at(-1), intent.value);
  }
  const actual = valueAtPath(after, path);
  const expected = intent.kind === 'replaceScalar' ? intent.nextValue : intent.value;
  return actual.found && Object.is(actual.value, expected);
}
function valueAtPath(value: unknown, path: StructuredPathSegment[]): { found: boolean; value: unknown } {
  let current = value;
  for (const segment of path) {
    if (typeof segment === 'number' && Array.isArray(current) && segment >= 0 && segment < current.length) current = current[segment];
    else if (typeof segment === 'string' && current !== null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, segment)) current = (current as Record<string, unknown>)[segment];
    else return { found: false, value: undefined };
  }
  return { found: true, value: current };
}
function previewLabel(intent: YamlVisualEditIntent): string {
  const target = displayPathFromPath(intent.path);
  if (intent.kind === 'replaceScalar') return `Replace YAML value at ${target}`;
  if (intent.kind === 'renameObjectKey') return `Rename YAML key at ${target}`;
  if (intent.kind === 'addObjectField') return `Add YAML field ${intent.key} at ${target}`;
  if (intent.kind === 'deleteObjectField') return `Delete YAML field at ${target}`;
  if (intent.kind === 'addArrayItem') return `Append YAML item at ${target}`;
  return `Delete YAML item at ${target}`;
}
