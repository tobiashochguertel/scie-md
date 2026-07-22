import { parser } from '@lezer/xml';
import type {
  DocumentContent,
  FormatDiagnostic,
  FormatParseResult,
  SourceSpan,
  StructuredNodeRef,
  StructuredPathSegment,
  StructuredSourceMap,
} from '../documentFormat.js';
import { createDocumentContent } from '../documentFormat.js';
import { requiredFormatParseBudgetBytes } from '../formatDefinitions.js';
import {
  analyzeStructuredValue,
  createStructuredJsonPreview,
  createStructuredPreservationSummary,
  type ParsedStructuredDocument,
  type StructuredJsonPreview,
} from '../structured/structuredValue.js';
import {
  createStructuredSourceMap,
  displayPathFromPath,
  pointerFromPath,
  sourceSpanFromOffset,
  structuredValueType,
} from '../structured/sourceMap.js';

export const XML_PARSE_BUDGET_BYTES = requiredFormatParseBudgetBytes('xml');

type XmlCursor = ReturnType<ReturnType<typeof parser.parse>['cursor']>;

export interface XmlDocumentValue {
  kind: 'xml-document';
  children: XmlVisualNode[];
}

export type XmlVisualNode =
  | XmlElementNode
  | XmlTextNode
  | XmlCommentNode
  | XmlCdataNode
  | XmlProcessingInstructionNode
  | XmlDoctypeNode
  | XmlEntityReferenceNode;

export interface XmlElementNode {
  kind: 'element';
  name: string;
  prefix: string | null;
  localName: string;
  namespaceUri: string | null;
  attributes: XmlAttributeNode[];
  namespaceDeclarations: XmlNamespaceDeclarationNode[];
  children: XmlVisualNode[];
  selfClosing: boolean;
}

export interface XmlAttributeNode {
  kind: 'attribute';
  name: string;
  prefix: string | null;
  localName: string;
  namespaceUri: string | null;
  value: string;
  rawValue: string;
}

export interface XmlNamespaceDeclarationNode {
  kind: 'namespace';
  prefix: string | null;
  uri: string;
  rawValue: string;
}

export interface XmlTextNode {
  kind: 'text';
  text: string;
  whitespaceOnly: boolean;
}

export interface XmlCommentNode {
  kind: 'comment';
  text: string;
}

export interface XmlCdataNode {
  kind: 'cdata';
  text: string;
}

export interface XmlProcessingInstructionNode {
  kind: 'processing-instruction';
  target: string;
  content: string;
  raw: string;
}

export interface XmlDoctypeNode {
  kind: 'doctype';
  raw: string;
}

export interface XmlEntityReferenceNode {
  kind: 'entity-reference';
  name: string;
  raw: string;
  referenceType: 'built-in' | 'numeric' | 'named';
  decoded: string | null;
}

export interface ParsedXmlDocument extends ParsedStructuredDocument {
  value: XmlDocumentValue;
  xml: XmlDocumentValue;
  elementCount: number;
  attributeCount: number;
  namespaceCount: number;
  textNodeCount: number;
  commentCount: number;
  cdataCount: number;
  processingInstructionCount: number;
  entityReferenceCount: number;
  doctypeCount: number;
}

interface XmlNodeWithSpan {
  value: unknown;
  path: StructuredPathSegment[];
  span: SourceSpan;
  valueSpan?: SourceSpan | null;
  keySpan?: SourceSpan | null;
  childCount?: number;
  editableOperations?: string[];
  unsupportedReason?: string;
  nodeKind?: string;
  qualifiedName?: string | null;
  localName?: string | null;
  namespaceUri?: string | null;
  namespaceContext?: Record<string, string>;
}

interface XmlDiagnosticCollector {
  syntaxDiagnostics: FormatDiagnostic[];
  preservationWarnings: FormatDiagnostic[];
}

interface XmlProjectionBuilder {
  text: string;
  nodes: XmlNodeWithSpan[];
  counts: {
    elements: number;
    attributes: number;
    namespaces: number;
    textNodes: number;
    comments: number;
    cdata: number;
    processingInstructions: number;
    entityReferences: number;
    doctypes: number;
  };
}

interface XmlTagInfo {
  name: string;
  prefix: string | null;
  localName: string;
  attributes: XmlAttributeNode[];
  namespaceDeclarations: XmlNamespaceDeclarationNode[];
  attributeSources: XmlAttributeSource[];
  namespaceDeclarationSources: XmlAttributeSource[];
  nameSpan: SourceSpan | null;
  selfClosing: boolean;
}

interface XmlAttributeSource {
  span: SourceSpan;
  keySpan: SourceSpan;
  valueSpan: SourceSpan;
  rawValue: string;
}

