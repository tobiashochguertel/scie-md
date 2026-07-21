import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocumentRecord, documentRecordReducer } from '../documentRecord';
import { createWorkspaceState } from '../workspace/workspaceState';
import { workspaceReducer } from '../workspace/workspaceState';
import { createWorkspaceStore, type WorkspaceStore } from '../workspace/workspaceStore';
import { useWindowCloseGuard } from './useWindowCloseGuard';

vi.mock('../runtime', () => ({ isTauriRuntime: () => false }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useWindowCloseGuard', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('protects beforeunload when the aggregate summary contains dirty work', () => {
    const dirty = documentRecordReducer(createDocumentRecord({ sourceText: 'a' }), { type: 'sourceChanged', sourceText: 'b' });
    const store = createWorkspaceStore(createWorkspaceState(dirty));
    act(() => root.render(<Harness store={store} />));
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('opens a quit decision for a dirty background document even when the active document is clean', async () => {
    const active = createDocumentRecord({ sourceText: 'active' });
    const background = documentRecordReducer(createDocumentRecord({ sourceText: 'saved' }), { type: 'sourceChanged', sourceText: 'background' });
    let state = createWorkspaceState(active, {
      multiDocumentWorkspaceEnabled: true,
      activationSurface: { id: 'guard-test', kind: 'hidden-harness' },
    });
    state = workspaceReducer(state, { type: 'openDocument', document: background });
    state = workspaceReducer(state, { type: 'activateDocument', documentId: active.id });
    const store = createWorkspaceStore(state);
    let controls!: ReturnType<typeof useWindowCloseGuard>;
    act(() => root.render(<Harness store={store} onControls={(value) => { controls = value; }} />));
    await act(async () => { await controls.closeWindow(); });
    expect(controls.closeDecision?.unresolvedDocumentIds).toEqual([background.id]);
  });
});

function Harness({ store, onControls }: { store: WorkspaceStore; onControls?: (controls: ReturnType<typeof useWindowCloseGuard>) => void }) {
  const controls = useWindowCloseGuard({ workspaceStore: store, onCloseRequested: vi.fn() });
  onControls?.(controls);
  return null;
}
