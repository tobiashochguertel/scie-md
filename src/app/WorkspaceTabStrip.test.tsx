import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocumentId } from './documentIdentity';
import { WorkspaceTabStrip, type WorkspaceTabStripProps } from './WorkspaceTabStrip';
import type { WorkspaceTabModel } from './workspace/workspaceTabs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('WorkspaceTabStrip', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('uses sibling controls, automatic roving activation, close keys, and keyboard context actions', () => {
    const props = fixture(3);
    render(props);
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs).toHaveLength(3);
    expect(tabs[0].querySelector('button')).toBeNull();
    expect(tabs[0].parentElement?.querySelector(':scope > .workspace-tab-close')).not.toBeNull();
    act(() => tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(props.onActivate).toHaveBeenCalledWith(props.model.tabs[1].documentId);
    act(() => tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })));
    expect(props.onClose).toHaveBeenCalledWith(props.model.tabs[1].documentId);
    act(() => tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })));
    expect(container.querySelector('[role="menu"]')?.getAttribute('aria-label')).toContain('Actions for');
  });

  it('offers a searchable 60-item listbox with empty results and workspace actions', () => {
    const props = fixture(60);
    render(props);
    click('Open tabs');
    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(60);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'not-present');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('No open tabs match.');
    click('Workspace actions');
    expect(container.textContent).toContain('Save all documents');
    expect(container.textContent).toContain('Switch to most recently used tab');
  });

  function render(props: WorkspaceTabStripProps) { act(() => root.render(<WorkspaceTabStrip {...props} />)); }
  function click(label: string) {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((node) => node.getAttribute('aria-label') === label || node.textContent === label);
    expect(button).toBeTruthy();
    act(() => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  }
});

function fixture(count: number): WorkspaceTabStripProps {
  const ids = Array.from({ length: count }, () => createDocumentId());
  const tabs: WorkspaceTabModel[] = ids.map((documentId, index) => ({
    documentId, fileName: index % 2 ? 'experiment-results.json' : 'experiment-results.md', visibleFileName: index % 2 ? 'experiment-results.json' : 'experiment-results.md', qualifier: `run-${index + 1}`,
    formatLabel: index % 2 ? 'JSON' : 'MARKDOWN', formatIconId: index % 2 ? 'braces' : 'markdown', visualState: { kind: index === 1 ? 'dirty' : 'ready', label: index === 1 ? 'Unsaved' : 'Ready' },
    accessibleStates: index === 1 ? ['Unsaved'] : [], accessibleName: `experiment results, tab ${index + 1} of ${count}`, tooltip: `experiment results — run-${index + 1}`,
    active: index === 0, index, count, canMoveLeft: index > 0, canMoveRight: index < count - 1,
  }));
  return { model: { tabs, activeDocumentId: ids[0], mruDocumentId: ids[1] ?? null, recentlyClosedCount: 1 }, onActivate: vi.fn(), onClose: vi.fn(), onCloseOthers: vi.fn(), onCloseRight: vi.fn(), onReorder: vi.fn(), onReopenClosed: vi.fn(), onSaveAll: vi.fn() };
}
