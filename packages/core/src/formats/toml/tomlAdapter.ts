import type { FormatAdapter } from '../documentFormat.js';
import { formatAdapterIdentity, requiredFormatParseBudgetBytes } from '../formatDefinitions.js';
import { createTomlContent, parseTomlDocument, type ParsedTomlDocument } from './parseTomlDocument.js';

export const TOML_FORMAT_EXTENSIONS = formatAdapterIdentity('toml').extensions;
export const TOML_PARSE_BUDGET_BYTES = requiredFormatParseBudgetBytes('toml');

export const tomlAdapter: FormatAdapter<ParsedTomlDocument> = {
  ...formatAdapterIdentity('toml'),
  capabilities: {
    sourceEditing: true,
    sourceEditor: {
      languageId: 'toml',
      codeMirrorLanguage: 'plainText',
      codeMirrorLanguageAvailable: false,
      formatter: 'none',
      lintProfile: 'structured',
      diagnosticsRangeSupport: 'line-column',
      commentSyntax: 'toml',
      sourceOnlyThresholdBytes: TOML_PARSE_BUDGET_BYTES,
      contextMenuOperations: [
        'copyText',
        'copyLine',
        'copyDiagnostics',
        'selectLine',
        'switchToVisual',
        'validateSelection',
        'validateClipboard',
      ],
      plainTextReason: 'No bundled first-party CodeMirror TOML language package; parser diagnostics still run in source mode.',
    },
    visualEditing: false,
    readonlyTree: true,
    visualSurfaces: [{
      kind: 'tree',
      label: 'TOML tree',
      readonly: true,
      editable: false,
      preservesSource: false,
      requiresValidParse: true,
      lossy: true,
    }],
    diagnostics: true,
    schemaValidation: false,
    formatPreservingEdits: false,
    parseBudgetBytes: TOML_PARSE_BUDGET_BYTES,
    editPolicy: 'lossy-readonly',
    preservationPolicy: 'lossy-projection',
    imageReferences: false,
    frontmatter: false,
    conflictMarkersAllowed: false,
    defaultMode: 'source',
  },
  createContent: createTomlContent,
  parse: parseTomlDocument,
};
