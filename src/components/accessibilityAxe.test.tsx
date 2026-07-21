import axe from 'axe-core';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModalShell } from './ModalShell';
import { ToastViewport } from './ToastViewport';
import { WorkspaceTabStrip } from '../app/WorkspaceTabStrip';
import { createDocumentId } from '../app/documentIdentity';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('accessibility axe smoke', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    patchDialogMethods();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    document.body.style.overflow = '';
  });

  it('keeps dialog and toast primitives free of axe violations', async () => {
    const documentId = createDocumentId();
    act(() => {
      root.render(
        <>
          <ModalShell open titleId="axe-dialog-title" onCancel={() => undefined}>
            <h2 id="axe-dialog-title">Review changes</h2>
            <p>Confirm this action before continuing.</p>
            <button type="button">Cancel</button>
            <button type="button">Apply</button>
          </ModalShell>
          <ToastViewport
            toasts={[
              { id: 1, tone: 'success', text: 'Saved', durationMs: 4500 },
              { id: 2, tone: 'error', text: 'Save failed', durationMs: null },
            ]}
            onDismiss={() => undefined}
            onPause={() => undefined}
            onResume={() => undefined}
          />
          <WorkspaceTabStrip
            model={{
              activeDocumentId: documentId,
              mruDocumentId: null,
              recentlyClosedCount: 0,
              tabs: [{ documentId, label: 'paper.md', accessibleName: 'paper.md, MARKDOWN, active, Unsaved, tab 1 of 1', formatLabel: 'MARKDOWN', statuses: ['Unsaved'], active: true, index: 0, count: 1, canMoveLeft: false, canMoveRight: false }],
            }}
            onActivate={() => undefined}
            onClose={() => undefined}
            onCloseOthers={() => undefined}
            onCloseRight={() => undefined}
            onReorder={() => undefined}
            onReopenClosed={() => undefined}
            onSaveAll={() => undefined}
          />
          <div role="tabpanel" id={`workspace-panel-${encodeURIComponent(documentId)}`} aria-labelledby={`workspace-tab-${encodeURIComponent(documentId)}`}>Editor</div>
        </>,
      );
    });

    const results = await axe.run(container, {
      rules: {
        'color-contrast': { enabled: false },
      },
    });

    expect(results.violations).toEqual([]);
  });
});

function patchDialogMethods() {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
}
