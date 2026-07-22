# Document Runtime, Structured Editing, and Workbench UI Foundations Wave

Status: Rounds 1-11 `CLOSED`; wave complete
Baseline reviewed: ScieMD `v1.1.0`, commit `f28bb9c`
Review date: 2026-07-21
Revision: 2 — residual consistency seams (park/autosave, review bypass, fonts/tabs, Round 6 soft deps)
Proposed size: 11 dependency-ordered rounds

Related completed work and binding decisions:

- [Multi-Document Workbench Foundations Refactor Wave](./multi_document_workbench_refactor_wave.md)
- [Round 20 Certification Record](./multi_document_round_20_certification.md)
- [Source Preservation Adapter Contract](./source_preservation_adapter_contract.md)
- [YAML/TOML Preservation Decision](./yaml_toml_preservation_decision.md)
- [YAML Source Preservation Evaluation](./yaml_source_preservation_evaluation.md)
- [TOML Source Preservation Evaluation](./toml_source_preservation_evaluation.md)
- [XML Read-Only Adapter Policy](./xml_readonly_adapter_policy.md)
- [File Fidelity Contract](./file_fidelity_contract.md)

This is a new wave. It does not reopen or rewrite the closed twenty-round multi-document roadmap. That wave established stable document identity, durable workspace ownership, additive ingress, tabs, and semantic source highlighting. This wave starts from the production behavior that now exists and addresses the next bottlenecks exposed by real use.

## 1. Decision

The next investment should make an already-open document a **warm, revision-addressed runtime**, then make structured visual editing a **single source-preserving mutation system**. The visible tab-strip redesign and source-font correction should consume those foundations near the end.

The dependency spine is:

> production-path measurements -> single-owner native load -> revisioned source/change authority -> resident editor runtime -> revision-indexed analysis scheduler -> canonical structured mutation authority -> YAML writer -> TOML writer -> XML writer -> adaptive tab chrome -> source typography, then integrated certification

This order matters. The arrows express execution priority and closure gates, not a claim that every adjacent round has a direct technical dependency: for example, the tab strip consumes Rounds 4–5 for warm activation and keyboard p95 evidence and is deliberately scheduled after the mutation authority and format writers because underlayer correctness is the higher investment; Round 6 hard-depends on Round 3 and only soft-depends on Round 5 cached artifacts. The user-visible delay when returning to a large Markdown tab is not a second disk read. The source string remains in its `DocumentRecord`; the delay comes from discarding and rebuilding editor and derived state. Likewise, YAML, TOML, and XML are not made safely editable by toggling a catalog boolean. They need a production mutation authority that proves review, revision, source preservation, and validation before a write is accepted.

## 2. Current truth established by the review

### 2.1 Large-document return is cold rehydration, not disk reload

The workspace keeps each document's source in `documentsById`, and activation changes `activeDocumentId`. A normal tab switch does not call the native file reader again.

The expensive work happens after activation:

- `src/app/documentEditorGateway.ts` snapshots a small view record and deletes the document's runtime during deactivation.
- `src/components/SourceTextEditor.tsx` retains one mounted `EditorView`, converts its current document to a string, and dispatches a complete `0..length` replacement when the active value changes.
- `src/components/VisualMarkdownEditor.tsx` uses Milkdown `replaceAll` for a new active Markdown value.
- `src/app/hooks/useLayerTwoDocument.ts` owns one active parsed state and synchronously builds a fallback document when the document target changes.
- `src/app/hooks/useSourceFormatDiagnostics.ts` and `src/app/hooks/useDocumentValidator.ts` likewise own active-singleton results rather than completed artifacts keyed by document revision.
- byte counts, line counts, renderer diagnostics, annotations, citation/variable work, and other features perform additional full-source scans.

There is also an ownership hazard to characterize in Round 1 and repair in Round 4: source-editor adapter registration is mount-bound, while its registration callback is document-bound and the gateway runtime is cleared on activation. A reused React editor component can therefore outlive the registration of the document it now displays.

### 2.2 The previous stress result did not measure this path

`src/stress/largeDocumentStress.test.ts` measures parsers, diagnostics, export, capture, and recovery helpers. Its default Markdown fixture is below the 5 MiB source-only threshold. It does not:

- read a representative file through packaged Tauri IPC;
- construct and hydrate CodeMirror or Milkdown in the packaged WebView;
- exercise an `A -> B -> A` tab sequence;
- measure first editable paint or warm reactivation;
- assert that returning to a tab performs no native read and no full-document replacement.

The earlier 105 MiB heap result is valid for the workload it measured, but the conclusion that no runtime cache or scheduler was needed was broader than that workload justified. Round 1 replaces that blind spot with a production-path contract before optimization starts.

### 2.3 Cold open is whole-file, synchronous, and copy-heavy

`src-tauri/src/commands/file_io.rs` currently performs metadata lookup, a complete `fs::read`, decoding, line-ending analysis, hashing, and Markdown image-grant discovery. The Tauri commands are synchronous. The response then carries the same full text in both `source_text` and deprecated `content`, including `content.clone()` on the Rust side, followed by JSON IPC serialization and renderer normalization.

The correct first move is not automatically "stream every file." It is to instrument the stages, move blocking work off the main thread, remove duplicate ownership and copies, and use native size metadata to choose the large-document policy early. A chunked channel is justified only if those measurements show IPC transfer is still the limiting stage. Incrementally dispatching chunks into CodeMirror is explicitly prohibited because it can turn one construction into many increasingly expensive edits.

### 2.4 Structured format editability today

All formats remain editable as raw source. "Read-only" below refers to the visual/structured surface.

| Format | Current visual surface | Current visual writes | Important limit |
| --- | --- | --- | --- |
| Markdown | visual document | editable | source-only above 5 MiB |
| JSON | tree/table/cards/health | bounded scalar and structural edits | source-only above 1 MiB; tree limits also apply |
| JSONL/NDJSON | record list | append, replace, duplicate, or delete a whole valid record | 200-record preview; bounded scan |
| CSV | table preview | replace mapped cells and append rows | 500-row preview; bounded scan |
| TSV | table preview | replace mapped cells and append rows | 500-row preview; bounded scan |
| YAML/YML | structured tree | read-only | source-preservation evidence exists, writes disabled |
| TOML | structured tree | read-only | native `toml_edit` inspection is experimental only |
| XML | structured tree | read-only | DTD/external-entity policy is fail-closed |
| Plain text | source | editable | no structured surface |

The foundational gaps are more important than the missing buttons:

- `StructuredEditableFormat` hard-codes only JSON, JSONL, CSV, and TSV.
- `App.tsx` owns separate JSON, JSONL, and tabular commit paths.
- the catalog can declare an editable surface without proving that a planner, executor, review path, and validator exist;
- `sourcePreservationAdapter.ts` has hashes, guarded patches, post-parse checks, and untouched-region comparison but has no production writer;
- JSON structural edits enter review, while production JSONL and CSV/TSV handlers can commit directly even when their operation metadata says review is required;
- review approval is bound to source identity but not consistently to the validator/schema fingerprint used when the plan was created;
- TOML currently has three authorities: a display parser, a TypeScript conflict scanner, and a native `toml_edit` inspection path.

"Make every structured format editable" therefore means:

> every structured format is usefully visually editable in desktop ScieMD where the host supplies its required planner, through the same guarded production transaction system; unsupported hosts and syntax nodes remain explicitly source-only rather than being regenerated lossily.

It does not mean claiming that every YAML tag, TOML layout, or XML construct can be mutated visually on day one.

### 2.5 The screenshot exposes a tab information-architecture failure

The current strip gives every tab a two-line layout while permanently spending width on a close button and an almost invisible native action `<select>`. The filename competes with a redundant uppercase format label and a comma-joined lifecycle sentence. This produces many nearly identical `material...` labels.

The right-side "All open documents" selector displays the active filename and therefore looks like another tab. Permanent text buttons for Previous tab, Reopen closed, and Save All consume the rest of the horizontal space. "Previous tab" actually means most-recently-used tab, not the tab to the left.

Because the desktop window is configured without native decorations, this strip is also application chrome. A visual rewrite that omits empty-space window dragging, double-click maximize/restore, and hit-test arbitration between window drag, tab reorder, close, and menu controls would regress basic desktop behavior.

Additional contract gaps exist beneath the visual confusion:

- overflow is unmeasured horizontal scrolling with no active-tab reveal guarantee;
- duplicate names use more path than necessary instead of the shortest unique qualifier;
- focus after close is not explicitly restored;
- the native action select can cause layout shift and its arrow events can bubble into tab navigation;
- inactive tabs can reference tab panels that are not present in the DOM;
- the current 200% test checks CSS text rather than rendered behavior;
- active, dirty, warning, hover, focus, and close states have no dedicated `--tab-*` token contract.

Round 10 replaces this component; it does not merely restyle it.

### 2.6 "IBM Flex" is interpreted as IBM Plex Mono

The official family is IBM Plex. IBM Plex Mono is the monospaced member intended for coding. ScieMD currently bundles IBM Plex Sans and JetBrains Mono, but not IBM Plex Mono.

Source mode uses the general `--mono-font` token. That token is also used by code blocks, reviews, tables, dialogs, and many other surfaces, and some visual styles override it with proportional Scie Sans. Changing `--mono-font` would therefore create unrelated typography changes and still fail the "all styles" requirement.

Round 11 introduces a dedicated desktop `--source-editor-font` whose value is IBM Plex Mono in every ScieMD visual style. `--mono-font` remains the general code/technical token. The VS Code custom editor deliberately continues to honor the user's `--vscode-editor-font-family`, with bundled IBM Plex Mono only as its fallback; the desktop styling request is not used to silently override host editor preferences.

## 3. Target architecture

Names may evolve, but the ownership boundaries must remain recognizable.

```ts
type OpenOperationId = string & { readonly __brand: "OpenOperationId" };

type RuntimeArtifactKey = {
  documentId: DocumentId;
  sourceRevision: SourceRevision;
  analyzer: AnalyzerId;
  optionsFingerprint: string;
  dependencyFingerprint: string;
};

type DocumentSourceResidency =
  | { kind: "resident"; source: RevisionedSourceBuffer; sourceRevision: SourceRevision }
  | { kind: "coldClean"; locator: DocumentLocator; verifiedBaseline: FileFingerprint };

type SourceChangeSet = {
  documentId: DocumentId;
  expectedRevision: SourceRevision;
  changes: readonly GuardedSourcePatch[];
};

type SourceCheckpoint = {
  revision: SourceRevision;
  source: SerializedPersistentText;
  fingerprint: VersionedSourceFingerprint;
};

interface RevisionedSourceBuffer {
  baseCheckpoint: SourceCheckpoint;
  pendingChanges: readonly SerializedSourceChange[];
  currentRevision: SourceRevision;
  currentFingerprint: VersionedSourceFingerprint;
  savedCheckpoint: SourceCheckpoint;
  byteWeight: number;
}

type MaterializedSourceSnapshot = {
  documentId: DocumentId;
  sourceRevision: SourceRevision;
  text: string;
  byteWeight: number;
};

interface DocumentRuntimeEntry {
  documentId: DocumentId;
  sourceRevision: SourceRevision;
  sourceEditorState?: EditorState;
  visualEditorState?: OpaqueVisualEditorState;
  byteWeight: number;
  lastUsedAt: number;
  residency: "active" | "warm" | "evictable";
}

interface StructuredMutationPlan {
  format: StructuredFormat;
  documentId: DocumentId;
  sourceRevision: SourceRevision;
  sourceFingerprint: string;
  validatorFingerprint: string;
  operation: StructuredOperationDescriptor;
  patches: readonly GuardedSourcePatch[];
  preservationEvidence: SourcePreservationEvidence;
  review: "required" | "optional" | "notRequired";
}

interface StructuredMutationAdapter {
  format: StructuredFormat;
  operations(node: StructuredNodeIdentity, context: MutationContext): readonly StructuredOperationDescriptor[];
  plan(intent: StructuredMutationIntent, context: MutationContext): Promise<StructuredMutationPlan>;
  validate(plan: StructuredMutationPlan, current: MutationContext): Promise<MutationValidationResult>;
}
```

The serializable `DocumentRecord` remains the durability authority. A resident record owns a pure revisioned source buffer; ordinary editor changes append compact guarded changes instead of materializing a new full string on every keystroke. Save, recovery, and analyzers share at most one materialized snapshot for a requested revision, while the pending patch log compacts under a declared bound outside activation. Only a clean, path-backed document with a verified disk baseline may enter an explicit `coldClean` state after measured memory pressure; dirty, untitled, conflicted, saving, and recovery-only sources stay resident. Editor states, syntax trees, parser results, worker handles, abort controls, and caches are reconstructible runtime state and must never be placed in workspace persistence.

The derived-analysis scheduler owns reconstructible computation; React hooks subscribe to results. A component mount or active tab may change priority, but it must not be the lifetime or authority of a parse or validation job. Recovery and watcher coordinators retain their separate durability/filesystem authority and may enqueue follow-up without making tab activation wait for it.

## 4. Non-negotiable invariants

1. Activating a resident/warm document performs zero main-document byte acquisition. A clean document may be reread only after an observable, budget-driven transition to `coldClean`; baseline verification and external-change handling precede adoption of reread content.
2. Warm activation never replaces the entire CodeMirror document through a content transaction on a **warm hit**. First attach and cache miss may construct a new `EditorState` from the authoritative source snapshot; a warm hit must attach a revision-matching parked state without a full-document content transaction.
3. The resident `DocumentRecord` source buffer, current revision/fingerprint, and independently addressable saved checkpoint are authoritative. CodeMirror edits are owner-addressed changes and never require full-source `toString()` per keystroke. A visual editor that cannot emit source patches uses an explicit, measured, revision-guarded whole-snapshot fallback and is never reported as incremental.
4. Dirty/untitled/conflicted/saving/recovery-only source is never silently discarded. Clean source eviction follows one explicit byte-budget policy and never masquerades as warm activation; capacity refusal and degraded states are visible.
5. Only one heavyweight editor DOM is mounted by default. Warm state retention is not permission to mount one full editor per tab. Documents under source-only large-file policy warm-park the **source** surface only; Milkdown/visual park is not attempted for those documents.
6. Deactivate flush is the sole editor→aggregate handoff. Save, autosave, and recovery actors consume the aggregate (and effect tokens), never a detached parked `EditorView`. External-change / reload / conflict adoption drops parked editor state for that document before disk bytes are adopted.
7. Every runtime or derived artifact is addressed by document ID and source revision; schema and linked-file-dependent artifacts also carry dependency fingerprints.
8. No synchronous deep parse, validation, decoration build, or whole-file diagnostic scan may block first editability for a document classified as large.
9. Cancellation must stop obsolete work, not merely ignore its eventual result.
10. Activation may enqueue recovery or watcher follow-up, but it does not synchronously serialize or hash a large source before the next tab becomes interactive; the existing durability and filesystem-correctness guarantees remain unchanged.
11. One structured mutation executor enforces revision, source hash, validator fingerprint, review, destructive-operation, post-parse, schema, and untouched-region policy for every format.
12. A format contribution cannot advertise a visual operation unless registry validation proves a production planner, handler, review policy, and tests for it.
13. YAML, TOML, and XML visual edits fail closed per node when source-preservation evidence is insufficient. Source mode always remains available.
14. Native TOML planning may return guarded text patches, but it must never bypass the document aggregate or write the file directly.
15. The tab component remains a projection and command surface; it never owns document lifecycle state. Tab chrome never exposes warm/cold/cache-hit jargon to end users.
16. Every tab state is conveyed by more than color and has complete tooltip/accessibility text even when its visible state is compact.
17. Desktop source presentation uses IBM Plex Mono in every ScieMD visual style without changing document/code-block typography or source characters. The VS Code source host retains its user-configured editor-font authority and uses IBM Plex Mono only as a packaged fallback.
18. A round cannot close on helper tests alone when its stated consumer is an editor, tab, packaged open path, or production structured surface.

