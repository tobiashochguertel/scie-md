import type {
  DocumentContent,
  FormatDiagnostic,
  FormatParseResult,
  SourceSpan,
  StructuredNodeRef,
  StructuredPathSegment,
  StructuredSourceMap,
} from '../documentFormat.js';
import {
  analyzeStructuredValue,
  createStructuredJsonPreview,
  createStructuredPreservationSummary,
  type ParsedStructuredDocument,
} from '../structured/structuredValue.js';
import { structuredValueType } from '../structured/sourceMap.js';

export const TOML_NATIVE_DTO_VERSION = 'toml-native-dto-v1' as const;
export const TOML_NATIVE_PLANNER_VERSION = 'toml-edit-native-v1' as const;

export interface TomlNativeDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  span?: SourceSpan | null;
  line?: number | null;
  column?: number | null;
}

export interface TomlNativeSourceMapNode {
  path: StructuredPathSegment[];
  pointer: string;
  displayPath: string;
  kind: string;
  valueType: string;
  span: SourceSpan | null;
  valueSpan: SourceSpan | null;
  keySpan: SourceSpan | null;
  editableCandidate: boolean;
  editableOperations: string[];
  unsupportedReason?: string | null;
}

export interface TomlNativeSourceMapReport {
  dtoVersion: string;
  plannerVersion: string;
  status: 'valid' | 'invalid';
  value: unknown | null;
  diagnostics: TomlNativeDiagnostic[];
  nodes: TomlNativeSourceMapNode[];
  unsupportedFeatures: Array<{
    kind: string;
    code: string;
    message: string;
    path: StructuredPathSegment[];
    pointer: string;
    displayPath: string;
    span: SourceSpan | null;
  }>;
  summary: {
    nodeCount: number;
    spannedNodeCount: number;
    unsupportedFeatureCount: number;
    noOpRoundTripPreserved: boolean;
    visualWritesEnabled: boolean;
    boundaryStatus: string;
    commandScope: string;
  };
}

export interface TomlNativeMutationIntent {
  kind: 'replaceScalar' | 'renameObjectKey' | 'addObjectField' | 'deleteObjectField' | 'addArrayItem' | 'deleteArrayItem';
  path: StructuredPathSegment[];
  newValue?: unknown;
  newKey?: string;
  key?: string;
}

export interface TomlNativeMutationPlanReport {
  dtoVersion: string;
  plannerVersion: string;
  status: 'planned' | 'rejected';
  operationId: string;
  path: StructuredPathSegment[];
  patches: Array<{ from: number; to: number; insert: string; expectedText: string }>;
  nextSource: string | null;
  nextValue: unknown | null;
  diagnostics: TomlNativeDiagnostic[];
  untouchedRegionsExact: boolean;
}

export interface ParsedNativeTomlDocument extends ParsedStructuredDocument {
  nativeIdentity: {
    dtoVersion: typeof TOML_NATIVE_DTO_VERSION;
    plannerVersion: typeof TOML_NATIVE_PLANNER_VERSION;
    boundaryStatus: string;
  };
}

export function parseTomlNativeReport(
  content: DocumentContent,
  report: TomlNativeSourceMapReport,
): FormatParseResult<ParsedNativeTomlDocument> {
  const diagnostics = report.diagnostics.map(nativeDiagnostic);
  if (report.dtoVersion !== TOML_NATIVE_DTO_VERSION || report.plannerVersion !== TOML_NATIVE_PLANNER_VERSION) {
    return invalidNativeResult(content, 'toml-native-version-mismatch', 'The desktop TOML engine uses an unsupported contract version.');
  }
  if (report.status !== 'valid' || report.value === null) {
    return { format: 'toml', content, parsed: null, diagnostics, sourceOnly: false };
  }
  if (!report.summary.noOpRoundTripPreserved) {
    return invalidNativeResult(content, 'toml-native-roundtrip-failed', 'The desktop TOML engine could not prove an exact no-op round trip.');
  }
  const sourceMap = nativeSourceMap(report, report.value);
  const warnings = report.unsupportedFeatures.map((feature): FormatDiagnostic => ({
    severity: 'info', code: feature.code, message: feature.message, source: 'toml', category: 'preservation',
    path: [...feature.path], pointer: feature.pointer, displayPath: feature.displayPath, span: feature.span ?? undefined,
    blocking: false,
  }));
  return {
    format: 'toml', content,
    parsed: {
      value: report.value,
      stats: analyzeStructuredValue(report.value),
      sourceMap,
      warnings,
      preservation: createStructuredPreservationSummary({
        format: 'toml', warnings, sourceMapFeasibility: 'cst-source-preserving', nodeSpanCoverage: 'partial',
        candidateLibraries: ['toml_edit'],
        blockers: ['Operations absent from a node native editableOperations list remain source-only.'],
        visualWritesEnabled: report.summary.visualWritesEnabled,
      }),
      jsonPreview: createStructuredJsonPreview(report.value, warnings, 'toml'),
      nativeIdentity: {
        dtoVersion: TOML_NATIVE_DTO_VERSION,
        plannerVersion: TOML_NATIVE_PLANNER_VERSION,
        boundaryStatus: report.summary.boundaryStatus,
      },
    },
    diagnostics: [...diagnostics, ...warnings], sourceOnly: false,
  };
}

