import { Braces, ChevronLeft, ChevronRight, FileCode2, FileText, List, MoreHorizontal, Rows3, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { ContextMenuCard, type ContextMenuPosition } from '../components/ContextMenuCard';
import type { DocumentId } from './documentIdentity';
import { workspaceTabId, workspaceTabPanelId, type TabFormatIconId, type WorkspaceTabModel, type WorkspaceTabsModel } from './workspace/workspaceTabs';

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

type OpenMenu = { kind: 'tab'; tab: WorkspaceTabModel; position: ContextMenuPosition; restore: HTMLElement | null }
  | { kind: 'workspace'; position: ContextMenuPosition; restore: HTMLElement | null }
  | null;

export function WorkspaceTabStrip(props: WorkspaceTabStripProps) {
  const { model, onActivate, onClose, onCloseOthers, onCloseRight, onReorder, onReopenClosed, onSaveAll } = props;
  const [focusedId, setFocusedId] = useState<DocumentId>(model.activeDocumentId);
  const [menu, setMenu] = useState<OpenMenu>(null);
  const [openList, setOpenList] = useState(false);
  const [query, setQuery] = useState('');
  const [listIndex, setListIndex] = useState(0);
  const [overflow, setOverflow] = useState({ active: false, canLeft: false, canRight: false });
  const [draggedId, setDraggedId] = useState<DocumentId | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingCloseFocus = useRef<DocumentId | null>(null);

  const filteredTabs = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? model.tabs.filter((tab) => `${tab.fileName} ${tab.qualifier ?? ''} ${tab.formatLabel}`.toLocaleLowerCase().includes(needle)) : model.tabs;
  }, [model.tabs, query]);

  const updateOverflow = () => {
    const node = scrollRef.current;
    if (!node) return;
    setOverflow({ active: node.scrollWidth > node.clientWidth + 1, canLeft: node.scrollLeft > 1, canRight: node.scrollLeft + node.clientWidth < node.scrollWidth - 1 });
  };

  useEffect(() => {
    setFocusedId(model.activeDocumentId);
    requestAnimationFrame(() => {
      const tab = document.getElementById(workspaceTabId(model.activeDocumentId));
      if (typeof tab?.scrollIntoView === 'function') tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }, [model.activeDocumentId]);
  useEffect(() => {
    const wanted = pendingCloseFocus.current;
    if (!wanted) return;
    const target = model.tabs.find((tab) => tab.documentId === wanted) ?? model.tabs.find((tab) => tab.active) ?? model.tabs[0];
    if (!target) return;
    pendingCloseFocus.current = null;
    setFocusedId(target.documentId);
    requestAnimationFrame(() => document.getElementById(workspaceTabId(target.documentId))?.focus());
  }, [model.tabs]);
  useEffect(() => {
    updateOverflow();
    const node = scrollRef.current;
    if (!node) return;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateOverflow);
    observer?.observe(node);
    node.addEventListener('scroll', updateOverflow, { passive: true });
    window.addEventListener('resize', updateOverflow);
    return () => { observer?.disconnect(); node.removeEventListener('scroll', updateOverflow); window.removeEventListener('resize', updateOverflow); };
  }, [model.tabs.length]);
  useEffect(() => { if (openList) requestAnimationFrame(() => searchRef.current?.focus()); }, [openList]);
  useEffect(() => setListIndex(0), [query]);

  const focusAndActivate = (index: number) => {
    const tab = model.tabs[Math.max(0, Math.min(index, model.tabs.length - 1))];
    if (!tab) return;
    setFocusedId(tab.documentId);
    onActivate(tab.documentId);
    requestAnimationFrame(() => document.getElementById(workspaceTabId(tab.documentId))?.focus());
  };
  const requestClose = (tab: WorkspaceTabModel) => {
    const next = model.tabs[tab.index + 1] ?? model.tabs[tab.index - 1] ?? tab;
    pendingCloseFocus.current = next.documentId;
    onClose(tab.documentId);
  };
  const openTabMenu = (tab: WorkspaceTabModel, position: ContextMenuPosition, restore: HTMLElement | null) => setMenu({ kind: 'tab', tab, position, restore });
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: WorkspaceTabModel) => {
    event.stopPropagation();
    let target: number | null = null;
    if (event.altKey && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      onReorder(tab.documentId, Math.max(0, Math.min(tab.index + (event.key === 'ArrowLeft' ? -1 : 1), model.tabs.length - 1)));
      return;
    }
    if (event.ctrlKey && event.key === 'F4') { event.preventDefault(); requestClose(model.tabs.find((item) => item.active) ?? tab); return; }
    if (event.key === 'Delete') { event.preventDefault(); requestClose(tab); return; }
    if (event.shiftKey && event.key === 'F10') { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openTabMenu(tab, { x: rect.left, y: rect.bottom }, event.currentTarget); return; }
    if (event.key === 'ArrowLeft') target = (tab.index - 1 + model.tabs.length) % model.tabs.length;
    if (event.key === 'ArrowRight') target = (tab.index + 1) % model.tabs.length;
    if (event.key === 'Home') target = 0;
    if (event.key === 'End') target = model.tabs.length - 1;
    if (target !== null) { event.preventDefault(); focusAndActivate(target); }
  };
  const scrollByPage = (direction: -1 | 1) => scrollRef.current?.scrollBy({ left: direction * Math.max(120, scrollRef.current.clientWidth * 0.72), behavior: 'smooth' });

  return (
    <section className="workspace-tabs" aria-label="Document workspace" data-activation-policy="automatic">
      {overflow.active && <button className="workspace-tab-scroll-button" aria-label="Scroll tabs left" disabled={!overflow.canLeft} onClick={() => scrollByPage(-1)}><ChevronLeft size={16} /></button>}
      <div className="workspace-tab-scroll" role="tablist" aria-label="Open documents" ref={scrollRef}>
        {model.tabs.map((tab) => (
          <div className={`workspace-tab-item ${tab.active ? 'is-active' : ''}`} data-tab-state={tab.visualState.kind} key={tab.documentId}
            draggable onDragStart={(event) => { setDraggedId(tab.documentId); event.dataTransfer.effectAllowed = 'move'; }}
            onDragEnd={() => setDraggedId(null)} onDragOver={(event) => { if (draggedId) event.preventDefault(); }}
            onDrop={(event: DragEvent) => { event.preventDefault(); if (draggedId && draggedId !== tab.documentId) onReorder(draggedId, tab.index); setDraggedId(null); }}>
            <button type="button" role="tab" id={workspaceTabId(tab.documentId)} aria-selected={tab.active} aria-controls={workspaceTabPanelId(tab.documentId)}
              aria-label={tab.accessibleName} title={tab.tooltip} tabIndex={tab.documentId === focusedId ? 0 : -1}
              onFocus={() => setFocusedId(tab.documentId)} onClick={() => onActivate(tab.documentId)} onKeyDown={(event) => onTabKeyDown(event, tab)}
              onContextMenu={(event: MouseEvent<HTMLButtonElement>) => { event.preventDefault(); openTabMenu(tab, { x: event.clientX, y: event.clientY }, event.currentTarget); }}>
              <span className="workspace-tab-icon" aria-hidden="true">{formatIcon(tab.formatIconId)}</span>
              <span className="workspace-tab-name">{tab.visibleFileName}{tab.qualifier && <small>{tab.qualifier}</small>}</span>
            </button>
            <span className={`workspace-tab-status is-${tab.visualState.kind}`} title={tab.visualState.label}><span className="sr-only">{tab.visualState.label}</span></span>
            <button type="button" className="workspace-tab-close" aria-label={`Close ${tab.fileName}`} onClick={() => requestClose(tab)}><X size={14} /></button>
          </div>
        ))}
      </div>
      <div className="workspace-tab-tools" data-window-drag-exclude="true">
        {overflow.active && <button className="workspace-tab-scroll-button" aria-label="Scroll tabs right" disabled={!overflow.canRight} onClick={() => scrollByPage(1)}><ChevronRight size={16} /></button>}
        <button ref={openButtonRef} aria-label="Open tabs" title="Open tabs" aria-haspopup="listbox" aria-expanded={openList} onClick={() => { setOpenList((value) => !value); setQuery(''); }}><List size={16} /></button>
        <button aria-label="Workspace actions" title="Workspace actions" aria-haspopup="menu" aria-expanded={menu?.kind === 'workspace'} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ kind: 'workspace', position: { x: rect.right, y: rect.bottom }, restore: event.currentTarget }); }}><MoreHorizontal size={16} /></button>
      </div>
      {openList && <div className="workspace-open-tabs-popover" onKeyDown={(event) => event.stopPropagation()}>
        <label><Search size={15} aria-hidden="true" /><span className="sr-only">Search open tabs</span><input ref={searchRef} role="combobox" aria-label="Search open tabs" aria-expanded="true" aria-controls="workspace-open-tabs-list" aria-activedescendant={filteredTabs[listIndex] ? `workspace-open-option-${encodeURIComponent(filteredTabs[listIndex].documentId)}` : undefined} value={query}
          onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); setOpenList(false); openButtonRef.current?.focus(); }
            if (event.key === 'ArrowDown') { event.preventDefault(); setListIndex((value) => Math.min(filteredTabs.length - 1, value + 1)); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setListIndex((value) => Math.max(0, value - 1)); }
            if (event.key === 'Home') { event.preventDefault(); setListIndex(0); }
            if (event.key === 'End') { event.preventDefault(); setListIndex(Math.max(0, filteredTabs.length - 1)); }
            if (event.key === 'Enter' && filteredTabs[listIndex]) { event.preventDefault(); onActivate(filteredTabs[listIndex].documentId); setOpenList(false); }
          }} /></label>
        <div className="workspace-open-tabs-count" aria-live="polite">{filteredTabs.length} of {model.tabs.length} open</div>
        <div id="workspace-open-tabs-list" role="listbox" aria-label="Open tab results">
          {filteredTabs.map((tab, index) => <button key={tab.documentId} id={`workspace-open-option-${encodeURIComponent(tab.documentId)}`} role="option" aria-selected={tab.active} className={index === listIndex ? 'is-focused' : ''} onMouseEnter={() => setListIndex(index)} onClick={() => { onActivate(tab.documentId); setOpenList(false); }}>{formatIcon(tab.formatIconId)}<span>{tab.fileName}{tab.qualifier && <small>{tab.qualifier}</small>}</span>{tab.active && <span className="sr-only">Active</span>}</button>)}
          {!filteredTabs.length && <p>No open tabs match.</p>}
        </div>
      </div>}
      {menu && <ContextMenuCard position={menu.position} restoreFocusTo={menu.restore} ariaLabel={menu.kind === 'tab' ? `Actions for ${menu.tab.fileName}` : 'Workspace actions'} onClose={() => setMenu(null)} sections={menu.kind === 'tab' ? [{ items: [
        { id: 'move-left', label: 'Move left', disabled: !menu.tab.canMoveLeft, onSelect: () => onReorder(menu.tab.documentId, menu.tab.index - 1) },
        { id: 'move-right', label: 'Move right', disabled: !menu.tab.canMoveRight, onSelect: () => onReorder(menu.tab.documentId, menu.tab.index + 1) },
        { id: 'close-others', label: 'Close other tabs', disabled: menu.tab.count < 2, onSelect: () => onCloseOthers(menu.tab.documentId) },
        { id: 'close-right', label: 'Close tabs to the right', disabled: !menu.tab.canMoveRight, onSelect: () => onCloseRight(menu.tab.documentId) },
        { id: 'close', label: 'Close tab', shortcut: 'Delete', onSelect: () => requestClose(menu.tab) },
      ] }] : [{ items: [
        { id: 'save-all', label: 'Save all documents', onSelect: onSaveAll },
        { id: 'reopen', label: 'Reopen closed document', disabled: model.recentlyClosedCount === 0, onSelect: onReopenClosed },
        { id: 'mru', label: 'Switch to most recently used tab', disabled: !model.mruDocumentId, onSelect: () => model.mruDocumentId && onActivate(model.mruDocumentId) },
      ] }]} />}
      <span className="sr-only" aria-live="polite">Active tab {model.tabs.findIndex((tab) => tab.active) + 1} of {model.tabs.length}</span>
    </section>
  );
}

function formatIcon(id: TabFormatIconId): ReactNode {
  if (id === 'braces') return <Braces size={14} />;
  if (id === 'rows') return <Rows3 size={14} />;
  if (id === 'markup') return <FileCode2 size={14} />;
  return <FileText size={14} />;
}
