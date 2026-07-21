# Multi-Document Workbench Foundations Refactor Wave

Status: Rounds 1-20 `CLOSED`; refactor wave complete
Baseline reviewed: ScieMD `v1.1.0`, commit `54765d6`
Review date: 2026-07-21
Revision: 24 — Round 20 integrated release certification evidence recorded; wave complete
Proposed size: 20 dependency-ordered rounds

Related established constraints:

- [Source Preservation Adapter Contract](./source_preservation_adapter_contract.md)
- [YAML/TOML Preservation Decision](./yaml_toml_preservation_decision.md)
- [YAML Source Preservation Evaluation](./yaml_source_preservation_evaluation.md)
- [TOML Source Preservation Evaluation](./toml_source_preservation_evaluation.md)
- [XML Read-Only Adapter Policy](./xml_readonly_adapter_policy.md)
- [Release Package Budgets](./release_package_budgets.md)

This roadmap sits above those decisions. It does not reopen source-preservation-gated visual writes; it gives every format adapter a safe per-document workspace owner.

## 1. Decision

The next major refactor should build a **multi-document workspace kernel**, not add a tab strip to the current single-document session.

Tabs, heterogeneous documents, and richer source presentation are the intended product outcomes. They should be late consumers of foundations that make each open document independently identifiable, durable, recoverable, observable, and safe under asynchronous work.

The recommended critical path is:

> stop-loss characterization -> minimum typed errors and source metadata -> document identity and one path authority -> minimum format contribution -> document aggregate -> headless workspace -> keyed editor gateway -> targeted effects -> origin-owned saving (**kernel proven**) -> production persistence/recovery/lifecycle -> active-document projection -> tabs -> semantic source presentation -> integrated certification

This is an extraction and hardening wave, not a rewrite. ScieMD already has good pieces worth preserving: generic text I/O, atomic replacement, metadata-based conflict protection, recovery mechanisms, a multi-scope watcher service, format adapters, format-aware workbench surfaces, CodeMirror language packages, and broad automated tests. The main weakness is that these pieces are coordinated around one active-document singleton.

## 2. Product outcome

At the end of the wave, ScieMD should be able to:

- keep several Markdown, JSON, JSONL, YAML, TOML, XML, CSV, TSV, and plain-text documents open at once;
- activate a tab without replacing, implicitly saving, discarding, or corrupting another document;
- expose the toolbar, canvas, sidebars, inspector, validation, and commands appropriate to the active document's format and surface;
- preserve a document's cursor, selection, scroll position, editor mode, structured selection, and bounded in-session undo history across tab switches, independently of whether its editor remains mounted;
- save, autosave, watch, recover, close, and restore every document independently;
- focus the existing tab when the same physical file is opened through an equivalent path;
- recover multiple untitled and saved dirty documents, including a document intentionally edited to an empty string;
- show semantic source styling without changing the source characters, selection behavior, undo history, or save result;
- remain bounded in memory and background work when many tabs are open.

## 3. Important correction to the premise

ScieMD is no longer a Markdown-only application internally. The current build already opens and routes several text formats through format-aware surfaces. The workbench contains Markdown visual/source modes, JSON health/tree/table/source surfaces, read-only structured projections for YAML/TOML/XML, record and table surfaces for JSONL/CSV/TSV, and a source fallback.

Therefore, the missing capability is not primarily “support JSON and text.” It is:

> reliable ownership of several independently living documents, plus one declarative way to project the active document into the correct UI.

Likewise, source-mode semantic styling is not blocked by a missing editor. CodeMirror language extensions are already wired for Markdown, JSON, YAML, and XML. The missing layer is a semantic highlight style and shared presentation contract.

## 4. Foundational diagnosis

### 4.1 One document is distributed across singleton state

`src/app/documentSession/controller.ts` describes one `DocumentSessionState`. `src/app/hooks/useDocumentSession.ts` then owns one source string, saved baseline, path, format, metadata snapshot, mode, autosave state, conflict state, recovery target, and several operation epochs in parallel state and refs.

Additional document-specific state lives outside that session in `src/app/App.tsx`: review proposals, edit journal, schema selection, structured selection, editor registrations, navigation state, authorship state, histories, and surface preferences. Some of it is reset when a document is replaced; none of it has a stable per-document owner.

This is the deepest blocker. A tab cannot safely be the owner of this state, and duplicating the current hook once per rendered tab would multiply global services and race conditions.

### 4.2 Open currently means settle and replace

`src/app/documentSession/openDocument.ts` exports `openDocumentForSession`, which settles the dirty active document before reading and committing a replacement. New-document and template flows have the same replacement model.

A workspace requires separate commands:

- `openDocument` adds or focuses a document;
- `activateDocument` changes the active projection;
- `deactivateDocument` flushes editor/view state without closing;
- `closeDocument` performs a durability transaction;
- `replaceDocument` is rare and explicit.

### 4.3 Editor access is process-global

`src/components/visualEditorStateSync.ts` registers readers in a module-global stack, and callers read whichever editor was registered last. Save, mode-switch, recovery, and undo flows use this bridge.

With multiple editors, that creates a credible wrong-document save. Even with only the active heavyweight editor mounted, deactivation needs an explicit `DocumentId`-targeted flush before unmount.

### 4.4 Async safety is based on “still active,” not document ownership

Open requests, parsers, diagnostics, schema work, save queues, timers, and recovery work commonly rely on active-session epochs, path/format keys, or singleton queues. A result that resolves after a tab switch must never be interpreted as belonging to the new active tab.

Every effect must carry a target document identity and revision. Active state may affect scheduling priority; it must not determine ownership.

### 4.5 Persistence and recovery are singular

`src/services/draftRecoveryService.ts` has one fixed untitled recovery identity. `src/services/rawDocumentRescue.ts` holds one module-global, Markdown-labelled rescue snapshot. Activating a saved file can clear the singleton untitled recovery path.

The reviewed baseline also had a direct data-loss case: a dirty document whose source became blank was treated as having no draft and its recovery was cleared. Round 1 closed that stop-loss defect; intentional deletion-to-empty is now recoverable, while multi-document recovery ownership remains Round 12 work.

### 4.6 Save durability is strong underneath but not correctly coordinated

The Rust I/O layer already performs metadata checks, temporary-file writes, file synchronization, atomic replacement, and directory synchronization where supported. The weak point is orchestration:

- there is one save/autosave lane;
- `useSaveOperations.ts` defines `isSnapshotCurrent()` as matching both the singleton document identity version and current path; several pre-write checks return `false` when that active identity changes, so a tab switch could abort the originating document's disk write rather than merely suppress stale UI;
- the reviewed baseline allowed overwrite dialogs to promise a backup and then continue after backup failure; Round 1 made those promised-backup paths fail closed;
- close protection considers one dirty flag rather than every dirty, saving, conflicted, or recovery-pending document.

Backup success must be a hard precondition when the UI promises it. Continuing without a backup requires a second explicit decision.

### 4.7 File identity is not canonical

Path comparison and normalization exist independently in the session controller, settings/recent-files logic, recovery, external-change detection, file watching, explorer flows, and native code. Those implementations do not represent one declared policy for Windows verbatim paths, UNC paths, separator differences, case, symlinks, or hard links.

Under tabs, one physical file could otherwise acquire two tabs, two watchers, two recovery entries, and two concurrent save queues.

### 4.8 Document presentation leaks into global preferences

Markdown presentation metadata extracted during open can be written into global settings. A document's frontmatter-derived visual style or document type must not silently become another tab's preference.

Global defaults and document-local presentation are different kinds of state. “Make this my default” should be explicit.

### 4.9 Format truth is fragmented

Format definitions and policies are split across the core format model, adapter registry, app capability checks, native picker/classification tables, installer/file-association policy, recovery validation, explorer behavior, and many component-level conditionals.

The reviewed baseline had one visible inconsistency: plain text was supported by the open flow and product documentation while one format policy said it could not open as a document. Round 1 aligned that live policy. Some native-association differences are deliberate—CSV may remain spreadsheet-friendly—so the later answer remains a manifest with surface-specific policy, not making every extension list identical.

### 4.10 “Source untouched” needs two precise guarantees

Semantic highlighting can guarantee that `EditorState.doc` is unchanged. It cannot by itself promise byte-for-byte disk preservation.

Current native I/O preserves useful metadata such as encoding, BOM, and dominant line ending, but normalizes in-memory text to LF and writes mixed line endings back using a dominant style. Malformed or unsupported encodings also require an explicit lossiness policy.

The refactor must distinguish:

1. **editor character fidelity** — presentation never inserts, removes, replaces, or hides source characters; and
2. **file byte fidelity** — a save is lossless for the original encoding/newline envelope, or it is blocked/warned with an explicit user decision.

### 4.11 The UI shell is already a coordination hotspot

`src/app/App.tsx`, `src/app/AppEditorStage.tsx`, `src/components/AppTopbar.tsx`, and `src/app/hooks/useDocumentSession.ts` each carry broad responsibilities. The stage already contains useful capability-aware routing, but the active-document projection, commands, lifecycle, and overlays are not bounded clearly enough for a workspace.

The refactor should extract owners and enforce boundaries rather than merely divide large files by line count.

## 5. Foundations to preserve

The wave should deliberately reuse these seams:

- `DocumentHost` and its native/browser adapters as the host boundary;
- native encoding/BOM metadata and atomic save implementation;
- metadata baselines and external-change conflict review;
- format adapters and current format-aware surface components;
- the watch service's ability to union multiple scoped paths, while replacing the separate path normalizers still used by launch, explorer, recovery, and external-change consumers;
- worker-backed parsing and diagnostics, after ownership is keyed correctly;
- current source-preservation adapters and policies;
- existing cold-start, recovery, format, save, and component tests;
- the active-editor-only rendering model, extended with explicit view snapshots and a bounded cache.

## 6. Target architecture

The exact names may evolve, but the ownership model should be recognizable in code:

```ts
type DocumentId = string & { readonly __brand: "DocumentId" };
type SourceRevision = number & { readonly __brand: "SourceRevision" };

type DocumentLocator =
  | { kind: "untitled"; untitledId: string }
  | {
      kind: "file";
      displayPath: string;
      comparisonKey: string;
      stableFileId?: string;
      identityConfidence: "stableFileId" | "pathOnly";
      aliases?: readonly string[];
    };

interface SourceEnvelope {
  sourceText: string;
  savedSourceText: string;
  revision: SourceRevision;
  savedRevision: SourceRevision;
  encoding: string;
  bom: boolean;
  lineEndings: "lf" | "crlf" | "cr" | "mixed";
  lineEndingMap?: readonly ("lf" | "crlf" | "cr")[];
  originalByteHash?: string;
  originalBytesRef?: string;
  losslessWrite: "yes" | "no" | "unknown";
}

interface DocumentLifecycleState {
  content: "clean" | "dirty";
  save: "idle" | "queued" | "saving" | "failed";
  external: "inSync" | "changed" | "missing" | "renamed" | "unknown";
  access: "writable" | "readOnly" | "permissionLost" | "cloudUnavailable";
  recovery: "notRequired" | "pending" | "current" | "failed" | "recoveryOnly";
}

interface DocumentRecord {
  id: DocumentId;
  locator: DocumentLocator;
  format: DocumentFormat;
  source: SourceEnvelope;
  fileBaseline?: FileFingerprint;
  observedExternal?: FileFingerprint;
  lifecycle: DocumentLifecycleState;
  presentation: DocumentPresentationState;
  view: DocumentViewState;
}

interface WorkspaceState {
  schemaVersion: number;
  documentsById: Record<DocumentId, DocumentRecord>;
  tabOrder: DocumentId[];
  activeDocumentId: DocumentId | null;
  recentlyActiveDocumentIds: DocumentId[];
}

interface EffectToken {
  documentId: DocumentId;
  operationId: string;
  sourceRevision: SourceRevision;
}
```

`DocumentRecord` must remain pure and serializable. Editor instances, abort controllers, save actors, parser caches, worker handles, and opaque editor history belong in `DocumentId`-keyed runtime registries. Durable baselines and conflict fingerprints belong in the serializable record.

`DocumentLifecycleState` should be a composition of orthogonal substates, not one mutually exclusive enum. Content can be dirty while saving, externally changed while read-only, or recovery-pending after a save failure. The model therefore needs independently typed content, save, external-file, access, and recovery facets, with their valid cross-state transitions defined centrally.

### 6.1 State ownership

| Owner | Examples | Persistence |
| --- | --- | --- |
| Global preferences | theme, font scale, default presentation choices | versioned settings |
| Workspace | tab order, active tab, MRU order, sidebar layout, explorer context | workspace manifest |
| Document durable state | ID, locator, format, source/baseline, fidelity metadata, document-local presentation | disk plus recovery catalog |
| Document view state | source selection, visual selection, scroll, structured path, mode, presentation override | selected serializable fields in manifest |
| Keyed runtime registries | editor/history snapshot, save actor, parser cache, abort controllers, worker handles | bounded in-memory state; never embedded in `DocumentRecord` |
| Transient overlay | dialogs, popovers, context menus, pending user decisions | never silently rebound; close or target by `DocumentId` |

### 6.2 Non-negotiable invariants

1. One stable physical-file identity—or one canonical-path fallback when stable identity is unavailable—has at most one owning `DocumentId`.
2. Every untitled document has a unique durable identity.
3. An async result can mutate only its addressed document and only when its operation/revision guard still matches.
4. `activeDocumentId` selects a projection; it never owns document data.
5. Activation/deactivation never itself forces a disk save, discard, or recovery clear; independently eligible per-document autosave may continue after a switch.
6. Every dirty document is checkpointed within a declared maximum recovery lag, including an empty source string; close, quit, and other destruction barriers require an awaited current-revision flush.
7. A close completes only after the selected save/discard/cancel outcome and required recovery/manifest writes complete.
8. Save As cannot silently make two open documents own the same file locator.
9. Only the active heavyweight editor is mounted by default; deactivation explicitly flushes content and snapshots view state.
10. Document-specific UI is resolved declaratively from format contribution, document state, host capability, parse status, and large-file policy; components do not invent a parallel capability matrix.
11. Semantic source styling is decoration/highlighting only and never dispatches a content-changing transaction.
12. Unknown future persistence versions are quarantined or opened safely; they are never destructively normalized as if current.

### 6.3 Background autosave policy

Path-backed dirty documents remain autosave-eligible while inactive when they are writable, conflict-free, and not blocked by format/fidelity policy. Activation affects priority and UI projection, not save ownership or eligibility.

- Each document keeps its own debounce/max-wait state and serial save lane.
- A workspace-level limiter permits one native document write at a time by default; active-document manual saves have priority over background autosave without canceling the originator.
- Untitled, conflicted, read-only, cloud-unavailable, parser-blocked, or fidelity-blocked documents rely on Round 12 recovery checkpoints until the block is resolved.
- Deactivation schedules/coalesces recovery but does not force an immediate disk save.
- Stress evidence in Round 20 may tune timing/concurrency, but it may not change the eligibility rule silently.

### 6.4 Physical-file identity decision

For this wave, ScieMD treats two existing paths with the same stable physical-file identity as one open document. Opening the second alias focuses the existing document and records the alias; a deliberate “second view of the same file” capability is outside this wave.

| Case | Identity decision |
| --- | --- |
| Canonical paths match | Same document. |
| Stable file IDs match, including hardlinks | Same document; preserve the first display path and record later aliases. |
| Stable file IDs differ | Distinct documents even if display names are similar. |
| Stable file ID unavailable | Fall back to canonical comparison key with `pathOnly` confidence; do not guess across different keys. |
| Symlink/junction to an existing file | Resolve the existing target, then apply stable-ID comparison when available. |
| Save As target does not yet exist | Reserve canonical parent + intended name, fence collisions, then refresh stable identity after creation. |
| Later identity discovery reveals a collision | Block the second writer and require focus/close/reconcile before either document can save. |

### 6.5 Internal multi-document capability gate

Before Round 18, `multiDocumentWorkspaceEnabled` is an internal capability that defaults off in production. Enabling more than one record is valid only when a `WorkspaceActivationSurface` is registered by the hidden harness. If the capability is on without an activation surface, the workspace refuses a second document and records an invariant failure rather than creating inaccessible state.

Round 18 registers the tab strip as the production activation surface and enables multi-document behavior with it. There is never a supported state in which several documents exist but the user cannot activate them.

### 6.6 Lossy-write authority

The application preflights known fidelity risks from `SourceEnvelope`, but native file I/O is the final authority because it owns encoding and byte conversion. A native-discovered fidelity risk returns typed `LOSSY_WRITE_REQUIRED`; the application may retry only after an explicit user decision tied to the same document/revision/locator. This is not inferred from an English error message.

### 6.7 Cold-start and warm-launch precedence

Restore and launch inputs are evaluated in this order. A higher entry wins; lower entries still contribute recoverable or background workspace state when the multi-document capability and activation surface allow them, but they must not overwrite the winner's visible active document.

1. **Explicit OS / protocol Open With or queued single-instance launch path** — becomes the visible active document promptly.
2. **Crash / dirty recovery that must be offered before discarding user work** — if no explicit launch path won, restore recoverable dirty documents (and activate the prior active dirty document when present).
3. **Saved workspace manifest** — restores order, MRU, view, and clean locators after or beneath the above; never overrides an explicit launch winner.
4. **Untitled recovery without a saved workspace entry** — opens only when no higher winner produced an active document.
5. **Bundled welcome content** — last resort for an empty cold start only.

Warm launch while a workspace is already open follows the same Open/duplicate-locator rules as Round 16 and never replaces healthy tabs solely because a manifest or welcome path exists.

## 7. Revision decisions and execution method

### 7.1 Review changes accepted

This revision keeps the architecture and 20-round destination, while tightening how the critical path is delivered:

- rounds 2, 3, 5, 9, and 11 now distinguish the minimum production adoption needed by the next consumer from certification depth that can wait;
- Round 1 now fixes the live plain-text policy contradiction and records the active-identity save-abort hazard as an explicit failing-forward obligation for Round 10;
- Round 4 includes a thin `DocumentId`-keyed editor-gateway facade over the current singleton, so rounds 6–7 do not create new dependencies on the global last-reader API;
- Round 6 must retire the existing `${format}:${filePath}` structured-surface preference key and move that real state to `DocumentRecord` ownership;
- Round 9 is limited to targeted mutation safety; scheduling, LRU, and inactive-tab suspension are added only when measured load requires them or in Round 20;
- Round 10 explicitly transfers save authority from “still active” to the originating `{ documentId, revision, locator }` snapshot and is the kernel-proven milestone;
- rounds 11–16 turn the proven kernel into a production-durable desktop workspace rather than defining whether multi-document ownership is possible;
- the desktop app owns this wave's workspace and tabs; the VS Code extension consumes shared contracts and compatibility tests but does not implement a second workspace kernel;
- Round 19 stays a contained presentation round with source and fixed-fixture byte-invariance golden tests;
- inactive writable saved documents remain autosave-eligible under a workspace I/O limiter, while blocked/untitled documents rely on recovery;
- stable physical-file identity deduplicates hardlinks when available, with an explicit canonical-path fallback and collision rule;
- Round 6 now names every known App-level cross-document poison state and requires migrate-or-clear ownership decisions;
- the internal multi-document capability fails closed unless a visible activation surface exists;
- layer-two/validator commits, asset-driven Save As, every recovery flush entry point, and aggregate dirty chrome are now explicit consumers of their owning rounds;
- native I/O is the final lossy-write authority through typed `LOSSY_WRITE_REQUIRED`;
- Round 4 ships `pathOnly` first and enables `stableFileId` only where the host already exposes it, without blocking closure on every OS identity API;
- Round 6 names paste/tabular/JSON edit review overlays as active-only or `DocumentId`-targeted;
- Round 13 records an explicit cold-start / warm-launch precedence order.

