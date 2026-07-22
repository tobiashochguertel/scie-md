import type { DocumentFormat, FormatDiagnostic, SourceSpan, StructuredPathSegment, StructuredSourceMap } from '../documentFormat.js';
import { splitJsonlSourceLines } from '../jsonl/parseJsonlDocument.js';
import type { JsonlSourceLine } from '../jsonl/parseJsonlDocument.js';
import { parseDelimitedText } from '../tabular/parseDelimitedText.js';
import type { ParsedDelimitedText } from '../tabular/parseDelimitedText.js';
import { createTomlContent, parseTomlDocument } from '../toml/parseTomlDocument.js';
import { parseTomlNativeReport, type TomlNativeSourceMapReport } from '../toml/tomlNative.js';
import { createXmlContent, parseXmlDocument, type ParsedXmlDocument } from '../xml/parseXmlDocument.js';
import { createYamlContent, parseYamlDocument, type ParsedYamlDocument } from '../yaml/parseYamlDocument.js';
import { displayPathFromPath, pointerFromPath, structuredValueType } from './sourceMap.js';

export type StructuredExternalConflictStatus = 'ready' | 'fallback';
export type StructuredExternalConflictEntryKind = 'jsonl-line' | 'tabular-cell' | 'structured-path';
export type StructuredExternalConflictChangeKind = 'changed';

export interface StructuredExternalConflictTextEdit {
  offset: number;
  length: number;
  content: string;
}

export interface StructuredExternalConflictEntry {
  id: string;
  entryKind: StructuredExternalConflictEntryKind;
  changeKind: StructuredExternalConflictChangeKind;
  displayTarget: string;
  basePreview: string;
  currentPreview: string;
  diskPreview: string;
  conflict: boolean;
  warnings: string[];
  edit: StructuredExternalConflictTextEdit;
}

export interface StructuredExternalConflictReviewPlan {
  status: StructuredExternalConflictStatus;
  format: DocumentFormat;
  baseSource: string;
  currentSource: string;
  diskSource: string;
  entries: StructuredExternalConflictEntry[];
  diagnostics: FormatDiagnostic[];
  fallbackReason?: string;
}

export interface StructuredExternalConflictApplyResult {
  ok: boolean;
  nextSource?: string;
  diagnostics: FormatDiagnostic[];
  unsupportedReason?: string;
}

interface JsonlReviewInput {
  label: string;
  source: string;
  lines: JsonlSourceLine[];
  diagnostics: FormatDiagnostic[];
}

interface SourceMappedStructuredReviewInput {
  label: 'base' | 'current' | 'disk';
  format: Extract<DocumentFormat, 'yaml' | 'toml' | 'xml'>;
  source: string;
  value: unknown;
  diagnostics: FormatDiagnostic[];
  sourceMap: StructuredSourceMap | null;
  unsupportedFeaturePointers: Set<string>;
}

interface SourceMappedStructuredPathNode {
  path: StructuredPathSegment[];
  pointer: string;
  displayPath: string;
  type: string;
  span: SourceSpan;
  raw: string;
  value: unknown;
}

interface StructuredPathRawChange {
  kind: StructuredExternalConflictChangeKind | 'added' | 'removed';
  path: StructuredPathSegment[];
}

export function createStructuredExternalConflictReview(
  format: DocumentFormat,
  baseSource: string,
  currentSource: string,
  diskSource: string,
): StructuredExternalConflictReviewPlan {
  if (format === 'jsonl') return createJsonlExternalConflictReview(format, baseSource, currentSource, diskSource);
  if (format === 'csv' || format === 'tsv') return createTabularExternalConflictReview(format, baseSource, currentSource, diskSource);
  if (format === 'yaml') {
    return createSourceMappedStructuredExternalConflictReview(format, baseSource, currentSource, diskSource);
  }
  if (format === 'xml') return createSourceMappedStructuredExternalConflictReview(format, baseSource, currentSource, diskSource);
  if (format === 'toml') return fallbackStructuredExternalConflictReview(
    format, baseSource, currentSource, diskSource,
    'TOML path review requires the desktop native toml_edit source-map capability.', [],
  );
  return fallbackStructuredExternalConflictReview(
    format,
    baseSource,
    currentSource,
    diskSource,
    `${format.toUpperCase()} conflicts are shown as source-only changes until a source-preserving ${format.toUpperCase()} patch planner exists.`,
    [],
  );
}

