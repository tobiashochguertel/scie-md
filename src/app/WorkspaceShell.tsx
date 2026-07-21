import type { ComponentProps, ReactNode } from 'react';
import { AppTopbar, type AppTopbarMenuId } from '../components/AppTopbar';
import { StatusBar } from '../components/StatusBar';
import type { ActiveDocumentProjection } from './workspace';

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
  children,
  overlays,
}: WorkspaceShellProps) {
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
      <div
        className="workspace-active-panel"
        role="tabpanel"
        id={`workspace-panel-${encodeURIComponent(activeProjection.documentId)}`}
        aria-labelledby={`workspace-tab-${encodeURIComponent(activeProjection.documentId)}`}
      >
        {children}
      </div>
      <StatusBar {...statusBar} />
      {overlays}
    </div>
  );
}