### 7.2 How rounds are selected

One round owns one independently closable semantic outcome or dependency spine. A round is not created merely because work crosses a file-count, line-count, time, generator, or ordinary-repair threshold.

Split a round only when the work introduces a genuinely separate authority boundary, stored-data migration/recovery domain, public contract, or semantic subsystem. Otherwise, normal repairs and mechanical companions remain inside the round.

Every capability round must reach at least one current production consumer. Compatibility adapters are allowed when they let the current single-document app consume the new contract; dormant infrastructure is not a valid round outcome.

### 7.3 Authority and writer topology

- One primary production writer owns the round's shared dependency spine and integrates the round in the shared tree.
- Shared contracts, migrations, generated outputs, registries, barrels, and closure metadata are primary-only paths.
- Parallel writers are allowed only after a shared interface is frozen and only on named, disjoint file leases.
- Read-only inventory, adversarial review, test design, and failure diagnosis are the preferred parallel tasks.
- Worktrees, packet commits, cherry-pick integration, repeated clean-tree preparation, and per-round release certification are not part of the default workflow.

The semantic writable lease automatically includes mechanical companions: adjacent tests and fixtures, module exports, manifests, migrations, generated registrations, test configuration, and completion metadata directly required by the owned change.

### 7.4 Validation and generator strategy

- Run focused unit/integration tests during implementation and the round's named build or contract checks at closure.
- Treat generators as a dependency DAG. After a diagnosed correction, rerun the affected generator and downstream checks, not every generator by ritual.
- Reserve broad integrated validation, packaged candidate construction, cross-platform smoke, and final evidence sealing for Round 20 unless an earlier round changes a public/generated boundary that its first consumer cannot use without regeneration.
- A stale test filter or moved path may be corrected and recorded without stopping; the semantic obligation may not be weakened.

### 7.5 Stop conditions

Ordinary compile failures, test failures, integration defects, generator corrections, and implementation repairs stay inside the round. Stop only for an unresolved product decision, authority/safety expansion, incompatible stored or public contract, destructive action, conflicting live edit, or external blocker.

### 7.6 Round closure record

Every round closes with one completion note containing:

1. the semantic outcome and first consumer now using it;
2. changed production, test, migration, generated, and documentation paths;
3. commands run and objective results;
4. invariant, compatibility, and migration evidence;
5. deferred certification depth and its owning later round;
6. the roadmap status advanced exactly one round.

Implementation, tests, generated projections, and the closure note must agree. Do not begin the next round in the same execution.

## 8. The 20-round refactor wave

### Wave A — Stop-loss behavior and canonical contracts

#### Round 1 — Reliability charter, characterization, and immediate stop-loss fixes

**Status:** `CLOSED` (2026-07-21).

**Original intended outcome and preserved scope:** close current data-loss and policy contradictions, then freeze the single-document behavior that later ownership changes must preserve. Dirty state is source versus saved baseline, not nonblank text; promised backups are hard overwrite preconditions; plain text is openable wherever advertised; the active-identity save abort remains a named failing-forward hazard. This round introduced no `DocumentId`, workspace state, tabs, typed host errors, fidelity envelope, or later-round persistence authority.

**Implemented semantic outcome:**

- Recovery storage, restore, native snapshots, the 600 ms checkpoint, and lifecycle flushes now preserve dirty `""` and whitespace-only source instead of treating it as deletion. Explicit clear operations and the unchanged-baseline/bundled-welcome exclusions remain the only ordinary clear paths.
- Manual conflict overwrite and existing-target Save As now preserve a recovery draft and fail closed with `save-required-backup-failed` when the promised backup cannot be created. Structured-conversion replacement and externally changed bibliography writes also stop on backup failure rather than claiming a backup and continuing.
- `plainText.canOpenAsDocument` is true. The existing `formatRuntimePolicyFor` production spine now makes `.txt` openable/importable through picker/open policy and both native-path and browser-file drop consumers while keeping plain text source-only and non-previewable.
- At Round 1 closure, `save_must_complete_for_originating_identity_even_if_active_document_changed` was an executable expected failure because `isSnapshotCurrent()` rejected the originating save after the active singleton identity changed during file verification. Round 10 converted the unchanged hazard assertion into an ordinary passing workspace-backed test.
- [Round 1 reliability charter](./multi_document_round_1_reliability_charter.md) records cold/warm launch, Open With, stale-decision, line-ending/encoding, recovery-entry-point behavior, and provisional interaction/memory/save/recovery/restart budgets.

**Important decisions / deviations:** fail-closed behavior was selected instead of adding a second “continue without backup” decision. No stored schema or public DTO changed. The existing recovery payloads can represent empty strings, so no migration was required. Round 1 generated no projections and changed no generator inputs; generator convergence remains Round 20 work.

**Production consumers reached:** `useDocumentSession` recovery scheduling/restore; `draftRecoveryService` browser/native persistence; `useSaveOperations` manual Save, Save As, and Save Anyway; structured-conversion Save As in `App`; externally changed bibliography writes; `formatRuntimePolicyFor`; and `useDocumentDropPaste` native/browser document drops.

**Changed-path manifest:**

- Production: `packages/core/src/formats/formatPolicy.ts`, `src/app/App.tsx`, `src/app/hooks/useCitationWorkflow.ts`, `src/app/hooks/useDocumentSession.ts`, `src/app/hooks/useSaveOperations.ts`, `src/services/draftRecoveryService.ts`.
- Tests: `packages/core/src/formats/formatPolicy.test.ts`, `src/app/hooks/useDocumentDropPaste.test.tsx`, `src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx`, `src/app/hooks/useSaveOperations.test.ts`, `src/services/draftRecoveryService.test.ts`.
- Documentation: `docs/refactor/multi_document_round_1_reliability_charter.md`, this roadmap.
- Migrations, fixtures, generated outputs, exports, and generator inputs: none.

**Commands and objective results:**

- `npm ci` — passed; 432 locked packages installed, 0 vulnerabilities.
- Required focused command: `npm test -- src/services/draftRecoveryService.test.ts src/app/hooks/useSaveOperations.test.ts src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx packages/core/src/formats/formatPolicy.test.ts src/app/hooks/useDocumentDropPaste.test.tsx` — 5 files passed; 92 tests passed; exactly 1 expected failure (93 total).
- Extended characterization command: `npm test -- src/services/draftRecoveryService.test.ts src/app/hooks/useSaveOperations.test.ts src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx packages/core/src/formats/formatPolicy.test.ts src/app/hooks/useDocumentDropPaste.test.tsx src/app/hooks/useDocumentSession.startup.test.tsx src/app/documentSession/openDocument.test.ts src/services/fileService.test.ts src/components/SourceTextEditor.test.ts src/app/hooks/useCitationWorkflow.test.ts` — 10 files passed; 136 tests passed; exactly 1 expected failure (137 total).
- `cargo test --manifest-path src-tauri/Cargo.toml --lib` — 109 passed, 0 failed; includes plain-text/structured cold and second-instance launch, CSV exclusion, encoding/BOM, atomic-write, and mixed-line-ending characterization.
- `npm run build` — passed (`tsc` and Vite production build; 4,559 modules transformed). Existing large-chunk warnings remain non-blocking and are not a Round 1 regression.

**Closure-criterion evidence:** empty and whitespace-only drafts round-trip through sync and native async stores; actual session restore accepts empty source; timer, hidden visibility, pagehide, and beforeunload target the current singleton and include empty dirty source; both promised-backup failure paths assert zero atomic writes and retained recovery; `.txt` path and browser drops reach the normal open/commit consumers; startup/Open With and line-ending assumptions pass in frontend/Rust suites; the named ownership hazard is the only expected failure; build and manifests agree.

**Remaining risks / deliberately deferred work:** save authority is still active-singleton-owned until Round 10; recovery listeners and one untitled identity remain singleton-owned until Round 12; exact mixed-ending and unsupported-encoding write authority remains Round 3; additive ingress remains Round 16; performance budgets are provisional until Round 20 certification. These are recorded deferrals, not weakened Round 1 obligations.

**Unblocks:** Round 2 is now the first open round.

#### Round 2 — Versioned host contract and typed error taxonomy

**Status: `CLOSED` (2026-07-21).**

**Problem / scope / outcome:** replace string parsing only on the document lifecycle paths needed by the kernel. A full DTO rewrite of every Tauri command is explicitly not required here.

**Dependencies / first consumer:** Round 1 behavior is fixed. `openDocumentForSession` and `useSaveOperations` are the first production consumers of typed failures; Round 3 consumes `LOSSY_WRITE_REQUIRED` for fidelity decisions.

**Primary owner / semantic writable lease:** the primary owns `src/app/host/documentHost.ts`, `src/app/host/desktopDocumentHost.ts`, `src/services/fileService.ts`, relevant `src-tauri/src/commands/{file_io,backups}.rs` results, and `scripts/validate-tauri-command-contract.mjs`. Shared error tags and generated/type projections are primary-only.

**Contracts / invariants:** error codes are stable and machine-readable; human messages remain presentation data; unknown/new codes degrade to a typed `UNKNOWN_HOST_ERROR`; browser/test hosts implement the same discriminated result boundary; no domain branch depends on English error text; native I/O may veto a write with `LOSSY_WRITE_REQUIRED` even when application preflight considered it safe.

**Completion record:** implemented a versioned `DocumentHostError` boundary with `FILE_CHANGED`, `NOT_FOUND`, `PERMISSION_DENIED`, `CLOUD_UNAVAILABLE`, `BACKUP_FAILED`, `LOSSY_WRITE_REQUIRED`, and `UNKNOWN_HOST_ERROR`. Adopted native read/edit/stat/atomic-write/backup commands now serialize typed failures; the desktop file adapter normalizes all lifecycle rejections and safely maps future versions/codes and legacy browser/test failures to `UNKNOWN_HOST_ERROR`. `openDocumentForSession` and `useSaveOperations` now make lifecycle decisions from codes, not localized messages. Native encoding vetoes preserve the draft and stop before file creation. Backup creation remains fail-closed where the existing save contract requires it.

**Important decisions / deviations:** legacy internal Rust helpers continue to produce string diagnostics and are classified only at the native command adapter, keeping the migration narrow. The internal desktop smoke harness retains its historical string result through an explicit compatibility conversion. Cloud placeholders are rejected natively as `CLOUD_UNAVAILABLE` as well as by the existing metadata preflight. No raw `invoke` call moved or was added; `fileService.ts` remained the raw transport adapter. Round 3 approval/fidelity-envelope UX was not implemented.

**Production consumers reached:** the real desktop host, `openDocumentForSession`, and `useSaveOperations`. Permission handling, missing-file recreation, write-race conflict handling, cloud unavailability, backup failure, generic failure, and lossy-write draft preservation all cross the adopted boundary.

**Migration / compatibility:** contract version 1 is shared by Rust and TypeScript. One JSON fixture is deserialized by Rust and consumed by TypeScript tests. Unknown tags, future tags, legacy `Error`, and string rejections preserve a presentation message while degrading to `UNKNOWN_HOST_ERROR`. No persisted data or public document schema changed, so no storage migration was required.

**Changed-path manifest:** `src/app/host/{documentHost.ts,documentHostError.ts,desktopDocumentHost.ts,desktopDocumentHost.test.ts,fixtures/documentHostErrors.v1.json}`; `src/app/documentSession/{openDocument.ts,openDocument.test.ts}`; `src/app/hooks/{useSaveOperations.ts,useSaveOperations.test.ts}`; `src-tauri/src/commands/{mod.rs,host_error.rs,file_io.rs,backups.rs}`; `scripts/validate-tauri-command-contract.mjs`; this roadmap.

**Validation / results:** `npm test -- src/app/host/desktopDocumentHost.test.ts src/app/documentSession/openDocument.test.ts src/app/hooks/useSaveOperations.test.ts` passed (3 files, 53 passed, 1 pre-existing expected failure); `npm run validate:tauri-contract` passed (55 registered commands, 54 TypeScript invokes, adopted typed boundary locked); `cargo test --manifest-path src-tauri/Cargo.toml --lib` passed (111/111); `npm run build` passed (`tsc` and Vite production build; only the existing chunk-size advisory). `git diff --check` passed. Focused native evidence also passed for the shared compatibility fixture and the Windows-1252 veto-before-create behavior.

**Generated outputs:** `npm run build` refreshed ignored `dist/` output. No committed generated projection or generator input changed; the versioned JSON compatibility fixture is source-controlled contract evidence, not generated output.

**Remaining risks / deliberately deferred work:** the complete native DTO audit remains Round 20 work. Round 3 owns the generic source/fidelity envelope and any user approval flow following `LOSSY_WRITE_REQUIRED`; this round only established and consumed the veto. Browser hosts remain represented by the host-neutral normalization contract and fallback test because there is no separate production browser `DocumentHost` implementation in the live tree.

**Objective closure evidence:** every declared tag appears in the shared fixture and adapter parameterized test; Rust deserializes the same fixture; unknown/future and browser-style errors normalize to `UNKNOWN_HOST_ERROR`; localized permission, file-change, and lossy messages prove decisions do not depend on English; the validator requires version 1, the complete code set, typed adopted Rust signatures, and absence of the removed open/save message classifiers; native lossy output is vetoed before target creation; all required commands pass. Current open/save consumers therefore use tagged failures and Round 3 is unblocked.

**Non-goals preserved:** no full Tauri DTO rewrite, no unrelated native-command migration, no Round 3 fidelity approval UI, and no Round 20 certification audit were performed.

#### Round 3 — Generic source contract and file-fidelity envelope

**Status: `CLOSED` (2026-07-21).**

**Problem / scope / outcome:** make current source metadata format-neutral and honest about preservation. This round does not implement an exact per-line newline map, retain arbitrary original bytes, or claim lossless mixed-ending writes.

**Dependencies / first consumer:** Round 2 supplies typed loss/failure reporting. The existing read/save session and `DocumentHost` metadata are the first consumers.

**Primary owner / semantic writable lease:** the primary owns `src/app/documentState.ts`, document host/file-service DTOs, `src-tauri/src/commands/file_io.rs`, `src-tauri/src/commands/file_io/text_encoding.rs`, and directly affected session/save tests. Generic `markdown` → `sourceText` compatibility aliases may remain only at explicit Markdown/editor boundaries.

**Contracts / invariants:** character-preserving editor presentation and byte-preserving disk round trip are separate guarantees; a content hash proves identity/change, not reconstruction; encoding, BOM, dominant line ending, and mixed-ending status already returned by Rust remain authoritative; the app preflights known risk, native I/O may return `LOSSY_WRITE_REQUIRED`, and any approved retry remains tied to the same document/revision/locator.

**Completion record:** implemented a host-neutral `SourceEnvelope` with generic source/saved-source text, encoding, BOM, observed/dominant endings, original-byte hash, `losslessWrite`, and typed loss reasons. Native metadata now reports uniform versus mixed endings, CR as a first-class dominant ending, decode replacement, original-byte hash, and honest `yes`/`no`/`unknown` policy. The production file-service adapter normalizes native/legacy results; `openDocumentForSession` consumes the envelope; session/controller inputs and adopted native writes use `sourceText`; `useSaveOperations` consumes the fidelity policy before writing.

**Important decisions / deviations:** uniform UTF-8, UTF-16LE/BE, representable Windows-1252, and LF/CRLF/CR cases are declared lossless. Mixed endings without a map and decode replacement are declared lossy. Manual approval for unrepresentable Windows-1252 converts the retry to UTF-8 without BOM; mixed-ending approval normalizes to the detected dominant ending. Autosave never approves and preserves recovery instead. Native I/O remains final authority and can trigger the same review after application preflight. Branded revision/locator types remain Round 4 work; this round binds approval to the current identity version, exact source text, locator, and unchanged expected disk metadata rather than pulling Round 4 identity implementation forward.

**Production consumers reached:** desktop native read/stat/write DTOs; `fileService`; `DocumentHost` read metadata; `openDocumentForSession`; the current `useDocumentSession` commit path; and `useSaveOperations` manual save/autosave. This is not dormant infrastructure.

**Migration / compatibility:** native reads add `sourceText` while retaining `content`; `readSourceEnvelope` normalizes browser/test/legacy responses. Additive fidelity fields are optional at compatibility inputs and become complete after adapter normalization. Atomic and create-new native write arguments migrated from `markdown` to `sourceText` together with their sole TypeScript adapter. Explicit Markdown/editor aliases remain bounded. No persisted schema changed, so no stored-data migration was required.

**Changed-path manifest:** `src/app/documentState.ts`; `src/app/documentSession/{controller.ts,controller.test.ts,openDocument.ts}`; `src/app/hooks/{useDocumentSession.ts,useSaveOperations.ts,useSaveOperations.test.ts}`; `src/services/{fileService.ts,fileService.test.ts}`; `src-tauri/src/commands/{file_io.rs,file_io/text_encoding.rs}`; `scripts/validate-tauri-command-contract.mjs`; `docs/refactor/{file_fidelity_contract.md,file_fidelity_corpus.v1.json}`; this roadmap.

**Validation / results:** required `npm test -- src/services/fileService.test.ts src/app/hooks/useSaveOperations.test.ts src/app/documentSession/controller.test.ts` passed (3 files, 63 passed, 1 pre-existing expected failure); required `cargo test --manifest-path src-tauri/Cargo.toml --lib file_io` passed (24/24); required `npm run build` passed (`tsc` and Vite, with only the existing chunk-size advisory). Extended open/external-read coverage passed (3 files, 26/26). `npm run validate:tauri-contract` passed with all 55 registered commands and 54 TypeScript invokes visible; it now locks generic write arguments, envelope fields, native fidelity fields, required corpus cases, and the mixed-ending no-lossless rule. `git diff --check` passed.

**Generated outputs:** `npm run build` refreshed ignored `dist/`. No committed generated projection or generator input changed. The JSON fidelity corpus is source-controlled contract evidence and is read directly by Rust tests and the validator.

**Remaining risks / deliberately deferred work:** exact mixed-ending reconstruction still requires a separately approved per-line map or raw-byte reference capability; arbitrary original bytes are not retained. Round 4 supplies branded source revision and canonical locator authority; Round 20 broadens corpus certification. YAML/TOML/XML visual writes remain disabled under their existing source-preservation policies.

**Objective closure evidence:** the shared corpus covers UTF-8, UTF-8 BOM, UTF-16LE/BE BOM, Windows-1252, LF, CRLF, CR, and mixed endings; native tests rewrite every `losslessWrite: "yes"` case byte-identically and refuse to label the mixed case lossless. Unsupported Windows-1252 output is vetoed before file creation. Frontend tests prove native-veto review/retry, known-risk preflight, same-fingerprint UTF-8 conversion, autosave blocking, recovery preservation, and stale approval rejection after source and locator changes. Current open/save production flows consume the envelope and policy, so Round 4 is unblocked.

