# YAML/TOML Preservation Decision

Date: 2026-06-30

## Decision

YAML and TOML have separate preservation authorities. YAML exposes a deliberately narrow, review-required, CST-backed editable tree. Desktop TOML exposes a review-required native `toml_edit` tree for its registered safe subset; hosts without the native capability remain visually read-only.

## Current Implementation Evidence

- YAML is parsed with the `yaml` package through `parseDocument`; the normalized `document.toJS()` value remains projection-only. Edit authority comes exclusively from CST ranges and guarded source tokens in `yamlEdits.ts`.
- The YAML planner and operation registry cover scalar replacement, simple-key rename, block-mapping add/delete, block-sequence append, and unambiguous item deletion. The generic tree and inspector expose per-node source-only reasons for excluded syntax.
- Desktop TOML is parsed and source-mapped by `toml_edit` through the typed host boundary. The same native identity feeds the tree, navigation, operation capabilities, and scalar conflict review.
- `plan_toml_mutation` returns typed, guarded, UTF-16-addressed patches and exact-source evidence. It has no file APIs; the shared executor and document aggregate retain sole commit authority. `smol-toml` is explicitly a non-authoritative preview/defense fallback.
- Taplo remains worth evaluating for syntax-tree, formatter, schema, and language-server behavior, but this refactor has not fixture-tested it as ScieMD's edit engine.

## Product Behavior

- YAML/TOML can be opened in source mode. Eligible YAML nodes and eligible desktop-native TOML nodes expose review-required write controls.
- The tree and inspector show preservation warnings for syntax that would be lost or changed by a naive value rewrite.
- YAML/TOML expose a copyable JSON preview with explicit lossy/read-only diagnostics.
- YAML and TOML writes use guarded source patches and the sealed structured-mutation executor. TOML scalar/key/table/scalar-array operations are enabled only when the native planner advertises that operation for the exact node.
- The TOML-specific evidence and operation/host matrix are documented in `docs/refactor/toml_source_preservation_evaluation.md`.

## Preserved Requirements

1. Editable YAML nodes must link to stable CST/source-token spans; normalized alias or merge projections never become authority.
2. Fixture coverage for YAML comments, anchors, aliases, tags, block scalars, merge keys, indentation-sensitive structures, TOML comments, dotted keys, arrays of tables, duplicate sections/keys, and section ordering.
3. An edit planner that can reject unsafe edits and apply safe edits without full-document reserialization.
4. Round-trip checks proving untouched source regions remain byte-for-byte stable for supported edits.
5. UI language must distinguish value inspection, read-only JSON conversion, guarded YAML source editing, and actionable source-only exclusions.

## References

- YAML package documentation: https://eemeli.org/yaml/
- Taplo documentation: https://taplo.tamasfe.dev/
- Rust toml_edit crate documentation: https://docs.rs/toml_edit/latest/toml_edit/
