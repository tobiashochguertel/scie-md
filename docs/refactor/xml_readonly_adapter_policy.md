# XML Source-Preserving Adapter Policy

Status: the Round 12 read-only projection was superseded by guarded, namespace-aware scalar writes in Round 9 of `document_runtime_structured_editing_foundations_wave.md`.

ScieMD accepts XML as a structured text document for source editing, diagnostics, source reveal, tree inspection, and a deliberately narrow set of reviewed scalar edits. Source text remains authoritative. Visual mode plans guarded source patches and never serializes or canonicalizes the document.

## Parser Decision

The XML adapter uses `@lezer/xml` because it provides a local syntax tree with source offsets and does not load external resources. This retains exact source ranges for projection and guarded writes without pairing parsing with entity expansion, resource loading, or normalization.

## Security Policy

- DTD and `DOCTYPE` declarations are blocking parser diagnostics.
- External entities are never loaded, resolved, or expanded.
- Entity references are represented as read-only source nodes.
- XML source parsing is bounded by `XML_PARSE_BUDGET_BYTES`; larger files stay editable in source mode but do not get a background tree preview.
- XML values copied from visual mode must be treated as untrusted document data, not instructions or executable content.

## Projection and Write Policy

The read-only tree keeps XML-specific constructs distinct:

- Elements include qualified name, prefix, local name, namespace URI, attributes, namespace declarations, child nodes, and self-closing state.
- Attributes remain separate from child elements.
- Namespace declarations are represented separately from ordinary attributes.
- Text, comments, CDATA, processing instructions, entity references, and DTD nodes are separate node kinds.
- Source-map entries are available for document, element, attribute, namespace declaration, text, comment, CDATA, processing instruction, entity reference, and DTD projection nodes.
- `replaceScalar` is available only for an ordinary attribute value without an existing entity-reference token, or an element's sole non-whitespace text value.
- Attribute edits preserve the existing quote delimiter and escape for attribute context; text edits escape for text context.
- Every edit is reviewed, guarded by the source hash and exact expected range, reparsed, checked for namespace/content identity, and committed through the shared structured mutation executor.
- Namespace declarations, element/attribute rename, structural add/delete, mixed content, whitespace-only text, comments, CDATA, processing instructions, and entity-bearing values remain source-only.

## Non-Goals

- No XML conversion writes.
- No XML schema, XSD, DTD, XPath, XSLT, or canonicalization support.
- No structural XML visual operations without separate fixture-backed proof.
- No comment, CDATA, processing-instruction, namespace-declaration, or entity-reference rewrites.
