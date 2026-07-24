import { describe, expect, it } from 'vitest';
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/kit/core';
import { AllSelection } from '@milkdown/prose/state';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { equivalentVisualMarkdown, visualClipboardPayload } from './VisualMarkdownEditor';

describe('visual clipboard serialization', () => {
  it('preserves inline formatting and list structure in rich and plain clipboard forms', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, [
          'A **bold** and *italic* [link](https://example.com).',
          '',
          '- First bullet',
          '- Second bullet',
          '',
          '3. Third item',
          '4. Fourth item',
        ].join('\n'));
      })
      .use(commonmark)
      .use(gfm)
      .use(clipboard)
      .create();
    const view = editor.ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));

    const payload = visualClipboardPayload(editor);

    expect(payload?.html).toContain('<strong>bold</strong>');
    expect(payload?.html).toContain('<em>italic</em>');
    expect(payload?.html).toContain('<ul ');
    expect(payload?.html).toContain('<ol start="3"');
    expect(payload?.text).toContain('**bold**');
    expect(payload?.text).toMatch(/[-*+] First bullet/);
    expect(payload?.text).toContain('3. Third item');

    await editor.destroy();
    root.remove();
  });
});

describe('equivalentVisualMarkdown', () => {
  it('treats first-mount line ending and trailing whitespace normalization as equivalent', () => {
    expect(equivalentVisualMarkdown('---\ntitle: Demo\n---\n# Title  \n', '---\r\ntitle: Demo\r\n---\r\n# Title\n')).toBe(true);
  });

  it('does not hide meaningful content changes', () => {
    expect(equivalentVisualMarkdown('# Title\n\nA', '# Title\n\nB')).toBe(false);
  });
});
