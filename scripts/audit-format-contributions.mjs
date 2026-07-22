import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve('.');
const catalogPath = resolve(repoRoot, 'packages/core/src/formats/formatCatalog.v1.json');
const operationMatrixPath = resolve(repoRoot, 'packages/core/src/formats/structured/structuredVisualOperationMatrix.v1.json');
const dialogsPath = resolve(repoRoot, 'src-tauri/src/commands/dialogs.rs');
const launchPath = resolve(repoRoot, 'src-tauri/src/lib.rs');
const tauriConfigPath = resolve(repoRoot, 'src-tauri/tauri.conf.json');
const nsisPath = resolve(repoRoot, 'src-tauri/windows/nsis-hooks.nsh');

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const operationMatrix = JSON.parse(readFileSync(operationMatrixPath, 'utf8'));
const dialogsSource = readFileSync(dialogsPath, 'utf8');
const launchSource = readFileSync(launchPath, 'utf8');
const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8'));
const nsisSource = readFileSync(nsisPath, 'utf8');

const expectedPicker = extensionsForPolicy('openPicker');
const expectedLaunch = extensionsForPolicy('launch');
const expectedAssociations = extensionsForPolicy('osAssociation');
const actualPicker = rustStringArray(dialogsSource, 'SCIEMD_TEXT_DOCUMENT_EXTENSIONS');
const actualLaunch = rustStringArray(launchSource, 'LAUNCH_DOCUMENT_EXTENSIONS');
const actualTauriAssociations = sortedUnique(
  (tauriConfig.bundle?.fileAssociations ?? []).flatMap((association) => association.ext ?? []),
);
const registrationBlock = nsisSource.match(/!macro RegisterScieMdDocumentOpenWith([\s\S]*?)!macroend/)?.[1] ?? '';
const actualNsisAssociations = sortedUnique(
  Array.from(registrationBlock.matchAll(/!insertmacro RegisterScieMdDocumentExtension "([^"]+)"/g), (match) => match[1]),
);

const comparisons = [
  compareSurface('native open picker', expectedPicker, actualPicker, dialogsPath),
  compareSurface('native launch', expectedLaunch, actualLaunch, launchPath),
  compareSurface('Tauri associations', expectedAssociations, actualTauriAssociations, tauriConfigPath),
  compareSurface('NSIS associations', expectedAssociations, actualNsisAssociations, nsisPath),
];
const structuredOperationCoverage = auditStructuredOperationCoverage();
comparisons.push(structuredOperationCoverage);
const deliberateExclusions = catalog.formats
  .filter((format) => Object.values(format.native).includes('exclude'))
  .map((format) => ({
    format: format.format,
    extensions: format.extensions,
    policies: format.native,
  }));
const report = {
  ok: comparisons.every((comparison) => comparison.ok),
  catalogVersion: catalog.version,
  comparisons,
  deliberateExclusions,
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);

function extensionsForPolicy(policy) {
  return sortedUnique(catalog.formats.flatMap((format) => format.native[policy] === 'include' ? format.extensions : []));
}

function auditStructuredOperationCoverage() {
  const editableFormats = catalog.formats.filter((format) => format.structured && format.workbench.editableSurfaces.length > 0);
  const errors = [];
  const seen = new Set();
  for (const operation of operationMatrix.operations ?? []) {
    const key = `${operation.format}:${operation.operationId}`;
    if (seen.has(key)) errors.push(`duplicate ${key}`);
    seen.add(key);
    if (!operation.nodeClass || !operation.operationId || !operation.plannerId || operation.handlerId !== 'structured-mutation-v1' || !operation.fixtureId
      || !['enabled', 'review', 'source-only', 'unsupported'].includes(operation.state)
      || !['direct', 'required'].includes(operation.review) || typeof operation.destructive !== 'boolean') {
      errors.push(`incomplete ${key}`);
    }
  }
  for (const format of editableFormats) {
    if (!operationMatrix.operations.some((operation) => operation.format === format.format)) errors.push(`missing ${format.format}`);
  }
  return {
    surface: 'structured visual operation registry', path: operationMatrixPath,
    ok: operationMatrix.version === 1 && errors.length === 0,
    expected: editableFormats.map((format) => format.format).sort(),
    actual: sortedUnique(operationMatrix.operations.map((operation) => operation.format)),
    missing: errors,
    unexpected: [],
  };
}

function rustStringArray(source, constantName) {
  const match = source.match(new RegExp(`const\\s+${constantName}[^=]*=\\s*&\\[([\\s\\S]*?)\\];`));
  if (!match) throw new Error(`Could not find Rust string array ${constantName}.`);
  return sortedUnique(Array.from(match[1].matchAll(/"([^"]+)"/g), (entry) => entry[1]));
}

function compareSurface(surface, expected, actual, path) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((extension) => !actualSet.has(extension));
  const unexpected = actual.filter((extension) => !expectedSet.has(extension));
  return { surface, path, ok: missing.length === 0 && unexpected.length === 0, expected, actual, missing, unexpected };
}

function sortedUnique(values) {
  return Array.from(new Set(values)).sort();
}
