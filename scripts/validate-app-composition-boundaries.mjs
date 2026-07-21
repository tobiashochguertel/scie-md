import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const presentationPaths = [
  'src/app/WorkspaceShell.tsx',
  'src/app/ActiveDocumentWorkbench.tsx',
  'src/app/AppWorkbench.tsx',
  'src/app/AppEditorStage.tsx',
  'src/app/AppSidebar.tsx',
  'src/app/AppOverlays.tsx',
  'src/components/AppTopbar.tsx',
  'src/components/InspectorPane.tsx',
  'src/components/StatusBar.tsx',
];
const coordinatorPaths = [
  'workspaceCloseCoordinator.ts',
  'workspaceExternalChangeCoordinator.ts',
  'workspaceIngressCoordinator.ts',
  'workspaceManifestCoordinator.ts',
  'workspaceRecoveryCoordinator.ts',
  'workspaceSaveCoordinator.ts',
];
const failures = [];

for (const relativePath of presentationPaths) {
  const source = readFileSync(path.join(root, relativePath), 'utf8');
  for (const forbidden of [
    '/services/fileService',
    '/services/draftRecoveryService',
    '/services/nativeRecoveryService',
    '/services/workspaceManifestService',
    '/host/desktop',
    'workspaceStore',
    'useDocumentSession',
  ]) {
    if (source.includes(forbidden)) failures.push(`${relativePath} imports forbidden authority ${forbidden}`);
  }
}

for (const fileName of coordinatorPaths) {
  const relativePath = `src/app/workspace/${fileName}`;
  const source = readFileSync(path.join(root, relativePath), 'utf8');
  if (/from\s+['"]react['"]/.test(source)) failures.push(`${relativePath} must remain React-mount-independent`);
}

const appSource = readFileSync(path.join(root, 'src/app/App.tsx'), 'utf8');
if (!appSource.includes("from './hooks/useDocumentSession'")) failures.push('App.tsx must remain the production session composition root');
for (const relativePath of presentationPaths) {
  const source = readFileSync(path.join(root, relativePath), 'utf8');
  if (source.includes("from './hooks/useDocumentSession'") || source.includes("from '../app/hooks/useDocumentSession'")) {
    failures.push(`${relativePath} must consume projections, not the document session hook`);
  }
}

if (failures.length > 0) {
  console.error('[app-boundaries] Composition ownership validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[app-boundaries] ${presentationPaths.length} presentation modules and ${coordinatorPaths.length} workspace coordinators obey the ownership map.`);
