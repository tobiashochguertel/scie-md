# Round 6 document-state ownership manifest

Status: implemented with Round 6; this is an ownership/cutover record, not a workspace persistence schema.

## Canonical aggregate

`src/app/documentRecord.ts` is the sole serializable owner for the current document. `useDocumentSession` owns one reducer instance and exposes compatibility selectors/setters to the existing single-document UI. Round 7 may place several records in a workspace collection; it must not create another document reducer.

| State | Round 6 owner | Cutover / policy |
| --- | --- | --- |
| ID and locator | `DocumentRecord.id` / `.locator` | Canonical Round 4 identity types; display paths are projections only. |
| Source and saved baseline | `DocumentRecord.source` | Branded source/saved revisions advance centrally; empty dirty source remains valid. |
| Format and file baseline | `DocumentRecord.format` / `.fileBaseline` | Format catalog and native metadata remain their respective authorities. |
| Dirty/save/external/access/recovery | `DocumentRecord.lifecycle` | Orthogonal facets; compatibility autosave status is nested in the save facet. |
| Frontmatter visual style/document type | `DocumentRecord.presentation` | Open-time metadata is document-local. It never writes global settings. |
| Mode, structured surface/path/schema | `DocumentRecord.view` | The `${format}:${filePath}` preference map is retired. Save As cannot lose view state. |
| Structured edit journal | `DocumentRecord.view.structuredEditJournal` | Serializable and isolated by `DocumentId`. |
| Authorship marks | `DocumentRecord.view.authorshipMarks` | Serializable and isolated by `DocumentId`. |
| Selected variable | `DocumentRecord.view.selectedVariableName` | Serializable document inspection state. |

## Keyed runtime and active-only state

| State | Owner / policy | Later owner |
| --- | --- | --- |
| Source/visual insert, jump, find, history handlers | `DocumentRuntimeRegistry`, keyed by `DocumentId`; the old compatibility slot is cleared before another document binds | Round 8 expands the keyed gateway and bounded snapshots. |
| Milkdown editor instance, selection getter, editor DOM/export handles | Active-only runtime; cleared on document identity change and never serialized | Round 8 keyed editor gateway where needed. |
| Paste, tabular-paste, and JSON edit reviews | Active-only overlays; cleared by replacement and the production-used `clearActiveDocumentCompatibilityState` deactivation guard | Round 10 may target proposals explicitly when the two-document harness exists. |
| Link, variable, citation, block dialogs; inspector focus | Active-only transient UI; the deactivation guard closes them before another document binds, and no state is applied without current handlers/source guards | Round 17 projection audit. |
| Find, command palette, shortcut, About, Settings, template, onboarding dialogs; topbar menu | Global/application overlay state, not document data | Round 17 shell decomposition. |
| Document epoch | Active-only stale-proposal guard; incremented on replacement and paired with overlay clear | Round 9 effect tokens replace epoch-only ownership for async mutation. |
| Editor reset token | Active editor compatibility control, not durable view state | Round 8 snapshot/registration work. |
| Drop depth/overlay | Global pointer interaction state | None. |
| Export render host/log sink | Global keyed runtime for the one active export surface | Round 17 composition boundary. |

## Hook-owned state outside `App.tsx`

Navigation cursors/pending jumps, layer-two/parser/validator results, schema discovery, external-conflict review, autosave actors, recovery timers, and background jobs remain in their existing hooks. They are classified as document view, targeted effect result, keyed runtime, or active-only overlay—not durable fields silently owned by the shell. Rounds 8–10 migrate runtime registrations and async result authority; rounds 12 and 14 migrate recovery and external-change coordination. Round 6 does not pre-implement those schedulers or workspace services.

## Global settings boundary

Theme, font scale, default visual style, default document type, layout, explorer root, and export preferences remain versioned global settings. Selecting a style in an open document now changes the document presentation override. Onboarding remains the existing explicit global-default action. A future “make default” control must call the settings boundary explicitly; frontmatter parsing may never do so.

## Serialization boundary

`DocumentRecord` contains only JSON-compatible values. Editor instances, functions, maps, abort controllers, workers, caches, save actors, timers, and DOM nodes are prohibited. The reducer rejects inconsistent source/lifecycle and revision states, and tests round-trip records through JSON.
