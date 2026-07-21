import { useMemo } from 'react';
import type { ComponentProps, CSSProperties } from 'react';
import { AmbientSuggestions } from '../components/AmbientSuggestions';
import { FindReplacePanel } from '../components/FindReplacePanel';
import { InspectorPane } from '../components/InspectorPane';
import { LocalPanelErrorBoundary } from '../components/LocalPanelErrorBoundary';
import { MarkdownToolbar } from '../components/MarkdownToolbar';
import { AppEditorStage } from './AppEditorStage';
import { AppSidebar } from './AppSidebar';
import type { FormatUiCapabilities } from './formatCapabilities';

export interface ActiveDocumentWorkbenchProps {
  formatCapabilities: FormatUiCapabilities;
  toolbar: ComponentProps<typeof MarkdownToolbar>;
  findReplace: ComponentProps<typeof FindReplacePanel> | null;
  outlineOpen: boolean;
  inspectorOpen: boolean;
  sidebarWidth: number;
  sidebar: ComponentProps<typeof AppSidebar>;
  editorStage: ComponentProps<typeof AppEditorStage>;
  inspector: ComponentProps<typeof InspectorPane>;
  ambientSuggestions: ComponentProps<typeof AmbientSuggestions>;
}

/** Active-document presentation only; activation and document mutation remain workspace commands. */
export function ActiveDocumentWorkbench({
  formatCapabilities,
  toolbar,
  findReplace,
  outlineOpen,
  inspectorOpen,
  sidebarWidth,
  sidebar,
  editorStage,
  inspector,
  ambientSuggestions,
}: ActiveDocumentWorkbenchProps) {
  const workbenchStyle = useMemo(() => ({
    '--outline-width': `${sidebarWidth}px`,
  }) as CSSProperties, [sidebarWidth]);

  return (
    <>
      {formatCapabilities.canUseMarkdownToolbar && <MarkdownToolbar {...toolbar} />}
      {findReplace && <FindReplacePanel {...findReplace} />}
      <div
        className={`workbench ${outlineOpen ? 'with-outline' : ''} ${inspectorOpen ? 'with-inspector' : ''}`}
        style={workbenchStyle}
      >
        <AppSidebar {...sidebar} />
        <AppEditorStage {...editorStage} />
        <LocalPanelErrorBoundary
          label="Inspector"
          resetKey={`inspector:${inspector.open ? 'open' : 'closed'}:${inspector.data.filePath ?? 'untitled'}:${inspector.data.mode}:${inspector.data.autosaveStatus}`}
        >
          <InspectorPane {...inspector} />
        </LocalPanelErrorBoundary>
      </div>
      <AmbientSuggestions {...ambientSuggestions} />
    </>
  );
}