**Non-goals preserved:** no raw-byte store, per-line ending map, exact mixed-ending claim, visual-editor rewrite, YAML/TOML/XML write enablement, workspace identity, or later-round persistence/certification work was added.

#### Round 4 — Stable document identity and canonical locators

**Status: `CLOSED` (2026-07-21).**

**Original intended outcome and preserved scope:** establish one identity/path-comparison authority and make the current single-document application consume it. `DocumentId` remains stable for an open document lifetime; untitled IDs are unique; stable physical-file identity wins over path spelling; `pathOnly` is the conservative fallback; display paths are never equality keys; Save As reserves before creation, refreshes afterward, and blocks a second owner. This round did not add a workspace collection, multi-editor registry, tabs, the Round 5 format manifest, or later save/workspace actors.

**Completion record:** added branded `DocumentId`, `UntitledId`, `SourceRevision`, and `DocumentLocator` contracts; one canonical comparison function; native/compatibility locator normalization; alias merging; and an identity-only ownership index with reserve/commit/collision rules. The desktop host now resolves existing targets through the filesystem, returns canonical comparison keys, and exposes Windows volume/file-index stable IDs through the supported handle API; Unix device/inode support and a symlink test are compiled for Unix hosts. Missing Save As targets resolve canonical parent plus intended name with `pathOnly` confidence. Current open/launch resolves identity before commit, hardlink/alias launches focus the current owner and retain the first display path, and Save As reserves at selection, rechecks immediately before write, then refreshes stable identity after creation.

**Important decisions / deviations:** browser/test hosts may omit the native resolver and deliberately fall back to `pathOnly`; different fallback keys never guess identity. Windows stable ID uses `GetFileInformationByHandle` because the equivalent Rust `MetadataExt` methods remain unstable. The ownership index stores locators only and releases replaced singleton owners, so it is not a workspace/document collection. The existing process-global editor reader remains only as the private backend of `SingleDocumentEditorGateway`; production consumers address reads/commits by `DocumentId`. A whole-crate `cargo fmt --check` exposed pre-existing unrelated formatting drift; only the owned `path_utils.rs` was formatted and its scoped check passes.

**Production consumers reached:** `useDocumentSession` document lifetime/open/launch handling; `openDocumentForSession`; `useSaveOperations` Save and Save As; `App` export/mode-switch reads; recent files/settings; file recovery keys/native snapshot matching; watcher registration; external-change event routing; explorer containment; linked-file watcher routing; the desktop `DocumentHost`; and the native Tauri command registry. No new app/service module may import the last-reader bridge directly; an executable boundary test enforces that rule.

**Migration / compatibility:** no persisted schema version changed. Settings load deduplicates equivalent recent paths while preserving the first display spelling. Recovery reads and clears both the canonical key and pre-Round-4 SHA/encoded/FNV path keys, so verbatim-path drafts remain recoverable and are rewritten naturally on the next checkpoint. Legacy/browser/test hosts keep the same `DocumentHost` shape through an optional identity section and receive deterministic `pathOnly` behavior. The original display path is preserved while canonical target spellings and later aliases are recorded separately.

**Changed-path manifest:** identity/gateway: `src/app/{documentIdentity.ts,documentIdentity.test.ts,documentEditorGateway.ts,documentEditorGateway.test.ts,App.tsx}`; session/effects: `src/app/documentSession/{controller.ts,controller.test.ts,openDocument.ts}`, `src/app/hooks/{useDocumentSession.ts,useSaveOperations.ts,useSaveOperations.test.ts,useExternalChangeDetection.ts,useExternalChangeDetection.test.tsx,useFileExplorer.ts,useLayerTwoDocument.ts}`; host/native: `src/app/host/{documentHost.ts,desktopDocumentHost.ts,desktopDocumentHost.test.ts}`, `src/services/fileService.ts`, `src-tauri/{Cargo.toml,src/lib.rs,src/commands/path_utils.rs,src/commands/file_watcher.rs,src/commands/diagnostics.rs}`; path consumers/tests: `src/services/{settingsService.ts,settingsService.test.ts,draftRecoveryService.ts,draftRecoveryService.test.ts,fileWatchService.ts,fileWatchService.test.ts}`; documentation: this roadmap. No migration file, public package export, or generator input changed.

**Validation / results:** required frontend command passed (5 files, 69/69); required `cargo test --manifest-path src-tauri/Cargo.toml --lib path_utils` passed (5/5 on Windows, 111 filtered; Unix symlink case remains cfg-gated); required `npm run build` passed (`tsc` plus Vite, 4,563 modules; only the existing chunk-size advisory). Extended identity/gateway/watch/explorer/layer-two/save/open/desktop-host/file-service coverage passed (9 files, 97 passed plus the one pre-existing Round 10 expected failure before the final additional Save As order case); the final `useSaveOperations` run passed 41 plus that same expected failure and `npx tsc --noEmit` passed. Native recovery-key compatibility passed (1/1) and native watcher convergence passed (6/6). `npm run validate:tauri-contract` passed (56 registered commands covering 55 TypeScript invokes). `rustfmt --edition 2021 --check src-tauri/src/commands/path_utils.rs` and `git diff --check` passed.

**Generated outputs:** `npm run build` refreshed ignored `dist/` assets. No committed generated projection changed; Tauri command registration and TypeScript invoke coverage were updated directly and validated.

**Remaining risks / deliberately deferred work:** Round 8 replaces the singleton gateway backend with per-document registrations and bounded snapshots. Round 10 transfers save completion away from the active-identity guard (the preserved expected failure). Round 14 owns multi-document watcher/conflict coordination; Round 16 owns all additive ingress; Round 20 performs cross-platform junction/cloud/stress certification. Stable IDs are enabled on Windows/Unix where practical; unsupported hosts remain explicitly `pathOnly`.

**Objective closure evidence:** the old `keyForLaunchPath` and separate launch/recent/recovery/watcher/external/explorer/linked-file normalizers are removed; path consumers import the canonical authority. Tests cover drive/separator/verbatim/UNC convergence, POSIX case sensitivity, unique untitled IDs, stable-ID hardlinks, alias preservation, unknown-ID non-guessing, later collision blocking, missing-target reservation/refresh order, legacy recovery-key migration, recent/recovery/watch convergence, and addressed gateway rejection of stale IDs. Native tests prove hardlinks share a stable ID and a nonexistent target changes from `pathOnly` to `stableFileId` after creation. Production open, save, launch, and editor consumers use the new spine; all required commands pass.

**Unblocks:** Round 5 is now the first open round; no Round 5 implementation was started.

#### Round 5 — Canonical format contribution manifest

**Status: `CLOSED` (2026-07-21).**

**Original intended outcome and preserved scope:** create the minimum host-neutral format contribution consumed by core policy and the desktop workbench. The serializable catalog owns IDs, extensions, MIME types, source-language IDs, runtime policy, workbench surfaces/features, and surface-specific native policy; typed runtime bindings map catalog IDs to executable adapters/source behavior. Plain text remains explicit and source-only. Document state, host capability, parse status, and large-file state may still narrow catalog capabilities. This round did not add document/workspace aggregates, tabs, generated Rust/installer projections, or any Round 6+ ownership work.

**Completion record:** added the versioned `formatCatalog.v1.json` for Markdown, JSON, JSONL, YAML, TOML, XML, CSV, TSV, and plain text. `formatDefinitions.ts` validates completeness, unique IDs/extensions/MIME types, budgets, modes, surface/edit contradictions, feature IDs, and explained native exclusions at module load. `registry.ts` provides one typed immutable binding per contribution, including the explicit no-parser plain-text source binding; it checks adapter identity, source language, budgets, and editable surfaces against the catalog. Adapter identity and parse-budget exports now derive from the catalog, `formatRuntimePolicyFor` derives runtime policy from it, and the former app Boolean matrix/JSON name check was replaced by generic surface/feature resolution.

**Important decisions / deviations:** the canonical artifact is checked-in JSON so host-neutral policy is serializable and the native audit can consume it without loading application code. Rust picker/launch and installer tables remain direct host-owned tables in this round; `validate:format-contributions` audits them rather than generating them, preserving Round 20's projection-convergence scope. The legacy `registerFormatAdapter` export remains as an idempotent compatibility shim for the canonical instance and fails closed for a competing writer. CSV is explicitly picker-enabled but launch/association-excluded with a spreadsheet-friendly reason.

**Production consumers reached:** core path/media detection and `formatRuntimePolicyFor`; adapter/source-editor lookup; `App.tsx` format capability resolution; `AppWorkbench` toolbar/topbar routing and downstream `AppEditorStage` surfaces; and native-path/browser-file drop routing. Browser drops now use the contribution's default mode instead of a hard-coded visual preference, so structured and plain-text files enter source mode while Markdown retains visual mode.

**Migrations / compatibility handling:** no persisted store, public DTO, recovery payload, or file content changed, so no data migration was required. `DocumentFormatDefinition` remains as a deprecated type alias, existing adapter extension/budget exports remain catalog-derived, and idempotent legacy adapter registration remains accepted. Unknown paths/media types and null format policy continue to use the existing null/plain-text fallback behavior.

**Changed paths:** `packages/core/src/formats/formatCatalog.v1.json`, `formatDefinitions.ts`, `formatPolicy.ts`, `registry.ts`, adapter identity/budget declarations under `formats/{markdown,json,jsonl,yaml,toml,xml,tabular}`, `src/app/formatCapabilities.ts`, `src/app/hooks/useDocumentDropPaste.ts`, their focused tests, `scripts/audit-format-contributions.mjs`, `package.json`, and this roadmap.

**Validation / results:** the required focused command passed 5 files and 34/34 tests after the compatibility case was added; coverage includes every format, explicit plain text, missing bindings, contradictory source-only/visual policy, legacy registration, large-file budgets, workbench routing, and deliberate CSV exclusion. `npm run validate:format-contributions` passed with exact agreement for native picker, native launch, Tauri associations, and NSIS associations, and reported CSV as the sole deliberate exclusion. `npm run validate:structured-workflows` passed 7/7 across 9 corpus files and all six workflow groups. `npm run build` passed (`tsc` plus Vite, 4,564 modules); only the existing chunk-size advisory remains. Intermediate `npx tsc --noEmit` and focused runs passed.

**Command manifest:** `npm test -- packages/core/src/formats/formatPolicy.test.ts packages/core/src/formats/registry.test.ts src/app/formatCapabilities.test.ts src/app/hooks/useDocumentDropPaste.test.tsx src/app/AppWorkbench.test.tsx`; `npm run validate:format-contributions`; `npm run validate:structured-workflows`; `npm run build`; `npx tsc --noEmit`; and `git diff --check`.

**Generated outputs:** `npm run build` refreshed ignored `dist/` assets, and structured validation wrote an ignored timestamped report under `tmp/structured-workflows/`. No committed native or installer projection was generated or changed.

**Remaining risks / deliberately deferred work:** native/installer tables are audited but stay host-owned until Round 20 decides and certifies generated projections. Per-document presentation ownership begins in Round 6; shell decomposition remains Round 17; source-mode presentation consumes the catalog source-language IDs in Round 19. The existing build chunk-size advisory is unrelated to this semantic round.

**Objective closure evidence:** one catalog now supplies all core definitions, adapter identity/budgets, runtime policy, app surface/features, source-language lookup, and drop default-mode routing; every contribution has exactly one checked runtime binding; contradictory or missing declarations fail closed; the production workbench tests prove catalog-resolved Markdown/structured routing; native and installer extension sets match catalog policy with no missing or unexpected entries; required structured and build gates pass. The catalog/runtime-binding layer is the sole writer for the shared format dependency spine.

**Unblocks:** Round 6 is now the first open round. No Round 6 implementation was started; Round 17 and Round 19 may later consume this closed contract.

### Wave B — An independently owned document and a headless workspace

#### Round 6 — Canonical document aggregate and state ownership

**Status: `CLOSED` (2026-07-21).**

**Original intended outcome and preserved scope:** replace the torn singleton tuple with one pure, serializable `DocumentRecord` state machine adopted by the current document-specific UI. The aggregate preserves orthogonal content/save/external/access/recovery facets, canonical Round 4 identity/locator types, Round 3 source/fidelity metadata, and Round 5 format IDs. Runtime objects remain outside the record. This round did not create a workspace collection, multi-document persistence, tabs, background schedulers, origin-owned saving, or any Round 7+ behavior.

**Completion record:** added the versioned `DocumentRecord` aggregate and validating reducer for identity/locator, format, source and saved revisions, file and observed-external baselines, lifecycle facets, document presentation, and serializable view state. `useDocumentSession` now owns one reducer and exposes compatibility selectors/setters to the existing shell. `App.tsx` consumes that record for mode/source/session state, structured surface/path/target/schema/variable state, structured edit journal, authorship marks, and presentation. The `${format}:${filePath}` surface map was removed; locator/Save As transitions preserve view state. Record replacement is atomic and creates a fresh document-scoped view.

**Important decisions / deviations:** frontmatter `visualStyle` and `documentType` now become document presentation overrides and never call the global settings writer; active style/type controls update the record, while onboarding remains the existing explicit default-setting path. Review proposals and document dialogs remain active-only in this single-visible-document compatibility round and are deterministically cleared on `DocumentId` change. A small keyed `DocumentRuntimeRegistry` owns insert/jump/find/history registrations now, while the full editor gateway/snapshot migration remains Round 8. One reducer in `useDocumentSession` is the primary writer for the shared serializable document spine; App compatibility callbacks dispatch into it rather than creating another store.

**Production consumers reached:** current Open/New/template/startup replacement flows; save/autosave/external-conflict compatibility selectors; `App.tsx`; `AppWorkbench` and `AppEditorStage`; Inspector structured selection/schema/journal/authorship inputs; structured-surface navigation; visual-style layout and export rendering; and source/visual editor insert, jump, find, and history registrations. `clearActiveDocumentCompatibilityState` is called by the live App identity-change effect, so review and registration policy is not dormant infrastructure.

**Migrations / compatibility handling:** there was no persisted `DocumentRecord`, workspace store, or serialized App view payload to migrate. Existing `DocumentSessionState` remains an open/replace transition DTO, and existing hook consumers retain their single-document setter/selector signatures while the reducer is the sole owner underneath. Existing settings files remain compatible because no schema changed; recent-file updates still persist, but document frontmatter no longer mutates defaults. A typed permission-denied startup fixture was repaired to use the established `DocumentHostError` contract rather than weakening failure classification.

**Ownership / transition evidence:** `docs/refactor/multi_document_round_6_state_ownership.md` records every direct App state/ref category, every named poison state, its durable/keyed-runtime/active-only/global owner, and the later cutover round where applicable. Reducer tests exercise the transition matrix, revision/baseline behavior including empty dirty content, impossible-state rejection, lifecycle orthogonality, JSON serialization, A/B document isolation, atomic replacement, and locator preservation. Active-document tests prove every active-only state class is cleared only on identity change; registration tests prove the old key is removed before the new document binds.

**Changed paths:** `src/app/documentRecord.ts`, `src/app/documentRecord.test.ts`, `src/app/activeDocumentCompatibility.ts`, `src/app/activeDocumentCompatibility.test.ts`, `src/app/App.tsx`, `src/app/documentSession/controller.ts`, `src/app/documentSession/controller.test.ts`, `src/app/hooks/useDocumentSession.ts`, `src/app/hooks/useDocumentSession.startup.test.tsx`, `src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx`, `src/app/hooks/useStableRegistration.ts`, `src/app/hooks/useStableRegistration.test.tsx`, `docs/refactor/multi_document_round_6_state_ownership.md`, and this roadmap.

**Validation / results:** the exact required focused command passed 6 files and 67/67 tests. The final combined seal passed 12 files with 145 passing tests and the one existing `save_must_complete_for_originating_identity_even_if_active_document_changed` expected-failure sentinel, which remains explicitly assigned to Round 10. `npx tsc --noEmit` passed. `npm run build` passed (`tsc` plus Vite, 4,566 modules); only the existing chunk-size advisory remains. `git diff --check` passed.

**Command manifest:** `npm test -- src/app/documentSession/controller.test.ts src/services/settingsService.test.ts src/app/AppWorkbench.test.tsx src/app/AppEditorStage.test.tsx src/components/InspectorPane.test.tsx src/app/documentState.test.ts`; `npm test -- src/app/documentSession/controller.test.ts src/services/settingsService.test.ts src/app/AppWorkbench.test.tsx src/app/AppEditorStage.test.tsx src/components/InspectorPane.test.tsx src/app/documentState.test.ts src/app/documentRecord.test.ts src/app/activeDocumentCompatibility.test.ts src/app/hooks/useStableRegistration.test.tsx src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx src/app/hooks/useDocumentSession.startup.test.tsx src/app/hooks/useSaveOperations.test.ts`; `npm test -- src/app/documentRecord.test.ts src/app/activeDocumentCompatibility.test.ts src/app/hooks/useStableRegistration.test.tsx`; `npx tsc --noEmit`; `npm run build`; and `git diff --check`.

**Generated outputs:** `npm run build` refreshed ignored `dist/` assets. No committed schema, persistence projection, native artifact, or generator output was required or produced.

**Remaining risks / deliberately deferred work:** Round 7 owns the headless workspace collection and additive commands; Round 8 completes keyed editor gateway/view-history ownership; Round 9 targets async results; Round 10 converts save actors and the retained expected-failure sentinel to origin-owned operations. Hook-owned parsers, validators, recovery actors, watchers, and background jobs remain classified in the ownership manifest for their named later rounds. The build chunk-size advisory is unrelated to this semantic round.

**Objective closure evidence:** the live shell reads document-specific state from one serializable aggregate; no `${format}:${filePath}` surface-preference writer remains; named journal/path/schema/authorship/presentation state is isolated by `DocumentId`; frontmatter cannot mutate defaults; all source/visual compatibility registrations carry a document key and clear before rebind; all active-only review/UI classes clear on identity change; the complete ownership manifest has no unclassified direct App state; transition, isolation, consumer, failure, exact focused, typecheck, and production-build gates pass. The reducer owned by `useDocumentSession` is the sole primary writer for the shared document dependency spine.

**Unblocks:** Round 7 is now the first open round. No Round 7 implementation was started; Round 8 retains the explicitly deferred full gateway/snapshot work.

#### Round 7 — Headless workspace registry and commands

**Status: `CLOSED` (2026-07-21).**

**Original intended outcome and preserved scope:** establish one desktop headless workspace as the owner of `DocumentRecord`s while the current production shell consumes only its active-document compatibility projection. Multi-record operation remains gated behind the internal harness activation surface. `documentsById`, tab order, active identity, MRU order, locator ownership, and close authorization agree centrally. This round did not add tabs, workspace persistence/restore, final close durability, background schedulers, editor snapshots, targeted async effects, or any Round 8+ implementation.

