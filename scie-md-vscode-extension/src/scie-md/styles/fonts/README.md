# Bundled Fonts

ScieMD ships the fonts it uses so document styles do not depend on fonts installed on
the user's operating system.

## App Fonts

- `scie-sans/` is generated from the authoritative desktop bundle and contains tuned
  Scie Sans, Scie Sans Compact, Scie Sans Text, and Scie Sans Text Compact assets.
- `vendor/google-sans-flex/` is generated from the authoritative desktop Google Sans Flex bundle by `npm run fonts:google-sans-flex`; do not edit this mirror manually.
- `vendor/source-serif-4/` contains Source Serif 4 for Nature-style prose.
- `vendor/lora/` contains Lora for Science-style prose.
- `vendor/ibm-plex-sans/` contains IBM Plex Sans for the lab-notebook style.
- `vendor/ibm-plex-mono/` is generated from the authoritative desktop IBM Plex Mono assets by `npm run fonts:ibm-plex-mono`; do not edit this mirror manually.
- `vendor/jetbrains-mono/` contains JetBrains Mono for code, technical UI, structured previews, and SVG labels.

All fonts in this folder are redistributable under the SIL Open Font License 1.1.
See `../FONT_LICENSES.md` for the app-level license summary.

The app does not require system font installation. Do not edit the generated Scie Sans
extension mirror directly; run `npm run fonts:scie-sans` from the repository root.
