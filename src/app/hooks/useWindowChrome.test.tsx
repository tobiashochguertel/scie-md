import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWindowChrome } from './useWindowChrome';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    startDragging: vi.fn(),
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useWindowChrome', () => {
  let container: HTMLDivElement;
  let root: Root;
  let controls: ReturnType<typeof useWindowChrome> | null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    controls = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('routes titlebar close through the unified close transaction', () => {
    const closeWindow = vi.fn(async () => undefined);

    renderChrome({ closeWindow });

    act(() => {
      controls?.handleWindowClose();
    });

    expect(closeWindow).toHaveBeenCalledTimes(1);
  });

  function renderChrome(props: {
    closeWindow: () => Promise<unknown>;
  }) {
    act(() => {
      root.render(
        <Harness
          {...props}
          onControls={(nextControls) => {
            controls = nextControls;
          }}
        />,
      );
    });
  }
});

function Harness({
  closeWindow,
  onControls,
}: {
  closeWindow: () => Promise<unknown>;
  onControls: (controls: ReturnType<typeof useWindowChrome>) => void;
}) {
  const controls = useWindowChrome({ closeWindow });
  onControls(controls);
  return null;
}
