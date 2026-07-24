# Changelog

All notable ScieMD release changes are tracked here.

## 1.1.1 - Editor Runtime And VS Code Parity

- Brought the VS Code extension up to date with the current desktop source and
  visual editing experience, including source line numbers, active/hover line
  context, visual style refinements, font scaling, document metrics, and theme
  behavior.
- Hardened desktop close, recovery, external-change, and editor-runtime
  authority boundaries so pending edits cannot be lost or applied to the wrong
  document during asynchronous transitions.
- Hardened the VS Code custom-editor host against disposed-panel edit replay and
  removed the local-only edit debounce before host-backed dirty state.
- Expanded desktop/extension drift guards and release validation coverage for
  host-adapted source-editor styles and visual token projections.

## 1.1.0 - Structured Data Visual Editing

- Added structured document support for JSON, JSONL/NDJSON, YAML, TOML, XML,
  CSV/TSV, and plain text alongside Markdown.
- Added visual structured views for JSON trees, object-array tables, JSONL records,
  tabular data, health diagnostics, schema-aware JSON checks, and read-only
  YAML/TOML/XML previews.
- Added guarded visual editing for JSON, JSONL, CSV, and TSV with source-aware
  validation, stale-review checks, conflict review, and safer numeric/text
  preservation.
- Added structured context menus, copy/export actions, example files, large-data
  validation, and release/package budget guards for the expanded format surface.
- Expanded Windows installer associations for supported non-CSV structured formats
  and added a Default Apps handoff prompt while leaving CSV available inside ScieMD
  but unclaimed at the OS level.
- Added command-based structured preview support in the VS Code extension without
  hijacking JSON/YAML/TOML/XML default editor associations.

## 1.0.12 - Merge Gate And Preview Release Readiness

- Added a repeatable pre-merge gate for release validation, packaged desktop build,
  required packaged smoke testing, VSIX packaging, package-content validation,
  staged artifact checks, release identity checks, and whitespace checks.
- Consolidated shared Markdown/domain logic into the `@sciemd/core` workspace
  package and expanded desktop/VS Code drift guards so mirrored code paths are
  classified and checked before release.
- Hardened startup-open recovery, external-change review, visual round-trip safety,
  path grants, export sanitization, generated-output checks, and large-document
  validation.
- Refined the VS Code extension shell with the modern ScieMD toolbar, Data panel,
  floating outline, light/dark/sepia theme polish, and clearer insert actions.
- Kept public Windows release artifacts installer-first by staging NSIS/MSI bundles
  and rejecting stale standalone portable executables by default.
- Added runtime version reporting in the About dialog for packaged Tauri builds,
  with package metadata as the browser/development fallback.
- Hardened VS Code extension packaging so local `file:` workspace dependencies are
  stripped from the packaged VSIX manifest while development installs keep them.

## 1.0.11 - Startup Launch Hardening

- Fixed cold-start Markdown file association launches so double-clicked `.md` and
  `.markdown` files open directly when ScieMD is closed.
- Hardened Windows launch argument parsing for quoted paths, `file://` URLs,
  command-line blobs, and spaced paths.
- Added startup document diagnostics, bounded recovery-draft checks, and duplicate
  pending-launch suppression.
- Corrected NSIS file-association command quoting for installed Windows builds.

## 1.0.10 - Public Preview Hardening

- Aligned desktop, Tauri, Rust, documentation, and VS Code extension release identity.
- Added release and drift guard coverage for duplicated desktop and VS Code editor code.
- Added stricter visual round-trip validation coverage for scientific Markdown edge cases.
- Hardened local export and file-access release gates.

## 1.0.0 - Public Preview

- Initial public preview of the ScieMD desktop Markdown editor.
- Added Windows installer, Windows MSI, macOS disk images, portable Windows executable,
  VS Code extension package, and SHA-256 checksum manifest as release assets.
- Released source under AGPLv3-or-later with commercial licensing available from
  Scienfy Inc. for AGPL-incompatible use.
- Added contribution, security, contributor agreement, third-party license, and font
  attribution documentation.