## 5. Round map and delivery gates

| Round | Independently closable outcome | First production consumer | Gate unlocked |
| --- | --- | --- | --- |
| 1 | Real cold-open and warm-reactivation performance contract | open/activate flow and diagnostics | optimization decisions use evidence |
| 2 | asynchronous, single-owner native text acquisition | existing Open/Open With flow | cold open avoids known duplicate work |
| 3 | revisioned source buffer and bounded edit data plane | CodeMirror, document aggregate, save/recovery | ordinary source typing no longer copies the file |
| 4 | bounded source/editor residency and warm activation | source and visual tab activation | admitted `A -> B -> A` is genuinely warm |
| 5 | revision-indexed cache and analysis scheduler | parsing, validation, metrics, outline, linked-data analysis | inactive results are reusable and work is bounded |
| 6 | one production structured mutation authority | existing JSON/JSONL/CSV/TSV editors | new format writers cannot bypass safety |
| 7 | source-preserving YAML visual writes | YAML structured tree | YAML is usefully editable where proven |
| 8 | native `toml_edit` mutation planner | desktop TOML structured tree | TOML is usefully editable where proven |
| 9 | namespace-aware XML mutation planner | XML structured tree | XML is usefully editable where proven |
| 10 | adaptive modern tab strip | desktop workspace | tab chrome is clear at realistic density |
| 11 | IBM Plex Mono source typography | desktop source editor; VS Code host-font fallback contract | wave-wide certification and closure |

Mandatory gates:

- Round 2 cannot choose chunked transport until Round 1 traces identify transfer/serialization as material after duplicate fields and blocking execution are considered.
- Round 4 must close before Round 10 chooses its keyboard activation semantics. Automatic activation is permitted only when the release fixture's full warm-reactivation p95 after Round 5 is at most 100 ms; otherwise the whole tablist uses manual activation. The behavior never changes dynamically per cache hit. Tabs never expose warm/cold/cache-hit jargon to users.
- Round 6 hard-depends on Round 3 (revisioned source/change authority) and on Round 1's review-bypass characterization. Round 5 cached parse artifacts are preferred but not required: a cache miss may use an on-demand revision-keyed parse. No YAML/TOML/XML editable catalog claim changes before Round 6's executor is the sole production commit route.
- Each new format writer enables only operations covered by its preservation corpus and the shared operation-matrix schema introduced in Round 6. A partially writable tree is acceptable; a lossy whole-document regeneration path is not.
- Round 10 visual baselines use the then-current source font (JetBrains Mono until Round 11). Round 11 re-baselines tab geometry after IBM Plex Mono lands; pixel-identical carry-forward across the font swap is not required.
- Broad merge, packaging, installed-VSIX, and exact evidence sealing run once after Round 11's focused outcome passes, as its terminal closure work, not in every round.

## 6. Efficient execution contract for the whole wave

- Execute exactly the first `OPEN` round. Do not implement or partially start later rounds in the same execution.
- One primary production writer owns the round's shared dependency spine, public types, registries, migrations, generated projections, and closure record.
- Parallel agents are read-only by default: inventory, adversarial review, test design, profiling analysis, or failure diagnosis.
- Parallel writers are permitted only for genuinely disjoint leaf files after the shared interface is frozen. They must not edit shared contracts, barrels, catalogs, lockfiles, migrations, roadmap status, or generator-owned outputs.
- Work directly in the shared integration tree. Do not create worktrees, packet commits, cherry-pick queues, or repeated clean-tree certification rituals.
- Mechanical companions are automatically inside the primary lease: adjacent tests/fixtures, exports, manifests, migrations, generated registrations, package/lock changes, license inventory, validator configuration, and the roadmap closure record.
- Run focused tests during implementation. Run only affected generators and their downstream validators. The terminal round owns broad integrated validation and candidate evidence.
- Repair ordinary implementation, test, generator, and type errors inside the round. Stop only for a genuinely unresolved product decision, incompatible stored/public contract, destructive action, authority/safety change, conflicting live edit, or external blocker.
- Command paths and Vitest filters below may be corrected if the repository moves, but the stated validation obligation may not be weakened except by an explicit user-approved, round-scoped governance amendment recorded in that round's closure record. A waiver must enumerate the omitted evidence and consequences, must never be represented as a passing result, and does not weaken any later round's obligations.

## 7. Rounds

### Round 1 - Production-path document performance contract - `CLOSED`

#### Status

`CLOSED` on 2026-07-21 (America/Toronto). Baseline identity: Git `HEAD f28bb9cf7abeb504402f702e8d8a78bdf302e03a` plus build-input manifest SHA-256 `efd8e458e183631b8510ac83f0a55658dbac86199356c26285eaf6e4bd5ab662` over 1,149 files. The measured release executable is `src-tauri/target/release/sciemd.exe`, SHA-256 `a69045b6cce2755a400dbf9866a030db8428dfe2520e29238c006d5b67913bde`.

#### Outcome delivered

The intended instrumentation/characterization outcome is live: one bounded, content-free performance trace measures native cold open, aggregate association, editor attach/paint, analysis readiness, accepted/echoed input, source materialization, save/recovery snapshots, reason-addressed byte acquisition, and clean/dirty `A -> B -> A` activation. Checked-in exact-byte fixtures, target budgets, deterministic gates, and a measured Windows release baseline replace the former helper-only claim.

#### Contracts and decisions

- `OpenOperationId` is allocated before a `DocumentId`; aggregate commit or duplicate focus associates the document later. Trace retention is bounded, numeric fields are validated, display identity is only a redacted `extension:size-bucket`, and production tracing fails inertly if instrumentation throws.
- Native phases use native monotonic durations; renderer invoke wall time records an IPC/dispatch residual. No native timestamp is subtracted from a renderer timestamp.
- Open, recovery, watcher-hash, external-verification, and typed future acquisition reasons are distinct. Warm activation evidence showed zero main-document byte acquisitions.
- CodeMirror and Milkdown expose attach/next-frame and accepted/echoed markers. The gateway, change callbacks, external replacement, save, and recovery paths count full materializations/transactions without content.
- The 5 MiB threshold fixtures use exact UTF-8 byte counts and realistic many-line geometry. Timing/memory values are distributions and observations, not deterministic promises.
- CSV remains deliberately excluded from OS startup/Open With arguments; the packaged mixed-tab probe covers every launchable structured format, while production CSV characterization remains in deterministic tests. This preserves the existing native compatibility rule.
- The original scope and non-goals remain historical constraints: this round instruments and characterizes; it does not add a runtime cache, rewrite the synchronous native reader, raise the 25 MiB limit, enforce structured review, or redesign tabs.

#### Production adoption

The production Open/Open With and picker orchestration in `openDocumentForSession`, native `read_text_file[_for_edit]`, workspace activation in `useDocumentSession`, `DocumentKeyedEditorGateway`, CodeMirror `SourceTextEditor`, Milkdown `VisualMarkdownEditor`, external-change verification, save/recovery coordinators, and the command-palette action `Copy document performance report` all use the contract. JSONL/CSV/TSV production writers also emit explicit failing-forward review-bypass characterization evidence.

#### Compatibility and migrations

Native read responses add `nativeTimings`; the renderer accepts it optionally, preserving browser/legacy host fixtures. The released `sourceText`/`content` duplicate payload, synchronous Rust reader, storage schemas, workspace manifests, file limits, CSV OS-launch exclusion, public extension APIs, and save/recovery authority are unchanged. No stored-data migration or generated registry migration was required. The live JSONL/CSV/TSV bypass is documented and tested, not repaired ahead of Round 6.

#### Changed-path manifest

- Contract, fixtures, baseline, budgets, and characterization: `src/app/performance/documentPerformance.ts`, `documentPerformance.test.ts`, `documentPerformanceHarness.test.ts`, `documentPerformanceFixtures.ts`, `documentPerformanceBudgets.v1.json`, `documentPerformanceBaseline.windows.v1.json`, `structuredReviewBypassCharacterization.ts`, and `structuredReviewBypassCharacterization.test.ts`.
- Native/typed open timing: `src-tauri/src/commands/file_io.rs`, `src/app/documentState.ts`, `src/services/fileService.ts`, `src/app/documentSession/openDocument.ts`.
- Production activation/editor/durability adoption: `src/app/documentEditorGateway.ts`, `src/app/hooks/useDocumentSession.ts`, `src/app/hooks/useSaveOperations.ts`, `src/app/workspace/workspaceExternalChangeCoordinator.ts`, `src/app/workspace/workspaceRecoveryCoordinator.ts`, `src/components/SourceTextEditor.tsx`, `src/components/SourceMarkdownEditor.tsx`, `src/components/VisualMarkdownEditor.tsx`, `src/app/AppEditorStage.tsx`, `src/app/App.tsx`.
- Command/export wiring and mechanical tests: `src/app/appCommands.ts`, `src/app/hooks/useAppCommands.ts`, `src/app/hooks/useAppCommandRegistry.ts`, `src/app/appCommands.test.ts`, `src/app/AppEditorStage.test.tsx`, `src/app/AppWorkbench.test.tsx`.
- Packaged gate and manifest: `scripts/validate-desktop-ui-performance.mjs`, `package.json`.
- Roadmap closure: `docs/refactor/document_runtime_structured_editing_foundations_wave.md`.

#### Validation evidence

- `npx vitest run src/app/performance src/app/documentSession/openDocument.test.ts src/app/documentEditorGateway.test.ts src/app/AppWorkbench.test.tsx` -> 6 files, 29 tests passed.
- Extended affected integration run covering external verification, recovery, and save -> 9 files, 87 tests passed.
- `npm run validate:large-document-stress` -> 1 file, 1 stress test passed; parser/export/structured/recovery report written under ignored `tmp/large-document-stress/`.
- `npm run validate:desktop-ui-performance -- --required` -> passed; rebuilt the release candidate, exercised exact threshold and 1/5/10/24 MiB cold paths, six OS-launchable structured formats, five accepted/echoed CodeMirror samples, five warm samples, and cumulative 5 x 10 MiB plus 3 x 24 MiB tabs.
- `npx tsc --noEmit` -> exit 0.
- `cargo test --manifest-path src-tauri/Cargo.toml commands::file_io --lib` -> 25 passed, 0 failed (99 filtered).
- `git diff --check` -> exit 0.

#### Generated outputs and candidate identity

The affected generator DAG is `validate:desktop-ui-performance` -> `build:desktop -- --no-bundle` -> `npm run build`/Vite + Rust release executable -> `documentPerformanceBaseline.windows.v1.json`. The final baseline records build-input manifest SHA-256 `efd8e458e183631b8510ac83f0a55658dbac86199356c26285eaf6e4bd5ab662` and executable SHA-256 `a69045b6cce2755a400dbf9866a030db8428dfe2520e29238c006d5b67913bde`; an independent `Get-FileHash` matched the executable. No other tracked projection changed.

#### Remaining risks

The measured baseline intentionally exposes work for later rounds: warm attach p95 `811.7 ms` exceeds the `250 ms` target; cold first-editable p95 `11,430.5 ms` exceeds `5,000 ms`; accepted-to-visible-echo p95 `416.5 ms` exceeds `100 ms`; pre-pressure WebView heap was `1,603,339,684` bytes; and cumulative process-tree working set was `3,777,642,496` bytes. Under full pressure the renderer stopped servicing DevTools, so pressure WebView heap is explicitly unavailable while external process-tree memory remains recorded. Native cooperative cancellation is not measurable in the preserved synchronous reader; the checked-in `native_cancel_stop_p95_ms` target is carried into Round 2. JSONL/CSV/TSV review bypass remains deliberately deferred to Round 6.

#### Non-goals preserved

No runtime/source cache, async or chunked native transport, revisioned source buffer, analysis scheduler, structured mutation executor, YAML/TOML/XML editing expansion, tab redesign, or typography work was started. The 25 MiB limit, synchronous native source authority, existing structured operation sets, and later-round ownership boundaries remain unchanged.

#### Proper closure statement

Round 1 is properly CLOSED.

#### Roadmap advancement

Round 2 is the sole `OPEN` round. Rounds 3-11 remain `PLANNED`; no Round 2 implementation was begun.

### Round 2 - Asynchronous single-owner native document loading - `CLOSED`

#### Status

`CLOSED` on 2026-07-21 (America/Toronto). Baseline identity: Git `HEAD f28bb9cf7abeb504402f702e8d8a78bdf302e03a` plus build-input manifest SHA-256 `2fd57da0dd76510fd991f672b00679136a4e7a348df456cb39b139bf4174ecbc` over 1,150 files. The measured release executable is `src-tauri/target/release/sciemd.exe`, SHA-256 `e769335e75e9d6589cd99d2299570110f77bfb97d2455669dd08d17dec57edf8`.

#### Outcome delivered

The intended single-owner native loading outcome is live in the first production consumer: `DocumentHost.readTextFileForEdit` now reaches asynchronous, coherent, cancellable native acquisition through picker, startup/Open With, workspace restore, and `openDocumentForSession`. One versioned source result becomes authoritative only after snapshot verification, fidelity analysis, image-grant policy, hashing, ordered channel completion, recovery-policy join, and the aggregate commit decision.

#### Contracts and decisions

