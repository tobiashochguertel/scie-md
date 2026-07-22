import type { FormatAdapter } from '../documentFormat.js';
import { formatAdapterIdentity, requiredFormatParseBudgetBytes } from '../formatDefinitions.js';
import { createYamlContent, parseYamlDocument, type ParsedYamlDocument } from './parseYamlDocument.js';

export const YAML_FORMAT_EXTENSIONS = formatAdapterIdentity('yaml').extensions;
export const YAML_PARSE_BUDGET_BYTES = requiredFormatParseBudgetBytes('yaml');

export const yamlAdapter: FormatAdapter<ParsedYamlDocument> = {
  ...formatAdapterIdentity('yaml'),
  capabilities: {
    sourceEditing: true,
    sourceEditor: {
      languageId: 'yaml',
      codeMirrorLanguage: 'yaml',
      codeMirrorLanguageAvailable: true,
      formatter: 'none',
      lintProfile: 'structured',
      diagnosticsRangeSupport: 'line-column',
      commentSyntax: 'yaml',
      sourceOnlyThresholdBytes: YAML_PARSE_BUDGET_BYTES,
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
    readonlyTree: false,
    visualSurfaces: [{
      kind: 'tree',
      label: 'YAML tree',
      readonly: false,
      editable: true,
      preservesSource: true,
      requiresValidParse: true,
      lossy: false,
    }],
    diagnostics: true,
    schemaValidation: false,
    formatPreservingEdits: true,
    parseBudgetBytes: YAML_PARSE_BUDGET_BYTES,
    editPolicy: 'format-preserving',
    preservationPolicy: 'exact-source',
    imageReferences: false,
    frontmatter: false,
    conflictMarkersAllowed: false,
    defaultMode: 'source',
  },
  createContent: createYamlContent,
  parse: parseYamlDocument,
};