**Completion record:** added a pure, serializable `WorkspaceState` and reducer with open, new, activate, deactivate, focus-by-locator, document update/replace, settled single-document replacement, request/finalize close, reopen, reorder, close-others/right, and locator reservation commands. A single `WorkspaceStore` is the writable state spine for both React and the hidden harness. `useDocumentSession` now initializes that store, selects its active `DocumentRecord`, dispatches all document mutations through it, and exposes the workspace snapshot while preserving existing single-document selectors/setters. The former standalone `DocumentLocatorOwnershipIndex` was retired; workspace records and reservations are now the sole locator-ownership authority.

**Important decisions / deviations:** production creates the workspace with `multiDocumentWorkspaceEnabled: false` and no activation surface, so Open/New retain the settled one-visible-document replacement behavior. Additive open/new behavior is enabled only by the hidden harness with an explicit `WorkspaceActivationSurface`. An enabled flag without that surface refuses a second record and records `ACTIVATION_SURFACE_REQUIRED`; flag-off refusal records `MULTI_DOCUMENT_DISABLED`. Explicit-path Open resolves identity first and focuses an existing owner without dirty settlement or disk reread, while interactive picker Open preserves the established settle-before-path-selection contract. Single-document replacement carries the active document ID and source revision and fails closed when stale.

**Contracts / invariants preserved:** workspace assertions require exact agreement among `documentsById`, `tabOrder`, and MRU membership; active identity must be null or owned; record keys equal `DocumentRecord.id`; document locators and outstanding reservations are unique; multiple records require both the enabled capability and activation surface. Activation/reorder never modify document content. Close requests capture document/revision/dirty state; `finalizeRemoveDocument` requires a matching current-revision authorization, and a dirty document can be removed only through the authorized discard or completed-save outcome. Save As reservation, locator commit, alias focus, later stable-ID collision, and duplicate Open all use the same workspace authority.

**Production consumers reached:** current manual/recent/explorer/Open With Open flows through `openDocumentForSession`; New and New From Template; startup document and draft replacement; reload and bundled fallback/template commits; active session state in `useDocumentSession`; save/Save As locator reservation and rekey; and the existing `App`/workbench projection through unchanged session selectors. The active document returned by `selectActiveDocument` supplies the live shell, so the workspace is not dormant infrastructure.

**Migrations / compatibility handling:** no persisted workspace schema existed, so no stored-data migration was required. Existing session/App APIs remain compatible through active-record selectors and dispatch adapters. The Round 4 identity comparison/resolution functions remain canonical, while its temporary identity-only ownership class and test moved into the workspace reducer/index tests to avoid two writers. Interactive Open still settles before showing the picker; explicit duplicate Open is the only early-focus path. Existing save metadata and stable locator aliases are preserved when the legacy `setFilePath` compatibility callback follows a successful workspace rekey.

**Changed paths:** new `src/app/workspace/{workspaceState.ts,workspaceState.test.ts,workspaceStore.ts,hiddenWorkspaceHarness.ts,index.ts}`; `src/app/hooks/useDocumentSession.ts`; `src/app/hooks/useDocumentSession.startup.test.tsx`; `src/app/documentSession/openDocument.ts`; `src/app/documentSession/openDocument.test.ts`; `src/app/documentIdentity.ts`; `src/app/documentIdentity.test.ts`; and this roadmap.

**Testing / objective evidence:** workspace tests cover default-off refusal, flag-on/surface-missing refusal, the registered hidden activation surface, isolated Markdown/JSON/untitled-plain-text records, several untitled identities, additive/idempotent duplicate Open with alias preservation, locator indexing/reservation/rekey, later stable-file-ID collision, activation content invariance, reorder/MRU, close request/authorization/stale revision, active removal, reopen, close others/right, settled replacement fencing, JSON serialization, and 250 deterministic randomized command transitions with invariant checks after every step. Open tests prove explicit duplicate focus performs no settlement, disk read, or replacement. Startup/New tests prove production keeps exactly one active record with the capability disabled and no surface.

**Validation / results:** the exact required command passed 3 files and 37/37 tests. The extended seal passed 9 files with 132 passing tests and the one existing `save_must_complete_for_originating_identity_even_if_active_document_changed` expected-failure sentinel retained for Round 10. `npx tsc --noEmit` passed. `npm run build` passed (`tsc` plus Vite, 4,568 modules); only the existing chunk-size advisory remains. `git diff --check` passed.

**Command manifest:** `npm test -- src/app/workspace src/app/documentSession/openDocument.test.ts src/app/hooks/useDocumentSession.startup.test.tsx`; `npm test -- src/app/workspace src/app/documentIdentity.test.ts src/app/documentRecord.test.ts src/app/documentSession/openDocument.test.ts src/app/hooks/useDocumentSession.startup.test.tsx src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx src/app/hooks/useSaveOperations.test.ts src/app/AppWorkbench.test.tsx src/app/AppEditorStage.test.tsx`; `npm test -- src/app/workspace src/app/documentIdentity.test.ts src/app/documentSession/openDocument.test.ts src/app/hooks/useDocumentSession.startup.test.tsx src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx src/app/hooks/useSaveOperations.test.ts`; `npx tsc --noEmit`; `npm run build`; and `git diff --check`.

**Generated outputs:** `npm run build` refreshed ignored `dist/` assets. No committed persistence schema, migration, native projection, installer projection, or generator output was required or produced.

**Remaining risks / deliberately deferred work:** Round 8 owns the complete keyed editor gateway, view/history snapshots, and deactivation flush ordering. Round 9 targets async results; Round 10 transfers saves from active-session authority and converts the retained expected failure; Rounds 11–16 add durable persistence/recovery/lifecycle/ingress. The hidden activation surface is intentionally not production UI; Round 18 atomically registers tabs and enables multi-record production behavior.

**Objective closure evidence:** the live production session has one workspace store and derives the active record from it; current Open/New replacements dispatch workspace commands and cannot leave inaccessible records; duplicate locators focus their owner; no separate locator ownership writer remains; a second record is impossible without both capability and activation surface; the harness can create, isolate, reorder, activate, close, and reopen heterogeneous records; dirty or stale close removal fails closed; required, extended, typecheck, build, and hygiene gates pass. `WorkspaceStore` plus `workspaceReducer` are the sole primary writer for the shared workspace/document dependency spine.

**Unblocks:** Round 8 is now the first open round. No Round 8 implementation was started; editor gateway/runtime ownership remains exactly its declared scope.

#### Round 8 — Document-keyed editor gateway and view preservation

**Status: `CLOSED` (2026-07-21).**

**Original intended outcome and preserved scope:** replace the Round 4 global last-reader compatibility backend with true `DocumentId`-keyed editor ownership, serializable view preservation, and bounded per-document history. Save, recovery flush, mode switch, undo/redo, focus, and editor commands become real addressed consumers. This round did not expose tabs, enable the multi-record production capability, keep inactive heavyweight editors mounted, add targeted asynchronous effects, or change save-completion authority reserved for Rounds 9 and 10.

**Completion record:** `DocumentKeyedEditorGateway` is now the sole writable runtime spine for source/visual adapters, insert/jump/find/history/selection registrations, view snapshots, focus, read/flush/commit/deactivate, and bounded document histories. The process-global desktop reader stack was removed; `visualEditorStateSync.ts` now contains host-neutral adapter read/flush/commit semantics only. CodeMirror and Milkdown adapters capture and restore selection plus scroll. App registration points address every operation with `DocumentId`; `useDocumentSession` uses keyed histories and deactivates before record replacement; `useSaveOperations` and recovery use addressed flushes; mode switching deactivates then remounts/focuses the addressed surface.

**Important decisions / deviations:** deactivation is ordered `flush pending controls -> mark committed and dispatch the source revision -> snapshot -> remove runtime registrations`; settled workspace replacement now reads the post-flush live record/revision so the Round 7 authorization fence remains valid. A permanently replaced record is released after successful workspace replacement, while ordinary deactivation retains bounded history/view snapshots for remount. Adapter unregister is identity-checked so stale teardown cannot remove a newer same-surface adapter. The VS Code webview retains one explicit single-document reader slot with stale-disposer protection; it does not import the desktop workspace or create a second lifecycle kernel. The required extension verifier also exposed two predecessor divergences, now explicitly classified as host adapters: native source-fidelity envelopes and desktop recent-file identity migration.

**Contracts / invariants preserved:** all desktop read, flush, focus, registration, unregister, snapshot, and disposal operations are `DocumentId`-addressed; missing IDs and missing/stale adapters return safely without cross-reading or removing a newer registration. Only the active heavyweight editor is rendered by `AppEditorStage`. `DocumentRecord.view` remains the serializable authority for mode and structured selection, while the gateway owns ephemeral cursor/selection/scroll and bounded history. History is isolated by document and independent of mounted-editor warmth. Save and recovery policy, fidelity/round-trip confirmation, workspace identity, locator ownership, and later-round save/effect authority were not weakened or duplicated.

**Production consumers reached:** desktop source and visual editor adapter registrations through `AppEditorStage`; Save/Save As/autosave flush in `useSaveOperations`; page-hide and external-open recovery flush in `useDocumentSession`; document replacement and draft restoration deactivation; source-history undo/redo; mode-switch flush/deactivate/remount/focus; current export Markdown and disk-change reads in `App`/`useDocumentSession`; insert, jump, find, history, and selection commands in `App`. The VS Code webview's existing save/message flush path consumes the thin compatibility slot.

**Migrations / compatibility handling:** no persisted editor-runtime or view-snapshot schema existed, so no stored-data migration was required. Existing editor callback shapes remain compatible, with an optional retiring-adapter identity added for safe unregister. `useStableRegistration` remains the React projection helper but writes only through the primary gateway; the separate `DocumentRuntimeRegistry` was removed. The desktop `registerStateReader` escape hatch was removed from `VisualMarkdownEditor` and `ExportRenderHost`. VS Code remains deliberately single-document and its host-specific reader is classified, tested, and shared-core verified. The extension TypeScript config gained JSON-module resolution required by the already-established shared format catalog.

**Changed paths:** `src/app/{App.tsx,AppEditorStage.tsx,AppEditorStage.test.tsx,AppWorkbench.test.tsx,documentEditorGateway.ts,documentEditorGateway.test.ts}`; `src/app/hooks/{useDocumentSession.ts,useDocumentSession.visualRoundTrip.test.tsx,useSaveOperations.ts,useSaveOperations.test.ts,useStableRegistration.ts,useStableRegistration.test.tsx}`; `src/components/{editorAdapter.ts,SourceTextEditor.tsx,VisualMarkdownEditor.tsx,ExportRenderHost.tsx,visualEditorStateSync.ts,visualEditorStateSync.test.ts}`; `scie-md-vscode-extension/src/scie-md/components/{visualEditorStateSync.ts,visualEditorStateSync.test.ts}`; `scie-md-vscode-extension/{tsconfig.extension.json,scripts/verify-shared-core-sync.mjs}`; and this roadmap.

**Testing / objective evidence:** the exact required desktop suite passed 3 files with 55 passing tests and the one pre-existing Round 10 expected-failure sentinel. Extended gateway/editor/workbench suites passed 7 files with 91 passing tests plus that sentinel; adapter-focused coverage passed 4 files and 21 tests. Tests prove two-document registration-order inversion, document-keyed command lookup, source/visual targeting, dirty flush/commit/snapshot order, deactivation/remount restoration, selection/scroll snapshots, isolated bounded undo history, missing editor behavior, rapid stale unregister safety, real workspace replacement after a dirty editor flush, and active-only rendering wiring. Extension compatibility tests passed 2 files and 23 tests, including stale single-slot disposal.

**Validation / command manifest:** `npm test -- src/components/visualEditorStateSync.test.ts src/app/hooks/useSaveOperations.test.ts src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx` passed; `npm test -- src/components/visualEditorStateSync.test.ts src/app/documentEditorGateway.test.ts src/app/hooks/useStableRegistration.test.tsx src/app/hooks/useSaveOperations.test.ts src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx src/app/AppEditorStage.test.tsx src/app/AppWorkbench.test.tsx` passed; `npm test -- src/components/SourceTextEditor.test.ts src/components/VisualMarkdownEditor.test.ts src/app/documentEditorGateway.test.ts src/app/activeDocumentCompatibility.test.ts` passed; `npm --prefix scie-md-vscode-extension test -- src/scie-md/components/visualEditorStateSync.test.ts src/webview/App.test.tsx` passed; `npm --prefix scie-md-vscode-extension run typecheck` passed after `npm --prefix scie-md-vscode-extension ci` restored lockfile-declared local dependencies; `npm --prefix scie-md-vscode-extension run verify:shared-core` passed with 162 overlaps classified as 137 exact mirrors and 25 host adapters; `npm run build` passed; and `git diff --check` passed.

**Generated outputs:** `npm run build` refreshed ignored `dist/` assets. Shared-core verification was read-only and produced no committed report. No persisted workspace/editor schema, migration file, native projection, package artifact, or other generated source was required or produced.

**Remaining risks / deliberately deferred work:** Round 9 still owns targeted async result tokens and stale-result reducer guards. Round 10 still owns origin-document save completion and conversion of the retained expected-failure sentinel. Durable workspace/view persistence, multi-document recovery/lifecycle/ingress, production tabs, inactive-editor budgeting, and cross-platform stress remain in their declared later rounds. The extension dependency install reported two existing high-severity audit findings; dependency upgrades were outside this semantic round and no audit fix was applied.

**Objective closure evidence:** no desktop production code exports or imports the old global reader APIs; one gateway owns all desktop runtime registrations and histories; save and recovery call `flush(documentId)`; mode/document deactivation commits before workspace replacement and unmount; post-flush revision authorization passes in the production session test; view snapshots restore on remount; two registered documents cannot cross-read; stale/missing registrations fail safely; the active-only mount contract remains; extension behavior/typecheck/shared-core verification and desktop required tests/build/hygiene pass.

**Unblocks:** Round 9 is now the first open round. No Round 9 targeted-effect implementation was started.

#### Round 9 — Targeted asynchronous effect protocol — `CLOSED`

**Problem / scope / outcome:** make every state-mutating asynchronous result belong to a document and revision. Priority scheduling, LRU caches, inactive suspension, and general worker-pool redesign are non-goals unless focused tests already prove they are required.

**Dependencies / first consumer:** rounds 6–8 supply reducer targets, workspace identity, and editor flushes. Open/read, source-format diagnostics, `useLayerTwoDocument`, `useDocumentValidator`, linked bibliography/variable refresh, schema/review, and recovery result application are the first consumers; save authority completes in Round 10.

**Primary owner / semantic writable lease:** the primary owns `EffectToken`/operation helpers, reducer stale-result guards, `src/app/documentSession/openEffects.ts`, targeted open/diagnostic/recovery consumers, and directly affected worker result adapters. Token creation/validation and reducer guards are primary-only.

**Contracts / invariants:** every mutating result carries `{ documentId, operationId, sourceRevision }`; the reducer, not the active tab, decides acceptance; stale results are observable and harmless; cancellation is scoped to one operation/document; path/format alone never identify an untitled job; inactive Markdown layer-two/validation work may be suspended, but any retained or delayed result remains targeted and may never project into the next active document.

**Completion record:** implemented one workspace-owned `DocumentEffectCoordinator` with `{ documentId, operationId, sourceRevision }` tokens, per-document/per-kind operation channels, reducer-runtime acceptance before mutation, exact-operation cancellation, and bounded content-free `TARGET_MISSING`, `REVISION_STALE`, `OPERATION_STALE`, and `CANCELLED` diagnostics. The live `WorkspaceStore` is the single owner of this shared dependency spine.

**Production consumers reached:** the active document session now targets open/read commits and external/untitled recovery application; source-format parsing, Markdown layer-two parsing, validation timers, bibliography refresh, linked-variable refresh, JSON Schema discovery, and external conflict-review reads all validate their originating document/revision before mutating state. Active-only layer-two/validation work uses an explicit suspend-on-deactivation policy: cleanup cancels only the retiring operation, activation starts a fresh targeted operation, and cached output is identity-checked before projection.

**Important decisions / deviations:** the legacy open helper callback shape remains as a compatibility seam for its unit fixtures, while the production caller now supplies coordinator-backed currency and token-guarded commits; the former session `openRequestIdRef` was removed. `documentIdentityVersionRef` remains only inside the existing save snapshot path because transferring save authority is Round 10's named outcome and was not pulled forward. No scheduler, priority queue, LRU cache, general worker pool, persistence, save-authority, or UI/tab work was added. Focused pressure evidence did not require scheduler depth: unrelated pending worker jobs survive a document-targeted supersession, so priority/LRU/suspension remains deferred to Round 20.

**Worker/cancellation handling:** format-worker supersession uses document identity when a token is present, including multiple untitled documents whose path is `null`; exact token cancellation cannot reject another job. Large Markdown parse supersession rejects only pending work for the same `DocumentId`; a timed-out shared worker falls back unrelated queued requests synchronously instead of discarding them. Legacy untokenized worker calls retain their prior compatibility behavior.

**Migrations / compatibility:** this round changes only in-memory effect ownership; no persisted schema or generated projection required migration, and no generated output was produced. Existing helper APIs and untokenized worker callers remain compatible while all named production consumers use tokens. Save completion and its retained expected-failure sentinel remain deliberately assigned to Round 10.

**Changed-path / command manifest:** implementation: `src/app/effects/documentEffectCoordinator.ts`, `src/app/workspace/workspaceStore.ts`, `src/app/hooks/useDocumentSession.ts`, `src/app/App.tsx`, `src/app/hooks/useSourceFormatDiagnostics.ts`, `src/app/hooks/useLayerTwoDocument.ts`, `src/app/hooks/useDocumentValidator.ts`, `src/app/hooks/useJsonSchemaDiscovery.ts`, `src/app/hooks/useExternalConflictReviewWorkflow.ts`, `src/domain/document/documentParserWorker.ts`, and `src/domain/formats/formatParserWorker.ts`. Tests/fixtures: `src/app/effects/documentEffectCoordinator.test.ts`, `src/app/hooks/useDocumentValidator.test.tsx`, `src/app/hooks/useSourceFormatDiagnostics.test.tsx`, `src/app/hooks/useLayerTwoDocument.test.tsx`, `src/app/hooks/useJsonSchemaDiscovery.test.tsx`, `src/app/hooks/useExternalConflictReviewWorkflow.test.tsx`, `src/domain/document/documentParserWorker.test.ts`, and `src/domain/formats/formatParserWorker.test.ts`. Closure record: this roadmap. No generator command applied.

**Testing / objective evidence:** the exact required focused command passed 6 files and 35/35 tests. Extended targeted coverage passed 10 files and 58/58 tests, including reducer-runtime stale rejection, delayed validation across document/revision changes, two untitled parse jobs, late success/failure isolation, JSON Schema/review compatibility, linked refresh behavior, and unrelated large-parse preservation. The repository-wide regression seal passed 179 files with 1,189 passing tests and the one pre-existing Round 10 expected-failure sentinel. `npm run build` passed (`tsc` plus Vite, 4,569 modules; only the existing chunk-size advisory). `git diff --check` passed. An initial full-suite attempt exposed a fallback parse object being recreated during activation and exhausted the worker heap after 178 files; memoizing the identity-targeted fallback repaired the implementation, after which the full suite passed.