- Heavy preflight, filesystem, coherent-read, decode/fidelity, grant, and hash work runs on Tauri's blocking pool. The native operation registry is keyed by renderer operation ID and has cooperative 256 KiB checkpoints; five packaged cancellation samples stopped at 8.3916 ms p95 against the 500 ms bound.
- Windows reads hold a read-only handle with sharing restricted to `FILE_SHARE_READ`, verify file identity and relevant metadata before/after, and retry three times with typed `FILE_CHANGED` failure. Hosts without write exclusion use two byte-identical, identity/metadata-stable reads under the same bounded policy.
- Native contract version 2 removed deprecated `content`; the renderer exposes exactly one full `sourceText`. Encoding, BOM, CR/LF/mixed state, lossy status, original-byte/content hashes, metadata, snapshot evidence, and source remain coherent.
- Early `stat_file` metadata is provisional only. Recovery lookup starts in parallel with native acquisition and joins before deterministic recovery/commit policy. Image grants remain inside the verified native completion rather than being deferred, avoiding a false-ready surface or weaker filesystem access.
- Measured one-shot invoke residual was material at 3,925.126 ms p95, so the production commands use ordered UTF-8-safe 2 MiB Tauri channel chunks. The renderer validates order/count, waits for the explicit completion record even when invoke resolves first, joins once, and never appends chunks through CodeMirror transactions. Native cancellation checkpoints remain 256 KiB.
- Intermediate packaged failures exposed and repaired channel-callback ordering and validator-generated concurrent Open With cancellation. The final gate uses sequential production ingress, consistent with the single active-open owner; fixture coverage and the 60-second ingress bound were not weakened.
- Browser/test hosts retain one compatibility constructor for the same semantic response, not a second source authority.

#### Production adoption

The native `read_text_file` and `read_text_file_for_edit` commands, `fileService`, `desktopDocumentHost`, `openDocumentForSession`, and `useDocumentSession` own the production spine. Picker, startup/Open With, duplicate-locator focus, workspace restore, external verification/conflict review, citation reads, JSON-schema discovery, and layer-two linked-document reads consume the canonical response. The packaged WebView reached the production editor shell, every launchable structured startup format, 1/5/10/24 MiB cold fixtures, and cumulative five 10 MiB plus three 24 MiB tabs.

#### Compatibility and migrations

Native read DTO contract 2 is an atomic internal cutover; deprecated `content` is removed. Document host errors moved to contract 2 with typed `CANCELLED` and optional phase while the TypeScript normalizer still accepts the version-1 fixture shape and maps unknown future codes safely. Browser/test hosts create the same version-2 response with explicit host snapshot evidence. No workspace, recovery, storage, extension, package-lock, or persisted-data migration was required; the 25 MiB ceiling, supported formats, CSV OS-launch exclusion, save authority, and fidelity rules are unchanged.

#### Changed-path manifest

- Native loading, cancellation, snapshot/fidelity, typed errors, and command registration: `src-tauri/src/commands/file_io.rs`, `src-tauri/src/commands/host_error.rs`, `src-tauri/src/lib.rs`.
- Canonical DTO/host/transport boundary: `src/app/documentState.ts`, `src/app/host/documentHost.ts`, `src/app/host/desktopDocumentHost.ts`, `src/app/host/documentHostError.ts`, `src/app/host/fixtures/documentHostErrors.v2.json`, `src/services/fileService.ts`.
- Open/recovery/cancellation production integration: `src/app/documentSession/openEffects.ts`, `src/app/documentSession/openDocument.ts`, `src/app/hooks/useDocumentSession.ts`.
- Canonical response consumers: `src/app/hooks/useCitationWorkflow.ts`, `useExternalConflictReviewWorkflow.ts`, `useJsonSchemaDiscovery.ts`, `useLayerTwoDocument.ts`.
- Focused/integration fixtures: `src/services/fileService.test.ts`, `src/app/host/desktopDocumentHost.test.ts`, `src/app/documentSession/openDocument.test.ts`, the matching hook tests, `src/app/hooks/useSaveOperations.test.ts`, `src/app/workspace/workspaceExternalChangeCoordinator.test.ts`, and `workspaceRestore.test.ts`.
- Validators/generated evidence/docs: `scripts/validate-tauri-command-contract.mjs`, `scripts/validate-desktop-ui-performance.mjs`, `src/app/performance/documentPerformanceBaseline.windows.v1.json`, this roadmap. No package or lockfile changed for Round 2; pre-existing Round 1 paths remain preserved in the shared dirty tree.

#### Validation evidence

- `cargo test --manifest-path src-tauri/Cargo.toml file_io` -> 31 passed, 0 failed (99 filtered).
- `npx vitest run src/services/fileService.test.ts src/app/host src/app/documentSession/openDocument.test.ts` -> 3 files, 34 tests passed.
- `npx vitest run src/app/workspace/workspaceManifestCoordinator.test.ts src/app/workspace/workspaceRecoveryCoordinator.test.ts src/app/workspace/workspaceExternalChangeCoordinator.test.ts src/services/workspaceManifestService.test.ts src/services/draftRecoveryService.test.ts src/app/hooks/useSaveOperations.test.ts` -> 6 files, 103 tests passed.
- `npm run validate:tauri-contract` -> passed; 59 registered commands cover 56 TypeScript invokes.
- `npm run validate:desktop-ui-performance -- --required` -> passed; rebuilt and exercised the sealed Windows release candidate, channel decision evidence, five native cancellation samples, cold/structured/warm/input paths, and all eight cumulative pressure fixtures.
- `npx tsc --noEmit` -> exit 0.
- `git diff --check` -> exit 0.
- Additional verified coverage: six startup/restore/linked-consumer files, 65 tests passed; `cargo test --manifest-path src-tauri/Cargo.toml host_error` -> 1 passed.

#### Generated outputs and candidate identity

The affected generator DAG is `validate:desktop-ui-performance` -> `build:desktop -- --no-bundle` -> TypeScript/Vite and Rust release build -> `src/app/performance/documentPerformanceBaseline.windows.v1.json`. The final artifact records source manifest SHA-256 `2fd57da0dd76510fd991f672b00679136a4e7a348df456cb39b139bf4174ecbc`, executable SHA-256 `e769335e75e9d6589cd99d2299570110f77bfb97d2455669dd08d17dec57edf8`, bounded-channel adoption, prior one-shot candidate identity, current distributions, cancellation samples, and reached pressure tabs. No other generator was affected.

#### Remaining risks

The channel removes the unbounded one-shot payload and keeps native work cancellable/off-main-thread, but renderer invoke residual remains material at 3,901.708 ms p95 under the measured fixture set; this is explicit evidence for the Round 3 revisioned buffer and later editor/runtime work, not hidden Round 2 work. Cold first-editable p95 improved from Round 1's 11,430.5 ms to 9,133.8 ms but remains above the 5,000 ms target. Input p95 is 179.5 ms, and cumulative process-tree working set is 3,224,530,944 bytes. Full source is still assembled once in JavaScript by design; later rounds own revisioned residency, editor reuse, analysis scheduling, and memory depth.

#### Non-goals preserved

No revisioned source buffer, incremental edit authority, resident editor/runtime cache, scheduler, structured mutation executor, YAML/TOML/XML writer, tab redesign, typography change, file-limit increase, or broad release certification was started. CodeMirror receives one complete authoritative value and no streamed incremental transactions. Round 3 implementation remains untouched.

#### Proper closure statement

Round 2 is properly CLOSED.

#### Roadmap advancement

Round 3 is now the sole `OPEN` round. Rounds 1-2 are `CLOSED`; Rounds 4-11 remain `PLANNED`. No Round 3 implementation was begun.
### Round 3 - Revisioned source buffer and bounded edit data plane - `CLOSED`

#### Status

`CLOSED` on 2026-07-22 (America/Toronto). Baseline identity: Git `HEAD f28bb9cf7abeb504402f702e8d8a78bdf302e03a` plus build-input manifest SHA-256 `b50586658333d72e504313a08f947101897503dd0186f83e05eb93c18ea590de` over 1,157 files. The shared dirty tree contains the preserved Round 1-2 closure work plus this Round 3 outcome; no staging or commit was performed.

#### Outcome delivered

One host-neutral, revisioned source buffer now owns current and saved source checkpoints. The first production consumer, `SourceTextEditor`, converts CodeMirror transactions into bounded guarded change sets without a per-keystroke `doc.toString()` or whole-source callback; `DocumentRecord`, save/dirty tracking, recovery checkpoints, and external-conflict comparison consume the same authority.

#### Contracts and decisions

- `DocumentRecord` schema 2 contains the pure serializable `RevisionedSourceBuffer`; one reducer remains the primary writer for guarded changes, whole-source adoption, saved-checkpoint advancement, and compaction. Runtime snapshots, leases, and memoization remain outside durable state in a `DocumentId`/address/revision-keyed service.
- Current and saved checkpoints are independently revision/fingerprint-addressed and reuse immutable segments. Dirty state is semantic checkpoint inequality, so undo back to saved bytes becomes clean; a saved checkpoint advances only after successful atomic write and baseline commit.
- Ordered non-overlapping changes are validated atomically against document, expected revision, guards, bounds, and checked-in limits. Typed rejection leaves the buffer unchanged and causes the editor to reconcile from an authoritative leased snapshot rather than silently retrying against another tab.
- Source typing, undo/redo, paste, multi-cursor transactions, and composition completion share the CodeMirror change path. External reconciliation is annotated so it cannot re-enter the writer. Content-free metrics distinguish bounded changes, snapshot materialization, and the explicit visual whole-snapshot fallback.
- Snapshot leases memoize one full string per addressed revision and release on success and failure. Save, recovery, conflict, activation, and visual-boundary consumers use addressed leases; the compatibility strings on `DocumentRecord` are projections, not edit authority.
- Compaction uses the closure-contract MVP: a thresholded, coalesced off-side candidate swaps only when document revision and storage epoch still match. It preserves semantic revision and the independently materializable saved checkpoint; stale/failing work leaves the original buffer valid. More elaborate piece-table compaction was not required by the measured critical path.

#### Production adoption

`SourceTextEditor` and `SourceMarkdownEditor` reach the production editor shell through `AppEditorStage` and `App`. `useDocumentSession` owns incremental commit/reconciliation and visual fallback orchestration; `documentEditorGateway` preserves explicit source-versus-visual behavior. `useSaveOperations`, `workspaceRecoveryCoordinator`, `workspaceExternalChangeCoordinator`, and `workspaceRestore` lease or restore revisioned checkpoints for save, recovery, conflict/reload, and restart paths.

#### Compatibility and migrations

Whole-source ingress from open, reload, recovery, external adoption, and the named visual fallback migrates into buffer schema 1. `DocumentRecord` schema 2 reconstructs valid predecessor whole-source records and rejects/quarantines future or corrupt buffer representations. Existing `sourceText` and `savedSourceText` fields remain synchronized compatibility projections for unmigrated read consumers; they do not authorize source edits. Recovery/workspace persisted payload shapes, file-fidelity rules, native DTOs, extensions, package dependencies, and lockfiles did not change. A latent open-wrapper positional argument error was corrected so ingress options no longer occupy the saved-source slot.

#### Changed-path manifest

- Source authority, snapshot leasing, compaction, exports, and focused tests: `src/app/source/index.ts`, `revisionedSourceBuffer.ts`, `sourceSnapshotService.ts`, `sourceBufferCompactionScheduler.ts`, and their three test files.
- Aggregate and production editor integration: `src/app/documentRecord.ts`, `src/app/documentRecord.test.ts`, `src/components/SourceTextEditor.tsx`, `src/components/SourceTextEditor.test.ts`, `src/components/SourceMarkdownEditor.tsx`, `src/app/AppEditorStage.tsx`, `src/app/App.tsx`, `src/app/documentEditorGateway.ts`, `src/app/documentEditorGateway.test.ts`.
- Session, save, recovery, conflict, and restore adoption: `src/app/hooks/useDocumentSession.ts`, `src/app/hooks/useSaveOperations.ts`, `src/app/hooks/useSaveOperations.test.ts`, `src/app/workspace/workspaceRecoveryCoordinator.ts`, `workspaceRecoveryCoordinator.test.ts`, `workspaceExternalChangeCoordinator.ts`, `workspaceExternalChangeCoordinator.test.ts`, and `workspaceRestore.ts`.
- Documentation: this roadmap. No Round 3 package, lockfile, native, extension, persistent generator projection, or performance-baseline path changed; unrelated/predecessor dirty paths were preserved.

#### Validation evidence

- `npx vitest run src/app/source src/app/documentRecord.test.ts src/app/documentEditorGateway.test.ts src/components/SourceTextEditor.test.ts src/components/VisualMarkdownEditor.test.ts` -> 7 files, 49 tests passed.
- `npx vitest run src/app/hooks/useSaveOperations.test.ts src/app/workspace/workspaceRecoveryCoordinator.test.ts src/app/workspace/workspaceExternalChangeCoordinator.test.ts src/app/workspace/workspaceManifestCoordinator.test.ts src/services/workspaceManifestService.test.ts src/services/draftRecoveryService.test.ts` -> 6 files, 106 tests passed.
- `npm run validate:large-document-stress` -> 1 file, 1 stress test passed; 457,423-byte/900-section document plus 3,200-record structured workload completed.
- `npx tsc --noEmit` -> exit 0.
- `npm run build` -> exit 0; TypeScript and Vite production build completed with 4,595 modules transformed.
- `git diff --check` -> exit 0.
- Additional affected-path evidence: `npx vitest run src/app/hooks/useDocumentSession.startup.test.tsx src/app/documentSession/openDocument.test.ts src/app/workspace/workspaceRestore.test.ts` -> 3 files, 44 tests passed. Tests cover 1/5/10/24 MiB snapshot fixtures, bounded CodeMirror edits with zero whole-source callback/materialization, typed rejection/reconciliation, semantic undo-to-clean, save/recovery/conflict failure release, migration/quarantine, stale compaction, and saved-checkpoint preservation.

#### Generated outputs and candidate identity

No persistent generator or checked-in projection was affected. `npm run build` regenerated ignored `dist/` output from the exact build-input manifest SHA-256 `b50586658333d72e504313a08f947101897503dd0186f83e05eb93c18ea590de`; the stress gate wrote only its ignored timestamped report under `tmp/large-document-stress/`. The Round 2 Windows performance baseline and sealed executable identity remain unchanged and are not claimed as a Round 3 candidate.

#### Remaining risks

Compatibility string projections remain until downstream read consumers can be removed safely, and compaction intentionally uses the permitted bounded-log/full-rebase MVP rather than a more elaborate persistent text structure. A supplemental packaged cumulative-pressure probe reached the incremental input gate and four 10 MiB pressure tabs, then the fifth file hit the existing native 20-second acquisition deadline under accumulated renderer pressure; no baseline was written. That resident-editor/activation/memory depth belongs to Round 4 and is not part of Round 3's required command set or source-mutation closure.

