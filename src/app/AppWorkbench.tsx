import type { ComponentProps, ReactNode } from 'react';
import { AmbientSuggestions } from '../components/AmbientSuggestions';
import { AppTopbar, type AppTopbarMenuId } from '../components/AppTopbar';
import { FindReplacePanel } from '../components/FindReplacePanel';
import { InspectorPane } from '../components/InspectorPane';
import { MarkdownToolbar } from '../components/MarkdownToolbar';
import { StatusBar } from '../components/StatusBar';
import { AppEditorStage } from './AppEditorStage';
import { AppSidebar } from './AppSidebar';
import { ActiveDocumentWorkbench } from './ActiveDocumentWorkbench';
import { WorkspaceShell } from './WorkspaceShell';
import { WorkspaceTabStrip } from './WorkspaceTabStrip';
import type { ActiveDocumentProjection } from './workspace';

type AppTopbarWorkbenchProps = Omit<ComponentProps<typeof AppTopbar>,
  'activeMenu' | 'onToggleMenu' | 'onCloseMenus' | 'format' | 'formatCapabilities' | 'documentChrome'>;

export interface AppWorkbenchProps {
  focusMode: boolean;
  skipToEditorLabel: string;
  activeTopbarMenu: AppTopbarMenuId | null;
  onToggleTopbarMenu: (menu: AppTopbarMenuId) => void;
  onCloseTopbarMenus: () => void;
  activeProjection: ActiveDocumentProjection;
  topbar: AppTopbarWorkbenchProps;
  toolbar: ComponentProps<typeof MarkdownToolbar>;
  findReplace: ComponentProps<typeof FindReplacePanel> | null;
  outlineOpen: boolean;
  inspectorOpen: boolean;
  sidebarWidth: number;
  sidebar: ComponentProps<typeof AppSidebar>;
  editorStage: ComponentProps<typeof AppEditorStage>;
  inspector: ComponentProps<typeof InspectorPane>;
  ambientSuggestions: ComponentProps<typeof AmbientSuggestions>;
  statusBar: ComponentProps<typeof StatusBar>;
  workspaceTabs: ComponentProps<typeof WorkspaceTabStrip>;
  children?: ReactNode;
}

export function AppWorkbench({
  focusMode,
  skipToEditorLabel,
  activeTopbarMenu,
  onToggleTopbarMenu,
  onCloseTopbarMenus,
  activeProjection,
  topbar,
  toolbar,
  findReplace,
  outlineOpen,
  inspectorOpen,
  sidebarWidth,
  sidebar,
  editorStage,
  inspector,
  ambientSuggestions,
  statusBar,
  workspaceTabs,
  children,
}: AppWorkbenchProps) {
  return (
    <WorkspaceShell
      focusMode={focusMode}
      skipToEditorLabel={skipToEditorLabel}
      activeTopbarMenu={activeTopbarMenu}
      onToggleTopbarMenu={onToggleTopbarMenu}
      onCloseTopbarMenus={onCloseTopbarMenus}
      activeProjection={activeProjection}
      topbar={topbar}
      statusBar={statusBar}
      tabStrip={<WorkspaceTabStrip {...workspaceTabs} />}
      overlays={children}
    >
      <ActiveDocumentWorkbench
        formatCapabilities={activeProjection.formatCapabilities}
        toolbar={toolbar}
        findReplace={findReplace}
        outlineOpen={outlineOpen}
        inspectorOpen={inspectorOpen}
        sidebarWidth={sidebarWidth}
        sidebar={sidebar}
        editorStage={editorStage}
        inspector={inspector}
        ambientSuggestions={ambientSuggestions}
      />
    </WorkspaceShell>
  );
}
