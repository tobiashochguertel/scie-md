import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import type { Range } from '@codemirror/state';
import { Decoration, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { SOURCE_SEMANTIC_TOKEN_CONTRACT } from '@sciemd/core';

const token = (name: keyof typeof SOURCE_SEMANTIC_TOKEN_CONTRACT) => `var(${SOURCE_SEMANTIC_TOKEN_CONTRACT[name]})`;
const markdownSyntaxMarkerNames = new Set([
  'CodeMark',
  'EmphasisMark',
  'HeaderMark',
  'LinkMark',
  'ListMark',
  'QuoteMark',
]);

/** Presentation-only CodeMirror extension. It defines tag styles and no state field, view plugin, decoration, or transaction filter. */
export function createScieMdSemanticHighlighting(): Extension {
  return syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: token('heading'), fontWeight: '400' },
    { tag: tags.strong, color: token('strong'), fontWeight: '500' },
    { tag: tags.emphasis, color: token('emphasis'), fontStyle: 'italic' },
    { tag: [tags.link, tags.url, tags.labelName], color: token('link'), textDecoration: 'underline' },
    { tag: [tags.monospace, tags.regexp], color: token('code') },
    { tag: tags.list, color: token('list') },
    { tag: tags.quote, color: token('quote') },
    { tag: [tags.documentMeta, tags.meta, tags.annotation], color: token('meta') },
    { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: token('comment'), fontStyle: 'italic' },
    { tag: [tags.punctuation, tags.separator, tags.bracket, tags.squareBracket, tags.brace, tags.paren, tags.angleBracket], color: token('punctuation') },
    { tag: tags.propertyName, color: token('property') },
    { tag: tags.tagName, color: token('tag') },
    { tag: [tags.attributeName, tags.attributeValue], color: token('attribute') },
    { tag: [tags.string, tags.character, tags.docString], color: token('string') },
    { tag: [tags.number, tags.integer, tags.float], color: token('number') },
    { tag: [tags.bool, tags.null, tags.atom], color: token('bool') },
    { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.typeName], color: token('keyword') },
    { tag: tags.invalid, color: token('invalid'), textDecoration: 'underline wavy' },
  ]));
}

function markdownSyntaxMarkerDecorations(view: EditorView): DecorationSet {
  const ranges = view.visibleRanges.flatMap(({ from, to }) => {
    const visibleMarkers: Range<Decoration>[] = [];
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (!markdownSyntaxMarkerNames.has(node.name)) return;
        visibleMarkers.push(Decoration.mark({ class: 'cm-source-syntax-marker' }).range(node.from, node.to));
      },
    });
    return visibleMarkers;
  });
  return Decoration.set(ranges, true);
}

const markdownSyntaxMarkerPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = markdownSyntaxMarkerDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = markdownSyntaxMarkerDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

/** Colors Markdown delimiters independently from the semantic content they surround. */
export function createScieMdMarkdownSyntaxMarkerHighlighting(): Extension {
  return markdownSyntaxMarkerPlugin;
}
