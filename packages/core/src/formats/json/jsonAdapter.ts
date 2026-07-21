import type { FormatAdapter } from '../documentFormat.js';
import { formatAdapterIdentity, requiredFormatParseBudgetBytes } from '../formatDefinitions.js';
import { createJsonContent, parseJsonDocument, type JsonParseOptions, type ParsedJsonDocument } from './parseJsonDocument.js';

export const JSON_FORMAT_EXTENSIONS = formatAdapterIdentity('json').extensions;
export const JSON_PARSE_BUDGET_BYTES = requiredFormatParseBudgetBytes('json');

export const jsonAdapter: FormatAdapter<ParsedJsonDocument, JsonParseOptions> = {
  ...formatAdapterIdentity('json'),
  capabilities: {
    sourceEditing: true,
    sourceEditor: {
      languageId: 'json',
      codeMirrorLanguage: 'json',
      codeMirrorLanguageAvailable: true,
      formatter: 'none',
      lintProfile: 'json',
      diagnosticsRangeSupport: 'offset',
      commentSyntax: 'none',
      sourceOnlyThresholdBytes: JSON_PARSE_BUDGET_BYTES,
      contextMenuOperations: [
        'copyText',
        'copyLine',
        'copyDiagnostics',
        'selectLine',
        'switchToVisual',
        'validateSelection',
        'validateClipboard',
      ],
    },
    visualEditing: true,
    readonlyTree: true,
    visualSurfaces: [{
      kind: 'tree',
      label: 'JSON tree',
      readonly: false,
      editable: true,
      preservesSource: true,
      requiresValidParse: true,
      lossy: false,
    }],
    diagnostics: true,
    schemaValidation: true,
    formatPreservingEdits: true,
    parseBudgetBytes: JSON_PARSE_BUDGET_BYTES,
    editPolicy: 'format-preserving',
    preservationPolicy: 'lossless-parse',
    imageReferences: false,
    frontmatter: false,
    conflictMarkersAllowed: false,
    defaultMode: 'source',
  },
  createContent: createJsonContent,
  parse: parseJsonDocument,
};