#### Non-goals preserved

No resident editor cache, editor-state reuse policy, tab-activation redesign, analysis scheduler, structured mutation executor, YAML/TOML/XML writer, typography change, file-limit increase, or broad release certification was implemented. Milkdown remains an explicitly named revision-guarded whole-source fallback and does not impersonate the CodeMirror incremental path.

#### Proper closure statement

Round 3 is properly CLOSED.

#### Roadmap advancement

Round 4 is now the sole `OPEN` round. Rounds 1-3 are `CLOSED`; Rounds 5-11 remain `PLANNED`. No Round 4 implementation was begun.

### Round 4 - Bounded resident editor runtime and warm tab activation - `CLOSED`

**Status**

`CLOSED` on 2026-07-22 (America/Toronto). Exact tree identity: Git `HEAD f28bb9cf7abeb504402f702e8d8a78bdf302e03a` plus build-input manifest SHA-256 `470c7592b243ca4f0f47fa86ed6425f42f7c7c9815fbf972351bd645b618c716` over 1,162 files. This is the shared dirty integration tree containing preserved predecessor work; no staging or commit was performed.

**Outcome delivered**

Returning to an admitted source document now reattaches its exact CodeMirror state without a document-changing transaction or disk reread, while one mounted heavyweight editor DOM is retained. The workspace now has bounded, document-keyed runtime admission and deterministic LRU shedding plus a separate `coldClean` aggregate-source policy with an atomic release barrier and baseline-verified reacquisition. Desktop source/visual editors and production `activateWorkspaceDocument` flows are the first consumers.

**Contracts and decisions**

The document/revision/surface/configuration cache key, aggregate-authority boundary, document-addressed callbacks, one-editor-DOM rule, source-only large-file policy, deterministic high/low/hard watermarks, reserved headroom, dirty-source pinning, refusal/degraded behavior, fixed shedding order, atomic cold release, external-change invalidation, and complete close cleanup are implemented. CodeMirror is exact-state warm; Milkdown is truthfully classified as a measured bounded rebuild with view restoration. Round 3 remains the sole source-mutation authority.

By explicit user direction on 2026-07-22, the wave contract was amended for this round only to waive the packaged bounded-memory evidence, generation of a new performance baseline, and sealed-candidate requirement. The failed packaged command is not represented as passing: WebView2 stopped servicing `Runtime.evaluate` before the cumulative five 10 MiB plus three 24 MiB pressure sequence completed. Consequently, real packaged heap/process-tree bounds, complete warm distributions, pressure-transition evidence, and the full editor flush/suspend/attach/focus sub-budget remain uncertified. This waiver does not alter Round 5 or any later validation obligation.

**Production adoption**

`documentEditorGateway`, `documentRuntimeRegistry`, `documentSourceResidency`, `useDocumentSession`, `App`/`AppEditorStage`, `SourceTextEditor`, `SourceMarkdownEditor`, and `VisualMarkdownEditor` use the new authority. Production activation, duplicate-focus, reopen, external-change, save/recovery, native pending-open, and close paths all reach the document-keyed runtime and source-residency integration.

**Compatibility and migrations**

Resident records preserve the existing revisioned aggregate and compatibility string projections. `coldClean` records retain locator and verified saved baseline only; unchanged files reacquire at the same semantic revision, external mismatch enters conflict review, and missing or permission-lost files remain cold with recovery guidance. No stored workspace schema, public extension contract, package dependency, or lockfile migration was introduced. Existing Round 1-3 fixtures and dirty-tree work remain preserved.

**Changed-path manifest**

Production and tests: `src/app/runtime/documentRuntimeRegistry.ts`, `src/app/runtime/documentRuntimeRegistry.test.ts`, `src/app/runtime/documentSourceResidency.ts`, `src/app/runtime/documentSourceResidency.test.ts`, `src/app/runtime/index.ts`, `src/app/documentRecord.ts`, `src/app/documentRecord.test.ts`, `src/app/documentEditorGateway.ts`, `src/app/documentEditorGateway.test.ts`, `src/app/activeDocumentCompatibility.ts`, `src/app/activeDocumentCompatibility.test.ts`, `src/app/source/sourceSnapshotService.ts`, `src/app/source/sourceSnapshotService.test.ts`, `src/app/effects/documentEffectCoordinator.ts`, `src/app/effects/documentEffectCoordinator.test.ts`, `src/app/documentSession/openDocument.ts`, `src/app/documentSession/openDocument.test.ts`, `src/app/performance/documentPerformance.ts`, `src/app/hooks/useDocumentSession.ts`, `src/app/hooks/useDocumentSession.startup.test.tsx`, `src/app/workspace/workspaceState.ts`, `src/app/workspace/workspaceExternalChangeCoordinator.ts`, `src/app/workspace/workspaceRecoveryCoordinator.ts`, `src/app/workspace/workspaceRecoveryCoordinator.test.ts`, `src/app/App.tsx`, `src/app/AppEditorStage.tsx`, `src/components/editorAdapter.ts`, `src/components/SourceTextEditor.tsx`, `src/components/SourceTextEditor.test.ts`, `src/components/SourceMarkdownEditor.tsx`, and `src/components/VisualMarkdownEditor.tsx`. Validation/docs: `scripts/validate-desktop-ui-performance.mjs` and this roadmap. No package or lockfile changed specifically for Round 4; predecessor and unrelated dirty paths were preserved.

**Validation evidence**

- `npx vitest run src/app/documentEditorGateway.test.ts src/app/runtime src/components/SourceTextEditor.test.ts src/components/VisualMarkdownEditor.test.ts src/app/AppWorkbench.test.tsx` -> 6 files, 37 tests passed.
- `npx vitest run src/app/hooks/useSaveOperations.test.ts src/app/workspace/workspaceRecoveryCoordinator.test.ts src/app/workspace/workspaceExternalChangeCoordinator.test.ts src/app/workspace/workspaceManifestCoordinator.test.ts src/services/workspaceManifestService.test.ts` -> 5 files, 68 tests passed.
- `npx vitest run src/app/hooks/useDocumentSession.startup.test.tsx src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx src/app/activeDocumentCompatibility.test.ts src/app/AppEditorStage.test.tsx src/app/documentRecord.test.ts src/app/source/sourceSnapshotService.test.ts src/app/effects/documentEffectCoordinator.test.ts src/app/workspace/workspaceState.test.ts src/app/documentSession/openDocument.test.ts` -> 9 files, 117 tests passed.
- `npm run validate:large-document-stress` -> 1 file, 1 stress test passed.
- `npx tsc --noEmit` -> exit 0.
- `git diff --check` -> exit 0 before closure-record editing; rerun after the roadmap change also passed.
- `npm run validate:desktop-ui-performance -- --required` -> did not pass in prior repeated attempts; the last diagnostic timed out after WebView2 stopped servicing `Runtime.evaluate` for 120 seconds. Its packaged bounded-memory/baseline/candidate obligations are explicitly waived for Round 4 only and are not recorded as successful evidence.

**Generated outputs and candidate identity**

No Round 4 performance baseline was generated. The existing `src/app/performance/documentPerformanceBaseline.windows.v1.json` remains the unchanged Round 2 artifact (file SHA-256 `6fb82d43043a318a8e4bddcac1df9ea2681990b442358fb3e567cbed48fedb85`) with manifest SHA-256 `2fd57da0dd76510fd991f672b00679136a4e7a348df456cb39b139bf4174ecbc` and executable SHA-256 `e769335e75e9d6589cd99d2299570110f77bfb97d2455669dd08d17dec57edf8`. The last diagnostic executable is `src-tauri/target/release/sciemd.exe`, SHA-256 `1b80f7afa4a0c112b822e9e585a39737fdc3b4f399171b99784ab6b495c4ce4c`; it is explicitly unsealed and is not presented as a Round 4 candidate. The new-baseline and sealed-candidate requirements were waived by the user for this round.

**Remaining risks**

The packaged cumulative-pressure sequence, observed WebView heap/process-tree ceiling, complete warm latency distribution, pressure-transition trace, and editor flush/suspend/attach/focus sub-budget are not certified for this tree. The production policies are covered by focused integration and stress tests, but the waiver transfers the risk of packaged WebView2 behavior forward without weakening any later round's own gates.

**Non-goals preserved**

Round 4 does not cache derived analysis, keep every document permanently resident, claim Milkdown full-state warmth, change structured mutation authority, implement Round 5 scheduling/cache work, or begin later format/tab/typography rounds.

**Proper closure statement**

Round 4 is properly CLOSED.

**Roadmap advancement**

Round 5 is now the sole `OPEN` round. Rounds 1-4 are `CLOSED`; Rounds 6-11 remain `PLANNED`. No Round 5 implementation was begun.

### Round 5 - Revision-indexed derived artifacts and analysis scheduler - `CLOSED`

#### Status

`CLOSED` on 2026-07-22 (America/Toronto). Exact baseline/tree identity: Git `HEAD f28bb9cf7abeb504402f702e8d8a78bdf302e03a` plus build-input manifest SHA-256 `c3a7dd9bd3037aae269b02b08919b8010cb98eeee8eb535f5edf891ebaf541e4` over 1,169 files. The integration tree remains intentionally dirty with preserved predecessor and Round 5 work; no staging or commit was performed.

#### Outcome delivered

One host-neutral, revision-indexed artifact cache and bounded analysis scheduler now reuse unchanged parsing, validation, metrics, outline, annotation, citation/variable, renderer-diagnostic, and source-presentation results across real tab activation. Large sources remain immediately editable through bounded source projection while deep work is background-only or unavailable by declared policy. The first production consumers are the active `App`/`useDocumentSession` editor path and its analysis hooks.

#### Contracts and decisions

- Artifact identity is `{documentId, sourceRevision, analyzer, optionsFingerprint, dependencyFingerprint}` with canonical semantic fingerprints. Activation changes priority, not validity; active work has priority with fairness, superseded revisions are pruned, and queues/artifacts are hard-bounded and observable.
- Projected DTO validation enforces recursive string, collection, span, source-map, and global byte limits. Results do not retain `content.text`, `frontmatter.body`, `sourcePrefix`, or equivalent near-whole-source fields; larger excerpts use a revision/range-checked `SourceSliceRef` broker.
- Every analyzer leases the Round 3 snapshot authority and releases it on success, cancellation, timeout, worker failure/replacement, rejection, and eviction. Recovery and external-watch coordinators remain independent and never enter the reconstructible artifact cache.
- The worker decision is one in-flight one-shot structured clone per exact artifact key with projected responses. `SharedArrayBuffer` was not adopted because cross-origin isolation is absent and no measured benefit justifies it; large immediate/viewport source work stays on the main thread while deep analysis is deferred.
- The source editor uses an exact-offset 128 Ki-code-unit window above 512 Ki UTF-16 code units, independently of the unchanged 5 MiB format source-only threshold. The aggregate remains the synchronous sole source writer; only React-facing publication of accepted interactive changes is coalesced to the next frame, while durability observers see the new state immediately and ordinary commands publish synchronously.
- `input-accepted` now records only after the aggregate returns an accepted revision. No budget or fixture was weakened, and no Round 5 obligation was waived.

#### Production adoption

`App`, `AppEditorStage`, `useDocumentSession`, `SourceTextEditor`, and the production workspace store use the runtime on real document open, edit, deactivate, and warm-reactivation paths. `useLayerTwoDocument`, `useSourceFormatDiagnostics`, `useDocumentValidator`, `useRevisionedDocumentMetrics`, `useRevisionedMarkdownArtifacts`, `useRendererDiagnostics`, citation/variable consumers, and both parser workers consume revision-keyed artifacts. Save/recovery/external-change flows continue to consume the document aggregate and snapshot service rather than cache state.

#### Compatibility and migrations

The cache and scheduler are reconstructible runtime state and are not persisted; no stored workspace schema or extension/public format contract changed. Existing revisioned buffers and compatibility string projections remain readable. Large-file policy retains explicit raw-byte, UTF-8-byte, UTF-16-code-unit, and runtime-weight units. Parser-worker cancellation is isolated and the native bounded-channel transport remains compatible. Structured packaged fixtures reached JSON, JSONL, YAML, TOML, XML, and TSV; CSV remains deliberately excluded from OS startup/Open With compatibility. Source slices and stale revisions fail closed.

#### Changed-path manifest

- Runtime authority: `src/app/runtime/analysisArtifactProjection.ts`, `documentAnalysisPolicy.ts`, `documentAnalysisRuntime.ts`, `documentAnalysisRuntime.test.ts`, and `index.ts`.
- Production consumers: `src/app/App.tsx`, `src/app/effects/documentEffectCoordinator.ts`, `src/app/hooks/useDocumentSession.ts`, `useLayerTwoDocument.ts`, `useSourceFormatDiagnostics.ts`, `useDocumentValidator.ts`, `useRevisionedDocumentMetrics.ts`, `useRevisionedMarkdownArtifacts.ts`, `useRendererDiagnostics.ts`, `src/domain/document/documentParserWorker.ts`, `src/domain/formats/formatParserWorker.ts`, `src/services/fileService.ts`, `src/components/SourceTextEditor.tsx`, `src/styles/app.source-editor.css`, and `packages/core/src/formats/formatPolicy.ts`.
- Interactive publication and focused tests: `src/app/workspace/workspaceStore.ts`, `workspaceStore.test.ts`, `src/components/SourceTextEditor.test.ts`, `src/app/hooks/useLayerTwoDocument.test.tsx`, `useSourceFormatDiagnostics.test.tsx`, `useDocumentValidator.test.tsx`, and `src/services/fileService.test.ts`.
- Validation, generated evidence, and documentation: `scripts/validate-desktop-ui-performance.mjs`, `src/app/performance/documentPerformance.ts`, `documentPerformanceBaseline.windows.v1.json`, and this roadmap. No package-lock or migration file changed for Round 5; unrelated/predecessor dirty paths were preserved.

#### Validation evidence

