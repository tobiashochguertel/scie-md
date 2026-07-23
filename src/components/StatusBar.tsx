import { Copy, MapPin, Minus, Plus, RotateCcw } from 'lucide-react';
import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { AutosaveStatus } from '../app/documentState';
import type { MarkdownHeading } from '@sciemd/core';
import { MARKDOWN_UI_CAPABILITIES, type FormatUiCapabilities } from '../app/formatCapabilities';
import { FONT_SCALE_MAX, FONT_SCALE_MIN } from '../services/settingsService';
import { ContextMenuCard, type ContextMenuSection } from './ContextMenuCard';
import {
  copyContextMenuItem,
  copyContextMenuSection,
  openContextMenuFromEvent,
  openContextMenuFromKeyboard,
  type ContextMenuCopyFeedback,
  type ContextMenuOpenState,
} from './contextMenuUtils';

interface StatusBarProps {
  formatCapabilities?: FormatUiCapabilities;
  autosaveStatus: AutosaveStatus;
  statusText: string;
  workspaceStatus?: string | null;
  headingPath: MarkdownHeading[];
  wordCount: number;
  lineCount: number;
  fontScale: number;
  externalConflict: boolean;
  filePath: string | null;
  onReviewConflict: () => void;
  onSaveAnyway: () => void;
  onReveal: () => void;
  onReload: () => void;
  onJumpToHeading: (heading: MarkdownHeading) => void;
  onSaveNow: () => void;
  onDecreaseFont: () => void;
  onIncreaseFont: () => void;
  onCopyFeedback?: ContextMenuCopyFeedback;
}

export function StatusBar({
  formatCapabilities = MARKDOWN_UI_CAPABILITIES,
  autosaveStatus,
  statusText,
  workspaceStatus = null,
  headingPath,
  wordCount,
  lineCount,
  fontScale,
  externalConflict,
  filePath,
  onReviewConflict,
  onSaveAnyway,
  onReveal,
  onReload,
  onJumpToHeading,
  onSaveNow,
  onDecreaseFont,
  onIncreaseFont,
  onCopyFeedback,
}: StatusBarProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuOpenState | null>(null);
  const currentHeading = headingPath.at(-1);
  const currentHeadingPath = headingPath.map((heading) => heading.text).join(' / ');
  const showManuscriptStatus = formatCapabilities.canUseManuscriptReadiness;
  const currentHeadingMenuState = currentHeading
    ? statusHeadingMenuState(currentHeading, currentHeadingPath, onJumpToHeading, onCopyFeedback)
    : null;
  const openCurrentHeadingMenu = (event: MouseEvent<HTMLElement>) => {
    if (!currentHeadingMenuState) return;
    openContextMenuFromEvent(event, setContextMenu, currentHeadingMenuState);
  };
  const openCurrentHeadingKeyboardMenu = (event: KeyboardEvent<HTMLElement>) => {
    if (!currentHeadingMenuState) return;
    openContextMenuFromKeyboard(event, setContextMenu, currentHeadingMenuState);
  };

  return (
    <footer className="statusbar">
      <div className="status-left">
        <span className={`status-dot ${autosaveStatus}`} />
        <span className="status-save-text">{statusText}</span>
        <span className="status-document-metrics" aria-label={`${wordCount.toLocaleString()} words, ${lineCount.toLocaleString()} lines`}>
          <span className="status-word-count">{formatCount(wordCount, 'word')}</span>
          <span className="status-line-count">{formatCount(lineCount, 'line')}</span>
        </span>
        {workspaceStatus && <span className="status-workspace-summary" role="status">Workspace: {workspaceStatus}</span>}
        {!filePath && (
          <button type="button" className="status-inline-action warning" onClick={onSaveNow}>
            Save now
          </button>
        )}
        {showManuscriptStatus && currentHeading && (
          <nav className="status-breadcrumb" aria-label="Current section">
            <span className="status-breadcrumb-segment">
              <button
                type="button"
                onClick={() => onJumpToHeading(currentHeading)}
                onKeyDown={openCurrentHeadingKeyboardMenu}
                onContextMenu={openCurrentHeadingMenu}
                title={`Current section: ${currentHeadingPath}`}
              >
                {currentHeading.text}
              </button>
            </span>
          </nav>
        )}
      </div>
      <div className="status-actions">
        {externalConflict && filePath && <button type="button" onClick={onReviewConflict}>Review Disk Changes</button>}
        {externalConflict && filePath && <button type="button" onClick={onSaveAnyway}>Save Anyway</button>}
        {filePath && <button type="button" onClick={onReveal}>Reveal in Explorer</button>}
        <button type="button" aria-label="Reload from disk" title="Reload from disk" disabled={!filePath} onClick={onReload}>
          <RotateCcw size={15} />Reload
        </button>
        <div className="status-font-size-controls" role="group" aria-label="Font size">
          <button
            type="button"
            aria-label="Decrease font size"
            title="Decrease font size"
            disabled={fontScale <= FONT_SCALE_MIN}
            onClick={onDecreaseFont}
          >
            <Minus size={15} aria-hidden="true" />
          </button>
          <output className="status-font-scale" aria-label="Current font size">
            {Math.round(fontScale * 100)}%
          </output>
          <button
            type="button"
            aria-label="Increase font size"
            title="Increase font size"
            disabled={fontScale >= FONT_SCALE_MAX}
            onClick={onIncreaseFont}
          >
            <Plus size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
      {contextMenu && (
        <ContextMenuCard
          ariaLabel={contextMenu.ariaLabel}
          sections={contextMenu.sections}
          position={contextMenu.position}
          restoreFocusTo={contextMenu.restoreFocusTo}
          onClose={() => setContextMenu(null)}
        />
      )}
    </footer>
  );
}

function formatCount(count: number, singular: string): string {
  const safeCount = Math.max(0, Math.round(count));
  return `${safeCount.toLocaleString()} ${safeCount === 1 ? singular : `${singular}s`}`;
}

function statusHeadingMenuState(
  heading: MarkdownHeading,
  headingPath: string,
  onJumpToHeading: (heading: MarkdownHeading) => void,
  onCopyFeedback?: ContextMenuCopyFeedback,
): Omit<ContextMenuOpenState, 'position'> {
  const sections: ContextMenuSection[] = [
    {
      items: [
        {
          id: 'jump-heading',
          label: 'Jump to heading',
          icon: <MapPin size={16} />,
          onSelect: () => onJumpToHeading(heading),
        },
      ],
    },
    copyContextMenuSection('copy-heading', 'Copy', <Copy size={16} />, [
      copyContextMenuItem({
        id: 'copy-heading-text',
        label: 'Copy heading text',
        icon: <Copy size={16} />,
        text: heading.text,
        onCopyFeedback,
      }),
      copyContextMenuItem({
        id: 'copy-section-path',
        label: 'Copy section path',
        icon: <Copy size={16} />,
        text: headingPath || heading.text,
        onCopyFeedback,
      }),
      copyContextMenuItem({
        id: 'copy-heading-line',
        label: 'Copy line number',
        icon: <Copy size={16} />,
        text: String(heading.line),
        onCopyFeedback,
      }),
    ]),
  ];
  return {
    ariaLabel: `Actions for current section ${heading.text}`,
    sections,
  };
}
