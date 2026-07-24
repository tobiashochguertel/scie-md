# Changelog

## 1.1.1

- Synchronized the extension with the current ScieMD editor and style system,
  including the latest Cursor and Scienfy visual refinements, bundled fonts,
  theme cycling, 30-200% font scaling, and live word/line metrics.
- Added source line numbers with persistent active-line context and distinct
  hover-line highlighting from either the gutter or source text.
- Preserved formatted HTML and Markdown clipboard content from visual mode and
  retained editor state when switching VS Code tabs or visual/source surfaces.
- Hardened host-backed edit durability so typing is reported immediately and
  queued edits from disposed custom-editor panels cannot mutate a closed or
  discarded document.
- Expanded shared-core and host-adapter drift checks so token and source-line
  interaction parity cannot silently fall behind the desktop application.

## 1.1.0

- Added command-based structured previews for JSON, JSONL/NDJSON, YAML, TOML, and
  XML files without taking over VS Code's default structured-data editors.
- Added opt-in validated JSON/JSONL clipboard replacement commands.
- Updated the packaged webview/editor shell to match the ScieMD desktop structured
  data surfaces and shared core package.

## 1.0.8

- Updated the Marketplace README opening to emphasize Markdown editing, reading, hybrid LLM writing, and direct document comments.
- Removed external badge images from the listing because they rendered poorly inside VS Code's extension details view.

## 1.0.7

- Refocused Marketplace search metadata around Markdown editor, reader, writing, commenting, hybrid writing, and LLM writing workflows.
- Updated the short Marketplace description to emphasize document comments, visual reading, and hybrid LLM drafting.

## 1.0.6

- Fixed broken Marketplace screenshots by switching to absolute `raw.githubusercontent.com` URLs that match the committed file paths and repository casing.

## 1.0.5

- Packaged Marketplace screenshots inside the VSIX so they render in VS Code's extension details view.
- Removed reliance on external raw GitHub screenshot URLs.

## 1.0.4

- Replaced the Marketplace screenshots with focused human visual-mode and LLM source-mode illustrations.
- Cropped screenshots to a consistent 16:9 layout for the listing.

## 1.0.3

- Added Marketplace badges and screenshots to the extension listing.
- Added a comparison table for scientific Markdown workflows.
- Clarified how to open Markdown files with ScieMD from VS Code.
- Standardized GitHub links on `scienfy/scie-md`.

## 1.0.2

- Added screenshots for the visual editor, Note to LLM workflow, visual styles, and text versions.

## 1.0.1

- Rewrote the Marketplace README for researchers and scientific writers.
- Expanded Marketplace keywords and categories.
- Added clearer installation and usage guidance.

## 1.0.0

- Initial VS Code Marketplace release of ScieMD Markdown Editor.
