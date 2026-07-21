# File Fidelity Contract

Date: 2026-07-21
Status: implemented by multi-document workbench Round 3

## Guarantees

ScieMD keeps editor character fidelity and disk byte fidelity separate. `SourceEnvelope.sourceText` is the normalized LF character stream used by editors. File metadata records the authoritative native encoding, BOM, dominant line ending, observed line-ending class, original-byte hash, and whether the available evidence supports a lossless write.

The original-byte hash is an identity/change guard only. It is not reconstruction data. A file is labelled `losslessWrite: "yes"` only when the supported encoding can be reproduced, decoding introduced no replacement, and the original line endings are uniform. Metadata-only stat results use `unknown` until native content inspection or a successful write establishes fidelity.

| Evidence | Write policy |
| --- | --- |
| UTF-8, UTF-16LE/BE, or representable Windows-1252 with uniform LF/CRLF/CR | Declared lossless and written with the recorded encoding, BOM, and ending. |
| Mixed line endings without a per-line map | `no`; autosave pauses and manual save requires explicit normalization approval. |
| Decode replacement | `no`; autosave pauses and manual save requires explicit approval. |
| Characters outside Windows-1252 | `no`; native I/O vetoes with `LOSSY_WRITE_REQUIRED`; an approved retry converts to UTF-8. |
| Unknown metadata-only evidence | `unknown`; no byte-exact claim is made. Native I/O remains final authority. |

## Approval authority

A fidelity approval is bound to the current document identity, exact source text, and locator. If any changes while the review is open, the approval is discarded and no retry occurs. The approved native retry keeps the same expected metadata fingerprint, so an external disk change still vetoes the write. Autosave never grants fidelity approval and preserves a recovery draft instead.

## Compatibility

The raw native read response retains `content` while the production file-service adapter publishes `sourceEnvelope` and `sourceText`. Existing browser/test hosts without the new projection are normalized through `readSourceEnvelope`. Markdown-named fields remain only at explicit Markdown/editor compatibility boundaries.

## Explicit non-goals

Round 3 does not retain arbitrary original bytes, create a per-line ending map, or claim exact reconstruction for mixed endings. Exact mixed-ending preservation requires a separately approved raw-byte reference or per-line-map capability and its own migration/security policy. YAML, TOML, and XML visual writes remain governed by their existing source-preservation contracts and stay disabled.

The source-controlled corpus is `file_fidelity_corpus.v1.json`. Round 20 may broaden certification, but it may not relabel a lossy or unknown case as lossless without reconstruction evidence.
