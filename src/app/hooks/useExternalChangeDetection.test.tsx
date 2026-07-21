import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_METADATA } from '../documentState';
import type { DocumentId } from '../documentIdentity';
import type { WorkspaceExternalChangeCoordinator, WorkspaceExternalChangeEvent } from '../workspace/workspaceExternalChangeCoordinator';
import { useExternalChangeDetection } from './useExternalChangeDetection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const documentId = 'document:active' as DocumentId;

describe('useExternalChangeDetection workspace projection', () => {
  let container: HTMLDivElement;
  let root: Root;
  let eventHandler: ((event: WorkspaceExternalChangeEvent) => void) | null;
  let coordinator: WorkspaceExternalChangeCoordinator;
  let latestCheck: (() => Promise<void>) | null;
  let onCloud: ReturnType<typeof vi.fn<(message: string) => void>>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    eventHandler = null;
    latestCheck = null;
    onCloud = vi.fn<(message: string) => void>();
    coordinator = {
      checkDocument: vi.fn(async () => undefined),
      subscribe: vi.fn((handler) => { eventHandler = handler; return () => { eventHandler = null; }; }),
    } as unknown as WorkspaceExternalChangeCoordinator;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('projects only addressed workspace events and delegates checks without owning a watcher or poller', async () => {
    act(() => root.render(<Harness coordinator={coordinator} onCheck={(check) => { latestCheck = check; }} onCloud={onCloud} />));
    await act(async () => latestCheck?.());
    expect(coordinator.checkDocument).toHaveBeenCalledWith(documentId);

    act(() => {
      eventHandler?.({ documentId: 'document:inactive' as DocumentId, type: 'conflict', path: 'C:\\inactive.md' });
      eventHandler?.({ documentId, type: 'conflict', path: 'C:\\active.md' });
      eventHandler?.({ documentId, type: 'synced', path: 'C:\\active.md', sourceText: 'disk', metadata: DEFAULT_METADATA });
      eventHandler?.({ documentId, type: 'access', path: 'C:\\active.md', detail: 'cloud-unavailable' });
    });
    expect(onCloud).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on unmount', () => {
    act(() => root.render(<Harness coordinator={coordinator} onCheck={(check) => { latestCheck = check; }} onCloud={onCloud} />));
    expect(eventHandler).not.toBeNull();
    act(() => root.unmount());
    expect(eventHandler).toBeNull();
  });
});

function Harness({ coordinator, onCheck, onCloud }: {
  coordinator: WorkspaceExternalChangeCoordinator;
  onCheck: (check: () => Promise<void>) => void;
  onCloud: (message: string) => void;
}) {
  onCheck(useExternalChangeDetection({
    documentId,
    coordinator,
    onCloudPlaceholder: onCloud,
  }));
  return null;
}