**Closure criteria satisfied:** every named current mutating async consumer reaches the workspace coordinator; acceptance is based on token target/revision rather than active tab or path; stale commits are observable and harmless; cancellation is document/operation scoped; inactive output is identity-checked; two-document, same-document revision, multiple-untitled, recovery/open compatibility, linked refresh, and unrelated-worker cases are covered; no later-round authority was implemented.

**Remaining risks / deliberately deferred work:** Round 10 owns origin-document save/autosave actors and removal of the active-identity save sentinel. Rounds 12–14 own multi-entry durable recovery and workspace watcher/conflict routing; Round 18 owns production tab activation; Round 20 owns measured scheduler/LRU/stress depth. Current inactive work is suspended by the single-visible-document compatibility projection rather than retained in a background scheduler.

**Unblocks:** Round 10 is now the first open round. No Round 10 save-authority implementation was started.

### Wave C — Per-document durability and coordinated lifecycle

#### Round 10 — Per-document save and autosave coordinator — `CLOSED`

**Status:** `CLOSED` (2026-07-21).

**Problem / scope / outcome:** transfer save authority from the active singleton to the originating document snapshot and prove the kernel with two real mounted/switching documents. This round does not add restart restore, final close-all durability, or production tabs.

**Dependencies / first consumer:** rounds 7–9 supply workspace records, keyed editor flushes, and effect tokens. Current Save, Save As, autosave, `ensureDocumentPathForAssets`/image insertion, and the hidden two-tab harness are the first consumers.

**Primary owner / semantic writable lease:** the primary owns the per-document save coordinator/runtime registry, `src/app/hooks/useSaveOperations.ts`, `src/app/hooks/useAutosaveTimer.ts`, `src/app/hooks/useImageInsertion.ts`, Save/Save As workspace commands, and the integration harness. Save actor contracts, autosave eligibility/limiting, locator rekeying, and shared status projection are primary-only.

**Contracts / invariants:** an in-flight save is owned by `{ documentId, sourceRevision, locator, metadataBaseline }`, not by `activeDocumentId`; switching tabs may suppress irrelevant active-tab UI but cannot abort the originating disk write; eligible inactive saved documents continue autosave under the Section 6.3 one-write workspace limiter; deactivation itself does not force disk save; each document has one serial lane; asset-driven Save As remains tied to its originating untitled document; Save As collision/rekey is fenced; backup and fidelity preconditions remain fail-closed.

**Completion record:** the workspace store now owns one `WorkspaceSaveCoordinator`, which is the production writer for document-keyed save actors, per-document serial lanes, per-document debounce/max-wait autosave runtimes, queue projection, deterministic Save All, and one globally bounded native-write scheduler with waiting manual writes ahead of waiting autosaves. Save tokens carry `DocumentId`, source revision, locator, metadata baseline, operation ID, and request kind. `useSaveOperations` flushes and snapshots the addressed record, queues through that coordinator, continues after activation changes, fences stale locator/revision commits, refreshes an intentionally committed Save As locator, and applies saved baseline/metadata/status only to the origin. Edits made during a write remain dirty against the written snapshot; autosave edits coalesce into one follow-up operation.

**Important decisions / deviations:** the active single-document compatibility API remains as a test/legacy fallback, but production workspace calls use the shared coordinator and do not create a second writer. Inactive save actors are deliberately retained by the workspace runtime so a mounted-to-unmounted activation transition does not destroy queued save/autosave ownership. Save All is a headless command-layer operation in this round; UI exposure remains later work. A production-backed version of the Round 1 hazard test exposed and fixed a coordinator acceptance bug for valid `void` mutations. An extended recovery test exposed and fixed clean-untitled autosave status churn; dirty untitled, conflicted, parser-blocked, and non-writable documents remain paused/recovery-only.

**Production consumers reached:** current App Save, Save As, Save Anyway, shortcut/topbar/workbench save callbacks, document-session autosave, `ensureDocumentPathForAssets`, and image insertion all reach the workspace-owned coordinator/effect spine. Asset insertion carries the originating `DocumentId` through Save As, copy, and addressed editor-gateway insertion, so a later activation cannot redirect it. The feature-flagged hidden React workspace harness mounts/unmounts keyed adapters while two records save and a delayed inactive completion commits.

**Migrations and compatibility handling:** no persisted schema, native DTO, or generator input changed, so no data migration was required. The pre-workspace hook queue/timer behavior remains only as compatibility fallback for isolated callers/tests. Existing fail-closed backup, fidelity-review, conflict, atomic-write, recovery-draft, format inference, locator reservation, and collision behavior was preserved. The Round 1 `it.fails` sentinel is now an ordinary workspace-backed passing test with the original assertion intact.

**Changed-path manifest:** `docs/refactor/multi_document_workbench_refactor_wave.md`; `src/app/workspace/workspaceSaveCoordinator.ts`; `src/app/workspace/workspaceSaveCoordinator.test.ts`; `src/app/workspace/workspaceStore.ts`; `src/app/workspace/index.ts`; `src/app/workspace/hiddenWorkspaceSaveHarness.test.tsx`; `src/app/hooks/useSaveOperations.ts`; `src/app/hooks/useSaveOperations.test.ts`; `src/app/hooks/useAutosaveTimer.ts`; `src/app/hooks/useImageInsertion.ts`; `src/app/hooks/useImageInsertion.test.tsx`; `src/app/hooks/useDocumentSession.ts`; `src/app/effects/documentEffectCoordinator.ts`; and `src/app/App.tsx`.

**Validation / command manifest:** required `npm test -- src/app/hooks/useSaveOperations.test.ts src/app/hooks/useAutosaveTimer.test.tsx src/app/hooks/useImageInsertion.test.tsx src/app/workspace` passed (6 files, 74/74); extended production-session command `npm test -- src/app/hooks/useDocumentSession.startup.test.tsx src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx src/app/AppWorkbench.test.tsx src/app/AppEditorStage.test.tsx` passed (4 files, 58/58); `npx tsc --noEmit` passed; required `npm run build` passed (`tsc` plus Vite, 4,570 modules; only the existing chunk-size advisory); and `git diff --check` passed.

**Generated outputs:** Vite regenerated ignored `dist/` build artifacts during validation. No tracked projection, schema, fixture generator output, native registration, or migration artifact changed.

**Remaining risks / deliberately deferred work:** durable versioned persistence remains Round 11; multi-entry recovery and workspace restore remain rounds 12–13; workspace watcher/conflict routing remains Round 14; close-all durability remains Round 15; production tabs remain Round 18; measured scheduler/LRU/stress depth remains Round 20. Save All has no user-visible multi-tab control before those later consumers. No part of those rounds was implemented here.

**Objective closure evidence:** the normal Round 1 regression starts a save through the real workspace store, activates another record during delayed file verification, completes the origin write, updates only the origin baseline, and leaves the second record and active ID unchanged. Coordinator tests prove one native writer, manual priority, independent lanes, retained inactive autosave, blocked recovery-only behavior, edit-during-save follow-up coalescing, commit-time and pre-native-write locator fencing, `void` commit acceptance, and deterministic Save All. Image tests prove delayed asset work inserts only through the originating keyed runtime after activation changes. The hidden two-document React harness proves keyed mount/unmount, isolated history, simultaneous saves, delayed inactive completion, targeted effects, empty-dirty recovery-to-clean transition, and no cross-record mutation. All required commands pass, so the **kernel-proven milestone** is satisfied.

**Non-goals preserved / unblocks:** no restart restore, persistence registry, multi-entry recovery catalog, workspace watcher, close transaction, additive production ingress, tab chrome, or semantic source presentation was added. Round 11 is now the first open round.

#### Round 11 — Versioned persistence, migrations, and crash consistency — CLOSED

**Status:** `CLOSED`

**Problem / scope / outcome:** create the minimum versioned persistence authority required by the upcoming recovery catalog and workspace manifest. This round does not rewrite every settings/grants store or require a universal multi-generation protocol.

**Dependencies / first consumer:** Round 10 proves in-memory ownership. The current draft-recovery store is migrated to the versioned authority first; rounds 12–13 are its next consumers.

**Primary owner / semantic writable lease:** the primary owns new persistence registry/migration modules, recovery serialization in `src/services/draftRecoveryService.ts`, relevant native recovery DTOs in `src-tauri/src/commands/diagnostics.rs`, and migration fixtures. Schema versions, migrator order, quarantine, checksum/generation rules, and exports are primary-only.

**Contracts / invariants:** every adopted payload declares a schema version; migrations are sequential/idempotent; unknown-future/corrupt payloads are quarantined, not normalized destructively; recovery content is committed before any manifest reference; tombstones are idempotent; startup reconciliation can repeat safely.

**Completion record:** added the primary-owned persistence registry for recovery and workspace-manifest payload families, current-version envelopes, deterministic checksums, monotonic generations, pending/committed markers, sequential migrations, validation, nondestructive quarantine, recovery-first publication ordering, repeatable orphan/stale reconciliation, and idempotent tombstones. The live browser `draftRecoveryService` now stores and restores versioned recovery envelopes through that registry across local storage, IndexedDB, and memory fallback. Native recovery DTOs and diagnostics persistence now use schema 3, generation/checksum/commit validation, atomic current/previous generations, deterministic quarantine, legacy migration, and previous-generation fallback. Empty and whitespace-only dirty source remains valid recovery content.

**Important decisions / deviations:** the minimum authority is intentionally limited to `recoveryDraft` and a reusable `workspaceManifest` contract; settings and path-grant stores are explicitly recorded as deferred. Browser publication retains the last valid local copy until IndexedDB commit succeeds, and quarantine removes an invalid source only after its preserved copy commits. Native diagnostics remains the sole native snapshot writer; the shared registry remains the sole browser schema/migration/checksum policy writer. No universal persistence protocol, all-store rewrite, multi-entry catalog, or workspace restore was introduced.

**Production consumers reached:** the current `draftRecoveryService` read/write/load/prune paths consume the registry, including the real `useDocumentSession` startup and visual round-trip flows. `nativeRecoveryService` sends committed schema-3 DTOs to the production Tauri `write_recovery_snapshot` command, whose corresponding production read/clear paths validate, migrate, quarantine, fall back, and tombstone the addressed snapshots.

**Migrations and compatibility handling:** unversioned, schema-1, and schema-2 recovery data migrate sequentially and idempotently to schema 3; the shared released fixture includes legacy empty/plain-text and structured-format content plus native future/interrupted cases. Existing keyed and latest native snapshot locations remain readable, the pre-Round-4 native recovery key remains a compatibility lookup, and latest native snapshots remain a compatibility mirror. Unknown future versions, malformed JSON/shapes, checksum failures, and pending publications fail closed into deterministic quarantine without destructive normalization. Settings and grants retain their existing formats.

**Changed-path manifest:** `src/services/persistence/persistenceRegistry.ts`; `src/services/persistence/index.ts`; `src/services/persistence/persistenceRegistry.test.ts`; `src/services/persistence/fixtures/recoveryPersistence.v1.json`; `src/services/draftRecoveryService.ts`; `src/services/draftRecoveryService.test.ts`; `src/services/nativeRecoveryService.ts`; `src-tauri/src/commands/diagnostics.rs`; `src-tauri/src/lib.rs`; and this roadmap.

**Tests and validation results / command manifest:** `npx tsc --noEmit` passed. `npm test -- src/services/persistence/persistenceRegistry.test.ts src/services/draftRecoveryService.test.ts src/services/rawDocumentRescue.test.ts src/services/settingsService.test.ts` passed 69/69 tests. The required `npm test -- src/services/draftRecoveryService.test.ts src/services/rawDocumentRescue.test.ts src/services/settingsService.test.ts` passed 53/53 tests. `npm test -- src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx src/app/hooks/useDocumentSession.startup.test.tsx` passed 27/27 production-session tests. The required `cargo test --manifest-path src-tauri/Cargo.toml --lib diagnostics` passed 9/9 diagnostics tests with 112 filtered out. `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` and `git diff --check` passed. The required `npm run build` passed; Vite emitted only its existing advisory for chunks over 500 kB.

**Generated outputs:** `npm run build` regenerated ignored `dist/` output successfully. No checked-in generated projection or schema artifact was required or changed; the shared JSON fixture is source-controlled test input, not a generated projection.

**Remaining risks / deliberately deferred work:** multi-entry recovery keys/catalog ownership, global lifecycle flushing, pruning policy across documents, and recovery-center models remain Round 12; workspace manifest persistence and restart restore remain Round 13; settings/path-grant adoption and any final DTO convergence remain deferred unless later consumers or the Round 20 audit require them. The compatibility latest-snapshot mirror remains intentionally single-entry until Round 12 replaces singleton recovery ownership.

**Objective closure evidence:** released legacy fixtures restore deterministically and repeated migration produces the same schema-3 checksum; browser and native future/interrupted/corrupt cases preserve their raw source in quarantine; browser publication fault injection and native corrupt-current tests retain or restore the last valid generation; schema/checksum/commit markers reject incomplete adoption; repeated tombstone removal is harmless; reconciliation tests classify live, orphan, and stale references repeatably; recovery-first tests prove manifest publication cannot precede a committed recovery reference. Current recovery is a real production consumer, and the workspace-manifest types expose the storage semantics Round 12/13 need without implementing either later round.

**Non-goals preserved / unblocks:** no settings/grants migration, universal store rewrite, multi-document recovery catalog, restart workspace restore, watcher/close transaction, production tab UI, or later-round infrastructure was added. Round 12 is now the first open round; all-store convergence and additional DTO depth remain eligible for Round 20 only if its final audit requires them.

#### Round 12 — Multi-document, format-generic recovery catalog

**Status: `CLOSED`**

**Problem / scope / outcome:** give every dirty document an independent, format-correct recovery record without synchronous writes on every keystroke. Workspace layout restoration remains Round 13.

**Dependencies / first consumer:** Round 1 supplies the complete timer/visibility/pagehide/beforeunload baseline; rounds 7, 10, and 11 supply workspace identity, revisioned save state, and versioned storage. The hidden workspace, current session recovery hooks, and renderer lifecycle handlers are the first consumers.

**Primary owner / semantic writable lease:** the primary owns `src/services/draftRecoveryService.ts`, `src/services/rawDocumentRescue.ts`, native recovery commands, workspace recovery coordination, the recovery listeners currently in `useDocumentSession`, and adjacent renderer/close lifecycle integration. Recovery keys, catalog schema, global flush entry points, pruning, checkpoint, and tombstone semantics are primary-only.

**Contracts / invariants:** recovery is keyed by `DocumentId` plus optional locator; empty dirty source is valid; checkpoint lag is measured/bounded; close/quit/destructive removal awaits the current revision; one document's activation or save cannot clear another's recovery; all timer/visibility/pagehide/beforeunload entry points route through one workspace coordinator; ordinary app close uses awaited barriers, while abrupt unload uses a best-effort targeted native/synchronous fallback and never clears unconfirmed entries; pruning never removes the only current dirty representation; MIME/extensions are format-correct.

**Completion record:** implemented a schema-1 multi-entry recovery catalog keyed by `DocumentId`, with optional canonical locator, source revision, format-derived MIME, complete browser source, bounded native rescue projection, Round 11 envelopes/generations, IndexedDB publication, native replication, deterministic corrupt/interrupted quarantine, recovery-center projection, quota state, and revision-fenced tombstones. `WorkspaceRecoveryCoordinator`, owned by the one `WorkspaceStore`, is now the sole production checkpoint/cleanup writer: it observes all records, coalesces dirty work at 600 ms with a 2,000 ms maximum wait, prioritizes deactivated records, flushes editor state by `DocumentId`, maintains recovery lifecycle state/metrics, and owns the single visibility-hidden/pagehide/beforeunload recovery path. Raw rescue state and exports are multi-entry and format-generic; an empty dirty source remains a first-class record.

**Important decisions / deviations:** the catalog extends Round 11's schema-3 recovery payload with optional schema-1 catalog metadata instead of invalidating released envelopes. Browser local storage remains the synchronous abrupt-unload durability floor; the coordinator immediately follows it with best-effort asynchronous IndexedDB/native replication and never clears an unconfirmed entry. Native legacy-count pruning explicitly excludes catalog documents, while catalog quota pressure becomes `attention-required` rather than selecting current dirty content for deletion. Full catalog-to-workspace restoration and its UI were not pulled forward from Round 13.

**Production consumers reached:** the live `useDocumentSession` configures the workspace coordinator with the keyed editor gateway and attaches its lifecycle handlers; `useSaveOperations` preserves failed writes and clears successful saves through addressed recovery operations; current Save-and-close, Discard-and-close, external-open preservation, and headless workspace removal use current-revision barriers; `WorkspaceStore` and the hidden workspace harness own the same coordinator; native diagnostics commands read/write/list/clear catalog entries; `App` error-boundary rescue export reads the generic catalog rather than a singleton Markdown slot.

**Migrations and compatibility handling:** unversioned/schema-1/schema-2 singleton drafts continue to load through the Round 11 registry and are cleared only after the addressed catalog checkpoint commits. Released path-keyed and untitled browser/native APIs remain isolated compatibility adapters for startup and older callers; current workspace writes do not use them as authority. Native schema-3 checksums remain byte-compatible when catalog fields are absent, legacy keyed/latest locations remain readable, and new native clears are fenced by `DocumentId` plus source revision so stale saves and repeated tombstones are harmless.

**Changed-path manifest:** catalog/registry: `src/services/recoveryCatalog.ts`, `src/services/recoveryCatalog.test.ts`, `src/services/persistence/persistenceRegistry.ts`, `src/services/persistence/persistenceRegistry.test.ts`, `src/services/persistence/fixtures/recoveryPersistence.v1.json`; rescue/native adapters: `src/services/rawDocumentRescue.ts`, `src/services/rawDocumentRescue.test.ts`, `src/services/nativeRecoveryService.ts`; workspace/session consumers: `src/app/workspace/workspaceRecoveryCoordinator.ts`, `src/app/workspace/workspaceRecoveryCoordinator.test.ts`, `src/app/workspace/workspaceStore.ts`, `src/app/workspace/hiddenWorkspaceHarness.ts`, `src/app/workspace/index.ts`, `src/app/hooks/useDocumentSession.ts`, `src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx`, `src/app/hooks/useSaveOperations.ts`, `src/app/App.tsx`; native host: `src-tauri/src/commands/diagnostics.rs`, `src-tauri/src/lib.rs`; documentation: this roadmap.

