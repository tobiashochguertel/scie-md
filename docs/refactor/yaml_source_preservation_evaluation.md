# YAML Source Preservation Evaluation

Date: 2026-07-22
Status: production guarded-write subset implemented and adopted

## Decision

The `yaml` package CST/source-token boundary is sufficient for a narrow production editing subset. The normalized visual value remains inspection-only; `packages/core/src/formats/yaml/yamlEdits.ts` is the sole YAML patch planner, and the shared structured-mutation executor is the sole commit authority. All YAML visual changes require exact source review.

## Production Operation Matrix

- Replace a locally owned scalar token, retaining plain, single-quoted, or double-quoted style when representable.
- Rename a simple key in a block mapping when uniqueness is proven.
- Add a scalar field to a non-empty block mapping.
- Delete a block-mapping field only when its complete line span is unambiguous and owns no comment.
- Append a scalar item to a non-empty block sequence.
- Delete a block-sequence item only when its complete line span is unambiguous and owns no comment.

Each plan is revision-bound and carries SHA-256 source/result/plan/validator fingerprints, expected-old-text guards, bounded non-overlapping patches, exact untouched-region comparison, authoritative YAML reparse, and operation-specific semantic assertions rechecked by the executor. No supported operation serializes the whole document.

## Source-Only Matrix

Aliases, anchors, explicit tags, merge keys, flow collections, block scalars, complex keys, multi-document streams and directives, duplicate keys, invalid or oversized input, normalized values without local spans, collection-valued insertion, positional sequence insertion, and comment-owned deletion spans fail closed with actionable source-mode reasons. The JSON preview remains read-only and is never a write source.

## Fixture and Consumer Evidence

The preservation corpus in `docs/refactor/yaml_preservation_fixtures/` covers comments and whitespace, anchors and aliases, tags and scalar spellings, block scalars, merge keys, flow/indentation, comprehensive CRLF preservation, and duplicate-key rejection. `yamlEdits.test.ts` adds supported-operation and exact-byte assertions. The production `AppEditorStage` passes eligible YAML tree intents to `App.applyYamlVisualEdit`, which creates a shared structured transaction and review plan before the production executor can commit it. The inspector receives source-map blockers and per-node `unsupportedReason` text from the same CST analysis.

## Remaining Risks

The safe subset intentionally excludes comment ownership beyond narrow scalar replacement, empty collection construction, collection-valued insertion, sequence reordering, and every advanced YAML identity/style feature listed above. Those are later roadmap work and must not be inferred from `visualWritesEnabled` on another node.

## References

- YAML package documentation: https://eemeli.org/yaml/
- YAML parse options and `keepSourceTokens`: `node_modules/yaml/dist/options.d.ts`
