# Source Preservation Adapter Contract

Date: 2026-07-01
Status: contract established; guarded YAML, native TOML, and namespace-aware XML writes implemented

## Purpose

ScieMD visual mode may eventually edit YAML, TOML, and XML, but these formats cannot be treated like JSON stringify output. A production write adapter must prove that it can preserve untouched source text, comments, ordering, style, namespace semantics, and security policy before any visual control is enabled. The host-neutral contract is implemented in `packages/core/src/formats/structured/sourcePreservationAdapter.ts`.

## Required Adapter Shape

A production `SourcePreservationAdapter` must provide:

- Parser-backed source-map analysis from visual paths to stable source ranges.
- Unsupported-feature classification with display paths, pointers, spans, and diagnostics.
- Edit planning that returns source patches, not whole-document regeneration.
- A source-hash guard to reject plans created against stale text.
- An expected-old-source guard for every patch span.
- Raw-token preservation for scalar values where the visual value would normalize syntax.
- Strict post-edit parsing and format-specific validation.
- Byte-for-byte no-op round-trip evidence.
- Untouched-region comparison after every planned edit.

Until those guards exist for a concrete operation, visual writes must return an unsupported plan. YAML, desktop-native TOML, and XML satisfy the contract only for their registered operation matrices.

## Format Decisions

### YAML

YAML uses the `yaml` package CST boundary (`keepSourceTokens`, node ranges, and source tokens). `packages/core/src/formats/yaml/yamlEdits.ts` plans narrow guarded patches for scalar replacement, simple-key rename, block-mapping add/delete, block-sequence append, and unambiguous sequence-item delete. Every YAML operation requires review and commits through the shared structured-mutation executor, which rechecks revision, SHA-256 source/plan/validator seals, expected source text, untouched regions, authoritative YAML parsing, and an operation-specific semantic assertion. Scalar style is retained where representable; an explicit quoted-style change is surfaced in review otherwise.

Aliases, anchors, explicit tags, merge keys, flow collections, block scalars, complex keys, multi-document streams, duplicate keys, non-local visual nodes, non-append sequence insertion, collection-valued insertion, and comment-owned deletion spans remain source-only. Comments and whitespace outside an authorized patch remain byte-for-byte exact.

### TOML

Desktop TOML production display, navigation, conflict review, and edit planning use the versioned Rust `toml_edit` commands `inspect_toml_source_map` and `plan_toml_mutation`. Native code returns identity-bearing source maps and one guarded patch but never writes files; the shared structured executor rechecks seals, guards, limits, parse/semantic postconditions, and exact untouched regions before the document aggregate commits. `smol-toml` remains only a non-authoritative preview and defense-in-depth parse fallback for hosts without native capability, which remain visually read-only.

### XML

XML uses the Lezer CST and namespace-aware source-map identities to plan one reviewed `replaceScalar` operation for ordinary attribute values and sole non-whitespace element text. The planner escapes for the exact attribute delimiter or text context, verifies QName/local-name/namespace/content postconditions, and preserves every untouched byte. Namespace declarations, mixed content, whitespace-only text, comments, CDATA, processing instructions, and entity-reference-bearing values remain source-only. DTD and DOCTYPE declarations remain blocked, and external entities are never loaded or expanded.

## Current Proof Gates

- `packages/core/src/formats/structured/sourcePreservationAdapter.test.ts` covers source hashes, expected-old-source guards, patch application, overlap rejection, no-op evidence, and untouched-region comparison.
- `packages/core/src/formats/yaml/yamlSourceMap.test.ts` covers the expanded YAML fixture corpus and CRLF comment spans.
- `packages/core/src/formats/yaml/yamlEdits.test.ts` covers the production operation matrix, exact untouched bytes, stale guards, and fail-closed exclusions.
- `src/app/structured/structuredMutationExecutor.test.ts` proves reviewed YAML plans reach the sole production commit port with semantic postconditions.
- `packages/core/src/formats/xml/parseXmlDocument.test.ts` covers XML namespace/comment/CDATA/entity fixtures and DTD blocking.
- `packages/core/src/formats/xml/xmlEdits.test.ts` covers namespace-aware scalar planning, exact untouched bytes, escaping, stale guards, size bounds, and fail-closed entity/DTD handling.
- `src/app/structured/structuredMutationExecutor.test.ts` proves reviewed XML plans reach the sole production commit port with namespace/content semantic postconditions.
- `src-tauri/tests/toml_preservation_spike.rs` covers TOML no-op preservation, scalar edit spikes, array-of-table insertion spikes, span exposure, duplicate rejection, and fixture behavior.
- `scripts/validate-tauri-command-contract.mjs` keeps the TOML source-map command experimental by ensuring production TypeScript does not invoke it.

## References

- YAML package documentation: https://eemeli.org/yaml/
- `toml_edit` documentation: https://docs.rs/toml_edit/latest/toml_edit/
- quick-xml security notes: https://docs.rs/quick-xml/latest/quick_xml/
