# Multi-Document Workbench Round 20 Certification

Status: `CLOSED`
Candidate version: `1.1.0`
Baseline commit: `54765d65081e5d510d165556f5c2e2640b31a5ac`
Certification date: 2026-07-21
Candidate input manifest: 1,098 repository input files, SHA-256 `6919fd8896e905d067107c37ca59d0fd11d3d9cbcd9c278096d760f352aa566a`

The input manifest hash is the SHA-256 of sorted `SHA-256  path` lines for every tracked or intended untracked repository file outside `docs/`, including source, configuration, package metadata, fonts/assets, and release inputs. Documentation and ignored generated artifacts are excluded because they are not candidate inputs.

## Candidate artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `src-tauri/target/release/sciemd.exe` | 17,702,400 | `f454107fb7416aa726b78b94dd017ec47941576b482887f7be3362d92c70db37` |
| `artifacts/installers/ScieMD_1.1.0_x64_en-US.msi` | 9,134,080 | `cff4510dfa79c4cfcc6a0f6b3b1e40ab84cea7164a0b041e7cfba77d3227e1b1` |
| `artifacts/installers/ScieMD_1.1.0_x64-setup.exe` | 7,724,041 | `fe98c405893a4cdf5198f1af456e84bb9d5c6619edffac35e820615c547ec269` |
| `artifacts/installers/sciemd-vscode-1.1.0.vsix` | 4,733,127 | `06c762976a13554882e57084031319b55958338ec2e665afce5728841d7d64db` |

`artifacts/SHA256SUMS.txt` is the generated checksum projection for the staged installers. Vite, extension `dist`, Tauri `target`, export-validation images/PDF, and temporary stress reports remain ignored generated evidence.

## Certification matrix evidence

- Documents, lifecycle, races, authority, recovery, and workspace restore: the 1,305-test frontend suite covers duplicate locators, several untitled records, additive mixed-format open/activation, inactive autosave and the one-write limiter, Save As collision/rekey, Save All, close/quit cancellation and partial failure, stale effects/dialogs, timer/visibility/pagehide/beforeunload checkpoints, corrupt/future migrations, empty dirty source, watcher routing, and restart restoration.
- Formats and fidelity: frontend/Rust corpora cover Markdown, JSON, JSONL, YAML, TOML, XML, CSV, TSV, plain text, UTF-8/BOM, UTF-16, Windows-1252, LF/CRLF/CR/mixed, and lossy-write veto. Packaged smoke performed real edits for every registered desktop format.
- Filesystem: Rust tests cover canonical/path-only identity, hardlink/alias identity, missing-target refresh, Windows verbatim and UNC variants, read-only/cloud states, watcher aliases, metadata conflicts, and atomic writes.
- Presentation and accessibility: source/visual switching, view/history restoration, semantic-highlight invariance, axe, tab semantics, keyboard navigation, forced colors, 200%/dense layout, and textual non-color statuses pass in the full suite and UX/visual smoke validators.
- Performance: the required deterministic stress run processed 900 Markdown sections, 180 export sections, 48 visual images, and 3,200 structured records. Peak recorded heap was 105 MiB; no priority/LRU/inactive-suspension subsystem was justified.
- Diagnostics: Rust diagnostics tests prove exported bundles contain lifecycle/recovery metadata without raw document content.
- Hosts/platforms: the Windows executable, MSI, NSIS, packaged self-test, VSIX package, temporary installed VSIX, and extension host/visual smoke passed locally. macOS and Linux release jobs remain the supported build certification paths in `.github/workflows/release.yml`; platform-specific installer execution remains CI/release-run evidence, not a claim from this Windows run.

## Commands and results

- `npm test` — passed 193 files / 1,305 tests.
- `cargo test --manifest-path src-tauri/Cargo.toml` — passed 124 library tests plus 7 TOML preservation tests.
- `npm run validate:generated-outputs` — passed; ordinary cumulative wave edits were distinguished from generated-output leakage.
- `npm run validate:large-document-stress` — passed with the measurements above.
- `npm run validate:release` — passed all release identity, generator, font, distribution, Tauri contract, frontend/extension build and test, round-trip, package-budget, Rust-test, and strict-clippy gates.
- `npm run build:desktop` — produced the executable, MSI, and NSIS candidate.
- `npm run validate:desktop-smoke -- --required` — passed no-file/startup/structured launch, save, recovery, DOCX/PDF export, and all-format native edit scenarios.
- `npm run validate:vscode-host-smoke` — passed 2 files / 8 tests.
- `npm run validate:vscode-visual-smoke` — passed 4 files / 19 tests.
- `npm run validate:merge` — passed the full release rerun, visual/stress gates, desktop rebuild/smoke, artifact staging/budgets, VSIX package/content/install smoke, checksum regeneration, generated-output recheck, and whitespace guard.

## Repairs and decisions

The deferred extension projection audit found five false exact-copy obligations. Desktop document-targeted parser cancellation, workspace shortcuts, aggregate close UI, and workspace-tab axe coverage are host-owned and would violate the no-second-extension-kernel rule if copied into VS Code. They are now explicit host-adapter classifications. The verifier reports 132 exact mirrors, 31 host adapters, zero intentional forks, and no drift.

Strict Rust clippy found over-wide fidelity metadata function signatures and a non-portable writable-permission test idiom. One typed fidelity metadata input now carries the same fields through the existing native writer, and the read-only test restores captured original permissions. No fidelity rule, error behavior, native DTO, or writer authority changed.

No scheduler/LRU depth was added because measured stress passed. No persistence schema migration was needed. Format projection differences remain declarative: CSV is intentionally not an OS association, and YAML/TOML/XML visual writes remain preservation-gated.

## Remaining risks

The unsigned local candidate is not a published release. Signing/notarization credentials and actual macOS/Linux installer jobs run only in their release environments. The existing Vite large-chunk advisory remains non-fatal and within the checked package budgets. These are distribution-environment risks, not incomplete multi-document ownership obligations.
