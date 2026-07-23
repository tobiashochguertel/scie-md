import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXPORT_OPTIONS } from '../export/exportTypes';
import { VISUAL_STYLE_OPTIONS } from '../services/visualStyleService';
import { FONT_SCALE_MAX, FONT_SCALE_MIN, type PersistedSettings } from '../services/settingsService';
import { SettingsDialog } from './SettingsDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

describe('SettingsDialog', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  it('renders every visual style option and the selected style explanation', () => {
    act(() => {
      root.render(
        <SettingsDialog
          open
          settings={{ ...settingsFixture, visualStyle: 'claude' }}
          onUpdate={vi.fn()}
          onCheckInkscape={vi.fn()}
          onSetInkscapePath={vi.fn()}
          onOpenWritingDefaults={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    const options = Array.from(container.querySelectorAll('select option')).map((option) => option.textContent);
    for (const style of VISUAL_STYLE_OPTIONS) {
      expect(options).toContain(style.label);
    }
    expect(container.textContent).toContain('Claude desktop-inspired');
  });

  it('exposes the full 30-to-200-percent font range', () => {
    const onUpdate = vi.fn();
    act(() => {
      root.render(
        <SettingsDialog
          open
          settings={{ ...settingsFixture, fontScale: FONT_SCALE_MIN }}
          onUpdate={onUpdate}
          onCheckInkscape={vi.fn()}
          onSetInkscapePath={vi.fn()}
          onOpenWritingDefaults={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    const controls = container.querySelector('[aria-label="Font size"]')!;
    const buttons = Array.from(controls.querySelectorAll('button'));
    expect(controls.querySelector('output')?.textContent).toBe('30%');
    expect(buttons[0].disabled).toBe(true);
    act(() => buttons[1].click());
    expect(onUpdate).toHaveBeenLastCalledWith({ fontScale: 0.35 });

    act(() => {
      root.render(
        <SettingsDialog
          open
          settings={{ ...settingsFixture, fontScale: FONT_SCALE_MAX }}
          onUpdate={onUpdate}
          onCheckInkscape={vi.fn()}
          onSetInkscapePath={vi.fn()}
          onOpenWritingDefaults={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });
    const maxControls = container.querySelector('[aria-label="Font size"]')!;
    const maxButtons = Array.from(maxControls.querySelectorAll('button'));
    expect(maxControls.querySelector('output')?.textContent).toBe('200%');
    expect(maxButtons[1].disabled).toBe(true);
  });
});

const settingsFixture: PersistedSettings = {
  recentFiles: [],
  themeMode: 'light',
  fontScale: 1,
  visualStyle: 'scienfy',
  outlineOpen: true,
  sidebarWidth: 360,
  sidebarView: 'outline',
  explorerRootPath: null,
  inspectorOpen: false,
  authorshipVisible: true,
  focusMode: false,
  documentType: 'report',
  onboardingComplete: true,
  inkscapePath: null,
  exportOptions: DEFAULT_EXPORT_OPTIONS,
};