export function validateTomlNativeMutationPlan(report: TomlNativeMutationPlanReport): string | null {
  if (report.dtoVersion !== TOML_NATIVE_DTO_VERSION) return 'The desktop TOML DTO version changed.';
  if (report.plannerVersion !== TOML_NATIVE_PLANNER_VERSION) return 'The desktop TOML planner version changed.';
  if (report.status !== 'planned' || report.nextSource === null || report.nextValue === null) {
    return report.diagnostics[0]?.message ?? 'The desktop TOML planner rejected this operation.';
  }
  if (!report.untouchedRegionsExact || report.patches.length !== 1) return 'The desktop TOML planner did not prove one guarded exact-source patch.';
  const patch = report.patches[0];
  if (!patch || !Number.isSafeInteger(patch.from) || !Number.isSafeInteger(patch.to) || patch.from < 0 || patch.to < patch.from) {
    return 'The desktop TOML planner returned an invalid source span.';
  }
  return null;
}

function nativeSourceMap(report: TomlNativeSourceMapReport, value: unknown): StructuredSourceMap {
  const nodes = report.nodes.map((node): StructuredNodeRef => {
    const nodeValue = valueAtPath(value, node.path);
    return {
      format: 'toml', path: [...node.path], pointer: node.pointer, displayPath: node.displayPath,
      type: structuredValueType(nodeValue), span: node.span, valueSpan: node.valueSpan, keySpan: node.keySpan,
      lossy: false, editable: node.editableCandidate, editableOperations: [...node.editableOperations],
      unsupportedReason: node.editableCandidate ? undefined : (node.unsupportedReason ?? 'This TOML syntax is source-only.'),
      childCount: childCount(nodeValue),
    };
  });
  const nodesByPointer: Record<string, StructuredNodeRef> = {};
  const nodesByDisplayPath: Record<string, StructuredNodeRef> = {};
  for (const node of nodes) { nodesByPointer[node.pointer] = node; nodesByDisplayPath[node.displayPath] = node; }
  return { format: 'toml', root: nodesByPointer[''] ?? nodes[0] ?? null, nodes, nodesByPointer, nodesByDisplayPath };
}

function invalidNativeResult(content: DocumentContent, code: string, message: string): FormatParseResult<ParsedNativeTomlDocument> {
  return { format: 'toml', content, parsed: null, diagnostics: [{ severity: 'error', code, message, source: 'toml', category: 'parser', blocking: true }], sourceOnly: false };
}

function nativeDiagnostic(diagnostic: TomlNativeDiagnostic): FormatDiagnostic {
  return {
    severity: diagnostic.severity, code: diagnostic.code, message: diagnostic.message, source: 'toml', category: 'parser',
    span: diagnostic.span ?? undefined, line: diagnostic.line ?? undefined, column: diagnostic.column ?? undefined,
    blocking: diagnostic.severity === 'error',
  };
}

function valueAtPath(value: unknown, path: readonly StructuredPathSegment[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === 'number' && Array.isArray(current)) current = current[segment];
    else if (typeof segment === 'string' && current !== null && typeof current === 'object') current = (current as Record<string, unknown>)[segment];
    else return undefined;
  }
  return current;
}

function childCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === 'object') return Object.keys(value).length;
  return 0;
}
