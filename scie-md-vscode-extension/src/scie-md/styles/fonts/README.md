# Bundled Fonts

ScieMD ships the fonts it uses so document styles do not depend on fonts installed on
the user's operating system.

## App Fonts

- `scie-sans/` contains Scie Sans and Scie Sans Compact, the Scienfy-maintained UI and
  house-style typefaces.
- `vendor/source-serif-4/` contains Source Serif 4 for manuscript-style prose.
- `vendor/lora/` contains Lora for Science-style prose.
- `vendor/ibm-plex-sans/` contains IBM Plex Sans for lab-note and technical styles.
- `vendor/ibm-plex-mono/` is generated from the authoritative desktop IBM Plex Mono assets by `npm run fonts:ibm-plex-mono`; do not edit this mirror manually.
- `vendor/jetbrains-mono/` contains JetBrains Mono for code, technical UI, structured previews, and SVG labels.

All fonts in this folder are redistributable under the SIL Open Font License 1.1.
See `../FONT_LICENSES.md` for the app-level license summary.

## System Installation

The app does not require system font installation. Scie Sans TTFs can be generated with
`npm run fonts:scie-sans` and installed into Windows for testing in external apps such as
Word, PowerPoint, and Inkscape.
