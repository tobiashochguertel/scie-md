import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../styles/app.css';
import fixture from './tabVisualFixture.v1.json';
import { WorkspaceTabStrip } from '../WorkspaceTabStrip';
import type { DocumentId } from '../documentIdentity';
import type { TabFormatIconId, TabVisualStateKind, WorkspaceTabModel } from './workspaceTabs';

function Harness() {
  const params = new URLSearchParams(location.search);
  const count = Math.min(60, Math.max(1, Number(params.get('count') ?? 60)));
  const [active, setActive] = useState<DocumentId>(() => 'tab-visual-1' as DocumentId);
  const [order, setOrder] = useState(() => Array.from({ length: count }, (_, index) => `tab-visual-${index + 1}` as DocumentId));
  const tabs = useMemo(() => order.map((documentId, index): WorkspaceTabModel => {
    const fileName = fixture.duplicateNameSet[index % fixture.duplicateNameSet.length];
    const kinds: TabVisualStateKind[] = ['ready', 'dirty', 'progress', 'danger', 'blocked', 'readonly'];
    const iconIds: TabFormatIconId[] = ['markdown', 'braces', 'rows', 'markup', 'text'];
    const kind = kinds[index % kinds.length];
    return { documentId, fileName, visibleFileName: fileName.length > 28 ? `${fileName.slice(0, 10)}…${fileName.slice(-14)}` : fileName, qualifier: `study-${index % 5 + 1}/run-${index + 1}`, formatLabel: iconIds[index % iconIds.length].toUpperCase(), formatIconId: iconIds[index % iconIds.length], visualState: { kind, label: kind === 'ready' ? 'Ready' : kind }, accessibleStates: kind === 'ready' ? [] : [kind], accessibleName: `${fileName}, ${kind}, tab ${index + 1} of ${count}`, tooltip: `${fileName} — study-${index % 5 + 1}/run-${index + 1}`, active: documentId === active, index, count, canMoveLeft: index > 0, canMoveRight: index < count - 1 };
  }), [active, count, order]);
  return <main className="app-shell" data-tab-visual-fixture={fixture.id}><WorkspaceTabStrip model={{ tabs, activeDocumentId: active, mruDocumentId: order[1] ?? null, recentlyClosedCount: 2 }} onActivate={setActive} onClose={() => undefined} onCloseOthers={() => undefined} onCloseRight={() => undefined} onReopenClosed={() => undefined} onSaveAll={() => undefined} onReorder={(id, toIndex) => setOrder((current) => { const next = current.filter((item) => item !== id); next.splice(toIndex, 0, id); return next; })} /><div className="workspace-active-panel" role="tabpanel" id={`workspace-panel-${encodeURIComponent(active)}`} aria-labelledby={`workspace-tab-${encodeURIComponent(active)}`}>Visual validation fixture</div></main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);