- `npx vitest run src/components/SourceTextEditor.test.ts src/app/workspace/workspaceStore.test.ts src/app/hooks/useDocumentSession.startup.test.tsx` -> 3 files, 50 tests passed, covering bounded source projection, authoritative interactive commits, frame-coalesced view publication, and startup integration.
- `npx vitest run src/app/runtime src/app/hooks/useLayerTwoDocument.test.tsx src/app/hooks/useSourceFormatDiagnostics.test.tsx src/app/hooks/useDocumentValidator.test.tsx src/domain/document src/domain/formats src/app/workspace/workspaceRecoveryCoordinator.test.ts src/app/workspace/workspaceExternalChangeCoordinator.test.ts` -> 13 files, 76 tests passed.
- `npm run validate:large-document-stress` -> 1 file, 1 test passed; the 457,423-byte/900-section fixture, 3,200 structured records, parser/diagnostic/background/structured/export/capture/recovery steps passed; ignored report `tmp/large-document-stress/report-1784718341509.json`.
- `npm run validate:desktop-ui-performance -- --required` -> exit 0; rebuilt and exercised the sealed Windows release candidate through structured ingress, seven cold fixtures, five accepted native cancellations, five input samples, warm `A -> B -> A`, and all eight cumulative pressure documents. Warm attach p95 was `24.6 ms` (budget `250 ms`), accepted-to-visible p95 `52.9 ms` (budget `100 ms`), native cancellation p95 `16.0657 ms` (budget `500 ms`), pressure WebView heap `133,711,884` bytes (limit `805,306,368`), and pressure process-tree working set `715,223,040` bytes (limit `1,073,741,824`); warm activation acquired zero main-document bytes, active leases/queue/running counts returned to zero, and all semantic/content-free gates passed.
- `npx tsc --noEmit` -> exit 0.
- `git diff --check` -> exit 0 before closure-record edit and again after final roadmap reconciliation.

#### Generated outputs and candidate identity

The affected generator DAG was `validate:desktop-ui-performance` -> `build:desktop -- --no-bundle` -> `npm run build`/Vite plus Rust release build -> `src-tauri/target/release/sciemd.exe` -> `src/app/performance/documentPerformanceBaseline.windows.v1.json`. The generated baseline timestamp is `2026-07-22T11:05:22.077Z`; it records source manifest `c3a7dd9bd3037aae269b02b08919b8010cb98eeee8eb535f5edf891ebaf541e4`, executable SHA-256 `5cc1b7564a150e5ddfed681ade7300586b9d762d43c82226cc586c2f8dd42dad`, and has independently verified SHA-256 `87946680da3dbd9f3115ec3f956ecfddd9394c353ad50cb6958cef5b9015730f`. Independent `Get-FileHash` verification matched the executable. The baseline and roadmap are excluded from the recorded build-input manifest by the validator, so this closure edit does not invalidate the sealed candidate.

#### Remaining risks

The slowest 24 MiB cold first-editable sample remains `9,760.1 ms`, above the Round 1 observational `5,000 ms` cold target; Round 5's required warm, input, cancellation, memory, semantic, and source-acquisition gates pass, and the terminal Round 11 integrated matrix retains broad cold-load certification. Parser caches intentionally do not survive application restart, and Milkdown remains a measured bounded rebuild rather than exact-state warmth. These are declared deferred depths, not incomplete Round 5 closure obligations.

#### Non-goals preserved

Round 5 did not persist runtime/parser objects, take authority from recovery/watch/save coordinators, create a generic OS I/O scheduler, change the file-size ceiling, add or advertise YAML/TOML/XML writers, introduce the Round 6 structured mutation executor, redesign tabs, or change source typography. Round 6 implementation was not begun.

#### Proper closure statement

Round 5 is properly CLOSED.

#### Roadmap advancement

Round 6 is now the sole `OPEN` round. Rounds 1-5 are `CLOSED`; Rounds 7-11 remain `PLANNED`. This execution stops here without beginning Round 6.

### Round 6 - Canonical structured mutation authority and current-writer adoption - `CLOSED`

#### Status

`CLOSED` on 2026-07-22 (America/Toronto). Exact baseline/tree identity: Git `HEAD f28bb9cf7abeb504402f702e8d8a78bdf302e03a` plus build-input manifest SHA-256 `05224a46a92a253b7240f323b882eead10b7549ae91d3fae5b3628e9e3af60da` over 1,171 files. The integration tree remains intentionally dirty with preserved predecessor and Round 6 work; no staging, commit, push, or pull request was performed.

#### Outcome delivered

One registry-bound structured mutation protocol and one production executor now own every JSON, JSONL, CSV, and TSV visual edit from planner output through guarded source mutation, exact-plan review, authoritative post-patch parsing/validation, and atomic source-revision/journal acknowledgement. The former JSON-specific review authority and JSONL/tabular direct-commit bypass were removed rather than retained as parallel paths.

#### Contracts and decisions

- The checked-in version-1 operation matrix is keyed by format, node class, and operation and declares `enabled | review | source-only | unsupported`, planner, executor, review/destructive policy, and fixture identity. Effective capability intersects the matrix/catalog claim with planner availability, host write support, runtime parser/size policy, and node preservation evidence.
- Plans carry document ID/revision, `sha256:v1` source/result/validator/plan fingerprints, planner/adapter/policy versions, operation and transaction identity, guarded authorized spans, count/size limits, parse/schema postconditions, and exact untouched-region preservation evidence. The executor recomputes the plan seal and rechecks registry and authority immediately before commit.
- The reconciled review policy permits direct guarded JSON scalar and CSV/TSV cell replacement. All JSON structural edits, every JSONL record edit, and additive CSV/TSV row append require exact-plan approval; destructive flags remain explicit. Approval substitution or any source, revision, validator, version, span, limit, policy, or postcondition drift fails closed.
- JSON uses the authoritative parser plus the attached schema contract; JSONL and tabular edits use their authoritative parsers. The reducer applies the guarded change set and appends the journal entry in one immutable transition, exposing no accepted revision if either part is rejected. One history checkpoint is recorded before that single revision transition, preserving document-level undo/redo semantics.
- Unsupported/source-only behavior remains reasoned and source-reveal capable through existing operation surfaces. YAML, TOML, and XML visual writes remain disabled.

#### Production adoption

`App` routes production JSON tree/table/cards, JSONL record-list, CSV table, and TSV table intents through `createStructuredMutationPlan` and `executeStructuredMutation`. `AppOverlays` now mounts the generic structured review dialog for every reviewed format. `useDocumentSession` is the sole commit port and the document aggregate is the sole source/journal writer. The structured workflow validator invokes that same executor rather than manually resolving reviews.

#### Compatibility and migrations

Structured journal entries are version 2 and carry registry-derived format identity, operation/transaction identity, source revision, source fingerprint, and plan fingerprint. Workspace-manifest decoding migrates legacy entries deterministically, accepts current registered operations, and quarantines unknown future journal versions or unregistered current operations; forward/backward fixtures passed. Existing source buffers, saved documents, format extensions, public host contracts, and JSON/JSONL/CSV/TSV operation sets remain compatible. Deleted internal JSON-only review and bypass modules had no public export. No YAML/TOML/XML catalog write claim changed.

#### Changed-path manifest

- Canonical contracts/registry: `packages/core/src/formats/structured/structuredMutation.ts`, `structuredMutation.test.ts`, `structuredVisualOperationMatrix.v1.json`, `structuredEditReview.ts`, `structuredOperations.ts`, `structuredOperations.test.ts`, `packages/core/src/formats/formatDefinitions.ts`, and `packages/core/src/formats/index.ts`.
- Production executor and consumers: `src/app/structured/structuredMutationExecutor.ts`, `structuredMutationExecutor.test.ts`, `structuredMutationReview.ts`, `src/app/App.tsx`, `AppOverlays.tsx`, `structuredOperationRegistry.ts`, `structuredOperations.test.ts`, `src/components/StructuredEditReviewDialog.test.tsx`, and `src/components/InspectorPane.test.tsx`.
- Atomic acknowledgement and migration: `src/app/documentRecord.ts`, `documentRecord.test.ts`, `src/app/hooks/useDocumentSession.ts`, `src/app/structuredEditJournal.ts`, `structuredEditJournal.test.ts`, `src/services/persistence/workspaceManifestSchema.ts`, and `workspaceManifestSchema.test.ts`.
- Validation integration: `src/app/structuredWorkflowValidation.test.ts`, `scripts/audit-format-contributions.mjs`, and the deleted tracked files `src/app/performance/structuredReviewBypassCharacterization.ts`, `structuredReviewBypassCharacterization.test.ts`, `src/app/jsonEditReview.ts`, `jsonEditReview.test.ts`, `src/components/JsonEditReviewDialog.tsx`, and `JsonEditReviewDialog.test.tsx`. `scripts/validate-desktop-ui-performance.mjs` now ignores deleted tracked inputs while hashing a dirty build tree. This roadmap is the only documentation path changed for closure; no package or lockfile changed in Round 6.

#### Validation evidence

- `npx vitest run packages/core/src/formats/structured packages/core/src/formats/json packages/core/src/formats/jsonl packages/core/src/formats/tabular src/app/structured src/components/StructuredEditReviewDialog.test.tsx` -> 27 files, 196 tests passed. Coverage includes the operation matrix, sealed plans, exact review, all authority intersections, stale source/revision/document/validator failures, version/span/limit/postcondition tampering, schema rejection, commit rejection, and generic dialog decisions.
- `npm run validate:structured-workflows` -> 1 file, 7 tests passed across nine example files; the report includes `canonical-structured-mutation-executor` and reviewed save/reopen, stale/autosave, surface, regression, and external-conflict workflows.
- `npm run validate:format-contributions` -> exit 0; native picker/launch/Tauri/NSIS projections matched and the structured visual operation registry covered exactly JSON, JSONL, CSV, and TSV with no missing or unexpected claim.
- `npx vitest run src/app/documentRecord.test.ts src/app/structuredEditJournal.test.ts src/services/persistence/workspaceManifestSchema.test.ts src/services/workspaceManifestService.test.ts src/components/InspectorPane.test.tsx src/app/structuredWorkflowValidation.test.ts src/app/structuredOperations.test.ts` -> 7 files, 40 tests passed, covering aggregate/journal atomicity and persistence compatibility in addition to production workflow adoption.
- `npx tsc --noEmit` -> exit 0.
- `npm run build` -> exit 0; TypeScript and Vite production build completed with 4,603 modules transformed. The existing chunk-size warning remains non-blocking and unchanged in kind.
- `git diff --check` -> exit 0 before this closure record; rerun after roadmap reconciliation also passed.

#### Generated outputs and candidate identity

The affected checked-in projection is `packages/core/src/formats/structured/structuredVisualOperationMatrix.v1.json`, SHA-256 `a581212aa7a04347faa78f3a6b1e052342508272ac0d320766e3e6adc85d17fb`; contribution validation consumed it directly. The final ignored structured-workflow report is `tmp/structured-workflows/report-1784720121329.json`, SHA-256 `006f0d9eab3a6eb6c2f9edd6f012772a3c304cc13f7f165714f254af5ad06634`. Vite regenerated ignored `dist/` assets. Round 6 does not own a packaged desktop baseline or sealed executable; its exact candidate identity is the `HEAD` plus build-input manifest recorded in Status, with this roadmap and the pre-existing performance baseline excluded by the established identity rule.

#### Remaining risks

The executor deliberately supports only the existing JSON/JSONL/CSV/TSV operation set. The matrix schema is ready for `source-only` and `unsupported` rows, but YAML/TOML/XML preservation corpora and operation rows are deliberately deferred to Rounds 7-9. Journal durability continues through the existing recovery-first workspace publication pipeline; the round made source/journal aggregate acknowledgement indivisible and treats a rejected commit port as unacknowledged, without introducing a second persistence subsystem.

#### Non-goals preserved

Round 6 did not add or advertise YAML, TOML, or XML writers; regenerate structured documents wholesale; materially expand current JSON/JSONL/tabular operations; change file-size ceilings, host/public extension contracts, save/recovery ownership, tabs, or typography; or begin Round 7 implementation.

#### Proper closure statement

Round 6 is properly CLOSED.

#### Roadmap advancement

Round 7 is now the sole `OPEN` round. Rounds 1-6 are `CLOSED`; Rounds 8-11 remain `PLANNED`. This execution stops here without beginning Round 7.

### Round 7 - YAML CST-backed source-preserving visual editing - `CLOSED`

#### Status

`CLOSED` on 2026-07-22 (America/Toronto). Exact baseline/tree identity: Git `HEAD f28bb9cf7abeb504402f702e8d8a78bdf302e03a` plus build-input manifest SHA-256 `987c3103261e4a6ef317db134fd145edad0304b589f21d18ea3e660655ef99fb` over 1,173 files, using the established candidate rule that excludes this roadmap and the pre-existing desktop performance baseline. The integration tree remains intentionally dirty with preserved predecessor and Round 7 work; no staging, commit, push, or pull request was performed.

#### Outcome delivered

The production YAML tree is now usefully editable through CST/source-token-owned, review-required patches without whole-document regeneration. Scalar replacement, simple-key rename, scalar block-mapping add/delete, block-sequence scalar append, and unambiguous sequence-item delete reach the shared Round 6 executor; the tree exposes only the supported operations for each node and gives source-mode reasons for exclusions.

#### Contracts and decisions

- `document.toJS()` remains projection-only. `yamlEdits.ts` resolves the selected path back to unique CST nodes and source tokens, rejects stale/invalid/oversized input, and emits one narrow guarded patch. Plain/single/double scalar style is retained when representable; a necessary quoted-style change produces an explicit preservation warning in review.
- All six registered YAML operations are `review`/`required`. No YAML direct-write path exists. The shared plan contains SHA-256 source/result/validator/plan seals, revision/document identity, planner/adapter/policy versions, expected-old-text guards, bounded non-overlapping patches, exact untouched-region enforcement, authoritative YAML reparse, and YAML operation-specific semantic assertions rechecked immediately before commit.
- Source-map nodes carry operation-level capabilities. Comment-owned delete spans, final-item/final-field container changes, non-append sequence insertion, and non-scalar insertion are not advertised. Aliases, anchors, tags, merges, flow collections, block scalars, complex/non-local nodes, directives, multi-document streams, duplicate keys, invalid input, and input above 1 MiB fail closed with actionable source-mode diagnostics.
- Single document markers, comments outside the authorized token, indentation, quotes, blank lines, Unicode, CRLF, scalar spellings, directives outside supported plans, and every untouched node remain byte-for-character exact. The JSON preview remains read-only and has no mutation authority.

#### Production adoption

`AppEditorStage` passes eligible production YAML tree intents through the generic `JsonTreeView` operation controls to `App.applyYamlVisualEdit`. That handler invokes `planYamlVisualEdit`, creates a shared structured transaction/review, and reaches `executeStructuredMutation`; `useDocumentSession` remains the sole atomic source/journal commit port. `InspectorPane` reports YAML journal identity and consumes the same source-map preservation blockers/reasons. The example-corpus workflow exercises this production executor and reparses the saved/reopened YAML meaning.

#### Compatibility and migrations

The format catalog now advertises YAML `structuredTree` as editable only alongside its six registry rows and production handler. YAML adapter policy changes from lossy read-only to format-preserving/exact-source for eligible nodes; TOML and XML remain unchanged. Structured journal schema stays version 2; its decoder now accepts current YAML entries while legacy migration behavior and unknown-operation quarantine remain intact. No native command, public extension contract, package dependency, lockfile, file association, source-size ceiling, or stored workspace schema version changed.

