import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { TextSelection } from '@milkdown/prose/state';
import { afterEach, describe, expect, it } from 'vitest';
import { focusModePlugin } from './focusModePlugin';

describe('visual active block highlighting', () => {
  const editors: Editor[] = [];
  const roots: HTMLElement[] = [];

  afterEach(async () => {
    await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
    roots.splice(0).forEach((root) => root.remove());
  });

  it('moves the persistent decoration with the ProseMirror caret', async () => {
    const root = document.createElement('div');
    roots.push(root);
    document.body.appendChild(root);
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, '# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n');
      })
      .use(commonmark)
      .use(focusModePlugin)
      .create();
    editors.push(editor);

    const view = editor.ctx.get(editorViewCtx);
    const paragraphs: Array<{ position: number; text: string }> = [];
    view.state.doc.descendants((node, position) => {
      if (node.type.name === 'paragraph') {
        paragraphs.push({ position: position + 1, text: node.textContent });
      }
    });

    expect(root.querySelector('h1')?.classList.contains('visual-active-block')).toBe(true);

    const secondParagraph = paragraphs.find((paragraph) => paragraph.text === 'Second paragraph.');
    expect(secondParagraph).toBeDefined();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(
      view.state.doc,
      secondParagraph!.position,
    )));

    expect(root.querySelector('h1')?.classList.contains('visual-active-block')).toBe(false);
    const activeBlock = root.querySelector('.visual-active-block');
    expect(activeBlock?.tagName).toBe('P');
    expect(activeBlock?.textContent).toBe('Second paragraph.');
  });

  it('activates the final block in a large document with at most two decorations', async () => {
    const root = document.createElement('div');
    roots.push(root);
    document.body.appendChild(root);
    const paragraphCount = 1_100;
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, Array.from(
          { length: paragraphCount },
          (_value, index) => `Paragraph ${index + 1}.`,
        ).join('\n\n'));
      })
      .use(commonmark)
      .use(focusModePlugin)
      .create();
    editors.push(editor);

    const view = editor.ctx.get(editorViewCtx);
    const finalPosition = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, finalPosition)));

    const focusDecorations = root.querySelectorAll('.focus-active-block, .focus-dimmed-block, .visual-active-block');
    expect(focusDecorations.length).toBeLessThanOrEqual(2);
    expect(root.querySelector('.focus-dimmed-block')).toBeNull();
    expect(root.querySelector('.focus-active-block')?.textContent).toBe(`Paragraph ${paragraphCount}.`);
  });
});