**Tests and validation results / command manifest:** `npx tsc --noEmit` passed. The required `npm test -- src/services/draftRecoveryService.test.ts src/services/rawDocumentRescue.test.ts src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx src/app/workspace` passed 7 files and 83/83 tests. `npm test -- src/services/persistence/persistenceRegistry.test.ts src/services/recoveryCatalog.test.ts src/services/rawDocumentRescue.test.ts src/app/workspace/workspaceRecoveryCoordinator.test.ts src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx` passed 5 files and 47/47 tests before the final explicit 600 ms measurement and format-correct export coverage were added; the required run contains both added passing tests. `npm test -- src/services/recoveryCatalog.test.ts src/services/persistence/persistenceRegistry.test.ts src/app/hooks/useSaveOperations.test.ts src/app/hooks/useDocumentSession.startup.test.tsx src/services/rawDocumentRescue.stress.test.ts` passed 4 discovered files and 84/84 tests (the named stress path has no matching file). The required `cargo test --manifest-path src-tauri/Cargo.toml --lib diagnostics` passed 11/11 tests with 112 filtered out. `npm run validate:tauri-contract` passed with 57 registered commands covering 56 TypeScript invokes. `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, `git diff --check`, and the roadmap closure-structure/current-marker assertion passed. The required `npm run build` passed; Vite emitted only its existing chunk-size advisory.

**Generated outputs:** the production build regenerated ignored `dist/` assets only. No checked-in projection, generator input, public package artifact, or migration executable was generated.

**Remaining risks / deliberately deferred work:** Round 13 still owns deterministic cold/warm workspace manifest restore and recovery-selection UI; Round 14 owns workspace watchers; Round 15 owns the unified multi-document close/quit transaction; Round 16 owns additive ingress; Round 18 owns production tabs; Round 20 owns release-scale stress and packaged crash certification. The production capability remains single-visible-document until those rounds, but its real recovery owner is already the multi-document workspace coordinator.

**Objective closure evidence:** shared browser/Rust fixtures restore saved and multiple untitled Markdown/JSON/plain-text entries, including `""`, with matching identity/revision/format/MIME. Catalog tests prove independent cleanup, stale-clear rejection, idempotent tombstones, native resurrection fencing, quarantine, and quota signaling. Workspace tests prove simultaneous checkpoints, exactly one lifecycle listener set, all-record abrupt fallback, activation/deactivation prioritization, a measured 600 ms ordinary checkpoint and 199 ms deactivation checkpoint, edit-during-flush repetition, and awaited destructive removal. Native tests prove distinct untitled keys, format metadata, migration/crash behavior, and that legacy quota pruning retains a catalog document's only dirty representation. The live session/save/close consumers use the coordinator, all required commands and build pass, and no later-round manifest/restore/tab implementation was introduced.

**Non-goals preserved / unblocks:** no workspace manifest publication/restore, full recovery UI, workspace watcher, unified close-all/quit decision model, additive production ingress, tab chrome, or later-round certification infrastructure was added. Round 13 is now the first open round; Round 12's catalog and barriers unblock deterministic workspace restore and the later Round 15 close transaction.

#### Round 13 — Workspace manifest and deterministic restore — `CLOSED`

**Status: `CLOSED` (2026-07-21).**

**Problem / scope / outcome:** persist and restore workspace structure while keeping clean file content on disk and dirty content in recovery. Production startup consumes the single-visible-document path; multi-document restore remains under the internal workspace flag until Round 18. This round does not expose a tab strip or duplicate saved-file contents into the manifest.

**Dependencies / first consumer:** rounds 11–12 supply versioned persistence and recovery references. The current desktop startup/session selection path is the first production consumer.

**Primary owner / semantic writable lease:** the primary owns workspace manifest DTOs/migrations, restore orchestration, and startup integration in `useDocumentSession.startup`/document launch code. Manifest schema, restore precedence, hydration ordering, and generated registrations are primary-only.

**Contracts / invariants:** manifest stores order/identity/locator/view/presentation/recovery references, not duplicate clean source; dirty recovery is written before the referring manifest; cold-start and warm-launch follow the Section 6.7 precedence order; one bad entry cannot block healthy startup; when `multiDocumentWorkspaceEnabled` is off or no activation surface exists, extra manifest entries are preserved but not instantiated as inaccessible `DocumentRecord`s.

**Completion record:** implemented schema-2 workspace manifests with sequential schema-1 migration, current/previous/pending crash-consistent publication, invalid-entry isolation, and recovery-first publication through one store-owned `WorkspaceManifestCoordinator`. Manifests persist tab order, active/MRU identity, canonical locators, serializable view/presentation state, and exact recovery generations while excluding both clean and dirty source text. Recovery catalog checkpoints now retain the saved-source baseline beside dirty source so empty dirty documents restore correctly without putting content in the manifest.

Desktop `useDocumentSession` startup is the real production consumer. It applies the Section 6.7 order: explicit OS/protocol launch remains visible; exact referenced recovery wins next; saved manifest follows; orphan untitled recovery follows; welcome/legacy fallback is last. Warm single-instance launches never invoke workspace restore. Active restoration is awaited first, remaining flagged records hydrate with bounded concurrency, and capability-off/no-surface startup instantiates at most one usable record while preserving all extras for a later activation surface.

**Important decisions / deviations:** corrupt document shapes and duplicate locators are isolated as actionable outcomes instead of invalidating healthy entries. Future/invalid manifest envelopes are deterministically quarantined and surfaced as a workspace-level actionable outcome; a previous committed generation is used when available. A stable-ID locator that is no longer at its recorded path is classified as potentially moved; path-only absence remains missing. Orphan saved-file recoveries remain in the recovery-center model rather than silently becoming the visible document, while orphan untitled recovery participates in startup precedence. No Round 14 watcher-based relocation was pulled forward.

**Production consumers reached:** `useDocumentSession` desktop/browser startup selection, the live `WorkspaceStore` dependency spine, and the current single-visible-document compatibility projection. The hidden workspace activation surface exercises multi-record restore without exposing production tabs.

**Migrations and compatibility:** released schema-1 manifest stubs migrate sequentially and idempotently to schema 2 using fixture-backed tests. Missing optional saved baselines in older recovery entries continue to use the disk read baseline. Unknown/future/checksum/interrupted values fail closed into quarantine. Capability-off manifests preserve inaccessible extras and their invalid-entry ledger across subsequent writes. Existing singleton untitled/file draft fallback remains last in precedence.

**Changed paths:** `src/services/persistence/{workspaceManifestSchema.ts,persistenceRegistry.ts,persistenceRegistry.test.ts,index.ts,fixtures/workspaceManifestPersistence.v1.json}`; `src/services/{workspaceManifestService.ts,workspaceManifestService.test.ts,recoveryCatalog.ts}`; `src/app/workspace/{workspaceManifestCoordinator.ts,workspaceManifestCoordinator.test.ts,workspaceRestore.ts,workspaceRestore.test.ts,workspaceRecoveryCoordinator.ts,workspaceState.ts,workspaceStore.ts,index.ts}`; `src/app/hooks/{useDocumentSession.ts,useDocumentSession.startup.test.tsx}`; this roadmap.

**Tests and validation:** `npm test -- src/app/hooks/useDocumentSession.startup.test.tsx src/app/startupOpenFailure.test.ts src/services/draftRecoveryService.test.ts src/app/workspace` passed (9 files, 96 tests); the closure-focused manifest/migration/restore command `npm test -- src/app/workspace/workspaceRestore.test.ts src/app/workspace/workspaceManifestCoordinator.test.ts src/services/workspaceManifestService.test.ts src/services/persistence/persistenceRegistry.test.ts` passed (4 files, 30 tests); `npx tsc --noEmit` passed; `npm run build` passed (4,578 modules transformed; only the pre-existing Vite large-chunk advisory remained).

**Generated outputs:** the production build regenerated ignored `dist/` assets. The committed migration projection is `src/services/persistence/fixtures/workspaceManifestPersistence.v1.json`; no other generated source projection was required.

**Remaining risks / deliberately deferred work:** Round 14 owns watcher-driven move/rename resolution and workspace conflict routing; Round 15 owns unified multi-document close/quit durability; Round 16 owns additive ingress; Round 18 owns the production tab activation surface. The native recovery fallback does not carry the new optional saved-source baseline, so an older/browser-unavailable native-only recovery uses the current disk baseline; dirty source remains recoverable. Packaged crash/stress certification remains Round 20.

**Objective closure evidence:** restart tests prove production adoption of persisted source-mode view/presentation; restore tests prove recovery-before-manifest winner selection, several dirty documents, active-first/bounded hydration, clean-from-disk/dirty-from-catalog ownership, partial failures, missing/moved/permission outcomes, duplicate/corrupt isolation, deterministic repeat restore, orphan policy, capability-off preservation, and later flagged restoration. Coordinator tests prove recovery is committed before the sole manifest writer publishes its reference and prove no pre-activation dormant write. Raw-storage assertions prove neither clean nor dirty source appears in the manifest. Migration fixtures prove schema-1 order/active/reference conversion and idempotent schema-2 decode. The required focused command and production build pass, so Round 13 is closed and unblocks Round 14 without implementing it.

**Non-goals preserved / unblocks:** no tab strip, production multi-document activation, workspace watcher/conflict coordinator, unified close-all transaction, additive ingress rewrite, or packaged certification was added. Round 14 is now the first open round.

#### Round 14 — Workspace external-change and conflict coordinator — `CLOSED`

**Status: `CLOSED` (2026-07-21).**

**Problem / scope / outcome:** turn the existing multi-scope watcher service into one canonical-locator/document coordinator. This round does not redesign file identity or create one hook/poller per mounted editor.

**Dependencies / first consumer:** Round 4 eliminated competing path authorities; rounds 7 and 13 provide open document ownership and restored locators. `useExternalChangeDetection` and the existing conflict review UI are the first consumers.

**Primary owner / semantic writable lease:** the primary owns `src/services/fileWatchService.ts`, `src/app/hooks/useExternalChangeDetection.ts`, workspace conflict routing, lifecycle transitions, and native watcher DTOs only as required. Locator routing and event/state taxonomy are primary-only.

**Contracts / invariants:** one canonical locator has one watcher/poll state machine; events target `DocumentId`; self-save echoes are correlated/suppressed; modified, missing, renamed/moved, permission-lost, read-only, cloud-unavailable, and fallback states stay distinct; inactive documents retain actionable state without mounting editors.

**Completion record:** added one store-owned `WorkspaceExternalChangeCoordinator` as the sole production writer for watcher registration, native-event routing, fallback polling/retry, burst coalescing, self-save echo correlation, typed external/access lifecycle transitions, and inactive-document notifications. It observes the union of restored/open file locators and registers that union through the existing process-wide `fileWatchService` scope. Event routing uses Round 4 `DocumentLocator` comparison and targets `DocumentId`; the former hook-local path comparator, listener, timers, retry state, polling interval, and random watcher scope were removed.

The coordinator distinguishes `changed`, `missing`, stable-ID `renamed` suspicion, `unknown`, `permissionLost`, `readOnly`, and `cloudUnavailable`, stores observed external metadata on the addressed record, and marks only that record's autosave as conflicted. Clean same-content metadata changes are adopted; a disk value matching the saved baseline refreshes metadata without clearing newer local edits. Save completion records a bounded metadata echo before committing its baseline so native events from the workspace's own write cannot create a false conflict. Active editor source reads remain `DocumentId`-addressed through the Round 8 gateway.

**Important decisions / deviations:** the low-level watcher service remains the native union-registration transport because it already coalesces all scopes and preserves a successfully applied watcher when replacement fails; workspace policy moved above it rather than duplicating native ownership. Native events remain raw hints and the coordinator re-stats/reads before classifying state. A missing stable-ID locator is reported as `renamed`/moved suspicion without guessing a new path; actual relocation resolution stays out of scope. Fallback notification never overwrites a stronger per-document conflict/access notification. Read-only is an additive optional metadata field, defaulting false for legacy/browser hosts.

**Production consumers reached:** live `WorkspaceStore`; production `useDocumentSession` configuration; the active `useExternalChangeDetection` compatibility projection; current status/conflict-review UI in `App`; workspace save completion; targeted Reload Disk, Keep Local, Save Anyway/overwrite, and compare operations; restored workspace records and the hidden multi-record activation surface. Inactive records receive lifecycle and notification updates without mounting editors.

**Migrations and compatibility handling:** no persisted schema version changed. `FileMetadata.readOnly` is optional at host compatibility inputs and normalized through the existing default; native Rust DTOs always emit it. Existing watcher host methods and raw native event shape remain compatible. Existing conflict-review reads retain Round 9 document/revision effect fencing. The old hook API was intentionally narrowed to a projection of the coordinator; it no longer owns registration or state mutation.

**Changed paths:** `src/app/workspace/{workspaceExternalChangeCoordinator.ts,workspaceExternalChangeCoordinator.test.ts,workspaceStore.ts,index.ts}`; `src/app/{documentRecord.ts,documentRecord.test.ts,documentState.ts,App.tsx}`; `src/app/hooks/{useExternalChangeDetection.ts,useExternalChangeDetection.test.tsx,useExternalConflictReviewWorkflow.ts,useExternalConflictReviewWorkflow.test.tsx,useDocumentSession.ts,useDocumentSession.startup.test.tsx,useSaveOperations.ts}`; `src-tauri/src/commands/file_io.rs`; this roadmap. `src/services/fileWatchService.ts` remains the reused low-level production union writer and required focused tests cover it; no competing service was added.

**Tests and validation:** required `npm test -- src/services/fileWatchService.test.ts src/app/hooks/useExternalChangeDetection.test.tsx src/app/hooks/useExternalConflictReviewWorkflow.test.tsx src/app/workspace` passed (10 files, 69 tests). The final production/state/session/save regression command `npm test -- src/app/documentRecord.test.ts src/app/hooks/useDocumentSession.startup.test.tsx src/app/hooks/useSaveOperations.test.ts src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx src/app/AppWorkbench.test.tsx` passed (5 files, 85 tests), including 19 production startup cases. `cargo test --manifest-path src-tauri/Cargo.toml --lib file_watcher` passed 6/6; focused native read-only metadata passed 1/1; `npm run validate:tauri-contract` passed (57 registered commands, 56 TypeScript invokes); `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, `npx tsc --noEmit`, and `npm run build` passed (4,579 modules transformed; only the existing Vite large-chunk advisory remained).

**Generated outputs:** `npm run build` regenerated ignored `dist/` assets. No checked-in generated source, migration fixture, registry projection, or generator input changed.

**Remaining risks / deliberately deferred work:** resolving a moved stable file to its new path requires Round 16 ingress/identity reconciliation or Round 20 platform certification; this round retains actionable `renamed` state without guessing. Round 15 owns aggregate close/quit durability over these conflict states. Round 17 owns aggregate shell projection, Round 18 exposes inactive notifications through tabs, and Round 20 owns packaged watcher/cloud/fault stress. No multi-document close transaction or tab UI was implemented.

**Objective closure evidence:** coordinator tests prove one listener and one union registration for restored records, alias event routing through canonical locators, two-file isolation, burst coalescing, inactive conflict retention, distinct missing/renamed/permission/cloud/read-only states, one centralized fallback poller and retry recovery, self-save echo suppression with later edits still dirty, and targeted compare/keep/reload/overwrite commands. The production startup test proves a real native watcher callback updates the live session's conflict projection through workspace state. Hook tests prove mounts subscribe only to addressed events and own no watcher/poller. Existing conflict-review tests prove targeted document/revision fencing. Native tests prove union filtering/path aliases and read-only metadata; all required commands and the build pass.

**Non-goals preserved / unblocks:** no file-identity redesign, per-editor poller, speculative relocation, close/quit transaction, additive ingress rewrite, production tabs, or broad packaged certification was added. Round 15 is now the first open round.

#### Round 15 — Unified close and quit durability transaction — `CLOSED`

**Status: `CLOSED` (2026-07-21).**

**Problem / scope / outcome:** make close tab, close groups, close all, and window quit one durability transaction. This round does not design the final tab strip.

**Dependencies / first consumer:** rounds 10, 12–14 supply save actors, recovery barriers, manifest persistence, and conflict states. The current window close guard, window chrome close affordance, and headless `requestClose` commands are the first consumers.

**Primary owner / semantic writable lease:** the primary owns the workspace close coordinator, `src/app/hooks/useWindowCloseGuard.ts`, `src/app/hooks/useWindowChrome.ts`, workspace dirty-summary projection, close decision UI/model, and integration with save/recovery/manifest actors. Transaction ordering, aggregate dirty authority, and `finalizeRemoveDocument` authorization are primary-only.

**Contracts / invariants:** targeted editor flush precedes dirty evaluation; every addressed document reaches save/discard/cancel/recovery settlement; Cancel is non-destructive; partial Save All preserves unresolved documents; recovery cleanup/tombstones and manifest publication are awaited; window destruction occurs last; window close protection and close affordances use aggregate dirty/saving/conflict/recovery counts, never only the active document.

**Completion record:** one store-owned `WorkspaceCloseCoordinator` now supplies the transaction API for one document, close others, close right, close all, and quit. It snapshots addressed `DocumentId`/revision targets, flushes each addressed editor before evaluation, checkpoints current-revision recovery, exposes a content-free `WorkspaceDirtySummary`, and presents one stable multi-document decision model with Save Selected, Discard Selected, Review Conflicts, Retry, and Cancel. Save/discard results are isolated per document; successful siblings may settle while failures remain open, recoverable, and actionable.

Projected post-close workspace state is durably published before the coordinator dispatches the only production `finalizeRemoveDocument` authorizations. Close publication can require durable storage and fails closed instead of accepting the manifest service's ordinary in-memory compatibility fallback. Quit skips document removal so the workspace remains restorable, but still awaits targeted recovery settlement and the exact current manifest before invoking window destruction. Discard-on-quit does not get re-checkpointed during that final publication. A bounded timeout converts hung save/recovery/manifest/window operations into explicit partial failure; it never silently proceeds.

**Important decisions / deviations:** the existing single-document `UnsavedDialog` remains the production compatibility view until Round 18, but it now consumes the coordinator's aggregate decision count and uses Save Selected/Discard Selected labels for multiple targets. `useWindowCloseGuard` intercepts every native close request and owns the final window-destruction permit; `useWindowChrome` routes directly through that same transaction rather than inspecting an active-document dirty Boolean. Browser `beforeunload` remains a synchronous aggregate protection signal, while app-initiated close uses the full asynchronous transaction. The former public `finalizeRemoveWithRecovery` alternate writer was removed; reducer authorization remains a lower-level invariant boundary used by the coordinator and its state tests.

**Production consumers reached:** the current Tauri window close listener, titlebar close affordance, browser unload protection, `useDocumentSession` Save/Discard/Cancel handlers, `AppOverlays`/`UnsavedDialog`, and the headless workspace close-document/others/right/all commands all use or project the coordinator. The live editor gateway, workspace save actors, recovery coordinator, manifest coordinator, and workspace reducer form one dependency spine owned by `WorkspaceStore`.

**Migrations and compatibility handling:** no persisted schema or public host DTO changed, so no data migration was required. `saveWorkspaceManifest` retains its ordinary in-memory fallback by default; only the destructive close barrier requests durable storage and treats its absence/failure as unresolved. The manifest coordinator gained explicit-state publication so it can persist the projected post-close order before removal. Existing single-document dialog callbacks and reducer close authorization shapes remain compatible.

**Changed paths:** `src/app/workspace/{workspaceCloseCoordinator.ts,workspaceCloseCoordinator.test.ts,workspaceStore.ts,workspaceState.ts,workspaceRecoveryCoordinator.test.ts,workspaceManifestCoordinator.ts,index.ts}`; `src/app/hooks/{useWindowCloseGuard.ts,useWindowCloseGuard.test.tsx,useWindowChrome.ts,useWindowChrome.test.tsx,useDocumentSession.ts}`; `src/app/{App.tsx,AppOverlays.tsx}`; `src/components/UnsavedDialog.tsx`; `src/services/workspaceManifestService.ts`; this roadmap.

