# Multi-Document Workbench Round 1 Reliability Charter

Status: baseline frozen by Round 1
Recorded: 2026-07-21
Scope: current single-document production behavior only

## Stop-loss guarantees now enforced

- Dirty means source text differs from its saved or initial baseline. Empty and whitespace-only source are valid dirty content and remain recoverable.
- An overwrite or replacement that promises a backup does not write unless that backup succeeds. Save operations preserve a recovery draft and report `save-required-backup-failed`; structured-conversion and externally changed bibliography writes propagate backup failure and do not continue.
- Plain text is an openable, importable, source-only document. Picker/open inference and both host-path and browser-file drop flows agree on `.txt`.
- Current file metadata remains authoritative for encoding, BOM, dominant line ending, and mixed-ending reporting. Round 1 does not claim byte-exact mixed-ending reconstruction.

## Characterized current behavior

### Startup and Open With

- Native cold start stays blank while `getInitialDocumentPath` settles. An explicit startup document opens before untitled recovery can be offered, and a successful startup document is not replaced by that recovery.
- Structured and plain-text OS launch arguments are accepted by the native document-path queue. CSV remains deliberately excluded from native association/startup routing.
- Warm single-instance paths enter the same pending queue and are drained only after the startup handshake. The current application still settles and replaces the active singleton; additive routing is deliberately deferred to Round 16.
- Executable evidence lives in `src/app/hooks/useDocumentSession.startup.test.tsx`, `src/services/fileService.test.ts`, and the pending/startup-path tests in `src-tauri/src/lib.rs`.

### Stale decisions and async ownership

- File-draft restore commits only while the disk document read for that decision is still current; otherwise the draft remains untouched.
- Save As is rejected when the singleton identity changes while the path dialog is open.
- The save pipeline still checks active identity and path before disk write. The executable expected failure `save_must_complete_for_originating_identity_even_if_active_document_changed` proves that switching identity during file verification aborts the originating write. This is a failing-forward hazard, not accepted behavior; Round 10 must make the same test pass normally.

### Line-ending and encoding reporting

- Native reads normalize editor text to LF while returning encoding, BOM, a dominant `lineEnding`, and `hasMixedLineEndings` metadata.
- `read_text_file_reports_mixed_line_endings` proves mixed input is flagged; `atomic_write_and_read_preserve_line_ending_and_bom_policy` proves the declared dominant policy for supported writes; `SourceTextEditor` exposes a visible mixed-line-ending status.
- A content hash detects identity/change but cannot reconstruct mixed original bytes. The fidelity envelope and explicit lossy-write authority remain Round 3 work.

### Recovery lag and singleton target inventory

- The current reactive checkpoint delay is exactly 600 ms after a source change.
- `visibilitychange` when hidden, `pagehide`, and `beforeunload` synchronously select the current singleton source/path and start an async recovery write immediately.
- The timer and all three lifecycle events are executable in `useDocumentSession.visualRoundTrip.test.tsx`, including dirty empty source. These are mandatory Round 12 migration entry points; none may remain session-singleton-owned after the workspace recovery coordinator exists.
- Native/browser storage completion is asynchronous, so 600 ms is a scheduling lag rather than a proven durable-write bound. Destruction-time awaiting and abrupt-unload fallback remain Round 12 and Round 15 obligations.

## Initial budgets

These are provisional regression guardrails for later rounds, not Round 1 certification results. Round 20 owns measurement under the final multi-document candidate and may tighten or revise them only with recorded evidence.

| Area | Initial budget / current bound |
| --- | --- |
| Interaction | Visible command/status acknowledgement within 100 ms p95; later active-document switch target within 150 ms p95 for an already-open small document. |
| Memory | At 20 small open documents, renderer working set target at or below 512 MiB; an inactive document target at or below 2 MiB fixed overhead plus twice its UTF-8 source bytes. Only one heavyweight editor is mounted by default. |
| Save | Visible `saving` state within 100 ms; a 1 MiB local manual save target within 2 s p95. Current autosave debounce is 5 s with a 30 s maximum wait and a 10 minute backup interval. |
| Recovery | Current reactive scheduling lag is 600 ms; later durable checkpoint target is within 1 s p95 for a 1 MiB local document. Visibility/pagehide/beforeunload initiate an immediate targeted flush. |
| Restart | Shell-visible target within 1.5 s and active local 1 MiB document usable within 3 s p95; explicit launch input wins over recovery/welcome according to the roadmap precedence. |

## Compatibility and deferred ownership

- Existing draft keys, schema version 2 payloads, legacy `markdown` fields, format inference, native compatibility mirrors, 14-day expiry, and path-key behavior are unchanged. Empty source uses the same payloads and requires no migration.
- Existing supported formats, CSV native-association exclusion, save metadata checks, atomic writes, autosave eligibility, and visual round-trip acknowledgement remain unchanged.
- No `DocumentId`, workspace collection, typed host errors, source-fidelity envelope, tab UI, or later-round persistence authority is introduced here.