export function createTomlNativeExternalConflictReview(
  baseSource: string,
  currentSource: string,
  diskSource: string,
  reports: { base: TomlNativeSourceMapReport; current: TomlNativeSourceMapReport; disk: TomlNativeSourceMapReport },
): StructuredExternalConflictReviewPlan {
  return createSourceMappedStructuredExternalConflictReview('toml', baseSource, currentSource, diskSource, reports);
}

export function applyStructuredExternalConflictReviewDecisions(
  review: StructuredExternalConflictReviewPlan,
  rejectedDiskChangeIds: ReadonlySet<string>,
): StructuredExternalConflictApplyResult {
  if (review.status !== 'ready') {
    return unsupportedApplyResult(
      review.fallbackReason ?? 'Structured conflict review is not available for this file.',
    );
  }

  const acceptedEntries = review.entries.filter((entry) => !rejectedDiskChangeIds.has(entry.id));
  if (acceptedEntries.length === 0) {
    return {
      ok: true,
      nextSource: review.currentSource,
      diagnostics: [],
    };
  }

  const nextSource = applyStructuredExternalConflictEdits(
    review.currentSource,
    acceptedEntries.map((entry) => entry.edit),
  );
  const validation = validateStructuredExternalConflictResult(review.format, nextSource);
  if (!validation.ok) return unsupportedApplyResult(validation.reason, validation.diagnostics);

  return {
    ok: true,
    nextSource,
    diagnostics: validation.diagnostics,
  };
}

function createJsonlExternalConflictReview(
  format: DocumentFormat,
  baseSource: string,
  currentSource: string,
  diskSource: string,
): StructuredExternalConflictReviewPlan {
  const base = parseJsonlForConflictReview('base', baseSource);
  const current = parseJsonlForConflictReview('current', currentSource);
  const disk = parseJsonlForConflictReview('disk', diskSource);
  const diagnostics = [
    ...base.diagnostics,
    ...current.diagnostics,
    ...disk.diagnostics,
  ];

  if (diagnostics.length > 0) {
    return fallbackStructuredExternalConflictReview(
      format,
      baseSource,
      currentSource,
      diskSource,
      'JSONL line review requires base, current, and disk sources to contain only valid one-line JSON records.',
      diagnostics,
    );
  }
  if (base.lines.length !== current.lines.length || base.lines.length !== disk.lines.length) {
    return fallbackStructuredExternalConflictReview(
      format,
      baseSource,
      currentSource,
      diskSource,
      'JSONL line review is available only when line counts are unchanged. Use file-level actions for inserted or deleted records.',
      [],
    );
  }

  const entries: StructuredExternalConflictEntry[] = [];
  for (let index = 0; index < disk.lines.length; index += 1) {
    const baseLine = base.lines[index];
    const currentLine = current.lines[index];
    const diskLine = disk.lines[index];
    if (!baseLine || !currentLine || !diskLine || baseLine.content === diskLine.content) continue;
    const lineNumber = index + 1;
    const conflict = currentLine.content !== baseLine.content;
    entries.push({
      id: stableExternalConflictId('jsonl', lineNumber, baseLine.content, diskLine.content),
      entryKind: 'jsonl-line',
      changeKind: 'changed',
      displayTarget: `Line ${lineNumber}`,
      basePreview: previewSourceToken(baseLine.content),
      currentPreview: previewSourceToken(currentLine.content),
      diskPreview: previewSourceToken(diskLine.content),
      conflict,
      warnings: conflict ? ['Current source also changed this line.'] : [],
      edit: {
        offset: currentLine.offset,
        length: currentLine.content.length,
        content: diskLine.content,
      },
    });
  }

  return {
    status: 'ready',
    format,
    baseSource,
    currentSource,
    diskSource,
    entries,
    diagnostics,
  };
}

