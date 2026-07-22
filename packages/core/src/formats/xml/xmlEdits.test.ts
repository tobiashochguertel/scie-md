import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createXmlContent, parseXmlDocument, XML_PARSE_BUDGET_BYTES } from './parseXmlDocument.js';
import { planXmlVisualEdit, xmlSourceHash } from './xmlEdits.js';

const fixtureDir = join(process.cwd(), 'docs/refactor/xml_preservation_fixtures');

describe('XML source-preserving visual edits', () => {
  it('exposes namespace-aware source identities only for ordinary attribute values and sole text', () => {
    const source = '<lab:study xmlns:lab="urn:lab" id="S-001"><lab:title>Old</lab:title></lab:study>\n';
    const parsed = parseXmlDocument(createXmlContent(source)).parsed!;
    const attribute = parsed.sourceMap.nodesByPointer['/children/0/attributes/0/value'];
    const text = parsed.sourceMap.nodesByPointer['/children/0/children/0/children/0/text'];
    const namespace = parsed.sourceMap.nodesByPointer['/children/0/namespaceDeclarations/0/uri'];

    expect(attribute).toMatchObject({
      nodeKind: 'attribute-value', qualifiedName: 'id', localName: 'id', namespaceUri: null,
      namespaceContext: { lab: 'urn:lab', xml: 'http://www.w3.org/XML/1998/namespace' },
      editable: true, editableOperations: ['replaceScalar'],
      valueSpan: expect.objectContaining({ offset: source.indexOf('S-001'), length: 5 }),
    });
    expect(text).toMatchObject({
      nodeKind: 'text-value', qualifiedName: 'lab:title', localName: 'title', namespaceUri: 'urn:lab',
      editable: true, editableOperations: ['replaceScalar'],
    });
    expect(namespace).toMatchObject({ nodeKind: 'namespace-value', editable: false });
  });

  it('replaces double-quoted attribute values with context-correct escaping and exact untouched regions', () => {
    const source = '<study xmlns="urn:study" id="S-001"><title>Old</title></study>\n';
    const plan = planXmlVisualEdit(source, {
      kind: 'replaceScalar', path: ['children', 0, 'attributes', 0, 'value'],
      nextValue: 'A&B <sample> "quoted"', expectedSourceHash: xmlSourceHash(source),
    });

    expect(plan.ok, plan.unsupportedReason).toBe(true);
    expect(plan.edits).toEqual([{ offset: source.indexOf('S-001'), length: 5, content: 'A&amp;B &lt;sample> &quot;quoted&quot;' }]);
    expect(plan.nextSource).toBe('<study xmlns="urn:study" id="A&amp;B &lt;sample> &quot;quoted&quot;"><title>Old</title></study>\n');
    expect(plan.targetIdentity).toMatchObject({
      kind: 'attribute-value', elementQualifiedName: 'study', elementNamespaceUri: 'urn:study',
      attributeQualifiedName: 'id', attributeNamespaceUri: null,
    });
  });

  it('preserves single-quote delimiters and escapes apostrophes without double-escaping semantic ampersands', () => {
    const source = "<study id='old'><title>Old</title></study>";
    const plan = planXmlVisualEdit(source, {
      kind: 'replaceScalar', path: ['children', 0, 'attributes', 0, 'value'], nextValue: "A&B's",
    });
    expect(plan.ok).toBe(true);
    expect(plan.nextSource).toBe("<study id='A&amp;B&apos;s'><title>Old</title></study>");
    expect(plan.nextSource).not.toContain('&amp;amp;');
  });

  it('replaces simple element text while retaining namespaces, CRLF, Unicode, comments, and all other bytes', () => {
    const source = '<?xml version="1.0"?>\r\n<lab:study xmlns:lab="urn:lab" id="S-Ω">\r\n  <lab:title>Old µ title</lab:title>\r\n  <!-- keep -->\r\n</lab:study>\r\n';
    const parsed = parseXmlDocument(createXmlContent(source)).parsed!;
    const titleText = parsed.sourceMap.nodes.find((node) => node.nodeKind === 'text-value' && node.qualifiedName === 'lab:title')!;
    const plan = planXmlVisualEdit(source, { kind: 'replaceScalar', path: [...titleText.path], nextValue: 'New µ <film> & ready' });

    expect(plan.ok, plan.unsupportedReason).toBe(true);
    expect(plan.nextSource).toContain('<lab:title>New µ &lt;film&gt; &amp; ready</lab:title>\r\n');
    expect(plan.nextSource?.startsWith('<?xml version="1.0"?>\r\n<lab:study xmlns:lab="urn:lab" id="S-Ω">\r\n  ')).toBe(true);
    expect(plan.nextSource?.endsWith('\r\n  <!-- keep -->\r\n</lab:study>\r\n')).toBe(true);
    expect(plan.targetIdentity).toMatchObject({
      kind: 'element-text', elementQualifiedName: 'lab:title', elementNamespaceUri: 'urn:lab',
    });
  });

  it('fails closed for entity-owned attributes, mixed content, whitespace, CDATA, comments, PIs, and namespace declarations', () => {
    const source = '<root xmlns:x="urn:x" label="A&amp;B">  <mixed>before <x:item>inside</x:item> after</mixed><![CDATA[raw]]><!--keep--><?pi x?></root>';
    const parsed = parseXmlDocument(createXmlContent(source)).parsed!;
    const entityAttribute = parsed.sourceMap.nodesByPointer['/children/0/attributes/0/value'];
    expect(entityAttribute).toMatchObject({ editable: false, nodeKind: 'attribute-value' });
    const editableNodes = parsed.sourceMap.nodes.filter((node) => node.editable);
    expect(editableNodes).toHaveLength(1);
    expect(editableNodes[0]).toMatchObject({ nodeKind: 'text-value', qualifiedName: 'x:item' });
    const protectedNodes = parsed.sourceMap.nodes.filter((node) => ['cdata', 'comment', 'processing-instruction', 'namespace-declaration'].includes(node.nodeKind ?? ''));
    expect(protectedNodes.length).toBeGreaterThanOrEqual(4);
    expect(protectedNodes.every((node) => !node.editable)).toBe(true);
  });

  it('retains namespace rebinding identity and keeps mixed descendants source-only', () => {
    const source = readFileSync(join(fixtureDir, 'namespace-rebinding-mixed.xml'), 'utf8');
    const parsed = parseXmlDocument(createXmlContent(source)).parsed!;
    const titleText = parsed.sourceMap.nodes.find((node) => node.nodeKind === 'text-value' && node.qualifiedName === 'lab:title');
    const mixedText = parsed.sourceMap.nodes.find((node) => node.nodeKind === 'text-value' && node.span
      && source.slice(node.span.offset, node.span.offset + node.span.length).includes('Before'));
    expect(titleText).toMatchObject({ editable: true, namespaceUri: 'urn:lab:v1' });
    expect(mixedText?.editable).toBe(false);
    expect(parsed.sourceMap.nodes.some((node) => node.nodeKind === 'element' && node.qualifiedName === 'lab:sample' && node.namespaceUri === 'urn:lab:v2')).toBe(true);
  });

  it('rejects stale, oversized, invalid-character, and attribute-normalization requests', () => {
    const source = '<root id="old">value</root>';
    expect(planXmlVisualEdit(source, { kind: 'replaceScalar', path: ['children', 0, 'attributes', 0, 'value'], nextValue: 'new', expectedSourceHash: 'stale' }))
      .toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'xml-edit-stale-source' })] });
    expect(planXmlVisualEdit(`<root>${'x'.repeat(XML_PARSE_BUDGET_BYTES + 1)}</root>`, { kind: 'replaceScalar', path: [], nextValue: 'new' }))
      .toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'xml-edit-source-too-large' })] });
    expect(planXmlVisualEdit(source, { kind: 'replaceScalar', path: ['children', 0, 'children', 0, 'text'], nextValue: 'bad\u0000value' }))
      .toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'xml-edit-invalid-character' })] });
    expect(planXmlVisualEdit(source, { kind: 'replaceScalar', path: ['children', 0, 'attributes', 0, 'value'], nextValue: 'line\nbreak' }))
      .toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'xml-edit-attribute-whitespace' })] });
  });

  it('blocks general and parameter external-entity fixtures without resolver or network activity', () => {
    const source = readFileSync(join(fixtureDir, 'external-entities.invalid.xml'), 'utf8');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = parseXmlDocument(createXmlContent(source));
    const plan = planXmlVisualEdit(source, { kind: 'replaceScalar', path: [], nextValue: 'blocked' });
    expect(result.parsed).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'xml-doctype-disabled', blocking: true }));
    expect(plan).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'xml-edit-invalid-source' })] });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('fails closed for undeclared prefixes and reserved namespace rebinding', () => {
    expect(parseXmlDocument(createXmlContent('<x:root>value</x:root>'))).toMatchObject({
      parsed: null,
      diagnostics: [expect.objectContaining({ code: 'xml-undeclared-element-prefix', blocking: true })],
    });
    expect(parseXmlDocument(createXmlContent('<root xmlns:xml="urn:not-xml">value</root>'))).toMatchObject({
      parsed: null,
      diagnostics: [expect.objectContaining({ code: 'xml-invalid-namespace-binding', blocking: true })],
    });
  });
});