type NamespaceScope = Map<string, string>;

const XML_NAMESPACE_URI = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE_URI = 'http://www.w3.org/2000/xmlns/';

export function parseXmlDocument(content: DocumentContent): FormatParseResult<ParsedXmlDocument> {
  const text = content.text;
  if (text.trim().length === 0) {
    return {
      format: 'xml',
      content,
      parsed: null,
      diagnostics: [xmlDiagnostic('error', 'xml-empty-document', 'XML document is empty.', text, 0, 1, true)],
      sourceOnly: false,
    };
  }

  if (byteLength(text) > XML_PARSE_BUDGET_BYTES) {
    return {
      format: 'xml',
      content,
      parsed: null,
      diagnostics: [xmlDiagnostic(
        'warning',
        'xml-source-only-large-file',
        `XML exceeds the ${formatBytes(XML_PARSE_BUDGET_BYTES)} background parse budget. Source editing remains available; tree inspection is disabled for this file.`,
        text,
        0,
        1,
        false,
      )],
      sourceOnly: true,
    };
  }

  const tree = parser.parse(text);
  const diagnostics = collectXmlDiagnostics(text, tree.cursor());
  if (diagnostics.syntaxDiagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return {
      format: 'xml',
      content,
      parsed: null,
      diagnostics: [...diagnostics.syntaxDiagnostics, ...diagnostics.preservationWarnings],
      sourceOnly: false,
    };
  }

  const builder = createXmlProjectionBuilder(text);
  const value = createDocumentProjection(tree.cursor(), builder);
  const namespaceDiagnostics = collectXmlNamespaceDiagnostics(value, builder);
  if (namespaceDiagnostics.length > 0) {
    return {
      format: 'xml', content, parsed: null,
      diagnostics: [...namespaceDiagnostics, ...diagnostics.preservationWarnings],
      sourceOnly: false,
    };
  }
  const warnings = [...diagnostics.preservationWarnings];
  const sourceMap = createXmlSourceMap(value, builder.nodes);
  const jsonPreview = createStructuredJsonPreview(value, warnings, 'xml');

  return {
    format: 'xml',
    content,
    parsed: {
      value,
      xml: value,
      stats: analyzeStructuredValue(value),
      sourceMap,
      warnings,
      preservation: createStructuredPreservationSummary({
        format: 'xml',
        warnings,
        visualWritesEnabled: true,
        sourceMapFeasibility: 'cst-source-preserving',
        nodeSpanCoverage: 'partial',
        candidateLibraries: ['@lezer/xml'],
        blockers: [
          'Only ordinary attribute values without existing entity tokens and sole non-whitespace text content expose reviewed visual replacement.',
          'Mixed content, whitespace-only text, comments, CDATA, processing instructions, entity references, namespace declarations, and structural element operations remain source-only.',
          'DTD declarations remain blocking and external entities are never loaded, resolved, or expanded. XML is patched locally and is never canonicalized or serialized wholesale.',
        ],
      }),
      jsonPreview,
      elementCount: builder.counts.elements,
      attributeCount: builder.counts.attributes,
      namespaceCount: builder.counts.namespaces,
      textNodeCount: builder.counts.textNodes,
      commentCount: builder.counts.comments,
      cdataCount: builder.counts.cdata,
      processingInstructionCount: builder.counts.processingInstructions,
      entityReferenceCount: builder.counts.entityReferences,
      doctypeCount: builder.counts.doctypes,
    },
    diagnostics: warnings,
    sourceOnly: false,
  };
}

export function createXmlContent(text: string, path: string | null = null, metadata?: unknown): DocumentContent {
  return createDocumentContent('xml', text, path, metadata);
}

export function createXmlJsonPreview(parseResult: FormatParseResult<ParsedXmlDocument>): StructuredJsonPreview | null {
  return parseResult.parsed?.jsonPreview ?? null;
}

