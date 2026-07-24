import { describe, expect, it, vi } from 'vitest';
import type { EditorAdapter } from './editorAdapter';
import {
  commitVisualEditorReadResult,
  flushEditorAdapterState,
  readEditorAdapterState,
} from './visualEditorStateSync';

describe('visualEditorStateSync', () => {
  it('reads and flushes only the supplied adapter without process-global registration', () => {
    const read = vi.fn(() => ({ surface: 'visual' as const, markdown: '# Read', changed: false }));
    const flushPendingEdits = vi.fn(() => ({ surface: 'visual' as const, markdown: '# Flushed', changed: true }));
    const adapter = createAdapter({ read, flushPendingEdits });

    expect(readEditorAdapterState(adapter)?.markdown).toBe('# Read');
    expect(flushEditorAdapterState(adapter)?.markdown).toBe('# Flushed');
    expect(read).toHaveBeenCalledTimes(1);
    expect(flushPendingEdits).toHaveBeenCalledTimes(1);
    expect(readEditorAdapterState(undefined)).toBeNull();
  });

  it('commits a previously-read changed state exactly once', () => {
    const events: string[] = [];
    const onCommit = vi.fn(() => events.push('commit'));
    const markCommitted = vi.fn(() => events.push('mark'));
    const result = { surface: 'visual' as const, markdown: '# Snapshot', changed: true, markCommitted };

    expect(commitVisualEditorReadResult(result, onCommit)).toBe('# Snapshot');
    expect(markCommitted).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('# Snapshot');
    expect(events).toEqual(['commit', 'mark']);
  });

  it('does not acknowledge a visual snapshot when the authoritative commit rejects it', () => {
    const markCommitted = vi.fn();
    const result = { surface: 'visual' as const, markdown: '# Uncommitted', changed: true, markCommitted };

    expect(() => commitVisualEditorReadResult(result, () => {
      throw new Error('stale document');
    })).toThrow('stale document');
    expect(markCommitted).not.toHaveBeenCalled();
  });

  it('does not call commit hooks for unchanged state', () => {
    const onCommit = vi.fn();
    const markCommitted = vi.fn();
    expect(commitVisualEditorReadResult({
      surface: 'source',
      markdown: '# Same',
      changed: false,
      markCommitted,
    }, onCommit)).toBe('# Same');
    expect(markCommitted).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

function createAdapter(overrides: Partial<EditorAdapter>): EditorAdapter {
  return {
    surface: 'visual',
    read: () => null,
    replace: () => false,
    focus: () => undefined,
    flushPendingEdits: () => null,
    ...overrides,
  };
}