#### Changed-path manifest

- YAML planner, source map, adapter, parse presentation, exports, and fixtures: `packages/core/src/formats/yaml/yamlEdits.ts`, `yamlEdits.test.ts`, `yamlSourceMap.ts`, `yamlSourceMap.test.ts`, `yamlAdapter.ts`, `parseYamlDocument.ts`, `parseYamlDocument.test.ts`, and `packages/core/src/formats/index.ts`.
- Shared contracts, registry, catalog, and semantic postconditions: `packages/core/src/formats/documentFormat.ts`, `formatCatalog.v1.json`, `structured/structuredVisualOperationMatrix.v1.json`, `structuredMutation.ts`, `structuredMutation.test.ts`, `structuredEditReview.ts`, `structuredValue.ts`, and `structuredAnalysisModel.test.ts`.
- Production consumers and compatibility: `src/app/App.tsx`, `AppEditorStage.tsx`, `AppEditorStage.test.tsx`, `formatCapabilities.ts`, `formatCapabilities.test.ts`, `structured/structuredMutationExecutor.ts`, `structuredMutationExecutor.test.ts`, `structuredEditJournal.ts`, `structuredEditJournal.test.ts`, `structuredWorkflowValidation.test.ts`, `src/components/JsonTreeView.tsx`, `JsonTreeView.test.tsx`, and `InspectorPane.tsx`.
- Superseded preservation policy and closure documentation: `docs/refactor/source_preservation_adapter_contract.md`, `yaml_toml_preservation_decision.md`, `yaml_source_preservation_evaluation.md`, and this roadmap. No package or lockfile changed in Round 7.

#### Validation evidence

- `npx vitest run packages/core/src/formats/yaml packages/core/src/formats/structured src/app/structured src/app/AppEditorStage.test.tsx src/components/InspectorPane.test.tsx` -> 22 files, 155 tests passed. Coverage includes all registered YAML operations, scalar styles, exact comments/whitespace/CRLF/Unicode preservation, EOF insertion, stale hash, invalid/oversized/duplicate/multi-document/directive rejection, advanced-syntax gating, executor approval/seals/semantic checks, and the production editor-stage callback.
- `npm run validate:structured-workflows` -> 1 file, 7 tests passed across nine example files; reviewed YAML mutation reached the production executor, retained its document marker/comments/anchor syntax, reparsed with the requested meaning, and joined save/reopen, stale/autosave, surface, regression, and external-conflict workflows.
- `npm run validate:format-contributions` -> exit 0; native picker/launch/Tauri/NSIS projections matched and the structured registry covered exactly JSON, JSONL, CSV, TSV, and YAML with no missing or unexpected claim.
- `npx vitest run src/components/JsonTreeView.test.tsx src/app/structuredEditJournal.test.ts` -> 2 files, 37 tests passed, including operation-level YAML presentation, YAML review labeling, comment-owned delete suppression, and version-2 journal compatibility.
- `npx tsc --noEmit` -> exit 0.
- `npm run build` -> exit 0; TypeScript and Vite production build completed with 4,604 modules transformed. The existing chunk-size warning remains non-blocking and unchanged in kind.
- `git diff --check` -> exit 0 before this closure edit; rerun after final roadmap reconciliation also passed.

#### Generated outputs and candidate identity

The affected checked-in projection is `packages/core/src/formats/structured/structuredVisualOperationMatrix.v1.json`, SHA-256 `3d40be2cf99b9627f4cc5d37a59c5b51ba5da3bfe0b128463bba3d7100b7497c`; contribution validation consumed the YAML rows directly. The final ignored structured-workflow report is `tmp/structured-workflows/report-1784721905604.json`, SHA-256 `006f0d9eab3a6eb6c2f9edd6f012772a3c304cc13f7f165714f254af5ad06634`. Vite regenerated ignored `dist/` assets. Round 7 does not own a packaged desktop executable or performance baseline; its exact candidate is the `HEAD` plus build-input manifest recorded in Status.

#### Remaining risks

The safe subset deliberately excludes YAML identity/reference features, tagged values, flow punctuation, block-scalar style/chomping, complex keys, empty-container construction, collection-valued insertion, positional sequence insertion/reorder, deleting the last container member, multi-document streams, and deletion where comment ownership is ambiguous. YAML schema attachment is not implemented, so the validator seal binds the current no-schema policy; a future schema feature must change that fingerprint and add schema postconditions. These are explicit later depths, not hidden Round 7 obligations.

#### Non-goals preserved

Round 7 did not implement or prepare the native `toml_edit` writer, XML mutation, tab chrome, source typography, broad terminal certification, whole-document YAML serialization, a second commit writer, new native commands, package changes, or a file-size increase. TOML and XML remain visually read-only, and Round 8 implementation was not begun.

#### Proper closure statement

Round 7 is properly CLOSED.

#### Roadmap advancement

Round 8 is now the sole `OPEN` round. Rounds 1-7 are `CLOSED`; Rounds 9-11 remain `PLANNED`. This execution stops here without beginning Round 8.

### Round 8 - Native `toml_edit` source-preserving visual editing - `CLOSED`

#### Status

`CLOSED` on 2026-07-22 (America/Toronto). Exact baseline/tree identity: Git `HEAD f28bb9cf7abeb504402f702e8d8a78bdf302e03a` plus build-input manifest SHA-256 `72a5383b2d11b5704fe08a1eaaef25193b6dd16ea76a51bae432a84eeabfa325` over 1,179 files, using the established rule that excludes this roadmap and the pre-existing desktop performance baseline. The shared integration tree remains intentionally dirty with preserved predecessor work; no staging, commit, push, or pull request was performed.

#### Outcome delivered

Desktop TOML now has one native `toml_edit` inspection and mutation authority. The first production consumers--the TOML structured tree, navigation, Inspector, external-conflict review, and visual edit handler--consume the native identity and route supported scalar, bare-key, scalar-table-field, and scalar-array operations through guarded review, the shared Round 6 executor, the document aggregate, and normal atomic save. Unsupported syntax and hosts remain source-editable with explicit source-only reasons.

#### Contracts and decisions

The versioned `toml-native-dto-v1` / `toml-edit-native-v1` boundary returns semantic value, UTF-16 source/key/value spans, per-node operations, content-free diagnostics, one guarded patch, preservation evidence, and the planned next value/source. Native code has no file-write authority. Scalar replacement and bare-key rename use authoritative native spans; safe collection changes use `DocumentMut`, preserve uniform CRLF, and are accepted only after parse and semantic postconditions. The shared executor still owns authorized spans/counts, collision-resistant source identity, document/revision identity, planner/adapter/policy/validator versions, review approval, and aggregate commit. Dotted keys, inline tables, arrays of tables, multiline strings, date/time scalars, decorated keys, comment-owned deletion, non-scalar insertion, and mixed-line-ending structural edits retain explicit source-only status. The former TypeScript TOML line scanner was removed. `smol-toml` remains only as a declared non-authoritative portable preview and executor defense-in-depth parser; it does not plan desktop edits or source maps. One primary writer owned the native DTO, host port, registry/matrix, barrels, command registration, and production cutover.

#### Production adoption

`plan_toml_mutation` and native inspection are registered Tauri commands consumed through `desktopDocumentHost` and `tomlNativeService`. `useSourceFormatDiagnostics` supplies the native report to the desktop artifact/structured path; `App`, `AppEditorStage`, `JsonTreeView`, `InspectorPane`, and the capability intersection expose only native-proven operations. Native conflict inspection replaces the old scanner in the external-change workflow. `structuredMutationExecutor` revalidates and commits TOML transactions, and the packaged `toml-structured-edit` scenario proves native plan -> shared executor -> aggregate -> ordinary save/reopen while comparing raw disk bytes before the save.

#### Compatibility and migrations

No public document format, file, workspace-schema, or native persistence migration was required. Structured journal version 2 now accepts TOML transactions without invalidating existing entries. Desktop hosts declare `tomlNativePlanning`; hosts without it remain visually read-only while retaining freeform source editing. Existing TOML files, including invalid or future syntax, are never normalized merely by opening or inspecting them. The fixture corpus passes for comments/decor, dotted keys, inline tables, arrays of tables, multiline strings, date/time values, duplicate invalid input, Unicode, LF, and uniform CRLF. Native errors remain typed and content-free.

#### Changed-path manifest

- Native production and packaged proof: `src-tauri/src/commands/toml_source_map.rs`, `src-tauri/src/lib.rs`, and `src-tauri/tests/toml_preservation_spike.rs`.
- Shared contracts and projections: `packages/core/src/formats/documentFormat.ts`, `formatCatalog.v1.json`, `formatDefinitions.ts`, `formatPolicy.ts`, `index.ts`, `toml/parseTomlDocument.ts`, `toml/tomlAdapter.ts`, new `toml/tomlNative.ts`, `structured/structuredEditReview.ts`, `structured/structuredExternalConflict.ts`, `structured/structuredMutation.ts`, `structured/structuredOperations.ts`, `structured/structuredValue.ts`, and `structured/structuredVisualOperationMatrix.v1.json`.
- Desktop integration: `src/services/tomlNativeService.ts`, `src/app/App.tsx`, `AppEditorStage.tsx`, `formatCapabilities.ts`, `structuredEditJournal.ts`, `structuredOperationRegistry.ts`, `structured/structuredMutationExecutor.ts`, `host/documentHost.ts`, `host/desktopDocumentHost.ts`, `hooks/useSourceFormatDiagnostics.ts`, `hooks/useExternalConflictReviewWorkflow.ts`, `workspace/workspaceExternalChangeCoordinator.ts`, `workspace/workspaceShellProjection.ts`, `components/JsonTreeView.tsx`, and `components/InspectorPane.tsx`.
- Tests and fixtures: the paired tests beside those shared/desktop modules, new `src/app/structured/tomlNativeIntegration.test.ts`, and `docs/refactor/toml_preservation_fixtures/unicode-and-datetime.toml`.
- Validation and documentation: `package.json`, `scripts/validate-desktop-structured-edit.mjs`, `scripts/validate-tauri-command-contract.mjs`, `scripts/audit-format-contributions.mjs`, `docs/refactor/source_preservation_adapter_contract.md`, `toml_source_preservation_evaluation.md`, and `yaml_toml_preservation_decision.md`. No package or lockfile changed.

#### Validation evidence

- `cargo test --manifest-path src-tauri/Cargo.toml toml` -> 6 native unit tests and 8 TOML preservation integration tests passed; 0 failed.
- `cargo test --manifest-path src-tauri/Cargo.toml --test toml_preservation_spike` -> 8 passed, 0 failed.
- `npx vitest run packages/core/src/formats/toml packages/core/src/formats/structured src/app/structured src/services/fileService.test.ts src/app/AppEditorStage.test.tsx src/components/InspectorPane.test.tsx` -> 23 files, 161 tests passed.
- `npm run validate:tauri-contract` -> passed; 60 registered commands cover 58 TypeScript invokes.
- `npm run validate:structured-workflows` -> 1 file, 7 tests passed across nine examples and all seven required workflow labels.
- `npm run validate:format-contributions` -> passed; native picker/launch/Tauri/NSIS projections agree and the structured registry is exactly JSON, JSONL, CSV, TSV, YAML, and TOML.
- `npm run validate:desktop-structured-edit -- --format toml --required` -> 1 shared-executor integration test passed and the packaged release executable reported native plan, shared executor, aggregate save, and no native direct write.
- `npx tsc --noEmit` -> exit 0.
- `npm run build:desktop` -> exit 0; Vite transformed 4,606 modules, Rust release built, and MSI plus NSIS bundles were produced. The existing chunk-size warning remains non-blocking and unchanged in kind.
- `git diff --check` -> exit 0 before closure editing and again after final roadmap reconciliation.

#### Generated outputs and candidate identity

The affected checked-in projection is `packages/core/src/formats/structured/structuredVisualOperationMatrix.v1.json`, SHA-256 `994efc2437e484d7497f6316cae286ac139c7f72453922ffcb6b04acee6dad71`; contribution validation consumed its six TOML rows. The final ignored structured-workflow report is `tmp/structured-workflows/report-1784724059098.json`, SHA-256 `006f0d9eab3a6eb6c2f9edd6f012772a3c304cc13f7f165714f254af5ad06634`. The candidate DAG is `build:desktop` -> TypeScript/Vite + Rust release -> `src-tauri/target/release/sciemd.exe` -> MSI/NSIS bundles -> packaged TOML validation. Independent hashes are executable `7bd8ff5fb09ad9e3e890492455c6f20368811bb48f2b398e3d25a5de8655cb6b`, MSI `bce0dbef16c4dcd820779fbcb09063d871e9ff91ca86ac5bc562408bc4712efe`, and NSIS `07b14d790c5a206fda7080cdf9fb0cb05c383cd60bfc091b1e90b64b96032641`. Ignored `dist/` was regenerated; no desktop performance baseline was affected.

#### Remaining risks

Advanced TOML constructs deliberately remain source-only until operation-specific preservation is proven. Browser and VS Code hosts do not receive a substitute writer and therefore retain source editing with read-only visual TOML. Broader XML editing, tab/chrome work, typography, and terminal wave certification remain assigned to Rounds 9-11; none is required for this independently closable native TOML outcome.

#### Non-goals preserved

Round 8 did not implement or prepare XML mutation, tab information architecture, IBM Plex Mono/source typography, broad terminal certification, arbitrary TOML serialization, native direct save authority, a second commit writer, browser/extension emulation of `toml_edit`, new file-size policy, or unrelated package/dependency changes.

#### Proper closure statement

Round 8 is properly CLOSED.

#### Roadmap advancement

Round 9 is now the sole `OPEN` round. Rounds 1-8 are `CLOSED`; Rounds 10-11 remain `PLANNED`. This execution stops here without beginning Round 9.

### Round 9 - Namespace-aware XML source-preserving visual editing - `CLOSED`

#### Status

`CLOSED` on 2026-07-22 (America/Toronto). Exact baseline/tree identity: Git `HEAD f28bb9cf7abeb504402f702e8d8a78bdf302e03a` plus build-input manifest SHA-256 `aab089071d675b7dd6c36d72299e9f8cb60dc9e806f01b5bfb4a9073bc41a705` over 1,183 files, using the established rule that excludes this roadmap and the pre-existing desktop performance baseline. The shared integration tree remains intentionally dirty with preserved predecessor work; no staging, commit, push, or pull request was performed.

#### Outcome delivered

