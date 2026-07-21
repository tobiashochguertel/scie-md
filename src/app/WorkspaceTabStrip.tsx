import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { DocumentId } from './documentIdentity';
import { workspaceTabId, type WorkspaceTabsModel } from './workspace/workspaceTabs';

export interface WorkspaceTabStripProps {
  model: WorkspaceTabsModel;
  onActivate: (documentId: DocumentId) => void;
  onClose: (documentId: DocumentId) => void;
  onCloseOthers: (documentId: DocumentId) => void;
  onCloseRight: (documentId: DocumentId) => void;
  onReorder: (documentId: DocumentId, toIndex: number) => void;
  onReopenClosed: () => void;
  onSaveAll: () => void;
}

export function WorkspaceTabStrip({
  model,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseRight,
  onReorder,
  onReopenClosed,
  onSaveAll,
}: WorkspaceTabStripProps) {
  const [focusedId, setFocusedId] = useState<DocumentId>(model.activeDocumentId);
  const tablistRef = useRef<HTMLDivElement>(null);
  useEffect(() => setFocusedId(model.activeDocumentId), [model.activeDocumentId]);
  const activeIndex = model.tabs.findIndex((tab) => tab.documentId === model.activeDocumentId);
  const selectedOverflowValue = useMemo(() => model.activeDocumentId as string, [model.activeDocumentId]);

  const focusAndActivate = (index: number) => {
    const tab = model.tabs[Math.max(0, Math.min(index, model.tabs.length - 1))];
    if (!tab) return;
    setFocusedId(tab.documentId);
    onActivate(tab.documentId);
    window.requestAnimationFrame(() => document.getElementById(workspaceTabId(tab.documentId))?.focus());
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focusedIndex = Math.max(0, model.tabs.findIndex((tab) => tab.documentId === focusedId));
    if (event.altKey && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? -1 : 1;
      const target = Math.max(0, Math.min(focusedIndex + delta, model.tabs.length - 1));
      onReorder(model.tabs[focusedIndex].documentId, target);
      return;
    }
    let target: number | null = null;
    if (event.key === 'ArrowLeft') target = (focusedIndex - 1 + model.tabs.length) % model.tabs.length;
    if (event.key === 'ArrowRight') target = (focusedIndex + 1) % model.tabs.length;
    if (event.key === 'Home') target = 0;
    if (event.key === 'End') target = model.tabs.length - 1;
    if (target !== null) {
      event.preventDefault();
      focusAndActivate(target);
    }
  };

  return (
    <section className="workspace-tabs" aria-label="Document workspace">
      <div className="workspace-tab-scroll" role="tablist" aria-label="Open documents" ref={tablistRef} onKeyDown={handleKeyDown}>
        {model.tabs.map((tab) => (
          <div className={`workspace-tab-item ${tab.active ? 'is-active' : ''}`} key={tab.documentId}>
            <button
              type="button"
              role="tab"
              id={workspaceTabId(tab.documentId)}
              aria-selected={tab.active}
              aria-controls={`workspace-panel-${encodeURIComponent(tab.documentId)}`}
              aria-label={tab.accessibleName}
              tabIndex={tab.documentId === focusedId ? 0 : -1}
              onFocus={() => setFocusedId(tab.documentId)}
              onClick={() => onActivate(tab.documentId)}
            >
              <span className="workspace-tab-name">{tab.label}</span>
              <span className="workspace-tab-format">{tab.formatLabel}</span>
              {tab.statuses.length > 0 && <span className="workspace-tab-status">{tab.statuses.join(', ')}</span>}
            </button>
            <button type="button" className="workspace-tab-close" aria-label={`Close ${tab.label}`} onClick={() => onClose(tab.documentId)}>×</button>
            <select
              className="workspace-tab-actions"
              aria-label={`Actions for ${tab.label}`}
              value=""
              onChange={(event) => {
                const action = event.currentTarget.value;
                event.currentTarget.value = '';
                if (action === 'left') onReorder(tab.documentId, tab.index - 1);
                if (action === 'right') onReorder(tab.documentId, tab.index + 1);
                if (action === 'others') onCloseOthers(tab.documentId);
                if (action === 'right-tabs') onCloseRight(tab.documentId);
              }}
            >
              <option value="">More actions</option>
              <option value="left" disabled={!tab.canMoveLeft}>Move left</option>
              <option value="right" disabled={!tab.canMoveRight}>Move right</option>
              <option value="others" disabled={tab.count < 2}>Close other tabs</option>
              <option value="right-tabs" disabled={!tab.canMoveRight}>Close tabs to the right</option>
            </select>
          </div>
        ))}
      </div>
      <div className="workspace-tab-tools">
        <select
          aria-label="All open documents"
          value={selectedOverflowValue}
          onChange={(event) => onActivate(event.currentTarget.value as DocumentId)}
        >
          {model.tabs.map((tab) => <option key={tab.documentId} value={tab.documentId}>{tab.label} — {tab.statuses.join(', ') || 'Ready'}</option>)}
        </select>
        <button type="button" onClick={() => model.mruDocumentId && onActivate(model.mruDocumentId)} disabled={!model.mruDocumentId}>Previous tab</button>
        <button type="button" onClick={onReopenClosed} disabled={model.recentlyClosedCount === 0}>Reopen closed</button>
        <button type="button" onClick={onSaveAll}>Save All</button>
      </div>
      <span className="sr-only" aria-live="polite">Active tab {activeIndex + 1} of {model.tabs.length}</span>
    </section>
  );
}