function createTabularExternalConflictReview(
  format: Extract<DocumentFormat, 'csv' | 'tsv'>,
  baseSource: string,
  currentSource: string,
  diskSource: string,
): StructuredExternalConflictReviewPlan {
  const base = parseDelimitedText(baseSource, { delimiter: delimiterForFormat(format) });
  const current = parseDelimitedText(currentSource, { delimiter: delimiterForFormat(format) });
  const disk = parseDelimitedText(diskSource, { delimiter: delimiterForFormat(format) });
  const guard = tabularConflictGuard(format, base, current, disk);
  if (!guard.ok) {
    return fallbackStructuredExternalConflictReview(
      format,
      baseSource,
      currentSource,
      diskSource,
      guard.reason,
      guard.diagnostics,
    );
  }

  const entries: StructuredExternalConflictEntry[] = [];
  for (let rowIndex = 0; rowIndex < disk.rowCount; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < disk.columnCount; columnIndex += 1) {
      const baseCell = base.sourceRows[rowIndex]?.cells[columnIndex];
      const currentCell = current.sourceRows[rowIndex]?.cells[columnIndex];
      const diskCell = disk.sourceRows[rowIndex]?.cells[columnIndex];
      if (!baseCell || !currentCell || !diskCell) {
        return fallbackStructuredExternalConflictReview(
          format,
          baseSource,
          currentSource,
          diskSource,
          'Table cell review requires every compared cell to have a stable source span.',
          [],
        );
      }
      const baseRaw = baseSource.slice(baseCell.span.offset, baseCell.span.endOffset);
      const currentRaw = currentSource.slice(currentCell.span.offset, currentCell.span.endOffset);
      const diskRaw = diskSource.slice(diskCell.span.offset, diskCell.span.endOffset);
      if (baseRaw === diskRaw) continue;
      const conflict = currentRaw !== baseRaw;
      entries.push({
        id: stableExternalConflictId(format, rowIndex + 1, `${columnIndex}:${baseRaw}`, diskRaw),
        entryKind: 'tabular-cell',
        changeKind: 'changed',
        displayTarget: tabularCellLabel(disk, rowIndex, columnIndex),
        basePreview: previewSourceToken(baseRaw),
        currentPreview: previewSourceToken(currentRaw),
        diskPreview: previewSourceToken(diskRaw),
        conflict,
        warnings: conflict ? ['Current source also changed this cell.'] : [],
        edit: {
          offset: currentCell.span.offset,
          length: currentCell.span.length,
          content: diskRaw,
        },
      });
    }
  }

  return {
    status: 'ready',
    format,
    baseSource,
    currentSource,
    diskSource,
    entries,
    diagnostics: [...base.diagnostics, ...current.diagnostics, ...disk.diagnostics],
  };
}

