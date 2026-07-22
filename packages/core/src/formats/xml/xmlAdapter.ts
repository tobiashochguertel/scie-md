import type { FormatAdapter } from '../documentFormat.js';
import { formatAdapterIdentity } from '../formatDefinitions.js';
import {
  createXmlContent,
  parseXmlDocument,
  type ParsedXmlDocument,
  XML_PARSE_BUDGET_BYTES,
} from './parseXmlDocument.js';

export const XML_FORMAT_EXTENSIONS = formatAdapterIdentity('xml').extensions;

export const xmlAdapter: FormatAdapter<ParsedXmlDocument> = {
  ...formatAdapterIdentity('xml'),
  capabilities: {
    sourceEditing: true,
    sourceEditor: {
      languageId: 'xml',
      codeMirrorLanguage: 'xml',
      codeMirrorLanguageAvailable: true,
      formatter: 'none',
      lintProfile: 'structured',
      diagnosticsRangeSupport: 'offset',
      commentSyntax: 'xml',
      sourceOnlyThresholdBytes: XML_PARSE_BUDGET_BYTES,
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
      label: 'XML tree',
      readonly: false,
      editable: true,
      preservesSource: true,
      requiresValidParse: true,
      lossy: false,
    }],
    diagnostics: true,
    schemaValidation: false,
    formatPreservingEdits: true,
    parseBudgetBytes: XML_PARSE_BUDGET_BYTES,
    editPolicy: 'format-preserving',
    preservationPolicy: 'exact-source',
    imageReferences: false,
    frontmatter: false,
    conflictMarkersAllowed: false,
    defaultMode: 'source',
  },
  createContent: createXmlContent,
  parse: parseXmlDocument,
};