**Tests and validation:** required `npm test -- src/app/hooks/useWindowCloseGuard.test.tsx src/app/hooks/useWindowChrome.test.tsx src/app/hooks/useSaveOperations.test.ts src/services/draftRecoveryService.test.ts src/app/workspace` passed (12 files, 139 tests). Integration regression `npm test -- src/app/AppWorkbench.test.tsx src/app/hooks/useDocumentSession.startup.test.tsx src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx src/services/workspaceManifestService.test.ts src/app/workspace/workspaceManifestCoordinator.test.ts` passed (5 files, 40 tests). `npx tsc --noEmit`, `git diff --check`, and required `npm run build` passed (4,580 modules transformed; only the pre-existing Vite large-chunk advisory remained).

**Generated outputs:** `npm run build` regenerated ignored `dist/` assets. No checked-in schema, migration fixture, registry projection, native artifact, generator input, or generated source changed.

**Event-order and objective closure evidence:** success traces assert `editor-flushed` before recovery/decision, save before durable manifest publication, and `window-destroyed` last. Cancel traces end at `cancelled`, preserve source and documents, and clear pending authorizations. Partial-failure traces retain failed targets while successfully saved siblings are removed only after projected manifest publication. Tests additionally prove clean-active/dirty-background protection, several dirty targets, saving/conflict/read-only/recovery facet counts, Review Conflicts, selected empty-dirty discard, retry, hung-save timeout, manifest-storage failure without removal, close-right/close-others shared routing, and the absence of window destruction on unresolved work. The required focused suite and production build pass, so every declared closure criterion is satisfied.

**Remaining risks / deliberately deferred work:** Round 16 still owns additive picker/explorer/drop/New/recent/OS ingress; Round 17 owns broader title/topbar aggregate status presentation; Round 18 owns final accessible tab chrome and richer per-document selection UI; Round 20 owns packaged crash, platform, and large-workspace fault certification. Browser-native tab shutdown cannot await asynchronous storage beyond the platform's `beforeunload` contract. No part of those rounds was implemented.

**Non-goals preserved / unblocks:** no final tab strip, additive ingress rewrite, shell decomposition, source styling, new format, second workspace kernel, or broad release certification was added. Round 16 is now the first open round; Round 15 unblocks its safe replacement/ingress settlement and later tab close controls.

#### Round 16 — Additive ingress and single-instance routing — `CLOSED`

**Status:** `CLOSED` on 2026-07-21.

**Problem / scope / outcome:** route every document ingress path through additive-capable workspace commands and deterministic startup precedence. The production UI remains in one-visible-document compatibility mode until Round 18, so no inaccessible hidden documents are created. This round does not add formats or tab chrome.

**Dependencies / first consumer:** rounds 7, 13, and 15 provide additive ownership, restore precedence, and safe settlement. Picker, explorer, drop/paste, New/template, recent files, and cold/warm OS launch are the production consumers.

**Primary owner / semantic writable lease:** the primary owns `src/app/documentSession/openDocument.ts`, `src/app/documentLaunch.ts`, startup/session orchestration, explorer/drop-paste open adapters, and native pending-open draining as required. Ingress precedence and workspace command routing are primary-only.

**Contracts / invariants:** Open adds/focuses rather than settles/replaces when the activation surface is available; duplicate canonical locators focus existing records; all queued launch paths drain deterministically; explicit launch becomes visible promptly without late restore overwriting it; unsupported/failed entries do not replace healthy documents; New always receives a unique ID; without a registered activation surface, a second ingress request is refused/preserved for later rather than creating an inaccessible record.

**Completion record:** `WorkspaceIngressCoordinator` is now the single prepared-document command router and serialized ingress lane. Picker, explorer, native and browser drag/drop, New/template, recents, cold startup/Open With/protocol launch, and warm single-instance launch reach it through `useDocumentSession`; native and browser multi-entry batches drain in FIFO order, one failed/unsupported entry does not replace a healthy record, canonical duplicates focus the existing record, and every New/template request retains a unique `DocumentId`. The native picker now exposes multi-select through the typed host/service boundary and grants every selected path.

**Important decisions / deviations:** the already-FIFO Rust `VecDeque` remained the native queue authority; the defect was the renderer consuming only one pending path, so the session now drains `takePendingDocumentOpen` to empty instead of introducing a second queue. `documentLaunch.ts` required no semantic change. Ordinary Open bypasses destructive settlement only when the internal multi-document capability is active. Capability-off production deliberately retains the settled single-visible replacement policy; capability-on without an activation surface refuses the workspace command and preserves the prepared request in the coordinator's deferred queue. Explicit replacement remains a separately authorized workspace command. Restore adoption remains a lifecycle operation rather than a competing ingress writer.

**Production consumers reached:** `App` picker and recent-file actions, explorer activation, native/browser drop adapters, New and template creation, startup explicit paths, queued OS/Open With/protocol paths, and warm single-instance events. The compatibility projection still shows one document in production, as required until Round 18; the hidden activation harness proves additive behavior without publishing tab chrome.

**Migrations / compatibility:** no persisted-data or manifest migration was required and no format policy changed. Existing single-document hosts may omit `pickDocumentFiles` and fall back to `pickDocumentFile`. Unflagged production settles and replaces exactly one visible document; the flagged no-surface state creates no inaccessible record and retains the refused request for later activation.

**Changed-path manifest:** `src/app/workspace/workspaceIngressCoordinator.ts`, `src/app/workspace/workspaceIngressCoordinator.test.ts`, `src/app/workspace/workspaceStore.ts`, `src/app/workspace/index.ts`, `src/app/documentSession/openDocument.ts`, `src/app/hooks/useDocumentSession.ts`, `src/app/hooks/useDocumentSession.startup.test.tsx`, `src/app/hooks/useDocumentDropPaste.ts`, `src/app/hooks/useDocumentDropPaste.test.tsx`, `src/app/App.tsx`, `src/app/host/documentHost.ts`, `src/app/host/desktopDocumentHost.ts`, `src/app/host/desktopDocumentHost.test.ts`, `src/services/fileService.ts`, `src/services/fileService.test.ts`, `src-tauri/src/commands/dialogs.rs`, `src-tauri/src/lib.rs`, `scripts/validate-tauri-command-contract.mjs`, and this roadmap.

**Tests / validation results:**

- `npm test -- src/app/documentSession/openDocument.test.ts src/app/hooks/useDocumentSession.startup.test.tsx src/app/hooks/useDocumentDropPaste.test.tsx src/app/startupOpenFailure.test.ts src/app/workspace` — passed, 13 files / 113 tests.
- `npx vitest run src/services/fileService.test.ts src/app/host/desktopDocumentHost.test.ts` — passed, 2 files / 22 tests.
- `npx tsc --noEmit` — passed.
- `npm run validate:tauri-contract` — passed; 58 registered commands cover 57 TypeScript invokes and the document-association policy remains locked.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` — passed.
- `cargo check --manifest-path src-tauri/Cargo.toml` — passed.
- `npm run validate:ux` — passed (`ok: true`).
- `npm run build` — passed; 4,581 modules transformed. The existing large-chunk advisory remains non-fatal and outside this round.

**Generated outputs:** the production build regenerated ignored `dist/` assets only; no source-controlled projection or migration output was introduced.

**Remaining risks / deliberately deferred work:** Round 17 owns active-document shell projection/decomposition, Round 18 owns the accessible production tab/activation surface, and Round 20 owns packaged multi-window/protocol/cloud/fault certification. Deferred requests in the intentionally invalid flag-without-surface state are process-local; publishing and replaying them belongs with the real activation surface, not this round. No tab chrome, shell decomposition, source presentation, new format, or later-round certification work was started.

**Objective closure evidence:** additive mixed-format picker/drop batches produce ordered independent records and the last successful entry is active; alias duplicates focus without rereading; multiple native queued paths drain FIFO; explicit startup launch wins over late restore; warm single-instance ingress preserves a dirty record and its save/conflict lifecycle; unsupported and failed entries are isolated; no-surface ingress is refused/preserved without adding a hidden record; New/template IDs are distinct; the sole ingress coordinator owns prepared-document replacement/add/focus policy; every required command above passed.

**Closure / unblocks:** all current ingress consumers route through the workspace, the cold/warm launch matrices pass, and production durability is complete. Round 17 is now the first open round. No Round 17 implementation was started.

### Wave D — UI projection, requested capabilities, and certification

#### Round 17 — Active-document projection and shell decomposition — `CLOSED`

**Status:** `CLOSED` on 2026-07-21.

**Problem / scope / outcome:** make the current shell a projection of workspace/document contracts and establish bounded ownership modules. The outcome is semantic decomposition, not a target line count, and this round does not add the tab strip.

**Dependencies / first consumer:** rounds 5–16 provide format contributions, active document, commands, durable lifecycle, and `WorkspaceDirtySummary`. `AppWorkbench`, `AppEditorStage`, `AppTopbar`, native/document title, sidebars, inspector, status, and shortcuts are the production consumers.

**Primary owner / semantic writable lease:** the primary owns `src/app/App.tsx`, `useDocumentSession` decomposition, `src/app/documentState.ts` title projection, `AppTopbar`, workspace shell/active-workbench/command/overlay modules, and shared composition interfaces. App composition, active/dirty projection, public module exports, and boundary rules are primary-only; leaf components may use disjoint leases after props freeze.

**Contracts / invariants:** `activeDocumentId` selects a projection and owns no content; document-specific UI resolves from format contribution + document state + host capability + parse status + large-file policy; overlays carry `DocumentId` or close on activation; workspace services are not React-mount-owned; host/domain imports obey declared boundaries; window/topbar title keeps the active document name, marks active dirty state, and also exposes aggregate unsaved background count so a clean active tab cannot make the workspace look clean.

**Completion record:** added one pure `createWorkspaceShellProjection` that selects the active `DocumentRecord`, derives its Round 5 format contribution, effective base mode, identity/display name, and `WorkspaceDirtySummary` chrome without owning content. `App` is the sole production composition root and passes that projection to `AppWorkbench`. The former combined workbench was semantically split into `WorkspaceShell` (topbar, window chrome, aggregate status, status bar, overlay slot) and `ActiveDocumentWorkbench` (toolbar, sidebar, editor stage, inspector, and ambient feedback). Existing `useAppCommands`, `AppOverlays`, active compatibility boundary, and store-owned background coordinators remain their bounded authorities rather than being duplicated.

**Important decisions / deviations:** existing command, overlay, editor-stage, sidebar, and workspace-service seams already matched the intended authorities, so this round integrated and enforced them instead of arbitrarily slicing files. `AppWorkbench` remains a thin compatibility composition component. `createWindowTitle` now accepts an explicit projection and always includes aggregate unsaved count when nonzero; a clean active document therefore cannot hide dirty background work. `AppTopbar` no longer receives independent path/dirty inputs: the active projection supplies document chrome and format policy, while parse/large-file surface availability remains in the existing contribution-backed structured navigation/stage contracts. Active-only reviews, citation UI, prompts, and confirms close at the document activation boundary; targeted external-conflict effects remain addressed by `DocumentId`/revision. Pure settings and visual-style catalogs remain allowed leaf presentation imports and are documented as a bounded residual; stateful host/service/session imports are prohibited.

**Production consumers reached:** live `App`, `AppWorkbench`, `WorkspaceShell`, `ActiveDocumentWorkbench`, `AppTopbar`, native/document title, `StatusBar`, Markdown toolbar, `AppSidebar`, `AppEditorStage`, `InspectorPane`, active format command bindings, window close affordance, and active-only overlays. Store-owned save/recovery/manifest/watcher/close/effect/ingress coordinators continue across presentation remounts and are verified as React-independent policy owners.

**Migrations / compatibility handling:** no persisted schema, native DTO, format catalog, extension contract, or storage migration changed. `AppWorkbench` preserves its production/test composition API except that one `ActiveDocumentProjection` replaces parallel top-level format/chrome inputs. Production remains one-visible-document with the capability disabled; no tab strip or production activation surface was added. Existing active-only overlay clearing is retained and expanded to pending prompt/confirm decisions and citation review.

**Changed-path manifest:** production: `src/app/{App.tsx,AppWorkbench.tsx,WorkspaceShell.tsx,ActiveDocumentWorkbench.tsx,activeDocumentCompatibility.ts,documentState.ts}`, `src/app/workspace/{workspaceShellProjection.ts,index.ts}`, `src/components/{AppTopbar.tsx,StatusBar.tsx}`, and `src/styles/app.shell.css`; tests: `src/app/{AppWorkbench.test.tsx,activeDocumentCompatibility.test.ts,documentState.test.ts}`, `src/app/workspace/workspaceShellProjection.test.ts`, and `src/components/{AppTopbar.test.tsx,StatusBar.test.tsx}`; enforcement/documentation: `scripts/validate-app-composition-boundaries.mjs`, `package.json`, `docs/refactor/multi_document_round_17_ownership_map.md`, and this roadmap.

**Tests / validation results:**

- Required `npm test -- src/app/AppWorkbench.test.tsx src/app/AppEditorStage.test.tsx src/app/documentState.test.ts src/app/hooks/useWindowChrome.test.tsx src/components/AppTopbar.test.tsx src/components/InspectorPane.test.tsx src/app/workspace` — passed, 16 files / 126 tests.
- `npx vitest run src/app/activeDocumentCompatibility.test.ts src/components/StatusBar.test.tsx src/app/hooks/useDocumentSession.startup.test.tsx src/app/hooks/useDocumentSession.visualRoundTrip.test.tsx` — passed, 4 files / 46 tests.
- `npx tsc --noEmit` — passed.
- `npm run validate:app-boundaries` — passed; 9 presentation modules and 6 workspace coordinators obey the ownership map.
- Required `npm run validate:structured-workflows` — passed, 7 tests across 9 format files and all 6 declared workflows.
- Required `npm run validate:ux` — passed (`ok: true`).
- Required `npm run build` — passed; 4,586 modules transformed. The existing large-chunk advisory remains non-fatal and outside this round.
- `git diff --check` — passed.

**Generated outputs:** structured-workflow validation generated an ignored report under `tmp/structured-workflows/`; the production build regenerated ignored `dist/` assets. No tracked generator projection, migration output, or generated source changed.

**Ownership/import evidence:** [Round 17 shell ownership map](./multi_document_round_17_ownership_map.md) names the composition, chrome, active-workbench, projection, command, overlay, background-service, and leaf-presentation authorities plus the bounded residuals. Its validator forbids stateful file/recovery/manifest/native host, `WorkspaceStore`, and `useDocumentSession` imports in presentation modules and forbids React ownership in the six policy coordinators.

**Objective closure evidence:** switching a hidden Markdown/JSON/plain-text workspace recomputes identity, name, mode, format contribution, toolbar eligibility, and active chrome while preserving every record's content. Clean-active/dirty-background and active-dirty cases assert window title, accessible topbar status, status-bar aggregate, and close-button label; saving/conflict/recovery counts remain distinct. Required stage/inspector suites cover structured surface availability, parse failure, source-only large-file behavior, and format-specific visibility. Command construction consumes the same active format capabilities. Activation clears active-only reviews and pending decisions, while targeted conflict operations retain their existing document/revision guards. All named tests, boundary/structured/UX validators, typecheck, build, and hygiene checks pass.

**Remaining risks / deliberately deferred work:** Round 18 owns the visible tab strip, atomic production activation surface/capability enablement, accessible tab semantics, and tab lifecycle controls. Round 19 owns semantic source styling. Round 20 owns packaged cross-platform, stress, accessibility, and release certification. `App.tsx` still assembles broad feature prop objects for the single mounted editor; the ownership map deliberately permits that compatibility composition and rejects arbitrary line-count decomposition. No part of Rounds 18–20 was implemented.

**Closure / unblocks:** the production shell is now an enforced read projection of workspace/document contracts, aggregate background work cannot disappear behind a clean active document, and mixed-format projection evidence passes. Round 18 is now the first open round. No Round 18 implementation was started.

#### Round 18 — Accessible heterogeneous tab workspace

**Status: `CLOSED` (2026-07-21).**

**Problem / scope / outcome:** expose the already-proven desktop workspace through accessible heterogeneous tabs. VS Code Custom Editor tab parity is a non-goal because VS Code owns its own tabs.

**Dependencies / first consumer:** Round 17 supplies the active projection and rounds 10–16 supply durable commands. The new desktop tab strip is the first consumer; all current format workbenches are its tab panels.

**Primary owner / semantic writable lease:** the primary owns the tab-strip model/component, integration in `AppWorkbench`, workspace tab commands, focus coordination, and tab-specific styles/accessibility tests. Workspace state and lifecycle commands remain primary-only; visual tab primitives may be a disjoint lease after behavior/ARIA contracts freeze.

**Contracts / invariants:** tabs only dispatch workspace commands; active state remains in the workspace; the production tab strip is the `WorkspaceActivationSurface`; `multiDocumentWorkspaceEnabled` and that surface are enabled atomically in the same production change; statuses are textual/non-color-dependent; ARIA `tablist`/`tab`/`tabpanel`, roving focus, focus restoration, and keyboard/reorder alternatives are complete; overflow never mounts unlimited editors.

**Implemented / production consumers reached:** `App` now supplies one atomic `PRODUCTION_WORKSPACE_CAPABILITY` containing the enabled flag and the `desktop-workspace-tabs` production activation surface. `WorkspaceTabStrip` is mounted by `AppWorkbench`/`WorkspaceShell`, while every supported format continues through one active `ActiveDocumentWorkbench` tab panel. The strip projects workspace-owned active/MRU/order/closed state and dispatches the existing workspace/coordinator commands for activation, reorder, close, close others/right, reopen, and Save All. The real picker, explorer, drop, New/template, recent, startup, single-instance, and protocol ingress paths therefore become additively reachable without a second writer.

**Important decisions / deviations:** tab labels disambiguate duplicate basenames with parent paths; lifecycle state is rendered as text (unsaved, queued/saving/failed, recovery, disk/external, read-only/permission/cloud) rather than color alone. Arrow/Home/End navigation uses automatic activation and roving focus; `Alt+1–9`, `Ctrl/Cmd+PageUp/PageDown`, close, reopen, Save All, MRU, overflow selection, and focusable per-tab action selects provide keyboard and reorder alternatives. Closing the final record creates one blank replacement before removal is finalized, preserving the existing active-projection invariant without bypassing close/recovery/manifest authorization. Closed runtime adapters are cleared while keyed view/history state is retained for reopen. Save All uses registered per-document actors and reports partial failure without closing failed documents.

**Migrations / compatibility:** no schema, manifest, recovery-catalog, file-format, or extension migration was required. Capability-off remains the single-document replacement path; enabled-without-surface still fails closed/defer-preserves ingress; hidden-harness behavior remains available. The desktop capability is enabled only at the production `App` call site. VS Code retains host-owned tabs and a contract test proves no desktop workspace fork was added.

**Changed paths:** `src/app/workspace/workspaceTabs.ts`, `workspaceTabs.test.ts`, and `index.ts`; `src/app/WorkspaceTabStrip.tsx`, `WorkspaceShell.tsx`, `AppWorkbench.tsx`, `AppWorkbench.test.tsx`, and `App.tsx`; `src/app/hooks/useDocumentSession.ts`, `useDocumentSession.startup.test.tsx`, `useWindowCloseGuard.ts`, and `useKeyboardShortcuts.ts`; `src/app/keyboardShortcuts.ts` and `.test.ts`; `src/components/accessibilityAxe.test.tsx`; `src/styles/app.shell.css`; `scripts/validate-ux-workflows.mjs`; and this roadmap.

**Tests / validation results:** the required focused command passed 14 files / 79 tests; the production session focus run passed 15 files / 105 tests; the complete `npm test` suite passed 193 files / 1,303 tests. `npm run validate:ux` passed with `workspaceTabContract: true`, proving linked production `tablist`/selected `tab`/`tabpanel` semantics and exactly one mounted editor. `npm run build` passed (`tsc` plus Vite); its pre-existing large-chunk advisory remains non-fatal. Axe passed with the tab surface, shortcut tests cover lifecycle/direct activation, workspace tests cover capability-off and flag-without-surface gates, close cancel/partial save/reorder/MRU/reopen and gateway history/view contracts, and the Round 18 model tests cover heterogeneous formats, duplicate names, all declared lifecycle labels, 60-tab bounded projection, overflow, forced colors, and high-density/200% layout rules.

**Generated outputs:** Vite regenerated ignored `dist/` production assets during validation. No tracked generated projection or migration output was introduced.

**Remaining risks / deliberately deferred work:** packaged cross-platform assistive-technology, watcher/cloud fault injection, multi-window protocol stress, and measured scheduler/LRU limits remain Round 20 certification work. Round 19 alone owns semantic source-mode highlighting. VS Code tab parity remains deliberately out of scope. No Round 19 or Round 20 implementation was started.

**Objective closure evidence:** the production capability and surface are one exported value and are consumed together by `App`; the UX validator observes the live surface; reducer/coordinator tests retain sole workspace write authority and all failure behavior; session evidence opens and activates Markdown/JSON records additively; plain-text and every registered format use the same bounded active panel; DOM/axe/keyboard evidence covers mouse, screen-reader naming, roving focus, direct activation, close/reopen, MRU, Save All, overflow, and reorder alternatives; lifecycle and duplicate-name projections are textual; focus/history remain keyed in the Round 8 gateway; compatibility gates and the extension non-fork test pass; the focused, full-suite, UX, and build commands are green.

**Closure / unblocks:** Round 18 is independently `CLOSED`. The accessible production tab workspace now exposes the durable multi-document aggregate, and Round 19 is the first open round.

#### Round 19 — Semantic source-mode presentation — `CLOSED`

**Problem / scope / outcome:** add the measured missing CodeMirror semantic highlight layer without rewriting the editor, previewing syntax as widgets, or changing file-fidelity policy.

**Dependencies / first consumer:** Round 5 supplies source-language IDs, Round 17 supplies theme/presentation inputs, and Round 18 proves switching. `SourceTextEditor` is the first desktop consumer; the extension consumes shared tokens/factory or a contract shim only.

**Primary owner / semantic writable lease:** the primary owns the host-neutral highlight style/tokens, `src/components/SourceTextEditor.tsx`, `src/styles/app.source-editor.css`, and the minimal extension adapter/contract tests. Shared semantic token names/factory and desktop theme integration are primary-only.

**Contracts / invariants:** installing highlighting dispatches no content transaction; Markdown markers stay visible; `doc.toString()`, selection, undo, clipboard, parse result, and save output are unchanged; a fixed LF UTF-8 fixture saves byte-identically; mixed/newline fidelity remains Round 3 policy; unsupported grammars stay conservatively plain.

**Completion record — implemented:** added the host-neutral semantic token and fallback-mode contract to `@sciemd/core`, a presentation-only CodeMirror `HighlightStyle`/`syntaxHighlighting` factory, and direct production integration in desktop `SourceTextEditor` for Markdown, JSON, YAML, and XML. The VS Code Markdown source editor consumes the exact same factory contract. Markdown headings, emphasis, links, code, lists, quotes, frontmatter/meta, citations through their Markdown syntax, comments, punctuation, and structured-language properties/tags/attributes/values now receive semantic styling. Light, dark, forced-color, selection, search, and diagnostic layers are explicit.

**Important decisions / deviations:** the format catalog's existing `sourceOnlyFileBytes` policy is the sole large-file threshold writer; exceeding it removes parser and highlighting together through compartment reconfiguration and adds no scheduler. Unsupported TOML/tabular/plain grammars remain plain. The factory owns no state field, view plugin, decoration, widget, transaction filter, or content dispatch, so IME and clipboard behavior remain CodeMirror-owned. The fixed fixture plus existing exact-source save-operation tests jointly prove byte-preserving output; no new save writer was introduced.

**Production consumers reached:** desktop `src/components/SourceTextEditor.tsx` is the first real heterogeneous source-mode consumer, including Round 18 tab switching. `scie-md-vscode-extension/src/scie-md/components/SourceMarkdownEditor.tsx` is the real extension source consumer. Both expose their semantic/fallback mode for host diagnostics.

**Migrations / compatibility handling:** `@lezer/highlight` is now a direct root and extension dependency instead of an accidental transitive dependency. `@sciemd/core` exports the source-presentation contract through its root and explicit package subpath. There is no persisted-data, file-format, native DTO, or settings migration. Mixed/newline/encoding fidelity remains exclusively under Round 3 policy, and unsupported grammars retain the prior plain presentation.

**Changed paths / command manifest:** root and extension package manifests/locks; `packages/core/package.json`, `packages/core/src/index.ts`, `packages/core/src/sourcePresentation.ts`; desktop `SourceTextEditor`, its tests and semantic factory; desktop token/source-editor/feedback styles; `src/app/host/fixtures/source-semantic-invariance.md`; extension shared-core verifier, source editor/test/factory, mirrored token/source-editor/feedback styles, and webview styles/tests. No generated projection changed; the build emitted only ignored `dist/` output.

**Tests / validation results:** the required desktop command passed 3 files / 63 tests; the required extension command passed 2 files / 20 tests; `npm run build` passed TypeScript and Vite (the pre-existing large-chunk advisory is non-fatal); extension typecheck passed both projects. A deterministic contrast audit covered all 18 literal semantic colors and reported minimum contrast 5.05:1 on light `#fbfcfc` and 8.39:1 on dark `#151b19`. The fixed fixture contains LF only and UTF-8 re-encoding equals its original bytes. Extension tests compare the presentation factory exactly plus all source-token declarations and interaction selectors across hosts.

