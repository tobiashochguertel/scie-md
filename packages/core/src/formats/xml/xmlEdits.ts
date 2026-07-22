import type { FormatDiagnostic, StructuredNodeRef, StructuredPathSegment } from '../documentFormat.js';
import { displayPathFromPath, pointerFromPath } from '../structured/sourceMap.js';
import { createXmlContent, parseXmlDocument, XML_PARSE_BUDGET_BYTES, type XmlElementNode, type XmlVisualNode } from './parseXmlDocument.js';

export const XML_VISUAL_PLANNER_VERSION = 'xml-lezer-source-v1';

export interface XmlVisualEditIntent {
  kind: 'replaceScalar';
  path: StructuredPathSegment[];
  nextValue: string;
  expectedSourceHash?: string;
}

export interface XmlTextEdit { offset: number; length: number; content: string }

export interface XmlMutationTargetIdentity {
  kind: 'attribute-value' | 'element-text';
  elementPath: StructuredPathSegment[];
  elementQualifiedName: string;
  elementLocalName: string;
  elementNamespaceUri: string | null;
  namespaceContext: Record<string, string>;
  attributeQualifiedName?: string;
  attributeLocalName?: string;
  attributeNamespaceUri?: string | null;
}

export interface XmlVisualEditPlan {
  ok: boolean;
  plannerVersion: typeof XML_VISUAL_PLANNER_VERSION;
  edits: XmlTextEdit[];
  diagnostics: FormatDiagnostic[];
  previewLabel: string;
  nextSource?: string;
  unsupportedReason?: string;
  targetIdentity?: XmlMutationTargetIdentity;
  semanticTargetValue?: unknown;
}

export function xmlSourceHash(source: string): string {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619) >>> 0;
  return `${source.length.toString(36)}:${hash.toString(36)}`;
}

export function applyXmlEdits(source: string, edits: readonly XmlTextEdit[]): string {
  return [...edits].sort((left, right) => right.offset - left.offset).reduce(
    (current, edit) => current.slice(0, edit.offset) + edit.content + current.slice(edit.offset + edit.length),
    source,
  );
}

export function planXmlVisualEdit(source: string, intent: XmlVisualEditIntent): XmlVisualEditPlan {
  if (intent.expectedSourceHash && intent.expectedSourceHash !== xmlSourceHash(source)) {
    return rejected('xml-edit-stale-source', 'XML source changed before this visual edit could be planned.', intent.path);
  }
  if (new TextEncoder().encode(source).length > XML_PARSE_BUDGET_BYTES) {
    return rejected('xml-edit-source-too-large', 'XML exceeds the visual parse budget and remains source-only.', intent.path);
  }
  if (!isValidXmlCharacters(intent.nextValue)) {
    return rejected('xml-edit-invalid-character', 'The replacement contains a character that XML 1.0 cannot represent.', intent.path);
  }
  const parsed = parseXmlDocument(createXmlContent(source));
  if (!parsed.parsed) {
    return rejected('xml-edit-invalid-source', parsed.diagnostics[0]?.message ?? 'XML source is invalid or prohibited.', intent.path);
  }
  const ref = parsed.parsed.sourceMap.nodesByPointer[pointerFromPath(intent.path)];
  if (!ref?.editable || !ref.editableOperations?.includes('replaceScalar') || !ref.valueSpan) {
    return rejected('xml-edit-source-only-node', ref?.unsupportedReason ?? 'This XML node is source-only.', intent.path);
  }
  const elementPath = containingElementPath(intent.path);
  const element = valueAtPath(parsed.parsed.value, elementPath);
  if (!isXmlElement(element)) return rejected('xml-edit-identity-missing', 'The XML element identity is no longer available.', intent.path);

  const planned = ref.nodeKind === 'attribute-value'
    ? planAttributeValue(source, ref, intent, elementPath, element)
    : ref.nodeKind === 'text-value'
      ? planElementText(ref, intent, elementPath, element)
      : null;
  if (!planned) return rejected('xml-edit-source-only-node', 'Only proven XML text and attribute values can be edited visually.', intent.path);
  if (!planned.ok) return rejected(planned.code, planned.reason, intent.path);

  const nextSource = applyXmlEdits(source, [planned.edit]);
  const next = parseXmlDocument(createXmlContent(nextSource));
  if (!next.parsed) return rejected('xml-edit-invalid-result', 'The resulting XML was not well formed and namespace-consistent.', intent.path);
  const nextElement = valueAtPath(next.parsed.value, elementPath);
  if (!isXmlElement(nextElement) || !sameElementIdentity(element, nextElement)) {
    return rejected('xml-edit-namespace-postcondition', 'The XML element or namespace identity changed after planning.', intent.path);
  }
  if (planned.identity.kind === 'attribute-value') {
    const index = attributeIndexFromPath(intent.path);
    const nextAttribute = index === null ? undefined : nextElement.attributes[index];
    if (!nextAttribute
      || nextAttribute.name !== planned.identity.attributeQualifiedName
      || nextAttribute.localName !== planned.identity.attributeLocalName
      || nextAttribute.namespaceUri !== planned.identity.attributeNamespaceUri
      || nextAttribute.value !== intent.nextValue) {
      return rejected('xml-edit-content-postcondition', 'The XML attribute value or namespace identity changed unexpectedly.', intent.path);
    }
  } else if (logicalElementText(nextElement) !== intent.nextValue) {
    return rejected('xml-edit-content-postcondition', 'The XML element text did not retain the requested semantic value.', intent.path);
  }

  return {
    ok: true,
    plannerVersion: XML_VISUAL_PLANNER_VERSION,
    edits: [planned.edit],
    diagnostics: [],
    previewLabel: planned.identity.kind === 'attribute-value'
      ? `Replace XML attribute ${planned.identity.attributeQualifiedName}.`
      : `Replace text in XML element ${planned.identity.elementQualifiedName}.`,
    nextSource,
    targetIdentity: planned.identity,
    semanticTargetValue: nextElement,
  };
}

