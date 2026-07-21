import type { DocumentDiagnostic, ParsedScienfyDocument, ParseScienfyDocumentOptions } from '../../domain/document/documentModel';
import { safeParseScienfyDocument } from '../../domain/document/documentModel';
import type { DocumentContent, FormatAdapter, FormatDiagnostic } from '../documentFormat';
import { createDocumentContent } from '../documentFormat';
import { formatAdapterIdentity, requiredFormatParseBudgetBytes } from '../formatDefinitions';

export const MARKDOWN_FORMAT_EXTENSIONS = formatAdapterIdentity('markdown').extensions;
export const MARKDOWN_SOURCE_ONLY_FILE_BYTES = requiredFormatParseBudgetBytes('markdown');

export const markdownAdapter: FormatAdapter<ParsedScienfyDocument, ParseScienfyDocumentOptions> = {
  ...formatAdapterIdentity('markdown'),
  capabilities: {
    sourceEditing: true,
    sourceEditor: {
      languageId: 'markdown',
      codeMirrorLanguage: 'markdown',
      codeMirrorLanguageAvailable: true,
      formatter: 'none',
      lintProfile: 'markdown',
      diagnosticsRangeSupport: 'line',
      commentSyntax: 'markdown',
      sourceOnlyThresholdBytes: MARKDOWN_SOURCE_ONLY_FILE_BYTES,
      contextMenuOperations: ['copyText', 'copyLine', 'copyDiagnostics', 'selectLine', 'switchToVisual'],
    },
    visualEditing: true,
    readonlyTree: false,
    visualSurfaces: [{
      kind: 'markdown',
      label: 'Markdown visual editor',
      readonly: false,
      editable: true,
      preservesSource: true,
      requiresValidParse: false,
      lossy: false,
    }],
    diagnostics: true,
    schemaValidation: false,
    formatPreservingEdits: true,
    parseBudgetBytes: MARKDOWN_SOURCE_ONLY_FILE_BYTES,
    editPolicy: 'format-preserving',
    preservationPolicy: 'exact-source',
    imageReferences: true,
    frontmatter: true,
    conflictMarkersAllowed: true,
    defaultMode: 'visual',
    sourceOnlyFileBytes: MARKDOWN_SOURCE_ONLY_FILE_BYTES,
  },
  createContent(text, path = null, metadata) {
    return createDocumentContent('markdown', text, path, metadata);
  },
  parse(content: DocumentContent, options: ParseScienfyDocumentOptions = {}) {
    const parsed = safeParseScienfyDocument(content.text, options);
    return {
      format: 'markdown',
      content,
      parsed,
      diagnostics: parsed.diagnostics.map(markdownDiagnosticToFormatDiagnostic),
      sourceOnly: content.text.length > MARKDOWN_SOURCE_ONLY_FILE_BYTES,
    };
  },
};

function markdownDiagnosticToFormatDiagnostic(diagnostic: DocumentDiagnostic): FormatDiagnostic {
  return {
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    line: diagnostic.line,
    source: 'markdown',
  };
}
