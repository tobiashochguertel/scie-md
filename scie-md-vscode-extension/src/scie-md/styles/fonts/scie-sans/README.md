# Scie Sans family bundle

This is ScieMD's authoritative runtime bundle for the tuned Scie Sans families imported
from the Scienfy `scie-sans-tuning` project. It is distributed under the SIL Open Font
License 1.1.

Included cuts:

- Scie Sans 1.320, with the latest tuned main-family glyphs
- Scie Sans Compact 1.320
- Scie Sans Text 1.1, tuned for continuous text and dark UI rendering
- Scie Sans Text Compact 1.2, optically compensated rather than mechanically scaled

## Runtime Files

Main family:

- `ScieSans-Light.woff2`
- `ScieSans-Regular.woff2`
- `ScieSans-Medium.woff2`
- `ScieSans-Bold.woff2`
- `ScieSans-LightItalic.woff2`
- `ScieSans-Italic.woff2`
- `ScieSans-MediumItalic.woff2`
- `ScieSans-BoldItalic.woff2`

Compact family:

- `compact-v1.320/ScieSansCompact-Light.woff2`
- `compact-v1.320/ScieSansCompact-Regular.woff2`
- `compact-v1.320/ScieSansCompact-Medium.woff2`

Text family:

- `ScieSansText-Regular.woff2`
- `ScieSansText-Italic.woff2`
- `ScieSansText-Medium.woff2`
- `ScieSansText-Bold.woff2`
- `ScieSansText-BoldItalic.woff2`
- `ScieSansTextCompact-Regular.woff2`
- `ScieSansTextCompact-Medium.woff2`

Scie Sans Text retains plain zero in prose and exposes the slashed form through the
OpenType `zero` feature. Its Geist-derived digit outlines are covered by
`OFL-Geist.txt`.

## Authority and projection

The files in this directory are checked-in production authority. Run
`npm run fonts:scie-sans` to hash the bundle, write `manifest.json`, and replace the VS
Code extension mirror with a byte-identical projection. The command deliberately does
not regenerate glyphs from an older recipe.
