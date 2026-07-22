# TOML Source Preservation Evaluation

Date: 2026-07-22
Status: production desktop boundary adopted; guarded operation matrix enabled

## Decision

Use Rust `toml_edit` as the one authoritative desktop TOML syntax, source-map, and mutation-planning engine. The versioned `inspect_toml_source_map` and `plan_toml_mutation` commands return value/source identities, operation capabilities, typed diagnostics, guarded patches, and exact untouched-region evidence without reading or writing files. The application shared executor remains authoritative for review, envelope validation, journal acknowledgement, aggregate commit, and normal save.

Taplo remains relevant for diagnostics, formatting, schema/LSP behavior, and syntax-tree inspection, but it is not the primary edit-preservation boundary for ScieMD right now. The reason is practical: the current codebase already has a Tauri/Rust layer, `toml_edit` already proves no-op preservation and localized mutation behavior inside ScieMD fixtures, and keeping TOML preservation in Rust avoids adding large TOML tooling to the webview bundle.

## Fixture Corpus

The evidence fixtures live in `docs/refactor/toml_preservation_fixtures/`:

- `comments-and-whitespace.toml`: leading comments, blank lines, aligned keys, inline comments, indented comments, and array spacing.
- `dotted-keys.toml`: dotted keys plus a later explicit table.
- `dotted-key-edit-risk.toml`: dotted key paths adjacent to an explicit table, for future edit-planner rejection/acceptance decisions.
- `arrays-of-tables.toml`: repeated `[[products]]` tables and table ordering.
- `arrays-of-tables-insertion.toml`: array-of-table insertion order and preservation risk.
- `comments-attached-to-keys.toml`: leading and inline comments that should stay attached to nearby keys.
- `inline-tables.toml`: nested inline tables and punctuation-sensitive scalar edits.
- `multiline-strings.toml`: basic and literal multiline string forms.
- `section-ordering.toml`: non-alphabetical section order.
- `duplicate-key.invalid.toml`: duplicate key rejection.
- `duplicate-section.invalid.toml`: duplicate section rejection.
- `unicode-and-datetime.toml`: non-ASCII strings plus offset/local date and time operation gating; the corpus also derives a uniform-CRLF variant.

## Spike Command

```bash
npm run spike:toml-preservation
```

This command runs the Rust integration corpus. Desktop production analysis now consumes `inspect_toml_source_map`; visual intents consume `plan_toml_mutation`; both use DTO `toml-native-dto-v1` and planner `toml-edit-native-v1`. `packages/core/src/formats/toml/parseTomlDocument.ts` remains only a host-neutral preview and defense-in-depth parse fallback and owns no desktop source identity or patch authority.

## Observed Evidence

The `toml_edit` spike currently proves:

- Valid LF fixtures round-trip byte-for-byte through `DocumentMut::to_string()`; the native boundary restores and proves uniform CRLF envelopes byte-for-byte.
- A scalar edit to `[catalog].title` preserves unrelated comments, `[[products]]` syntax, existing product rows, and relative source order.
- A scalar edit inside an inline table preserves the surrounding fixture comments and inline table structure in the isolated spike.
- Inserting a table into an existing array of tables preserves existing entries and relative order in the isolated spike.
- Immutable `Document<String>` access exposes spans for table headers, array-of-table headers, keys, and values. The production adapter retains that immutable identity before any `DocumentMut` operation.
- `inspect_toml_source_map` returns source-span-backed nodes, no-op round-trip status, per-operation capabilities, and unsupported feature classifications without mutating the document.
- Duplicate key and duplicate section fixtures are rejected by the parser.

Operation and host matrix:

- Desktop enables review-required scalar replacement for basic/literal single-line strings, finite numbers, and booleans; bare-key rename; scalar field add/delete in mutable tables; and scalar-array append/delete. The native node capability list is the final per-node gate.
- Scalar replacement is safe inside dotted keys, inline tables, and arrays of tables because it patches the authoritative value span only. Structural edits to dotted keys, inline tables, and arrays of tables remain source-only unless a node explicitly advertises them.
- Multiline strings and date/time scalar replacement remain source-only. Quoted/decorated key rename, ambiguous comment-owned deletion, non-scalar insertion, reorder, table move, and mixed-line-ending structural mutation remain source-only.
- Comments, whitespace, ordering, quote style where representable, Unicode, uniform CRLF, key decoration, trailing decoration, and all untouched regions are preserved. Necessary double-quoted string escaping is visible in required review.
- Browser and VS Code hosts do not imitate native preservation. They remain source-editable and visually read-only through declarative host capability intersection.

## Implemented Adapter Contract

The production adapter provides:

1. A parser-backed source map from every editable visual node to a stable TOML item and source range.
2. A read-only fallback for nodes represented by dotted keys, arrays of tables, inline tables, multiline strings, comments, or table structure that the adapter cannot patch locally.
3. Patch planning with expected-source hash checks and post-edit strict TOML parse validation.
4. Byte-for-byte round-trip tests for no-op documents and untouched regions across the fixture corpus.
5. Native scalar/key/table/scalar-array fixtures plus explicit dotted-key, inline-table, array-of-table, multiline-string, datetime, Unicode, CRLF, duplicate-key/section, and comment-decoration status.
6. A typed bridge from native evidence to the host-neutral structured operation/review model and the shared Round 6 executor.
7. Declarative catalog, matrix, node, runtime, and host intersection; absent native capability keeps the TOML tree read-only.

## References

- `toml_edit` documentation: https://docs.rs/toml_edit/latest/toml_edit/
- `toml_edit` crate features: https://docs.rs/crate/toml_edit/latest/features
- Taplo documentation: https://taplo.tamasfe.dev/