XML visual mode now offers reviewed, source-preserving replacement for ordinary attribute values and sole non-whitespace element text. Namespace-aware identities, exact guarded spans, context-correct escaping, fail-closed security, and source-only reasons reach the production XML structured tree, navigation, Inspector/source reveal, external-conflict review, shared mutation executor, document aggregate, history, save, and reopen paths.

#### Contracts and decisions

The Lezer CST remains authoritative and now projects node kind, qualified/local name, namespace URI/context, key/value spans, editable operations, and explicit unsupported reasons for elements, attributes, namespace declarations, text, comments, CDATA, processing instructions, entities, DTDs, and the document. The frozen XML matrix contains one `review` operation, `replaceScalar`, for entity-free ordinary attributes and sole non-whitespace text. Attribute edits preserve their quote delimiter and reject normalization-prone tabs/newlines; text edits escape XML metacharacters without whole-document serialization. Every candidate reparses, rejects undeclared/reserved namespace bindings, preserves element/attribute expanded identity, verifies requested logical content, and enters the full Round 6 fingerprint/version/span/count/validator/semantic-postcondition envelope. No structural add/delete/rename was enabled because no structural case met the round's fixture-proven unambiguous-layout requirement; this is the declared gate, not deferred infrastructure. One primary writer retained ownership of the shared registry, catalog, barrels, planner, policy, and integration spine.

#### Production adoption

`App.applyXmlVisualEdit` plans XML intent and submits the resulting transaction to `structuredMutationExecutor`; `AppEditorStage` and `JsonTreeView` expose only source-map-approved XML actions and retain source reveal for protected nodes. `InspectorPane` consumes the same structured analysis. XML is advertised by the format catalog and shared operation matrix, journal version 2 accepts XML records, the document aggregate remains the sole commit writer, and source-mapped XML conflicts use the shared external-conflict review with mixed/risky cases falling back safely.

#### Compatibility and migrations

No document, workspace, public API, native persistence, extension, package, or lockfile migration was required. Existing XML source remains authoritative and is never normalized on open or edit. The former blanket read-only policy is superseded only for the registered scalar subset; invalid, oversized, DTD-bearing, entity-sensitive, mixed-content, whitespace-only, namespace-declaration, CDATA, comment, and processing-instruction cases retain source editing and explicit visual source-only behavior. Structured journal schema version 2 accepts XML without changing legacy migration semantics. The namespace-rebinding/mixed-content and general/parameter external-entity fixtures pass with zero resolver/network access.

#### Changed-path manifest

- XML production contracts and planner: `packages/core/src/formats/documentFormat.ts`, `formatCatalog.v1.json`, `index.ts`, `xml/parseXmlDocument.ts`, `xml/xmlAdapter.ts`, new `xml/xmlEdits.ts`, `structured/structuredEditReview.ts`, `structured/structuredExternalConflict.ts`, `structured/structuredMutation.ts`, and `structured/structuredVisualOperationMatrix.v1.json`.
- Desktop production integration: `src/app/App.tsx`, `AppEditorStage.tsx`, `structuredEditJournal.ts`, `structured/structuredMutationExecutor.ts`, and `src/components/JsonTreeView.tsx`.
- Tests and fixtures: paired tests for the paths above, `src/app/formatCapabilities.test.ts`, `structuredWorkflowValidation.test.ts`, and new `docs/refactor/xml_preservation_fixtures/namespace-rebinding-mixed.xml` plus `external-entities.invalid.xml`.
- Documentation: `docs/refactor/xml_readonly_adapter_policy.md`, `source_preservation_adapter_contract.md`, and this roadmap. No generated native projection, package, lockfile, or extension path changed.

#### Validation evidence

- `npx vitest run packages/core/src/formats/xml packages/core/src/formats/structured src/app/structured src/app/AppEditorStage.test.tsx src/components/InspectorPane.test.tsx` -> 22 files, 162 tests passed; 0 failed.
- `npm run validate:structured-workflows` -> 1 file, 7 tests passed across nine examples and all seven workflow labels, including reviewed XML save/reopen, exact undo/redo, and source-mapped external conflict.
- `npm run validate:format-contributions` -> passed; native picker/launch/Tauri/NSIS projections agree and the structured registry is exactly JSON, JSONL, CSV, TSV, YAML, TOML, and XML.
- `npm run build` -> exit 0; TypeScript passed and Vite transformed 4,607 modules. The existing chunk-size warning remains non-blocking and unchanged in kind.
- `npx tsc --noEmit` -> exit 0.
- `git diff --check` -> exit 0 before closure editing and again after final roadmap reconciliation.

#### Generated outputs and candidate identity

The affected checked-in projection is `packages/core/src/formats/structured/structuredVisualOperationMatrix.v1.json`, SHA-256 `2cd55921c2582818c1cc43f41c05a4f7996086eb995640762f4d373217d30b7e`; contribution validation consumed its XML row directly. The final ignored structured-workflow report is `tmp/structured-workflows/report-1784726070095.json`, SHA-256 `006f0d9eab3a6eb6c2f9edd6f012772a3c304cc13f7f165714f254af5ad06634`. `npm run build` regenerated ignored `dist/` output. Round 9 owns no packaged executable, native generator, or performance baseline; its exact candidate is the `HEAD` plus build-input manifest recorded in Status.

#### Remaining risks

Structural XML operations and edits to mixed content, significant whitespace, CDATA, comments, processing instructions, namespace declarations, or entity-bearing values remain source-only pending operation-specific preservation proof. XML schema/XSD/DTD/XPath/XSLT/canonicalization remain outside scope. Tab/chrome redesign, IBM Plex Mono adoption, and terminal wave certification remain assigned to Rounds 10-11.

#### Non-goals preserved

Round 9 did not introduce DOM serialization, whole-document XML regeneration, entity resolution, filesystem/network access, DTD support, a second writer, native XML mutation, blanket XML editability, tab/chrome work, source typography changes, broad terminal certification, package changes, or any Round 10-11 implementation.

#### Proper closure statement

Round 9 is properly CLOSED.

#### Roadmap advancement

Round 10 is now the sole `OPEN` round. Rounds 1-9 are `CLOSED`; Round 11 remains `PLANNED`. This execution stops here without beginning Round 10.

### Round 10 - Adaptive modern workspace tab strip - `CLOSED`

#### Status

`CLOSED` on 2026-07-22 (America/Toronto). Exact baseline/tree identity: Git `HEAD f28bb9cf7abeb504402f702e8d8a78bdf302e03a` plus build-input manifest SHA-256 `cbc60c72679f65cbf89ca2e1c00d9b4a2b30dcb5ebf76e1995da3fdff8baba3a` over 1,188 files, using the established exclusion of this roadmap and the generated desktop performance baseline. The shared integration tree remains intentionally dirty with preserved predecessor work; no staging, commit, push, or pull request was performed.

#### Outcome delivered

The desktop document workspace now uses a compact one-row adaptive tab strip with distinguishable duplicate/long names, semantic icons, prioritized status, deterministic focus/activation, measured overflow, searchable navigation, context actions, pointer/keyboard reorder, stable inactive panel shells, and explicit frameless-window hit regions. `WorkspaceTabStrip`, `WorkspaceShell`, and the packaged Tauri window are the first production consumers.

#### Contracts and decisions

`TabPresentation` is React-free and carries filename/visible fragment, shortest unique qualifier, semantic icon ID, one prioritized visual state, every accessible lifecycle state, accessible name, and tooltip. Visual priority is danger/conflict, blocked availability, progress, dirty, read-only, then ready. Round 5's 24.6 ms warm p95 is below 100 ms, so automatic arrow/Home/End activation is frozen for the whole tablist independent of cache state. Sibling close controls, roving focus, `Delete`, active-tab `Ctrl+F4`, `Shift+F10`, and `Alt+Shift+Left/Right` delegate to existing workspace commands. Only positively marked empty chrome may drag/toggle maximize. Dedicated `--tab-*` tokens cover existing styles, forced colors, reduced motion, responsive density, and coarse pointers.

#### Production adoption

`App` projects the live workspace; `AppWorkbench` mounts the real strip and passes its model to `WorkspaceShell`. The shell renders one uniquely linked lightweight panel per document, hides/empties inactive panels, and mounts the sole heavyweight editor only in the active panel. Save All, Reopen Closed, and accurately named MRU navigation are in the workspace-more menu and production command palette. `ContextMenuCard` owns actions; `AppTopbar` and `useWindowChrome` own the positive native hit region.

#### Compatibility and migrations

No stored document, workspace, recovery, public format, native command, extension, package, or lockfile migration was required. Document/write authority, dirty-close/save/recovery policy, last-tab blank replacement, zero-read warm activation, persistence, and VS Code-owned tabs are unchanged. The former internal tab-model shape and invisible native select were replaced atomically with every desktop consumer and fixture.

#### Changed-path manifest

- Contracts/integration: `src/app/workspace/workspaceTabs.ts`, `src/app/WorkspaceTabStrip.tsx`, `src/app/WorkspaceShell.tsx`, `src/app/AppWorkbench.tsx`, and `src/app/App.tsx`.
- Commands/chrome: `src/app/appCommands.ts`, `src/app/hooks/useAppCommands.ts`, `src/app/hooks/useAppCommandRegistry.ts`, `src/components/AppTopbar.tsx`, and `src/app/hooks/useWindowChrome.ts`.
- Tokens/tests: `src/styles/app.shell.css`, tab/workbench/command/chrome/accessibility tests, including new `src/app/WorkspaceTabStrip.test.tsx`.
- Validation/evidence: `package.json`, new `scripts/validate-tab-visuals.mjs`, `tab-visual-harness.html`, `src/app/workspace/tabVisualHarness.tsx`, `src/app/workspace/tabVisualFixture.v1.json`, `scripts/validate-desktop-ui-performance.mjs`, generated `src/app/performance/documentPerformanceBaseline.windows.v1.json`, ignored tab PNG, plus this roadmap.

#### Validation evidence

- `npx vitest run src/app/workspace/workspaceTabs.test.ts src/app/WorkspaceTabStrip.test.tsx src/app/AppWorkbench.test.tsx src/components/AppTopbar.test.tsx src/app/hooks/useWindowChrome.test.tsx src/components/accessibilityAxe.test.tsx`: 6 files, 34 tests passed; 0 failed.
- `npx vitest run src/app/appCommands.test.ts src/app/hooks/useAppCommands.test.tsx`: the existing filter resolved 1 file, 4 tests passed; 0 failed.
- `npm run validate:ux`: passed production shell, command-palette, readiness, slash-menu, and tab/panel checks.
- `npm run validate:desktop-ui-performance -- --required`: passed packaged Windows cold/warm/input/cancellation/zero-read/memory and drag/maximize/control-exclusion gates; warm samples 16.7/14.0/13.7/14.0/14.3 ms; heap 101,390,517 bytes; working set 111,386,624 bytes; pressure tree 712,957,952 bytes.
- `npm run validate:tab-visuals -- --required`: passed rendered 1/2/12/30/60-tab, 100%/200% zoom, forced-colors, reduced-motion, geometry, target, accessibility-tree, active-reveal, and deterministic screenshot checks; pixel difference 0 within 0.01.
- `npx tsc --noEmit`: exit 0. `npm run build`: exit 0, 4,607 modules. `git diff --check`: exit 0 before closure editing.

#### Generated outputs and candidate identity

Checked-in fixture `round10-dense-tabs-jetbrains-mono-v1` (1440 x 900, DPR 1, current JetBrains Mono) SHA-256: `08044c7bfcd97d6ad0c0a0273bb0f1331f3ddb28ebafac5306a65765d9ef9228`. Generated ignored PNG SHA-256: `588cd26847417947f49964cbc1731a47cfde5b34c4f00949d3b89a43c2324149`. Packaged `sciemd.exe` SHA-256: `48eef1c93d6e992d23d738cb6ffee1da9775a12f9de35d016908feb87c74589d`. Generated performance baseline SHA-256: `3a847f50d99aa31d7fafb7ba54fd5980044a51403b7402d8bb4b5eb6654e100d`, recording the same source manifest. Ignored `dist/` was rebuilt; no other generator DAG was affected.

#### Remaining risks

Round 11 intentionally re-runs geometry after IBM Plex Mono; pixel-identical carry-forward is not required. The open-tabs list renders all 60 lightweight rows, bounded by this round's certified density. Broad merge/package/installed-VSIX convergence remains Round 11's terminal obligation.

#### Non-goals preserved

Round 10 did not change document/write authority, save/recovery/close policy, persistence/migrations, format routing, cache semantics, extension tabs, source typography, IBM Plex assets, terminal certification, or any Round 11 implementation.

#### Proper closure statement

Round 10 is properly CLOSED.

#### Roadmap advancement

Round 11 is now the sole `OPEN` round. Rounds 1-10 are `CLOSED`; no following round remains `PLANNED`. This execution stops here without beginning Round 11.

### Round 11 - IBM Plex Mono source typography - `CLOSED`

#### Status

`CLOSED` on 2026-07-22 (America/Toronto). Exact baseline/tree identity: Git `HEAD f28bb9cf7abeb504402f702e8d8a78bdf302e03a` plus build-input manifest SHA-256 `a3b5ce28ccffa7ed04b231051e3aa73c792e65651c015e03fa86ec0d5b3330cc` over 1,207 files. Candidate and final identities are identical under the declared exclusion of this roadmap, the certification JSON, and the generated desktop performance baseline. The shared integration tree remains intentionally dirty with preserved predecessor work; no staging, commit, push, or pull request was performed.

#### Outcome delivered

Desktop source editing now uses IBM Plex Mono in every visual style through one source-only token, while general code/document typography is unchanged. Desktop CodeMirror and the raw-source fallback are the first production consumers. VS Code Markdown source preserves the configured host editor font and uses the same packaged IBM family only as fallback. The terminal wave DAG certified all eleven rounds against the exact production artifacts built by that run.

#### Contracts and decisions

- `--source-editor-font: "IBM Plex Mono", monospace` is declared once outside visual-style overrides and is applied directly to CodeMirror editor/content plus raw fallback; no `--mono-font` consumer was migrated.
- The authoritative assets are pinned IBM Plex Mono `2.5.0` regular, italic, medium, and bold faces under `public/fonts/vendor/ibm-plex-mono`; the extension mirror is generator-owned and hash-identical.
- IBM Plex Mono does not contain the required Greek block. The justified coverage deviation is a pinned Noto Sans Mono `5.2.10` Greek-only supplemental face under the same CSS family and a non-overlapping `unicode-range`; IBM remains authoritative for all of its covered glyphs. Both OFLs, provenance, hashes, glyph coverage, CSS URLs, and mirrors are verified.
- Desktop and extension editors await `document.fonts.ready`, request a CodeMirror remeasure, expose loaded/fallback evidence, and remain editable with generic monospace after a load failure. The packaged performance probe verified `document.fonts.load`, `FontFace.status`, computed `.cm-content`, emitted WOFF2 resources, and offline/CSP loading.
- The VS Code override remains `var(--vscode-editor-font-family, "IBM Plex Mono", monospace)` for Markdown source only; structured previews retain their existing host/technical typography.
- The non-recursive terminal orchestrator owns the generator/test/build/package DAG, checkpoints only exact-tree successes, and executed desktop build, VSIX package build, installed-VSIX smoke, and packaged performance exactly once.
- Ordinary convergence repairs stayed within existing obligations: YAML/XML expectations were aligned with their closed preservation policies; the native text-read metadata was boxed without changing its serde wire contract; and Windows atomic replace now uses the established synced-sibling fallback for provider error 1175 as well as cross-device error 17.