function createSourceMappedStructuredExternalConflictReview(
  format: Extract<DocumentFormat, 'yaml' | 'toml' | 'xml'>,
  baseSource: string,
  currentSource: string,
  diskSource: string,
  tomlReports?: { base: TomlNativeSourceMapReport; current: TomlNativeSourceMapReport; disk: TomlNativeSourceMapReport },
): StructuredExternalConflictReviewPlan {
  const base = parseSourceMappedStructuredForConflictReview(format, 'base', baseSource, tomlReports?.base);
  const current = parseSourceMappedStructuredForConflictReview(format, 'current', currentSource, tomlReports?.current);
  const disk = parseSourceMappedStructuredForConflictReview(format, 'disk', diskSource, tomlReports?.disk);
  const diagnostics = [
    ...base.diagnostics,
    ...current.diagnostics,
    ...disk.diagnostics,
  ];

  if (!base.sourceMap || !current.sourceMap || !disk.sourceMap) {
    return fallbackStructuredExternalConflictReview(
      format,
      baseSource,
      currentSource,
      diskSource,
      `${format.toUpperCase()} path review requires base, current, and disk sources to parse with source spans.`,
      diagnostics,
    );
  }

  const diskChanges = collectStructuredPathChanges(base.value, disk.value, []);
  const unsupportedChange = diskChanges.find((change) => change.kind !== 'changed');
  if (unsupportedChange) {
    return fallbackStructuredExternalConflictReview(
      format,
      baseSource,
      currentSource,
      diskSource,
      `${format.toUpperCase()} path review currently supports existing scalar value changes only. Use file-level actions for added or removed paths such as ${displayPathFromPath(unsupportedChange.path)}.`,
      diagnostics,
    );
  }

  const nonScalarChange = diskChanges.find((change) => (
    !isStructuredScalarValue(valueAtStructuredPath(base.value, change.path))
    || !isStructuredScalarValue(valueAtStructuredPath(current.value, change.path))
    || !isStructuredScalarValue(valueAtStructuredPath(disk.value, change.path))
  ));
  if (nonScalarChange) {
    return fallbackStructuredExternalConflictReview(
      format,
      baseSource,
      currentSource,
      diskSource,
      `${format.toUpperCase()} path review currently supports scalar path changes only. Use file-level actions for container changes such as ${displayPathFromPath(nonScalarChange.path)}.`,
      diagnostics,
    );
  }

  const currentChanges = collectStructuredPathChanges(base.value, current.value, []);
  const entries: StructuredExternalConflictEntry[] = [];
  for (let index = 0; index < diskChanges.length; index += 1) {
    const change = diskChanges[index];
    const baseNode = sourceMappedNodeForPath(base, change.path);
    const currentNode = sourceMappedNodeForPath(current, change.path);
    const diskNode = sourceMappedNodeForPath(disk, change.path);
    const missingSpan = !baseNode || !currentNode || !diskNode;
    const unsupportedPointer = [base, current, disk].find((input) => hasUnsupportedFeatureAtPath(input, change.path));
    if (missingSpan || unsupportedPointer) {
      return fallbackStructuredExternalConflictReview(
        format,
        baseSource,
        currentSource,
        diskSource,
        missingSpan
          ? `${format.toUpperCase()} path review requires stable raw source spans for ${displayPathFromPath(change.path)}.`
          : `${format.toUpperCase()} path review is unavailable for ${displayPathFromPath(change.path)} because unsupported source syntax touches that path.`,
        diagnostics,
      );
    }

    const conflict = currentNode.raw !== baseNode.raw;
    const warnings = [
      ...(conflict ? [`Current source also changed ${diskNode.displayPath}.`] : []),
      ...(change.path.some((segment) => typeof segment === 'number')
        ? ['Array item changes are reviewed by numeric index; confirm the item still means the same record before accepting disk.']
        : []),
    ];
    entries.push({
      id: stableExternalConflictId(format, index + 1, `${baseNode.pointer}:${baseNode.raw}`, diskNode.raw),
      entryKind: 'structured-path',
      changeKind: 'changed',
      displayTarget: diskNode.displayPath,
      basePreview: previewSourceToken(baseNode.raw),
      currentPreview: previewSourceToken(currentNode.raw),
      diskPreview: previewSourceToken(diskNode.raw),
      conflict,
      warnings,
      edit: {
        offset: currentNode.span.offset,
        length: currentNode.span.length,
        content: diskNode.raw,
      },
    });
  }

  return {
    status: 'ready',
    format,
    baseSource,
    currentSource,
    diskSource,
    entries,
    diagnostics,
  };
}

function parseJsonlForConflictReview(label: string, source: string): JsonlReviewInput {
  const lines = splitJsonlSourceLines(source);
  const diagnostics: FormatDiagnostic[] = [];
  lines.forEach((line) => {
    if (line.content.trim().length === 0) {
      diagnostics.push({
        severity: 'error',
        code: 'jsonl-conflict-blank-line',
        message: `${label} JSONL line ${line.line} is blank; blank lines cannot be safely line-reviewed.`,
        line: line.line,
        column: 1,
        offset: line.offset,
        length: Math.max(1, line.content.length),
        source: 'jsonl',
        category: 'parser',
      });
      return;
    }
    try {
      JSON.parse(line.content);
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'jsonl-conflict-invalid-line',
        message: `${label} JSONL line ${line.line} does not parse: ${error instanceof Error ? error.message : String(error)}`,
        line: line.line,
        column: 1,
        offset: line.offset,
        length: Math.max(1, line.content.length),
        source: 'jsonl',
        category: 'parser',
      });
    }
  });
  return { label, source, lines, diagnostics };
}

