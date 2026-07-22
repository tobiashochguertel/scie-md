import { useCallback } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriRuntime } from '../runtime';

interface WindowChromeParams {
  closeWindow: () => Promise<unknown>;
}

export function useWindowChrome({ closeWindow }: WindowChromeParams) {
  const handleWindowMinimize = useCallback(() => {
    if (!isTauriRuntime()) return;
    void getCurrentWindow().minimize().catch((error) => {
      console.warn('Window minimize failed.', error);
    });
  }, []);

  const handleWindowMaximize = useCallback(() => {
    if (!isTauriRuntime()) return;
    void getCurrentWindow().toggleMaximize().catch((error) => {
      console.warn('Window maximize failed.', error);
    });
  }, []);

  const handleWindowClose = useCallback(() => {
    void closeWindow().catch((error) => {
      console.warn('Window close failed.', error);
    });
  }, [closeWindow]);

  const handleTitlebarMouseDown = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0 || !isTauriRuntime() || !isExplicitWindowDragTarget(event.target)) return;
    recordWindowChromeAction('drag');
    void getCurrentWindow().startDragging().catch((error) => {
      console.warn('Window drag failed.', error);
    });
  }, []);

  const handleTitlebarDoubleClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0 || !isTauriRuntime() || !isExplicitWindowDragTarget(event.target)) return;
    recordWindowChromeAction('toggle-maximize');
    void getCurrentWindow().toggleMaximize().catch((error) => {
      console.warn('Window maximize failed.', error);
    });
  }, []);

  return {
    handleWindowMinimize,
    handleWindowMaximize,
    handleWindowClose,
    handleTitlebarMouseDown,
    handleTitlebarDoubleClick,
  };
}

function recordWindowChromeAction(action: 'drag' | 'toggle-maximize'): void {
  const root = document.documentElement;
  root.dataset.windowChromeAction = action;
  root.dataset.windowChromeSequence = String(Number(root.dataset.windowChromeSequence ?? '0') + 1);
}

export function isExplicitWindowDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const region = target.closest('[data-window-drag-region="true"]');
  if (!region) return false;
  return !target.closest('button, input, textarea, select, a, [role="button"], [role="menu"], [role="menuitem"], [data-window-drag-exclude="true"]');
}