**Remaining risks / deliberately deferred work:** packaged assistive-technology checks, broad release matrices, measured multi-document stress, and global generated-projection convergence remain Round 20. The optional repository-wide shared-core audit reports predecessor-era unrelated mirror differences; the newly registered Round 19 factory group itself is identical and its focused exact-contract test passes. No later-round certification work was performed.

**Non-goals preserved:** no editor/parser rewrite, syntax widgets, source-marker hiding, file-fidelity policy change, scheduler/LRU work, new grammar support, save-authority transfer, or Round 20 release work was introduced.

**Objective closure evidence:** factory installation changes presentation extensions only; source/selection/parse invariance is asserted for Markdown/JSON/YAML/XML; visible Markdown markers and citations remain in the LF UTF-8 golden; plain and over-budget modes have no language tree; existing history/save tests remain green; interaction and forced-color layers are explicit; desktop/extension factories are byte-identical; named production consumers are wired; every required focused command, build, and typecheck passes.

**Closure / unblocks:** Round 19 is independently `CLOSED`. Semantic source presentation is live without changing document authority or fidelity, and Round 20 is now the first open round.

#### Round 20 — Reliability, performance, accessibility, and release certification — `CLOSED`

**Problem / scope / outcome:** converge the completed wave into one supported release candidate and seal exact evidence once. This round is not a container for unrelated polish or unfinished semantic outcomes from earlier rounds.

**Dependencies / first consumer:** rounds 1–19 are individually closed. The packaged desktop candidate, release pipeline, diagnostics, and support evidence are the consumers.

**Primary owner / semantic writable lease:** one primary integration writer owns validation orchestration, generated-output convergence, release configuration, completion note, changed-path/command manifest, and final roadmap status. Other work is read-only review, test design, or disjoint diagnosed repairs; shared contracts/migrations/generators remain primary-owned.

**Contracts / invariants:** no earlier invariant is weakened to pass certification; focused failures are repaired at their owning boundary; generators run in dependency order only when affected; deferred depth is implemented only when the final drift/stress audit proves it necessary; candidate inputs and evidence identify one exact tree state.

**Completion record — implemented:** converged the final desktop/extension projection audit, repaired strict native lint findings without changing fidelity behavior, ran the complete certification DAG, built and smoked the Windows desktop candidate, packaged and installed-smoked the VSIX, staged installers/checksums, measured large-document behavior, and sealed [the exact Round 20 certification record](./multi_document_round_20_certification.md). The packaged executable, release pipeline, diagnostics bundle, and support evidence are the real consumers.

**Important decisions / deviations:** the extension audit now classifies desktop-only document-targeted parser cancellation, workspace shortcuts, aggregate close UI, and workspace-tab axe coverage as host adapters; copying them would create the explicitly forbidden second VS Code workspace kernel. Native fidelity metadata was grouped into one typed input to satisfy strict clippy while preserving all fields and write decisions. Measured stress did not justify priority/LRU/inactive suspension. One intermediate fidelity test encountered a transient OneDrive atomic-replace lock and passed immediately in isolation; the subsequent standalone release validator and full merge rerun both passed the complete Rust suite.

**Production consumers reached:** `src-tauri/target/release/sciemd.exe`, the MSI/NSIS packaging pipeline, required packaged self-test, staged VSIX and temporary installed VS Code host, diagnostics exporter, artifact budget/checksum guards, and the macOS/Linux release build jobs all consume the certified contracts. Windows packaging and smoke ran locally; platform-specific macOS/Linux installers remain owned by their declared release jobs and are not misrepresented as locally executed.

**Migrations / compatibility handling:** all versioned settings, workspace manifest, recovery catalog, native recovery, host-error, and file-fidelity migration corpora passed, including future/interrupted fail-closed cases. No new schema migration was required. CSV's deliberate OS-association exclusion and YAML/TOML/XML preservation-gated visual writes remain unchanged. The extension remains a shared-contract/source-presentation consumer, not a workspace owner.

**Changed paths:** `scie-md-vscode-extension/scripts/verify-shared-core-sync.mjs` records the final host-adapter projection decisions; `src-tauri/src/commands/file_io.rs` contains the typed fidelity metadata/clippy repair; `docs/refactor/multi_document_round_20_certification.md` is the exact evidence/command/artifact manifest; this roadmap records closure. Generator runs also refreshed only ignored/staged outputs listed below.

**Tests / validation results:** every required command passed: `npm test` (193 files / 1,305 tests); `cargo test --manifest-path src-tauri/Cargo.toml` (124 library plus 7 TOML preservation tests); generated-output and large-document stress validators; standalone release validation; desktop build and required packaged smoke; VS Code host (2 files / 8 tests) and visual smoke (4 files / 19 tests); and the full 257.6-second `validate:merge` DAG. Release validation additionally passed strict round-trip, all 60 extension files / 319 tests, both TypeScript builds, package budgets, Rust clippy with warnings denied, UX/structured/style/export/distribution/Tauri guards, and content-free diagnostics tests.

**Generated outputs / candidate identity:** the candidate input manifest covers 1,098 repository input files at SHA-256 `6919fd8896e905d067107c37ca59d0fd11d3d9cbcd9c278096d760f352aa566a`, based on baseline commit `54765d65081e5d510d165556f5c2e2640b31a5ac`. The executable SHA-256 is `f454107fb7416aa726b78b94dd017ec47941576b482887f7be3362d92c70db37`; staged MSI, NSIS, and VSIX checksums are recorded in `artifacts/SHA256SUMS.txt` and the certification record. Vite/extension `dist`, Tauri `target`, export-validation captures, and stress reports are ignored generated evidence; the staged installers/checksum file are the intended release outputs. The generated-output guard passed before and after staging.

**Remaining risks / deliberately deferred work:** the local candidate is unsigned and unpublished; signing/notarization credentials and actual macOS/Linux installer execution belong to their release environments. The existing Vite large-chunk advisory remains non-fatal and within enforced artifact budgets. These are distribution-environment risks, not incomplete workbench invariants. No Round 21 or next-wave work was started.

**Non-goals preserved:** no editor/parser rewrite, unlimited mounted editors, tab-owned state, arbitrary format forks, source preview widgets, forced OS associations, collaboration/remote workspace/plugin system, unsupported byte-fidelity claim, or second extension workspace kernel was introduced.

**Objective closure evidence:** the certification record maps every Section 10 dimension to automated frontend, native, packaged, extension, stress, accessibility, migration, diagnostics, or release evidence. The extension verifier reports 132 exact mirrors, 31 documented host adapters, zero intentional forks, and no drift. Stress peaked at 105 MiB and passed all budgets. Packaged smoke proved no-file and file launch, native save/recovery/export, structured CLI launch, and real edits for JSON/JSONL/YAML/TOML/XML/CSV/TSV/plain text. Installed VSIX smoke proved activation and structured preview policy in VS Code 1.129.1. Candidate hashes, commands, migrations, projections, artifacts, completion note, and roadmap status agree.

**Closure / unblocks:** Round 20 is independently `CLOSED`; all twenty rounds are closed and the multi-document workbench refactor wave is complete. No later round exists in this roadmap.

## 9. Milestones and delivery gates

The following gates prevent a visually successful but unreliable implementation:

- **Round 4 — foundation vocabulary proven.** Current path consumers use one locator authority, and new code reaches editor state through a `DocumentId`-keyed facade rather than adding new global-reader dependencies.
- **Round 10 — kernel proven.** Headless workspace + `DocumentId`-keyed gateway + targeted effects + origin-owned save completion + empty-dirty recovery pass the hidden two-tab React harness.
- **Round 16 — production durability proven.** Versioned recovery, deterministic restore, workspace watchers/conflicts, close/quit, and all ingress paths use the proven kernel.
- **No production tab strip before rounds 1–17 close.** Round 18 exposes the workspace; the hidden harness is the earlier integration consumer.
- **Multi-record state implies an activation surface.** Before Round 18, the capability defaults off and any flag-without-surface configuration fails closed; Round 18 registers the visible tab strip and enables the capability atomically.
- **Round 20 — release certification only.** Broad validation, candidate construction, generated convergence, and exact evidence sealing happen once after focused round closures.
- **No workspace restore before multiple-document recovery and migrations pass.** A manifest must never become a new source of data loss.
- **No unlimited mounted editors.** View state should be preserved while expensive editor/worker state is bounded.
- **No active-tab-based effect ownership.** Active state influences priority only.
- **No byte-fidelity claims from syntax highlighting.** Character and disk guarantees stay separate and tested.
- **No format-specific UI fork inside the tab strip.** The active format contribution plus declared runtime inputs drives the existing workbench projection.
- **No second workspace kernel in the VS Code extension.** Desktop owns workspace/tabs/manifest; the extension consumes shared core contracts or narrow compatibility shims and contract tests.
- **No dormant contract rounds.** Every round's named first consumer must be in production code before closure.

## 10. Required certification matrix

At minimum, automated scenarios should cover these combinations:

| Dimension | Required cases |
| --- | --- |
| Documents | one, two, many, duplicate path, hardlink/alias duplicate, several untitled |
| Formats | Markdown, JSON, plain text, plus representative YAML/XML/CSV |
| Lifecycle | open, activate, edit, active/inactive autosave, asset-driven Save As, Save All, close, quit, restore |
| Races | switch during save, active manual save versus background autosave, close during parse/validation, stale dialog, external event during Save As, rapid activation |
| Recovery | crash, dirty empty source, several untitled, timer/visibility/pagehide/beforeunload flush, partial catalog corruption, old schema migration |
| File system | case/path aliases, stable-ID hardlinks, path-only fallback and later collision, UNC where supported, missing/renamed, permission loss, cloud delay, read-only |
| Fidelity | UTF-8/BOM, UTF-16, Windows-1252, LF/CRLF/CR/mixed, unsupported write characters |
| Presentation | source/visual switch, format-specific surface, view restore, semantic highlight invariance |
| Accessibility | keyboard-only, screen reader semantics, high contrast, 200% zoom, non-color statuses |
| Performance | many small tabs, several large tabs, parser queue pressure, restore latency, memory ceiling |
| Authority | stale layer-two/validator results, wrong-document editor access, origin-owned save, native lossy-write veto, Save As rekey, duplicate locator, activation-surface gate |
| Hosts | desktop full workspace; VS Code shared-contract/source-presentation compatibility only |

The critical three-document acceptance story is:

1. open one Markdown file, one JSON file, and one untitled plain-text document;
2. edit all three, including deleting one to an empty string;
3. switch repeatedly while parsing, autosave, and external file events occur;
4. verify format-appropriate UI and preserved view/undo state;
5. terminate and restore the app;
6. Save All, resolve a conflict, close the workspace, and reopen through both picker and OS Open With;
7. prove every resulting source and path belongs to the correct document.

## 11. Explicit non-goals for this wave

- Do not rewrite all editors or parsers.
- Do not keep one complete heavyweight editor mounted per tab.
- Do not make the tab component a state store.
- Do not add arbitrary format checks to individual components when a contribution can declare them.
- Do not combine visual preview widgets with the source-preservation guarantee.
- Do not force every supported format into an OS file association.
- Do not add collaborative editing, remote workspaces, or arbitrary plugin code as prerequisites.
- Do not make byte-exact preservation claims until the fidelity envelope and corpus prove them.
- Do not implement a second workspace/tab/manifest kernel in the VS Code extension; VS Code already owns document tabs.
- Do not require every host DTO, store, generator, or native table to converge before the kernel's first real consumer; adopt the minimum boundary, then certify remaining drift in Round 20.
- Do not treat broad release validation, clean-tree preparation, candidate construction, or evidence sealing as per-round rituals.

## 12. Recommended starting tranche

Begin with rounds 1–4 as the first planning tranche, while executing and closing exactly one round at a time:

1. fix blank-dirty recovery, fail-closed promised backups, and the plain-text policy contradiction; record the active-identity save abort as Round 10's failing-forward obligation;
2. adopt typed errors only for current document open/save lifecycle branches;
3. adopt the source metadata already returned by Rust and make lossy-write policy explicit without inventing raw-byte fidelity;
4. introduce `DocumentId`, stable physical-file identity with canonical-path fallback, and the thin keyed editor-gateway facade used by the current singleton.

That tranche yielded immediate reliability value and prevented rounds 6–7 from creating new code against the global last-reader API. It is a roadmap grouping, not permission to implement several rounds in one execution. Rounds 1–20 are now closed; the production multi-document kernel, durability/lifecycle layers, additive ingress, active-document shell, accessible heterogeneous tabs, semantic source presentation, and integrated release certification are complete. No round remains open in this wave.

## 13. Architectural success criterion

The wave is successful when the following sentence is true in code, not only in the UI:

> A document remains a complete, durable, independently addressable aggregate whether it is active, inactive, not mounted, saving, conflicted, recovering, or being restored; a tab merely activates its projection.
