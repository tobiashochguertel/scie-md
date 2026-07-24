import { Editor, defaultValueCtx, editorViewCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '@sciemd/core';
import { createVisualSourcePositionIndex, markdownTextblockStartLines, textblockIndexAtPosition, visualSourceLineForPosition } from './visualSourceMapping';

describe('visualSourceMapping', () => {
  it('maps a visual list-item selection back to the exact source list line with front matter and variables', async () => {
    const markdown = [
      '---',
      'title: "ScieMD Tutorial"',
      'author: "Scienfy"',
      'bibliography: references.bib',
      'variables:',
      '  cohort_n: 128',
      '  exp1_p_value: "0.018"',
      '  response_rate: "42%"',
      '  reactor_temp_c: 37',
      'scienfy:',
      '  schema: 2',
      '  documentType: "paper"',
      '  visualStyle: "scienfy"',
      '---',
      '',
      '# ScieMD Quick Tour',
      '',
      'ScieMD is a scientific Markdown editor for hybrid work with an LLM.',
      '',
      'The Markdown file stays as the shared source of truth.',
      '',
      '## The five-minute loop',
      '',
      '1. Draft in **Visual** mode.',
      '2. Use **View -> Theme** for light, dark, or system color mode.',
      '3. Type `/` on a blank line to insert content.',
      '4. Select text to use the floating toolbar.',
      '5. Keep reusable values in front matter variables, then cite them inline: {{ cohort_n }} participants, p = {{ exp1_p_value }}.',
      '6. Export through **File -> Export**.',
    ].join('\n');

    const editor = await createEditor(parseFrontmatter(markdown).body);
    const view = editor.ctx.get(editorViewCtx);
    const position = findTextPosition(view.state.doc, 'Keep reusable values');

    expect(textblockIndexAtPosition(view.state.doc, position)).toBe(8);
    expect(visualSourceLineForPosition(view.state.doc, position, markdown)).toBe(28);

    await editor.destroy();
  });

  it('ignores ScieMD metadata comments when matching visual block order to source lines', () => {
    const markdown = [
      '# Title',
      '',
      '<!-- scie_md:note id="llm-1" kind="llm" target="quote" quote="Paragraph": Revise. -->',
      '',
      'Paragraph after metadata.',
    ].join('\n');

    expect(markdownTextblockStartLines(markdown)).toEqual([1, 5]);
  });

  it('keeps source line mapping stable for CRLF front matter documents', () => {
    const markdown = [
      '---',
      'title: CRLF Mapping',
      'variables:',
      '  cohort_n: 128',
      '---',
      '',
      '# Title',
      '',
      'Paragraph with {{ cohort_n }}.',
      '',
      '1. First item',
      '2. Second item',
    ].join('\r\n');

    expect(markdownTextblockStartLines(markdown)).toEqual([7, 9, 11, 12]);
  });

  it('ignores full ScieMD variant bodies when matching visual block order to source lines', () => {
    const markdown = [
      '# Title',
      '',
      '<!-- scie_md:variant:group id="variant-1" active="v1" target="quote" quote="selected text" -->',
      '<!-- scie_md:variant:item id="v1" name="Original" -->',
      'selected text',
      '<!-- scie_md:variant:item id="v2" name="Alternative" -->',
      'alternative text',
      '<!-- scie_md:variant:end -->',
      '',
      'Paragraph after variant metadata.',
    ].join('\n');

    expect(markdownTextblockStartLines(markdown)).toEqual([1, 10]);
  });

  it('builds one revision index that serves repeated positions in a structurally rich document', async () => {
    const markdown = Array.from({ length: 240 }, (_, index) => [
      `## Section ${index + 1}`,
      '',
      `Paragraph ${index + 1}.`,
      '',
      `- Item ${index + 1}`,
    ].join('\n')).join('\n\n');
    const editor = await createEditor(markdown);
    const view = editor.ctx.get(editorViewCtx);
    const index = createVisualSourcePositionIndex(view.state.doc, markdown);
    const first = findTextPosition(view.state.doc, 'Section 1');
    const middle = findTextPosition(view.state.doc, 'Section 120');
    const last = findTextPosition(view.state.doc, 'Section 240');

    expect(index.lineAt(first)).toBe(1);
    expect(index.lineAt(middle)).toBe(715);
    expect(index.lineAt(last)).toBe(1435);
    expect(visualSourceLineForPosition(view.state.doc, last, markdown)).toBe(1435);

    await editor.destroy();
  });
});

async function createEditor(markdown: string): Promise<Editor> {
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(gfm);
  await editor.create();
  return editor;
}

function findTextPosition(doc: { descendants: (callback: (node: { isText: boolean; text?: string }, pos: number) => boolean | void) => void }, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text?.includes(text)) {
      found = pos + node.text.indexOf(text);
      return false;
    }
    return true;
  });
  expect(found).toBeGreaterThanOrEqual(0);
  return found;
}