function collectXmlDiagnostics(text: string, cursor: XmlCursor): XmlDiagnosticCollector {
  const syntaxDiagnostics: FormatDiagnostic[] = [];
  const preservationWarnings: FormatDiagnostic[] = [];
  let topLevelElementCount = 0;

  visitCursor(cursor, (node, depth) => {
    if (node.type.isError || node.name === '⚠') {
      syntaxDiagnostics.push(xmlDiagnostic(
        'error',
        'xml-syntax',
        'XML parser reported malformed syntax.',
        text,
        node.from,
        Math.max(1, node.to - node.from),
        true,
      ));
    }
    if (node.name === 'MissingCloseTag') {
      syntaxDiagnostics.push(xmlDiagnostic(
        'error',
        'xml-missing-close-tag',
        'XML element is missing a matching closing tag.',
        text,
        node.from,
        1,
        true,
      ));
    }
    if (node.name === 'DoctypeDecl') {
      syntaxDiagnostics.push(xmlDiagnostic(
        'error',
        'xml-doctype-disabled',
        'XML DTD and DOCTYPE declarations are disabled for safety. ScieMD does not load or expand external entities.',
        text,
        node.from,
        Math.max(1, node.to - node.from),
        true,
      ));
    }
    if (node.name === 'EntityReference' || node.name === 'CharacterReference') {
      preservationWarnings.push(xmlDiagnostic(
        'warning',
        'xml-entity-reference-readonly',
        'XML entity references are preserved as read-only source references; only safe built-in and numeric references expose decoded display text.',
        text,
        node.from,
        Math.max(1, node.to - node.from),
        false,
      ));
    }
    if (depth === 1 && node.name === 'Element') {
      topLevelElementCount += 1;
    }
    if (depth === 1 && node.name === 'Text' && text.slice(node.from, node.to).trim().length > 0) {
      syntaxDiagnostics.push(xmlDiagnostic(
        'error',
        'xml-top-level-text',
        'XML documents may not contain non-whitespace text outside the root element.',
        text,
        node.from,
        Math.max(1, node.to - node.from),
        true,
      ));
    }
  });

  if (topLevelElementCount === 0) {
    syntaxDiagnostics.push(xmlDiagnostic(
      'error',
      'xml-root-missing',
      'XML document must contain exactly one root element.',
      text,
      0,
      1,
      true,
    ));
  } else if (topLevelElementCount > 1) {
    syntaxDiagnostics.push(xmlDiagnostic(
      'error',
      'xml-multiple-root-elements',
      'XML document must contain exactly one root element.',
      text,
      0,
      1,
      true,
    ));
  }

  return { syntaxDiagnostics: dedupeDiagnostics(syntaxDiagnostics), preservationWarnings: dedupeDiagnostics(preservationWarnings) };
}

function createDocumentProjection(cursor: XmlCursor, builder: XmlProjectionBuilder): XmlDocumentValue {
  const value: XmlDocumentValue = {
    kind: 'xml-document',
    children: [],
  };
  builder.nodes.push({
    value,
    path: [],
    span: sourceSpanFromOffset(builder.text, cursor.from, Math.max(1, cursor.to - cursor.from)),
    childCount: 0,
    nodeKind: 'xml-document',
    unsupportedReason: 'The XML document container is source-only; edit a proven attribute or simple text value.',
  });

  const children: XmlVisualNode[] = [];
  forEachChild(cursor, (child) => {
    if (!isVisualXmlNodeName(child.name)) return;
    const path: StructuredPathSegment[] = ['children', children.length];
    const node = xmlVisualNodeFromCursor(child, path, createRootNamespaceScope(), builder);
    if (node) children.push(node);
  });
  value.children = children;
  builder.nodes[0].childCount = children.length;
  return value;
}

function collectXmlNamespaceDiagnostics(value: XmlDocumentValue, builder: XmlProjectionBuilder): FormatDiagnostic[] {
  const diagnostics: FormatDiagnostic[] = [];
  const visit = (node: XmlVisualNode): void => {
    if (node.kind !== 'element') return;
    if (node.prefix && node.namespaceUri === null) add(node, 'xml-undeclared-element-prefix', `XML element prefix "${node.prefix}" is not declared.`);
    const expandedAttributes = new Set<string>();
    for (const attribute of node.attributes) {
      if (attribute.prefix && attribute.namespaceUri === null) add(attribute, 'xml-undeclared-attribute-prefix', `XML attribute prefix "${attribute.prefix}" is not declared.`);
      const expandedName = `${attribute.namespaceUri ?? ''}\u0000${attribute.localName}`;
      if (expandedAttributes.has(expandedName)) add(attribute, 'xml-duplicate-expanded-attribute', `XML attribute "${attribute.name}" duplicates an expanded namespace name.`);
      expandedAttributes.add(expandedName);
    }
    for (const declaration of node.namespaceDeclarations) {
      const invalid = declaration.prefix === 'xmlns'
        || declaration.uri === XMLNS_NAMESPACE_URI
        || (declaration.prefix === 'xml' && declaration.uri !== XML_NAMESPACE_URI)
        || (declaration.prefix !== 'xml' && declaration.uri === XML_NAMESPACE_URI)
        || (declaration.prefix !== null && declaration.uri === '');
      if (invalid) add(declaration, 'xml-invalid-namespace-binding', 'XML namespace declaration uses a reserved or invalid prefix/URI binding.');
    }
    node.children.forEach(visit);
  };
  const add = (node: XmlElementNode | XmlAttributeNode | XmlNamespaceDeclarationNode, code: string, message: string): void => {
    const mapped = builder.nodes.find((candidate) => candidate.value === node);
    diagnostics.push(xmlDiagnostic('error', code, message, builder.text, mapped?.span.offset ?? 0, mapped?.span.length ?? 1, true));
  };
  value.children.forEach(visit);
  return diagnostics;
}