#### Production adoption

- Desktop `SourceTextEditor`, Markdown source editor, and raw structured-source fallback consume the dedicated font token and post-load remeasure path.
- The shipped Tauri executable, MSI, and NSIS installer contain and load the authoritative desktop faces.
- The installed VSIX Markdown custom editor consumes host-font precedence plus the generated IBM/Noto fallback assets; its structured tree/preview remains outside the migration.
- About dialogs, font/license inventories, package validation, performance smoke, and dense-tab visual baselines consume the final font identity.

#### Compatibility and migrations

No stored document, workspace, recovery, public format, native command, extension setting, or file-format migration was introduced. Source characters, offsets, selections, undo/history, cursor-line/scroll-anchor restoration, clipboard, save/recovery/close authority, warm activation, and structured mutation authority remain unchanged. Package/lock changes pin only the font inputs and verification tooling. The native boxed metadata is wire-compatible; the Windows provider fallback preserves atomic same-volume replacement. Generated desktop and extension assets and both OFLs pass hash/package/license checks.

#### Changed-path manifest

- Packages/generators/assets: `package.json`, `package-lock.json`, `scripts/fonts/sync-ibm-plex-mono.mjs`, `scripts/fonts/verify-ibm-plex-mono.mjs`, `public/fonts/vendor/ibm-plex-mono/**`, and generated `scie-md-vscode-extension/src/scie-md/styles/fonts/vendor/ibm-plex-mono/**`.
- Desktop production/tests: `src/styles/app.tokens.css`, `src/styles/app.source-editor.css`, `src/styles/app.panels.css`, `src/components/SourceTextEditor.tsx`, `src/components/SourceMarkdownEditor.tsx`, their tests, `src/styles/fontLicensing.test.ts`, `src/components/AboutDialog.tsx`, and `src/app/workspace/tabVisualFixture.v1.json`.
- Extension production/tests: mirrored token/source/panel CSS, `scie-md-vscode-extension/src/webview/styles.css`, `src/webview/main.tsx`, `SourceMarkdownEditor.tsx`, About/README surfaces, and source/style tests.
- License/docs: root and public `FONT_LICENSES.md`, `THIRD_PARTY_LICENSES.md`, `public/fonts/README.md`, and the extension font README.
- Validation/integration: `scripts/validate-vscode-installed-smoke.mjs`, `scripts/validate-desktop-ui-performance.mjs`, new `scripts/validate-document-foundations-wave.mjs`, generated performance/tab evidence, `src-tauri/src/commands/file_io.rs`, `src-tauri/src/commands/host_error.rs`, `src/app/formatDiagnostics.test.ts`, `packages/core/src/formats/formatPolicy.test.ts`, this roadmap, and `docs/refactor/document_runtime_structured_editing_foundations_wave_certification.v1.json`.

#### Validation evidence

- `npx vitest run src/components/SourceTextEditor.test.ts src/components/SourceMarkdownEditor.test.ts src/styles/fontLicensing.test.ts`: 3 files, 29 tests passed; 0 failed.
- `npm --prefix scie-md-vscode-extension test -- SourceMarkdownEditor font`: corrected package-local filter exercised the source editor/font suites; 13 tests passed; 0 failed.
- `npm run validate:document-foundations-wave -- --required`: 32/32 DAG nodes passed in 572 seconds on the sealed candidate. Its exact manifest records `fonts:scie-sans`, `fonts:ibm-plex-mono`, `fonts:verify`, version/distribution/Tauri/format/app/export/style/UX/structured checks, desktop `test:all` (209 files, 1,423 tests plus offline Milkdown round-trip), extension test (60 files, 321 tests), extension host/visual smoke (8 and 20 tests), `cargo test` (134 unit/integration tests plus doc tests), strict Clippy, large-document stress, desktop build, VSIX package/content/budgets, packaged desktop smoke, packaged TOML edit, installed-VSIX smoke, packaged performance, tab visuals, artifact staging, generated-output policy, and `git diff --check`; every command exited 0.
- Packaged performance passed all cold/warm/pressure fixtures with five warm samples of 14.9-16.0 ms, heap `101,349,438` bytes, process working set `122,318,848` bytes, and pressure process-tree working set `718,110,720` bytes. Tab validation passed 1/2/12/30/60 tabs, 200% zoom, forced colors, reduced motion, accessibility, and zero pixel difference under fixture `round11-dense-tabs-ibm-plex-mono-v1`.
- `git diff --check`: passed inside the terminal DAG; 0 whitespace errors.

#### Generated outputs and candidate identity

The generator order was Scie Sans then IBM Plex Mono, followed by font verification, all contract/test gates, one desktop build, one VSIX build, package consumers, performance/tab evidence, staging, and final guards. The extension font mirror is hash-identical to the authoritative directory. Candidate and final manifests both equal `a3b5ce28ccffa7ed04b231051e3aa73c792e65651c015e03fa86ec0d5b3330cc` at `HEAD f28bb9cf7abeb504402f702e8d8a78bdf302e03a`; expensive-node counts are all exactly one.

Certified artifacts:

- `src-tauri/target/release/sciemd.exe`: 18,243,072 bytes, SHA-256 `f744ca205762fd2d643f0334de01a4884dd7b031e23177d0f3f8a1cd2b813d8c`.
- `src-tauri/target/release/bundle/msi/ScieMD_1.1.0_x64_en-US.msi`: 9,478,144 bytes, SHA-256 `bb68cbe59dddacae094270d9587f285926c5e15c81421421cdb0ea989215349a`.
- `src-tauri/target/release/bundle/nsis/ScieMD_1.1.0_x64-setup.exe`: 8,027,205 bytes, SHA-256 `b46dc1a5812a8ba15bc130ab007f0fd1f101c5fdb72cf5d5e4fb536ee3659163`.
- `scie-md-vscode-extension/sciemd-vscode-1.1.0.vsix`: 4,989,898 bytes, SHA-256 `bd7bf801257199230909c5c668c4910ee7dda466851ee5db0204180dee0d4061`.

The generated certification record is `docs/refactor/document_runtime_structured_editing_foundations_wave_certification.v1.json`; staged installer/VSIX copies and `artifacts/SHA256SUMS.txt` agree with the built artifacts.

#### Remaining risks

IBM Plex Mono's upstream Greek omission requires the deliberately bounded Noto Sans Mono face; the verifier locks its non-overlapping range, license, provenance, and hashes. Font metrics intentionally changed the Round 10 geometry baseline, while semantic source state remained invariant. Windows cloud/provider atomic replacement depends on the verified `MoveFileExW` same-volume fallback when `ReplaceFileW` reports error 1175. These are documented operating constraints with passing production evidence, not incomplete closure obligations.

#### Non-goals preserved

Round 11 did not redesign semantic highlighting, alter source content, replace the general mono token, change visual/editor features, migrate structured preview typography, weaken prior performance/safety budgets, or change any document/write authority. No later round was implemented or prepared.

#### Proper closure statement

Round 11 is properly CLOSED.

#### Roadmap advancement

Rounds 1-11 are `CLOSED`; the wave is complete. No round remains `OPEN` or `PLANNED`. This execution stops here.

## 8. Standard round closure record

When a round closes, delete its forward-looking implementation plan from this document and replace it with a concise evidence record containing exactly these headings:

1. `Status` - `CLOSED`, date, and exact baseline/tree identity.
2. `Outcome delivered` - observable semantic result and first production consumer.
3. `Contracts and decisions` - invariants implemented, decisions, and justified deviations.
4. `Production adoption` - named real screens/commands/services using the result.
5. `Compatibility and migrations` - stored/public/native/extension changes and fixture results.
6. `Changed-path manifest` - production, tests, docs, generated projections, packages/locks.
7. `Validation evidence` - exact commands and pass/fail counts; no reconstructed evidence.
8. `Generated outputs and candidate identity` - affected generator DAG and artifact/tree hashes when applicable.
9. `Remaining risks` - only genuinely deferred depth; no hidden incomplete closure obligation.
10. `Non-goals preserved` - proof that later rounds were not started.
11. `Proper closure statement` - literal text `Round N is properly CLOSED.`
12. `Roadmap advancement` - make exactly the next planned round `OPEN`, or mark the wave complete after Round 11.

Implementation, tests, generated projections, manifest, evidence, and roadmap status must agree. Do not retain stale task lists under a closed round. Do not start the next round in the same execution.

## 9. Integrated certification matrix

The terminal Round 11 pass must cover at least:

| Dimension | Required cases |
| --- | --- |
| Cold load | 1/5/10/24 MiB Markdown; many-line and long-line; local and delayed/cloud-simulated I/O; cancellation |
| Warm activation | clean and dirty resident `A -> B -> A`; source/visual/mixed format; cache hit/miss/runtime eviction; zero disk reread |
| Source residency | cumulative 5 x 10 MiB and several-24-MiB tabs; dirty pinning; clean cold transition; hysteresis; baseline-verified cold reacquisition |
| Editor state | source, selection, scroll, focus, undo, IME, syntax/highlight state, revision mismatch |
| Scheduler | rapid switching/typing, stale work, real cancellation, fairness, cache pressure, dependency invalidation |
| Durability I/O | recovery lag/flush, watcher ambiguous hash, save/autosave priority, close/quit under load |
| Current structured writers | JSON/JSONL/CSV/TSV operations, review enforcement, schema change, journal/undo |
| New structured writers | YAML/TOML/XML supported matrix, unsupported node fallback, exact untouched regions |
| Security | XML DTD/entities, malformed encodings, typed native errors, content-free diagnostics |
| Tabs | 1/2/12/30/60 tabs, duplicate names, narrow/200%, forced colors, context/reorder/close focus, active reveal |
| Typography | every desktop visual style/theme/language; installed VSIX host-font precedence plus IBM fallback; CSP/offline; italic/bold/scientific glyphs |
| Fidelity | encoding/BOM/newline envelope, source preservation, save/reopen, external conflict |
| Hosts | desktop owns runtime/tabs/native TOML; extension consumes shared source presentation and host-appropriate structured policy |

The decisive acceptance story is:

1. cold-open a 10 MiB Markdown file and record every stage to first editability;
2. open JSON, YAML, TOML, XML, CSV, and plain-text tabs;
3. in desktop ScieMD, edit the safe visual subset of every structured format whose required host planner is available, while unsupported hosts and advanced nodes remain source-only;
4. prove a JSONL or tabular visual op whose matrix requires review cannot commit without approval;
5. switch repeatedly back to the resident large Markdown tab and prove zero disk reads, no full CodeMirror content replacement on warm hit, and cached derived artifacts;
6. while that large Markdown tab is inactive and dirty, prove autosave/recovery target the aggregate after deactivate flush and that return remains warm with zero reads;
7. create pressure that first evicts a safe inactive runtime and eventually transitions an eligible clean source to `coldClean`; prove bounded reconstruction, baseline verification, and no eviction thrash while dirty sources remain pinned;
8. exercise recovery, external change (including parked-state drop before reload), schema change, Save All, close, restart, and workspace restore;
9. verify the modern tab strip remains clear and accessible at the reported density without exposing cache jargon;
10. verify IBM Plex Mono is loaded/computed on every desktop source surface, VS Code preserves its configured editor font with IBM fallback, and no saved character changes.

## 10. Explicit non-goals

- Do not reopen the completed document identity, workspace durability, or tab ownership architecture without new failing evidence.
- Do not keep one mounted heavyweight editor per tab.
- Do not persist CodeMirror/Milkdown/parser runtime objects.
- Do not stream by default or append streamed chunks through repeated editor transactions.
- Do not increase the file-size ceiling merely because transport changed; measure memory and editability first.
- Do not use active-tab identity as effect ownership.
- Do not regenerate YAML, TOML, or XML wholesale for a local visual edit.
- Do not advertise blanket editability for unsupported syntax constructs.
- Do not expand JSONL into arbitrary nested-field editing or add a complete CSV/TSV row/header/column operation suite in this wave; Round 6 preserves the current useful operation set while making its authority generic and safe.
- Do not allow native TOML code to write around the document aggregate/save authority.
- Do not weaken XML DTD/entity security to gain visual features.
- Do not create format-specific document authority inside the tab strip.
- Do not introduce a second workspace/tab/runtime kernel in the VS Code extension.
- Do not globally replace `--mono-font` or restyle exported/code-block typography as part of source font work.
- Do not perform broad release certification in every round.

## 11. Architectural success criterion

The wave is complete when this sentence is true in production and in evidence:

> An open document is either an authoritative resident source with a bounded revision-matching warm runtime or an explicitly cold, clean, baseline-verified locator; derived artifacts are reusable and cancellable; every structured visual edit is a policy-enforced guarded source-preserving transaction with human review wherever the operation matrix requires it; tabs clearly project those documents; desktop source uses IBM Plex Mono in every visual style while VS Code preserves host font authority; and typography never changes source content.

## 12. External implementation references

- Tauri commands: async commands are preferred for heavy work, command responses are JSON-serialized unless an optimized response is used, and Channels are intended for ordered streaming: <https://v2.tauri.app/develop/calling-rust/>
- CodeMirror state is persistent/immutable and carries document, selection, history, syntax, and extension state suitable for runtime retention: <https://codemirror.net/docs/ref/>
- CodeMirror highlighting is an editor extension and need not mutate source: <https://codemirror.net/docs/extensions/>
- WAI-ARIA tab keyboard and latency guidance: <https://www.w3.org/WAI/ARIA/apg/patterns/tabs/>
- Tauri frameless/custom titlebar drag, permissions, and double-click maximize guidance: <https://v2.tauri.app/learn/window-customization/>
- IBM Plex subfamilies and Mono coding guidance: <https://www.ibm.com/design/language/typography/typeface/>
- IBM Plex source and OFL license: <https://github.com/IBM/plex>
- Rust `toml_edit` mutable document/format-preserving model: <https://docs.rs/toml_edit/latest/toml_edit/>
