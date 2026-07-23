# Bundled Fonts

ScieMD ships the fonts it uses so document styles do not depend on fonts installed on
the user's operating system.

## App Fonts

- `scie-sans/` is the authoritative, hashed bundle for the tuned Scie Sans, Scie Sans
  Compact, Scie Sans Text, and Scie Sans Text Compact families. `npm run fonts:scie-sans`
  projects that bundle into the VS Code extension.
- `vendor/google-sans-flex/` is the authoritative, hashed Google Sans Flex variable-font bundle for the Cursor style. `npm run fonts:google-sans-flex` refreshes it from pinned Google Fonts v21 assets and projects the extension mirror.
- `vendor/source-serif-4/` contains Source Serif 4 for Nature-style prose.
- `vendor/lora/` contains Lora for Science-style prose.
- `vendor/ibm-plex-sans/` contains IBM Plex Sans for the lab-notebook style.
- `vendor/ibm-plex-mono/` is the authoritative, hashed IBM Plex Mono source-editor asset set. Its manifest also records the bounded Noto Sans Mono Greek glyph supplement; `npm run fonts:ibm-plex-mono` generates the extension mirror.
- `vendor/jetbrains-mono/` contains JetBrains Mono for code, technical UI, structured previews, and SVG labels.

All fonts in this folder are redistributable under the SIL Open Font License 1.1.
See `../FONT_LICENSES.md` for the app-level license summary.

The app does not require system font installation. Its checked-in WOFF2 assets are used
by both the desktop app and the generated VS Code extension projection.