function xmlVisualNodeFromCursor(
  cursor: XmlCursor,
  path: StructuredPathSegment[],
  namespaceScope: NamespaceScope,
  builder: XmlProjectionBuilder,
): XmlVisualNode | null {
  if (cursor.name === 'Element') return xmlElementFromCursor(cursor, path, namespaceScope, builder);
  if (cursor.name === 'Text') return xmlTextFromCursor(cursor, path, builder);
  if (cursor.name === 'Comment') return xmlCommentFromCursor(cursor, path, builder);
  if (cursor.name === 'Cdata') return xmlCdataFromCursor(cursor, path, builder);
  if (cursor.name === 'ProcessingInst') return xmlProcessingInstructionFromCursor(cursor, path, builder);
  if (cursor.name === 'DoctypeDecl') return xmlDoctypeFromCursor(cursor, path, builder);
  if (cursor.name === 'EntityReference' || cursor.name === 'CharacterReference') return xmlEntityReferenceFromCursor(cursor, path, builder);
  return null;
}

function xmlElementFromCursor(
  cursor: XmlCursor,
  path: StructuredPathSegment[],
  namespaceScope: NamespaceScope,
  builder: XmlProjectionBuilder,
): XmlElementNode {
  const tagInfo = tagInfoFromElement(cursor, builder);
  const childNamespaceScope = new Map(namespaceScope);
  for (const declaration of tagInfo.namespaceDeclarations) {
    childNamespaceScope.set(declaration.prefix ?? '', declaration.uri);
  }
  const value: XmlElementNode = {
    kind: 'element',
    name: tagInfo.name,
    prefix: tagInfo.prefix,
    localName: tagInfo.localName,
    namespaceUri: namespaceUriForPrefix(childNamespaceScope, tagInfo.prefix),
    attributes: tagInfo.attributes.map((attribute) => ({
      ...attribute,
      namespaceUri: namespaceUriForAttribute(childNamespaceScope, attribute.prefix),
    })),
    namespaceDeclarations: tagInfo.namespaceDeclarations,
    children: [],
    selfClosing: tagInfo.selfClosing,
  };
  const namespaceContext = Object.fromEntries(childNamespaceScope);
  value.namespaceDeclarations.forEach((declaration, index) => {
    const source = tagInfo.namespaceDeclarationSources[index];
    if (!source) return;
    const declarationPath = [...path, 'namespaceDeclarations', index];
    recordXmlNode(builder, declaration, declarationPath, source.span.offset, source.span.offset + source.span.length, 0, {
      keySpan: source.keySpan,
      valueSpan: source.valueSpan,
      nodeKind: 'namespace-declaration',
      qualifiedName: declaration.prefix ? `xmlns:${declaration.prefix}` : 'xmlns',
      localName: declaration.prefix,
      namespaceUri: declaration.uri,
      namespaceContext,
      unsupportedReason: 'Namespace declarations are source-only because changing them can rebind descendant names.',
    });
    recordXmlNode(builder, declaration.uri, [...declarationPath, 'uri'], source.valueSpan.offset, source.valueSpan.offset + source.valueSpan.length, 0, {
      valueSpan: source.valueSpan,
      nodeKind: 'namespace-value',
      qualifiedName: declaration.prefix ? `xmlns:${declaration.prefix}` : 'xmlns',
      localName: declaration.prefix,
      namespaceUri: declaration.uri,
      namespaceContext,
      unsupportedReason: 'Namespace declaration values are source-only because changing them can rebind descendant names.',
    });
  });
  value.attributes.forEach((attribute, index) => {
    const source = tagInfo.attributeSources[index];
    if (!source) return;
    const attributePath = [...path, 'attributes', index];
    const hasEntityToken = /&(?:#(?:x[0-9A-Fa-f]+|\d+)|[A-Za-z_][\w.-]*);/.test(stripXmlAttributeQuotes(source.rawValue));
    recordXmlNode(builder, attribute, attributePath, source.span.offset, source.span.offset + source.span.length, 0, {
      keySpan: source.keySpan,
      valueSpan: source.valueSpan,
      nodeKind: 'attribute',
      qualifiedName: attribute.name,
      localName: attribute.localName,
      namespaceUri: attribute.namespaceUri,
      namespaceContext,
      unsupportedReason: 'Select the attribute value to edit it; attribute add, delete, and rename remain source-only.',
    });
    recordXmlNode(builder, attribute.value, [...attributePath, 'value'], source.valueSpan.offset, source.valueSpan.offset + source.valueSpan.length, 0, {
      valueSpan: source.valueSpan,
      nodeKind: 'attribute-value',
      qualifiedName: attribute.name,
      localName: attribute.localName,
      namespaceUri: attribute.namespaceUri,
      namespaceContext,
      editableOperations: hasEntityToken ? [] : ['replaceScalar'],
      unsupportedReason: hasEntityToken
        ? 'Attribute values containing entity-reference tokens remain source-only to avoid changing their source representation.'
        : undefined,
    });
  });
  const children: XmlVisualNode[] = [];
  forEachChild(cursor, (child) => {
    if (!isVisualXmlNodeName(child.name)) return;
    const childPath: StructuredPathSegment[] = [...path, 'children', children.length];
    const childNode = xmlVisualNodeFromCursor(child, childPath, childNamespaceScope, builder);
    if (childNode) children.push(childNode);
  });
  value.children = children;
  if (children.length === 1 && children[0]?.kind === 'text' && !children[0].whitespaceOnly) {
    markXmlTextNodeEditable(builder, [...path, 'children', 0, 'text'], {
      qualifiedName: value.name,
      localName: value.localName,
      namespaceUri: value.namespaceUri,
      namespaceContext,
    });
  }
  builder.counts.elements += 1;
  recordXmlNode(builder, value, path, cursor.from, cursor.to, value.attributes.length + value.namespaceDeclarations.length + value.children.length, {
    keySpan: tagInfo.nameSpan,
    nodeKind: 'element',
    qualifiedName: value.name,
    localName: value.localName,
    namespaceUri: value.namespaceUri,
    namespaceContext,
    unsupportedReason: 'Element add, delete, and rename remain source-only until layout and namespace effects are proven.',
  });
  return value;
}

function tagInfoFromElement(cursor: XmlCursor, builder: XmlProjectionBuilder): XmlTagInfo {
  let tagCursor: XmlCursor | null = null;
  let selfClosing = false;
  forEachChild(cursor, (child) => {
    if (!tagCursor && (child.name === 'OpenTag' || child.name === 'SelfClosingTag')) {
      selfClosing = child.name === 'SelfClosingTag';
      tagCursor = child.node.cursor();
    }
  });
  if (!tagCursor) {
    return {
      name: '',
      prefix: null,
      localName: '',
      attributes: [],
      namespaceDeclarations: [],
      attributeSources: [],
      namespaceDeclarationSources: [],
      nameSpan: null,
      selfClosing: false,
    };
  }

  let name = '';
  let nameSpan: SourceSpan | null = null;
  const attributes: XmlAttributeNode[] = [];
  const namespaceDeclarations: XmlNamespaceDeclarationNode[] = [];
  const attributeSources: XmlAttributeSource[] = [];
  const namespaceDeclarationSources: XmlAttributeSource[] = [];
  forEachChild(tagCursor, (child) => {
    if (child.name === 'TagName') {
      name = builder.text.slice(child.from, child.to);
      nameSpan = sourceSpanFromOffset(builder.text, child.from, child.to - child.from);
    }
    if (child.name !== 'Attribute') return;
    const rawAttribute = attributeFromCursor(child, builder.text);
    if (!rawAttribute) return;
    if (rawAttribute.namespaceDeclaration) {
      const declaration: XmlNamespaceDeclarationNode = {
        kind: 'namespace',
        prefix: rawAttribute.namespaceDeclaration.prefix,
        uri: rawAttribute.value,
        rawValue: rawAttribute.rawValue,
      };
      namespaceDeclarations.push(declaration);
      namespaceDeclarationSources.push(rawAttribute.source);
      builder.counts.namespaces += 1;
      return;
    }
    const qualified = splitQualifiedName(rawAttribute.name);
    const attribute: XmlAttributeNode = {
      kind: 'attribute',
      name: rawAttribute.name,
      prefix: qualified.prefix,
      localName: qualified.localName,
      namespaceUri: null,
      value: rawAttribute.value,
      rawValue: rawAttribute.rawValue,
    };
    attributes.push(attribute);
    attributeSources.push(rawAttribute.source);
    builder.counts.attributes += 1;
  });

  const qualified = splitQualifiedName(name);
  return {
    name,
    prefix: qualified.prefix,
    localName: qualified.localName,
    attributes,
    namespaceDeclarations,
    attributeSources,
    namespaceDeclarationSources,
    nameSpan,
    selfClosing,
  };
}

function attributeFromCursor(
  cursor: XmlCursor,
  text: string,
): { name: string; value: string; rawValue: string; namespaceDeclaration: { prefix: string | null } | null; source: XmlAttributeSource } | null {
  let name = '';
  let rawValue = '';
  let nameFrom = cursor.from;
  let nameTo = cursor.from;
  let valueFrom = cursor.to;
  let valueTo = cursor.to;
  forEachChild(cursor, (child) => {
    if (child.name === 'AttributeName') { name = text.slice(child.from, child.to); nameFrom = child.from; nameTo = child.to; }
    if (child.name === 'AttributeValue') { rawValue = text.slice(child.from, child.to); valueFrom = child.from; valueTo = child.to; }
  });
  if (!name || rawValue.length < 2 || !((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'")))) return null;
  const value = decodeBuiltInXmlEntities(stripXmlAttributeQuotes(rawValue));
  return {
    name,
    value,
    rawValue,
    namespaceDeclaration: namespaceDeclarationFromAttributeName(name),
    source: {
      span: sourceSpanFromOffset(text, cursor.from, cursor.to - cursor.from),
      keySpan: sourceSpanFromOffset(text, nameFrom, nameTo - nameFrom),
      valueSpan: sourceSpanFromOffset(text, valueFrom + 1, Math.max(0, valueTo - valueFrom - 2)),
      rawValue,
    },
  };
}

function xmlTextFromCursor(cursor: XmlCursor, path: StructuredPathSegment[], builder: XmlProjectionBuilder): XmlTextNode {
  const text = builder.text.slice(cursor.from, cursor.to);
  const value: XmlTextNode = {
    kind: 'text',
    text,
    whitespaceOnly: text.trim().length === 0,
  };
  builder.counts.textNodes += 1;
  const span = sourceSpanFromOffset(builder.text, cursor.from, cursor.to - cursor.from);
  const reason = value.whitespaceOnly
    ? 'Whitespace-only XML text is source-only because it may control significant layout.'
    : 'Text replacement is available only when this is the element\'s sole content node.';
  recordXmlNode(builder, value, path, cursor.from, cursor.to, 0, { valueSpan: span, nodeKind: 'text', unsupportedReason: reason });
  recordXmlNode(builder, value.text, [...path, 'text'], cursor.from, cursor.to, 0, { valueSpan: span, nodeKind: 'text-value', unsupportedReason: reason });
  return value;
}

function xmlCommentFromCursor(cursor: XmlCursor, path: StructuredPathSegment[], builder: XmlProjectionBuilder): XmlCommentNode {
  const raw = builder.text.slice(cursor.from, cursor.to);
  const value: XmlCommentNode = {
    kind: 'comment',
    text: raw.startsWith('<!--') && raw.endsWith('-->') ? raw.slice(4, -3) : raw,
  };
  builder.counts.comments += 1;
  recordXmlNode(builder, value, path, cursor.from, cursor.to, 0, {
    nodeKind: 'comment', unsupportedReason: 'XML comments remain source-only.',
  });
  return value;
}

function xmlCdataFromCursor(cursor: XmlCursor, path: StructuredPathSegment[], builder: XmlProjectionBuilder): XmlCdataNode {
  const raw = builder.text.slice(cursor.from, cursor.to);
  const value: XmlCdataNode = {
    kind: 'cdata',
    text: raw.startsWith('<![CDATA[') && raw.endsWith(']]>') ? raw.slice(9, -3) : raw,
  };
  builder.counts.cdata += 1;
  recordXmlNode(builder, value, path, cursor.from, cursor.to, 0, {
    nodeKind: 'cdata', unsupportedReason: 'CDATA boundaries and content remain source-only.',
  });
  return value;
}

function xmlProcessingInstructionFromCursor(
  cursor: XmlCursor,
  path: StructuredPathSegment[],
  builder: XmlProjectionBuilder,
): XmlProcessingInstructionNode {
  const raw = builder.text.slice(cursor.from, cursor.to);
  const body = raw.startsWith('<?') && raw.endsWith('?>') ? raw.slice(2, -2).trim() : raw.trim();
  const target = body.split(/\s+/, 1)[0] ?? '';
  const value: XmlProcessingInstructionNode = {
    kind: 'processing-instruction',
    target,
    content: body.slice(target.length).trim(),
    raw,
  };
  builder.counts.processingInstructions += 1;
  recordXmlNode(builder, value, path, cursor.from, cursor.to, 0, {
    nodeKind: 'processing-instruction', qualifiedName: value.target,
    unsupportedReason: 'XML processing instructions remain source-only.',
  });
  return value;
}

function xmlDoctypeFromCursor(cursor: XmlCursor, path: StructuredPathSegment[], builder: XmlProjectionBuilder): XmlDoctypeNode {
  const value: XmlDoctypeNode = {
    kind: 'doctype',
    raw: builder.text.slice(cursor.from, cursor.to),
  };
  builder.counts.doctypes += 1;
  recordXmlNode(builder, value, path, cursor.from, cursor.to, 0, {
    nodeKind: 'doctype', unsupportedReason: 'DTD and DOCTYPE declarations are prohibited.',
  });
  return value;
}

function xmlEntityReferenceFromCursor(
  cursor: XmlCursor,
  path: StructuredPathSegment[],
  builder: XmlProjectionBuilder,
): XmlEntityReferenceNode {
  const raw = builder.text.slice(cursor.from, cursor.to);
  const name = raw.replace(/^&|;$/g, '');
  const value: XmlEntityReferenceNode = {
    kind: 'entity-reference',
    name,
    raw,
    referenceType: xmlEntityReferenceType(name),
    decoded: decodeXmlEntityReferenceName(name),
  };
  builder.counts.entityReferences += 1;
  recordXmlNode(builder, value, path, cursor.from, cursor.to, 0, {
    nodeKind: 'entity-reference', qualifiedName: value.name,
    unsupportedReason: 'Entity-reference tokens remain source-only.',
  });
  return value;
}

function createXmlProjectionBuilder(text: string): XmlProjectionBuilder {
  return {
    text,
    nodes: [],
    counts: {
      elements: 0,
      attributes: 0,
      namespaces: 0,
      textNodes: 0,
      comments: 0,
      cdata: 0,
      processingInstructions: 0,
      entityReferences: 0,
      doctypes: 0,
    },
  };
}

function createXmlSourceMap(value: XmlDocumentValue, nodes: readonly XmlNodeWithSpan[]): StructuredSourceMap {
  const sourceNodes: StructuredNodeRef[] = nodes.map((node) => ({
    format: 'xml',
    path: node.path,
    pointer: pointerFromPath(node.path),
    displayPath: displayPathFromPath(node.path),
    type: structuredValueType(node.value),
    span: node.span,
    valueSpan: node.valueSpan ?? node.span,
    keySpan: node.keySpan ?? null,
    lossy: false,
    editable: Boolean(node.editableOperations?.length),
    editableOperations: [...(node.editableOperations ?? [])],
    ...(node.unsupportedReason ? { unsupportedReason: node.unsupportedReason } : {}),
    childCount: node.childCount ?? childCount(node.value),
    ...(node.nodeKind ? { nodeKind: node.nodeKind } : {}),
    ...(node.qualifiedName !== undefined ? { qualifiedName: node.qualifiedName } : {}),
    ...(node.localName !== undefined ? { localName: node.localName } : {}),
    ...(node.namespaceUri !== undefined ? { namespaceUri: node.namespaceUri } : {}),
    ...(node.namespaceContext ? { namespaceContext: { ...node.namespaceContext } } : {}),
  }));
  if (!sourceNodes.some((node) => node.pointer === '')) {
    sourceNodes.unshift({
      format: 'xml',
      path: [],
      pointer: '',
      displayPath: '$',
      type: structuredValueType(value),
      span: null,
      valueSpan: null,
      keySpan: null,
      lossy: false,
      editable: false,
      editableOperations: [],
      unsupportedReason: 'The XML document root is a projection; select a proven text or attribute value.',
      childCount: value.children.length,
      nodeKind: 'xml-document',
    });
  }
  return createStructuredSourceMap('xml', sourceNodes);
}

function recordXmlNode(
  builder: XmlProjectionBuilder,
  value: unknown,
  path: StructuredPathSegment[],
  from: number,
  to: number,
  childCount: number,
  options: Omit<XmlNodeWithSpan, 'value' | 'path' | 'span' | 'childCount'> = {},
): void {
  builder.nodes.push({
    value,
    path,
    span: sourceSpanFromOffset(builder.text, from, Math.max(1, to - from)),
    childCount,
    ...options,
  });
}

function markXmlTextNodeEditable(
  builder: XmlProjectionBuilder,
  path: StructuredPathSegment[],
  identity: Pick<XmlNodeWithSpan, 'qualifiedName' | 'localName' | 'namespaceUri' | 'namespaceContext'>,
): void {
  const pointer = pointerFromPath(path);
  const node = builder.nodes.find((candidate) => pointerFromPath(candidate.path) === pointer);
  if (!node) return;
  node.editableOperations = ['replaceScalar'];
  delete node.unsupportedReason;
  node.qualifiedName = identity.qualifiedName;
  node.localName = identity.localName;
  node.namespaceUri = identity.namespaceUri;
  if (identity.namespaceContext) node.namespaceContext = { ...identity.namespaceContext };
}

function visitCursor(cursor: XmlCursor, visitor: (cursor: XmlCursor, depth: number) => void, depth = 0): void {
  visitor(cursor, depth);
  if (!cursor.firstChild()) return;
  do {
    visitCursor(cursor, visitor, depth + 1);
  } while (cursor.nextSibling());
  cursor.parent();
}

function forEachChild(cursor: XmlCursor, callback: (cursor: XmlCursor) => void): void {
  if (!cursor.firstChild()) return;
  do {
    callback(cursor);
  } while (cursor.nextSibling());
  cursor.parent();
}

function isVisualXmlNodeName(name: string): boolean {
  return name === 'Element'
    || name === 'Text'
    || name === 'Comment'
    || name === 'Cdata'
    || name === 'ProcessingInst'
    || name === 'DoctypeDecl'
    || name === 'EntityReference'
    || name === 'CharacterReference';
}

function splitQualifiedName(name: string): { prefix: string | null; localName: string } {
  const separator = name.indexOf(':');
  if (separator <= 0) return { prefix: null, localName: name };
  return {
    prefix: name.slice(0, separator),
    localName: name.slice(separator + 1),
  };
}

function namespaceDeclarationFromAttributeName(name: string): { prefix: string | null } | null {
  if (name === 'xmlns') return { prefix: null };
  if (name.startsWith('xmlns:')) return { prefix: name.slice('xmlns:'.length) || null };
  return null;
}

function namespaceUriForPrefix(scope: NamespaceScope, prefix: string | null): string | null {
  return scope.get(prefix ?? '') ?? null;
}

function namespaceUriForAttribute(scope: NamespaceScope, prefix: string | null): string | null {
  if (!prefix) return null;
  return namespaceUriForPrefix(scope, prefix);
}

function createRootNamespaceScope(): NamespaceScope {
  return new Map([['xml', XML_NAMESPACE_URI]]);
}

function stripXmlAttributeQuotes(rawValue: string): string {
  if (rawValue.length >= 2 && ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'")))) {
    return rawValue.slice(1, -1);
  }
  return rawValue;
}

function decodeBuiltInXmlEntities(value: string): string {
  return value
    .replace(/&#(?:x[0-9A-Fa-f]+|\d+);/g, (raw) => {
      const decoded = decodeXmlEntityReferenceName(raw.slice(1, -1));
      return decoded ?? raw;
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlEntityReferenceType(name: string): XmlEntityReferenceNode['referenceType'] {
  if (name.startsWith('#')) return 'numeric';
  return decodeBuiltInXmlEntityName(name) === null ? 'named' : 'built-in';
}

function decodeXmlEntityReferenceName(name: string): string | null {
  if (name.startsWith('#x') || name.startsWith('#X')) {
    return codePointToString(Number.parseInt(name.slice(2), 16));
  }
  if (name.startsWith('#')) {
    return codePointToString(Number.parseInt(name.slice(1), 10));
  }
  return decodeBuiltInXmlEntityName(name);
}

function decodeBuiltInXmlEntityName(name: string): string | null {
  if (name === 'lt') return '<';
  if (name === 'gt') return '>';
  if (name === 'quot') return '"';
  if (name === 'apos') return "'";
  if (name === 'amp') return '&';
  return null;
}

function codePointToString(codePoint: number): string | null {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return null;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return null;
  }
}

function xmlDiagnostic(
  severity: FormatDiagnostic['severity'],
  code: string,
  message: string,
  text: string,
  offset: number,
  length: number,
  blocking: boolean,
): FormatDiagnostic {
  const span = sourceSpanFromOffset(text, offset, length);
  return {
    severity,
    code,
    message,
    line: span.line,
    column: span.column,
    offset: span.offset,
    length: span.length,
    span,
    source: 'xml',
    category: severity === 'error' ? 'parser' : 'preservation',
    blocking,
  };
}

function dedupeDiagnostics(diagnostics: FormatDiagnostic[]): FormatDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.code}:${diagnostic.offset ?? ''}:${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function childCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length;
  return 0;
}

function byteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).byteLength;
  return unescape(encodeURIComponent(text)).length;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${Math.round(bytes / 1024 / 1024)} MiB`;
}