function tabularConflictGuard(
  format: Extract<DocumentFormat, 'csv' | 'tsv'>,
  base: ParsedDelimitedText,
  current: ParsedDelimitedText,
  disk: ParsedDelimitedText,
): { ok: true } | { ok: false; reason: string; diagnostics: FormatDiagnostic[] } {
  const diagnostics = [...base.diagnostics, ...current.diagnostics, ...disk.diagnostics];
  const blocking = diagnostics.find((diagnostic) => (
    diagnostic.severity === 'error'
    || diagnostic.code === 'tabular-inconsistent-row-width'
    || diagnostic.code === 'tabular-characters-after-quote'
  ));
  if (blocking) {
    return {
      ok: false,
      reason: `Table cell review is unavailable until parser issues are resolved. ${blocking.message}`,
      diagnostics,
    };
  }
  if (base.previewTruncated || current.previewTruncated || disk.previewTruncated) {
    return {
      ok: false,
      reason: 'Table cell review is unavailable for truncated parser previews. Use file-level actions for this large table.',
      diagnostics,
    };
  }
  if (base.rowCount !== current.rowCount || base.rowCount !== disk.rowCount) {
    return {
      ok: false,
      reason: 'Table cell review is available only when row counts are unchanged. Use file-level actions for inserted or deleted rows.',
      diagnostics,
    };
  }
  if (base.columnCount !== current.columnCount || base.columnCount !== disk.columnCount) {
    return {
      ok: false,
      reason: 'Table cell review is available only when column counts are unchanged. Use file-level actions for changed table shapes.',
      diagnostics,
    };
  }
  if (
    base.header.hasHeader !== current.header.hasHeader
    || base.header.hasHeader !== disk.header.hasHeader
    || base.header.names.join('\u0000') !== current.header.names.join('\u0000')
    || base.header.names.join('\u0000') !== disk.header.names.join('\u0000')
  ) {
    return {
      ok: false,
      reason: 'Table cell review requires stable header detection and header names across base, current, and disk.',
      diagnostics,
    };
  }
  if (format === 'csv' && (base.delimiter !== ',' || current.delimiter !== ',' || disk.delimiter !== ',')) {
    return {
      ok: false,
      reason: 'CSV cell review requires comma-delimited source across base, current, and disk.',
      diagnostics,
    };
  }
  if (format === 'tsv' && (base.delimiter !== '\t' || current.delimiter !== '\t' || disk.delimiter !== '\t')) {
    return {
      ok: false,
      reason: 'TSV cell review requires tab-delimited source across base, current, and disk.',
      diagnostics,
    };
  }
  return { ok: true };
}

function parseSourceMappedStructuredForConflictReview(
  format: Extract<DocumentFormat, 'yaml' | 'toml' | 'xml'>,
  label: 'base' | 'current' | 'disk',
  source: string,
  tomlReport?: TomlNativeSourceMapReport,
): SourceMappedStructuredReviewInput {
  if (format === 'yaml') {
    const result = parseYamlDocument(createYamlContent(source));
    return {
      label,
      format,
      source,
      value: result.parsed?.value,
      diagnostics: labelDiagnostics(label, result.diagnostics),
      sourceMap: result.parsed?.sourceMap ?? null,
      unsupportedFeaturePointers: yamlUnsupportedFeaturePointers(result.parsed),
    };
  }

  if (format === 'xml') {
    const result = parseXmlDocument(createXmlContent(source));
    return {
      label,
      format,
      source,
      value: result.parsed?.value,
      diagnostics: labelDiagnostics(label, result.diagnostics),
      sourceMap: result.parsed?.sourceMap ?? null,
      unsupportedFeaturePointers: xmlUnsupportedFeaturePointers(result.parsed),
    };
  }

  if (!tomlReport) return { label, format, source, value: undefined, diagnostics: [], sourceMap: null, unsupportedFeaturePointers: new Set() };
  const result = parseTomlNativeReport(createTomlContent(source), tomlReport);
  return {
    label,
    format,
    source,
    value: result.parsed?.value,
    diagnostics: labelDiagnostics(label, result.diagnostics),
    sourceMap: result.parsed?.sourceMap ?? null,
    unsupportedFeaturePointers: new Set(result.parsed?.sourceMap.nodes.filter((node) => !node.editableOperations?.includes('replaceScalar')).map((node) => node.pointer) ?? []),
  };
}

