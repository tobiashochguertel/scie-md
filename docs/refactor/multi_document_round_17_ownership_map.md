# Round 17 shell ownership map

Status: active contract established by Round 17.

| Authority | Primary module | Allowed responsibility | Forbidden responsibility |
| --- | --- | --- | --- |
| Composition root | `src/app/App.tsx` | Instantiate the document session, build active projections, compose controllers and presentation props | Owning workspace records or duplicating service coordinators |
| Workspace chrome | `src/app/WorkspaceShell.tsx` | Topbar, window chrome, aggregate status, status bar, overlay slot | Reading or mutating document/session/service state |
| Active workbench | `src/app/ActiveDocumentWorkbench.tsx` | Render the active toolbar, sidebar, editor stage, inspector, and ambient feedback from props | Selecting the active document or inventing format policy |
| Active projection | `src/app/workspace/workspaceShellProjection.ts` | Purely derive active identity, format contribution, mode, title, and aggregate lifecycle chrome | Mutating records, activation, persistence, or React lifecycle ownership |
| Commands | `src/app/hooks/useAppCommands.ts` | Bind declared commands to composition callbacks | Direct workspace persistence or hidden document state |
| Overlays | `src/app/AppOverlays.tsx` and `src/app/activeDocumentCompatibility.ts` | Render explicit models; close active-only decisions on activation | Rebinding an open decision to a newly active document |
| Background workspace services | `WorkspaceStore` coordinators | Save, recovery, manifest, watcher, close, effect, and ingress authority keyed by `DocumentId` | Component-mount ownership or presentation imports |
| Leaf presentation | `AppTopbar`, `StatusBar`, `InspectorPane`, `AppEditorStage`, `AppSidebar` | Render declared projection/contract props and dispatch callbacks | Importing desktop hosts, services, `WorkspaceStore`, or `useDocumentSession` |

`npm run validate:app-boundaries` enforces the import half of this map. Behavioral tests enforce active projection switching, aggregate dirty chrome, format contribution selection, and active-only overlay clearing. This is a semantic boundary map, not a file-size target.

Known bounded residual: `App.tsx` still assembles broad feature-specific prop objects because the current production shell has one visible editor until Round 18. Those objects consume the active projection and do not own workspace content. Leaf components retain imports from the pure settings/visual-style catalogs for presentation types and option labels; the validator forbids stateful file, recovery, manifest, native, host, workspace-store, and session authority. Further visual subdivision is permitted only when it creates a new authority boundary; arbitrary line slicing is not a goal.
