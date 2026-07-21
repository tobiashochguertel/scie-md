import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';
import { SOURCE_SEMANTIC_TOKEN_CONTRACT } from '@sciemd/core';

const token = (name: keyof typeof SOURCE_SEMANTIC_TOKEN_CONTRACT) => `var(${SOURCE_SEMANTIC_TOKEN_CONTRACT[name]})`;

/** Presentation-only CodeMirror extension. It defines tag styles and no state field, view plugin, decoration, or transaction filter. */
export function createScieMdSemanticHighlighting(): Extension {
  return syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: token('heading'), fontWeight: '700' },
    { tag: tags.strong, color: token('strong'), fontWeight: '700' },
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
