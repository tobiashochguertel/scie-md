import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusBar } from './StatusBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => undefined;

let container: HTMLDivElement;
let root: Root;
let writeClipboardText: ReturnType<typeof vi.fn>;

describe('StatusBar', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    writeClipboardText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeClipboardText },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  it('shows word and line counts while keeping validation badges out of the bottom bar', () => {
    renderStatusBar({ wordCount: 1234, lineCount: 57 });

    expect(container.querySelector('.status-word-count')?.textContent).toBe('1,234 words');
    expect(container.querySelector('.status-line-count')?.textContent).toBe('57 lines');
    expect(container.querySelector('.status-readiness')).toBeNull();
    expect(container.querySelector('.status-badge')).toBeNull();
    expect(container.querySelector('.status-save-text')?.textContent).toBe('Saved');
  });

  it('changes font size from the bottom-right controls and reports the current scale', () => {
    const onDecreaseFont = vi.fn();
    const onIncreaseFont = vi.fn();
    renderStatusBar({ fontScale: 1.5, onDecreaseFont, onIncreaseFont });

    expect(container.querySelector('.status-font-scale')?.textContent).toBe('150%');
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Decrease font size"]')?.click();
      container.querySelector<HTMLButtonElement>('button[aria-label="Increase font size"]')?.click();
    });

    expect(onDecreaseFont).toHaveBeenCalledTimes(1);
    expect(onIncreaseFont).toHaveBeenCalledTimes(1);
  });

  it('enforces the 30-to-200-percent font range at the controls', () => {
    renderStatusBar({ fontScale: 0.3 });
    expect(container.querySelector('.status-font-scale')?.textContent).toBe('30%');
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Decrease font size"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Increase font size"]')?.disabled).toBe(false);

    renderStatusBar({ fontScale: 2 });
    expect(container.querySelector('.status-font-scale')?.textContent).toBe('200%');
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Decrease font size"]')?.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Increase font size"]')?.disabled).toBe(true);
  });

  it('offers save now for unsaved documents', () => {
    const onSaveNow = vi.fn();
    renderStatusBar({
      autosaveStatus: 'idle',
      statusText: 'Autosave off until saved',
      filePath: null,
      onSaveNow,
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('.status-inline-action.warning')?.click();
    });

    expect(onSaveNow).toHaveBeenCalledTimes(1);
  });

  it('keeps aggregate background document state visible beside active save state', () => {
    renderStatusBar({ workspaceStatus: '2 unsaved, 1 conflicted' });

    expect(container.querySelector('.status-save-text')?.textContent).toBe('Saved');
    expect(container.querySelector('.status-workspace-summary')?.textContent).toBe('Workspace: 2 unsaved, 1 conflicted');
  });

  it('keeps the current heading navigation and copy actions', async () => {
    const onJumpToHeading = vi.fn();
    const onCopyFeedback = vi.fn();
    const headingPath = [
      { id: 'root', level: 1, text: 'Study', line: 1 },
      { id: 'methods', level: 2, text: 'Methods', line: 18 },
    ];
    renderStatusBar({ headingPath, onJumpToHeading, onCopyFeedback });

    const breadcrumbButton = container.querySelector<HTMLButtonElement>('.status-breadcrumb button');
    expect(breadcrumbButton?.textContent).toBe('Methods');

    act(() => {
      breadcrumbButton?.click();
    });
    expect(onJumpToHeading).toHaveBeenCalledWith(headingPath[1]);

    openContextMenu(breadcrumbButton!);
    await clickContextMenuItem('Copy');
    await clickContextMenuItem('Copy section path');
    expect(writeClipboardText).toHaveBeenLastCalledWith('Study / Methods');
    expect(onCopyFeedback).toHaveBeenLastCalledWith('Copy section path copied.', 'success');
  });
});

type StatusBarProps = Parameters<typeof StatusBar>[0];

function renderStatusBar(overrides: Partial<StatusBarProps> = {}) {
  const props: StatusBarProps = {
    autosaveStatus: 'saved',
    statusText: 'Saved',
    workspaceStatus: null,
    headingPath: [],
    wordCount: 0,
    lineCount: 0,
    fontScale: 1,
    externalConflict: false,
    filePath: 'C:\\docs\\paper.md',
    onReviewConflict: noop,
    onSaveAnyway: noop,
    onReveal: noop,
    onReload: noop,
    onJumpToHeading: noop,
    onSaveNow: noop,
    onDecreaseFont: noop,
    onIncreaseFont: noop,
    ...overrides,
  };
  act(() => root.render(<StatusBar {...props} />));
}

function openContextMenu(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 160,
      clientY: 96,
      button: 2,
    }));
  });
}

function contextMenuItem(label: string): HTMLButtonElement {
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu-item'))
    .find((candidate) => candidate.querySelector('.context-menu-label')?.textContent === label);
  expect(item).toBeTruthy();
  return item as HTMLButtonElement;
}

function clickContextMenuItem(label: string) {
  const item = contextMenuItem(label);
  return act(async () => {
    item.click();
    await Promise.resolve();
  });
}
