import type { ComponentProps, ReactNode } from 'react';
import { AppTopbar, type AppTopbarMenuId } from '../components/AppTopbar';
import { StatusBar } from '../components/StatusBar';
import { workspaceTabId, workspaceTabPanelId, type ActiveDocumentProjection, type WorkspaceTabsModel } from './workspace';

type ShellTopbarProps = Omit<ComponentProps<typeof AppTopbar>,
  'activeMenu' | 'onToggleMenu' | 'onCloseMenus' | 'format' | 'formatCapabilities' | 'documentChrome'>;

export interface WorkspaceShellProps {
  focusMode: boolean;
  skipToEditorLabel: string;
  activeTopbarMenu: AppTopbarMenuId | null;
  onToggleTopbarMenu: (menu: AppTopbarMenuId) => void;
  onCloseTopbarMenus: () => void;
  activeProjection: ActiveDocumentProjection;
  topbar: ShellTopbarProps;
  statusBar: ComponentProps<typeof StatusBar>;
  tabStrip: ReactNode;
  workspaceTabsModel: WorkspaceTabsModel;
  children: ReactNode;
  overlays?: ReactNode;
}

/** Workspace chrome only. Document data arrives as a read projection through props. */
export function WorkspaceShell({
  focusMode,
  skipToEditorLabel,
  activeTopbarMenu,
  onToggleTopbarMenu,
  onCloseTopbarMenus,
  activeProjection,
  topbar,
  statusBar,
  tabStrip,
  workspaceTabsModel,
  children,
  overlays,
}: WorkspaceShellProps) {
  const activeTab = workspaceTabsModel.tabs.find((tab) => tab.active) ?? null;
  return (
    <div className={`app-shell ${focusMode ? 'focus-mode' : ''}`}>
      <a className="skip-link" href="#editor-stage">{skipToEditorLabel}</a>
      <AppTopbar
        {...topbar}
        format={activeProjection.format}
        formatCapabilities={activeProjection.formatCapabilities}
        documentChrome={activeProjection.chrome}
        activeMenu={activeTopbarMenu}
        onToggleMenu={onToggleTopbarMenu}
        onCloseMenus={onCloseTopbarMenus}
      />
      {tabStrip}
      {workspaceTabsModel.tabs.filter((tab) => !tab.active).map((tab) => (
        <div
          key={tab.documentId}
          className="workspace-active-panel"
          role="tabpanel"
          id={workspaceTabPanelId(tab.documentId)}
          aria-labelledby={workspaceTabId(tab.documentId)}
          hidden
          tabIndex={-1}
        />
      ))}
      {activeTab && (
        <div
          className="workspace-active-panel"
          role="tabpanel"
          id={workspaceTabPanelId(activeTab.documentId)}
          aria-labelledby={workspaceTabId(activeTab.documentId)}
          tabIndex={0}
        >
          {children}
        </div>
      )}
      <StatusBar {...statusBar} />
      {overlays}
    </div>
  );
}