function planAttributeValue(
  source: string,
  ref: StructuredNodeRef,
  intent: XmlVisualEditIntent,
  elementPath: StructuredPathSegment[],
  element: XmlElementNode,
): { ok: true; edit: XmlTextEdit; identity: XmlMutationTargetIdentity } | { ok: false; code: string; reason: string } {
  const index = attributeIndexFromPath(intent.path);
  const attribute = index === null ? undefined : element.attributes[index];
  if (!attribute || !ref.valueSpan) return fail('xml-edit-attribute-identity', 'The XML attribute identity is no longer available.');
  if (/[\r\n\t]/.test(intent.nextValue)) return fail('xml-edit-attribute-whitespace', 'Attribute line breaks and tabs remain source-only because XML normalizes them.');
  const quote = source[ref.valueSpan.offset - 1];
  if ((quote !== '"' && quote !== "'") || source[ref.valueSpan.offset + ref.valueSpan.length] !== quote) {
    return fail('xml-edit-attribute-delimiter', 'The XML attribute delimiter could not be proven.');
  }
  return {
    ok: true,
    edit: { offset: ref.valueSpan.offset, length: ref.valueSpan.length, content: escapeXmlAttribute(intent.nextValue, quote) },
    identity: {
      kind: 'attribute-value',
      elementPath: [...elementPath],
      elementQualifiedName: element.name,
      elementLocalName: element.localName,
      elementNamespaceUri: element.namespaceUri,
      namespaceContext: { ...(ref.namespaceContext ?? {}) },
      attributeQualifiedName: attribute.name,
      attributeLocalName: attribute.localName,
      attributeNamespaceUri: attribute.namespaceUri,
    },
  };
}

function planElementText(
  ref: StructuredNodeRef,
  intent: XmlVisualEditIntent,
  elementPath: StructuredPathSegment[],
  element: XmlElementNode,
): { ok: true; edit: XmlTextEdit; identity: XmlMutationTargetIdentity } | { ok: false; code: string; reason: string } {
  if (element.children.length !== 1 || element.children[0]?.kind !== 'text' || element.children[0].whitespaceOnly || !ref.valueSpan) {
    return fail('xml-edit-mixed-content', 'Only sole non-whitespace element text can be replaced visually.');
  }
  return {
    ok: true,
    edit: { offset: ref.valueSpan.offset, length: ref.valueSpan.length, content: escapeXmlText(intent.nextValue) },
    identity: {
      kind: 'element-text',
      elementPath: [...elementPath],
      elementQualifiedName: element.name,
      elementLocalName: element.localName,
      elementNamespaceUri: element.namespaceUri,
      namespaceContext: { ...(ref.namespaceContext ?? {}) },
    },
  };
}

function containingElementPath(path: readonly StructuredPathSegment[]): StructuredPathSegment[] {
  return path.length >= 3 ? path.slice(0, -3) : [];
}

function attributeIndexFromPath(path: readonly StructuredPathSegment[]): number | null {
  const marker = path.at(-3);
  const index = path.at(-2);
  return marker === 'attributes' && typeof index === 'number' ? index : null;
}

function valueAtPath(value: unknown, path: readonly StructuredPathSegment[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === 'number' && Array.isArray(current)) current = current[segment];
    else if (typeof segment === 'string' && current !== null && typeof current === 'object') current = (current as Record<string, unknown>)[segment];
    else return undefined;
  }
  return current;
}

function isXmlElement(value: unknown): value is XmlElementNode {
  return Boolean(value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'element');
}

function sameElementIdentity(left: XmlElementNode, right: XmlElementNode): boolean {
  return left.name === right.name && left.localName === right.localName && left.namespaceUri === right.namespaceUri;
}

function logicalElementText(element: XmlElementNode): string | null {
  let text = '';
  for (const child of element.children) {
    if (child.kind === 'text') text += child.text;
    else if (child.kind === 'entity-reference' && child.decoded !== null) text += child.decoded;
    else return null;
  }
  return text;
}

function escapeXmlAttribute(value: string, quote: '"' | "'"): string {
  const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return quote === '"' ? escaped.replace(/"/g, '&quot;') : escaped.replace(/'/g, '&apos;');
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isValidXmlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd) continue;
    if ((codePoint >= 0x20 && codePoint <= 0xd7ff) || (codePoint >= 0xe000 && codePoint <= 0xfffd) || (codePoint >= 0x10000 && codePoint <= 0x10ffff)) continue;
    return false;
  }
  return true;
}

function rejected(code: string, message: string, path: readonly StructuredPathSegment[]): XmlVisualEditPlan {
  return {
    ok: false,
    plannerVersion: XML_VISUAL_PLANNER_VERSION,
    edits: [],
    diagnostics: [{
      severity: 'warning', code, message, source: 'xml', category: 'preservation', blocking: false,
      path: [...path], pointer: pointerFromPath(path), displayPath: displayPathFromPath(path),
    }],
    previewLabel: 'XML visual edit is unavailable.',
    unsupportedReason: message,
  };
}

function fail(code: string, reason: string): { ok: false; code: string; reason: string } {
  return { ok: false, code, reason };
}

export function xmlNodeIsTextual(node: XmlVisualNode): boolean {
  return node.kind === 'text' || node.kind === 'entity-reference';
}