function labelDiagnostics(label: 'base' | 'current' | 'disk', diagnostics: readonly FormatDiagnostic[]): FormatDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    code: `${diagnostic.source ?? 'structured'}-review-${label}-${diagnostic.code}`,
    message: `${sourceLabel(label)}: ${diagnostic.message}`,
  }));
}

function yamlUnsupportedFeaturePointers(parsed: ParsedYamlDocument | null | undefined): Set<string> {
  const pointers = new Set<string>();
  for (const feature of parsed?.sourceMapUnsupportedFeatures ?? []) {
    pointers.add(feature.pointer);
  }
  return pointers;
}

function xmlUnsupportedFeaturePointers(parsed: ParsedXmlDocument | null | undefined): Set<string> {
  return new Set((parsed?.sourceMap.nodes ?? [])
    .filter((node) => node.type === 'string' && !node.editable)
    .map((node) => node.pointer));
}

function collectStructuredPathChanges(
  before: unknown,
  after: unknown,
  path: StructuredPathSegment[],
): StructuredPathRawChange[] {
  if (structuredValueType(before) !== structuredValueType(after)) {
    return [{ kind: 'changed', path }];
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const changes: StructuredPathRawChange[] = [];
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= before.length) {
        changes.push({ kind: 'added', path: [...path, index] });
      } else if (index >= after.length) {
        changes.push({ kind: 'removed', path: [...path, index] });
      } else {
        changes.push(...collectStructuredPathChanges(before[index], after[index], [...path, index]));
      }
    }
    return changes;
  }

  if (isRecord(before) && isRecord(after)) {
    const changes: StructuredPathRawChange[] = [];
    const beforeKeys = new Set(Object.keys(before));
    const afterKeys = new Set(Object.keys(after));
    const keys = Array.from(new Set([...beforeKeys, ...afterKeys])).sort((left, right) => left.localeCompare(right));
    for (const key of keys) {
      if (!beforeKeys.has(key)) {
        changes.push({ kind: 'added', path: [...path, key] });
      } else if (!afterKeys.has(key)) {
        changes.push({ kind: 'removed', path: [...path, key] });
      } else {
        changes.push(...collectStructuredPathChanges(before[key], after[key], [...path, key]));
      }
    }
    return changes;
  }

  return structuredScalarValuesEqual(before, after) ? [] : [{ kind: 'changed', path }];
}

function sourceMappedNodeForPath(
  input: SourceMappedStructuredReviewInput,
  path: readonly StructuredPathSegment[],
): SourceMappedStructuredPathNode | null {
  const pointer = pointerFromPath(path);
  const node = input.sourceMap?.nodesByPointer[pointer];
  const span = node?.valueSpan ?? node?.span ?? null;
  if (!node || !span) return null;
  return {
    path: [...path],
    pointer,
    displayPath: node.displayPath,
    type: node.type,
    span,
    raw: input.source.slice(span.offset, span.offset + span.length),
    value: valueAtStructuredPath(input.value, path),
  };
}

function hasUnsupportedFeatureAtPath(
  input: SourceMappedStructuredReviewInput,
  path: readonly StructuredPathSegment[],
): boolean {
  return input.unsupportedFeaturePointers.has(pointerFromPath(path));
}

