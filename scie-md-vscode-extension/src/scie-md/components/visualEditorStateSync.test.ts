import { describe, expect, it } from 'vitest';
import { flushVisualEditorState, setVisualEditorStateReader } from './visualEditorStateSync';

describe('VS Code single-document editor state compatibility', () => {
  it('uses one current reader and ignores stale disposal without creating workspace state', () => {
    const disposeFirst = setVisualEditorStateReader(() => '# First');
    const disposeSecond = setVisualEditorStateReader(() => '# Second');

    expect(flushVisualEditorState()).toBe('# Second');
    disposeFirst();
    expect(flushVisualEditorState()).toBe('# Second');
    disposeSecond();
    expect(flushVisualEditorState()).toBeNull();
  });
});