function valueAtStructuredPath(value: unknown, path: readonly StructuredPathSegment[]): unknown {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === 'number') {
      current = current[segment];
      continue;
    }
    if (isRecord(current) && typeof segment === 'string') {
      current = current[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

function isStructuredScalarValue(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function structuredScalarValuesEqual(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' && typeof right === 'number') return Object.is(left, right);
  return left === right;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateStructuredExternalConflictResult(format: DocumentFormat, source: string): { ok: true; diagnostics: FormatDiagnostic[] } | { ok: false; reason: string; diagnostics: FormatDiagnostic[] } {
  if (format === 'jsonl') {
    const parsed = parseJsonlForConflictReview('merged', source);
    if (parsed.diagnostics.length > 0) {
      return {
        ok: false,
        reason: 'Structured review was rejected because the merged JSONL source would not parse.',
        diagnostics: parsed.diagnostics,
      };
    }
    return { ok: true, diagnostics: [] };
  }
  if (format === 'csv' || format === 'tsv') {
    const parsed = parseDelimitedText(source, { delimiter: delimiterForFormat(format) });
    const blocking = parsed.diagnostics.find((diagnostic) => (
      diagnostic.severity === 'error'
      || diagnostic.code === 'tabular-inconsistent-row-width'
      || diagnostic.code === 'tabular-characters-after-quote'
    ));
    if (blocking) {
      return {
        ok: false,
        reason: `Structured review was rejected because the merged table would not parse safely. ${blocking.message}`,
        diagnostics: parsed.diagnostics,
      };
    }
    return { ok: true, diagnostics: parsed.diagnostics };
  }
  if (format === 'yaml') {
    const result = parseYamlDocument(createYamlContent(source));
    if (!result.parsed) {
      return {
        ok: false,
        reason: 'Structured review was rejected because the merged YAML source would not parse.',
        diagnostics: result.diagnostics,
      };
    }
    return { ok: true, diagnostics: result.diagnostics };
  }
  if (format === 'toml') {
    const result = parseTomlDocument(createTomlContent(source));
    if (!result.parsed) {
      return {
        ok: false,
        reason: 'Structured review was rejected because the merged TOML source would not parse.',
        diagnostics: result.diagnostics,
      };
    }
    return { ok: true, diagnostics: result.diagnostics };
  }
  if (format === 'xml') {
    const result = parseXmlDocument(createXmlContent(source));
    if (!result.parsed) {
      return {
        ok: false,
        reason: 'Structured review was rejected because the merged XML source would not parse or violated the XML security policy.',
        diagnostics: result.diagnostics,
      };
    }
    return { ok: true, diagnostics: result.diagnostics };
  }
  return { ok: true, diagnostics: [] };
}

function applyStructuredExternalConflictEdits(source: string, edits: readonly StructuredExternalConflictTextEdit[]): string {
  return [...edits]
    .sort((left, right) => right.offset - left.offset)
    .reduce((current, edit) => (
      `${current.slice(0, edit.offset)}${edit.content}${current.slice(edit.offset + edit.length)}`
    ), source);
}

function fallbackStructuredExternalConflictReview(
  format: DocumentFormat,
  baseSource: string,
  currentSource: string,
  diskSource: string,
  fallbackReason: string,
  diagnostics: FormatDiagnostic[],
): StructuredExternalConflictReviewPlan {
  return {
    status: 'fallback',
    format,
    baseSource,
    currentSource,
    diskSource,
    entries: [],
    diagnostics,
    fallbackReason,
  };
}

function tabularCellLabel(parsed: ParsedDelimitedText, rowIndex: number, columnIndex: number): string {
  const columnName = parsed.header.names[columnIndex] ?? `Column ${columnIndex + 1}`;
  if (parsed.header.hasHeader && rowIndex === 0) return `Header "${columnName}"`;
  const dataRowIndex = parsed.header.hasHeader ? rowIndex : rowIndex + 1;
  return `Row ${dataRowIndex}, ${columnName}`;
}

function delimiterForFormat(format: Extract<DocumentFormat, 'csv' | 'tsv'>): ',' | '\t' {
  return format === 'tsv' ? '\t' : ',';
}

function previewSourceToken(value: string): string {
  const collapsed = value.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  return collapsed.length > 180 ? `${collapsed.slice(0, 177)}...` : collapsed;
}

function stableExternalConflictId(format: string, index: number, base: string, disk: string): string {
  return `${format}:${index}:${simpleHash(base)}:${simpleHash(disk)}`;
}

function sourceLabel(label: 'base' | 'current' | 'disk'): string {
  if (label === 'base') return 'Base source';
  if (label === 'current') return 'Current source';
  return 'Disk source';
}

function simpleHash(source: string): string {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 16777619) >>> 0;
  }
  return `${source.length.toString(36)}-${hash.toString(36)}`;
}

function unsupportedApplyResult(reason: string, diagnostics: FormatDiagnostic[] = []): StructuredExternalConflictApplyResult {
  return {
    ok: false,
    diagnostics,
    unsupportedReason: reason,
  };
}
