import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

if (!process.argv.includes('--required')) {
  throw new Error('Wave certification must be invoked with --required.');
}

const root = process.cwd();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const git = process.platform === 'win32' ? 'git.exe' : 'git';
const certificationPath = resolve('docs/refactor/document_runtime_structured_editing_foundations_wave_certification.v1.json');
const resume = process.argv.includes('--resume');
const excludedEvidencePaths = new Set([
  'docs/refactor/document_runtime_structured_editing_foundations_wave.md',
  'docs/refactor/document_runtime_structured_editing_foundations_wave_certification.v1.json',
  'src/app/performance/documentPerformanceBaseline.windows.v1.json',
]);
const checkpoint = resume && existsSync(certificationPath)
  ? JSON.parse(readFileSync(certificationPath, 'utf8'))
  : null;
if (resume && !['running', 'failed'].includes(checkpoint?.status)) {
  throw new Error('Resume requires a running or failed wave checkpoint.');
}
const priorFailedAttempts = checkpoint?.commands?.filter((entry) => entry.exitCode !== 0) ?? [];
const commands = checkpoint?.commands?.filter((entry) => entry.exitCode === 0) ?? [];

const generatorSteps = [
  step('font-generator-scie-sans', npm, ['run', 'fonts:scie-sans']),
  step('font-generator-ibm-plex-mono', npm, ['run', 'fonts:ibm-plex-mono']),
];
const preBuildSteps = [
  step('font-verification', npm, ['run', 'fonts:verify']),
  step('version-changelog', npm, ['run', 'validate:version-changelog']),
  step('distribution-contract', npm, ['run', 'validate:distribution']),
  step('tauri-contract', npm, ['run', 'validate:tauri-contract']),
  step('format-contributions', npm, ['run', 'validate:format-contributions']),
  step('app-boundaries', npm, ['run', 'validate:app-boundaries']),
  step('export-fidelity', npm, ['run', 'validate:export']),
  step('visual-style-accessibility', npm, ['run', 'validate:styles']),
  step('ux-workflows', npm, ['run', 'validate:ux']),
  step('structured-workflows', npm, ['run', 'validate:structured-workflows']),
  step('desktop-unit-migration-fidelity', npm, ['run', 'test:all']),
  step('extension-unit-migration-fidelity', npm, ['--prefix', 'scie-md-vscode-extension', 'test']),
  step('extension-host-smoke', npm, ['run', 'validate:vscode-host-smoke']),
  step('extension-visual-smoke', npm, ['run', 'validate:vscode-visual-smoke']),
  step('rust-tests', cargo, ['test'], 'src-tauri'),
  step('rust-clippy', cargo, ['clippy', '--all-targets', '--', '-D', 'warnings'], 'src-tauri'),
  step('large-document-stress', npm, ['run', 'validate:large-document-stress']),
];
const buildSteps = [
  step('desktop-build', npm, ['run', 'build:desktop']),
  step('vscode-package-build', npm, ['run', 'package:vscode']),
];

let candidateIdentity;
let finalIdentity;
let failure = null;
try {
  runSteps(generatorSteps);
  candidateIdentity = sourceTreeIdentity();
  if (resume && JSON.stringify(candidateIdentity) !== JSON.stringify(checkpoint.candidateIdentity)) {
    throw new Error(`Resume candidate identity differs: ${JSON.stringify({ checkpoint: checkpoint.candidateIdentity, current: candidateIdentity })}.`);
  }
  writeCheckpoint('running');
  runSteps(preBuildSteps);
  runSteps(buildSteps);

  const appPath = resolve('src-tauri/target/release/sciemd.exe');
  const extensionPackage = JSON.parse(readFileSync(resolve('scie-md-vscode-extension/package.json'), 'utf8'));
  const vsixPath = resolve('scie-md-vscode-extension', `${extensionPackage.name}-${extensionPackage.version}.vsix`);
  if (!existsSync(appPath)) throw new Error(`Desktop build did not produce ${appPath}.`);
  if (!existsSync(vsixPath)) throw new Error(`VS Code package did not produce ${vsixPath}.`);

  runSteps([
    step('vscode-package-content', npm, ['run', 'validate:vscode-package']),
    step('package-budgets', npm, ['run', 'validate:package-budgets', '--', '--vsix', '--desktop-bundles']),
    step('desktop-smoke', npm, ['run', 'validate:desktop-smoke', '--', '--required', '--app', appPath]),
    step('desktop-structured-edit', npm, ['run', 'validate:desktop-structured-edit', '--', '--required', '--format', 'toml']),
    step('installed-vsix-smoke', npm, ['run', 'validate:vscode-installed-smoke', '--', '--required', '--vsix', vsixPath]),
    step('desktop-ui-performance', npm, ['run', 'validate:desktop-ui-performance', '--', '--required', '--app', appPath]),
    step('tab-visual-accessibility', npm, ['run', 'validate:tab-visuals', '--', '--required']),
    step('desktop-artifact-staging', npm, ['run', 'copy:exe']),
    step('vscode-artifact-staging', npm, ['run', 'stage:vscode']),
    step('generated-output-policy', npm, ['run', 'validate:generated-outputs']),
    step('whitespace-guard', git, ['diff', '--check']),
  ]);

  finalIdentity = sourceTreeIdentity();
  if (JSON.stringify(finalIdentity) !== JSON.stringify(candidateIdentity)) {
    throw new Error(`Candidate tree changed during certification: ${JSON.stringify({ candidateIdentity, finalIdentity })}.`);
  }

  const artifacts = collectArtifacts(appPath, vsixPath);
  const record = {
    schemaVersion: 1,
    status: 'passed',
    wave: 'document runtime structured editing foundations',
    rounds: Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`round${index + 1}`, 'CLOSED'])),
    candidateIdentity,
    finalIdentity,
    excludedMutableEvidencePaths: [...excludedEvidencePaths].sort(),
    artifacts,
    commandCount: commands.length,
    expensiveNodeCounts: {
      desktopBuild: commands.filter((entry) => entry.id === 'desktop-build').length,
      vscodePackageBuild: commands.filter((entry) => entry.id === 'vscode-package-build').length,
      desktopUiPerformance: commands.filter((entry) => entry.id === 'desktop-ui-performance').length,
      installedVsixSmoke: commands.filter((entry) => entry.id === 'installed-vsix-smoke').length,
    },
    commands,
    priorFailedAttempts,
  };
  for (const [node, count] of Object.entries(record.expensiveNodeCounts)) {
    if (count !== 1) throw new Error(`${node} executed ${count} times; expected exactly once.`);
  }
  writeFileSync(certificationPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, certificationPath, candidateIdentity, artifacts, commandCount: commands.length }, null, 2));
} catch (error) {
  failure = error;
  const record = {
    schemaVersion: 1,
    status: 'failed',
    candidateIdentity: candidateIdentity ?? null,
    finalIdentity: sourceTreeIdentity(),
    excludedMutableEvidencePaths: [...excludedEvidencePaths].sort(),
    failure: error instanceof Error ? error.message : String(error),
    commands,
    priorFailedAttempts,
  };
  writeFileSync(certificationPath, `${JSON.stringify(record, null, 2)}\n`);
}

if (failure) throw failure;

function step(id, command, args, cwd = '.') { return { id, command, args, cwd }; }

function runSteps(steps) {
  for (const current of steps) {
    if (commands.some((entry) => entry.id === current.id)) {
      console.log(`\n[document-foundations-wave] ${current.id} (checkpoint: prior success)`);
      continue;
    }
    const startedAt = new Date().toISOString();
    console.log(`\n[document-foundations-wave] ${current.id}`);
    const result = spawnSync(current.command, current.args, {
      cwd: resolve(current.cwd),
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    const entry = {
      id: current.id,
      command: commandText(current.command, current.args),
      cwd: current.cwd,
      startedAt,
      durationMs: Date.now() - Date.parse(startedAt),
      exitCode: result.status ?? 1,
    };
    commands.push(entry);
    if (candidateIdentity) writeCheckpoint(result.status === 0 ? 'running' : 'failed', result.status === 0 ? null : `DAG node ${current.id} failed with exit code ${result.status ?? 1}.`);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`DAG node ${current.id} failed with exit code ${result.status ?? 1}.`);
  }
}

function writeCheckpoint(status, failureMessage = null) {
  const record = {
    schemaVersion: 1,
    status,
    candidateIdentity: candidateIdentity ?? checkpoint?.candidateIdentity ?? null,
    finalIdentity: sourceTreeIdentity(),
    excludedMutableEvidencePaths: [...excludedEvidencePaths].sort(),
    failure: failureMessage,
    commands,
    priorFailedAttempts,
  };
  writeFileSync(certificationPath, `${JSON.stringify(record, null, 2)}\n`);
}

function sourceTreeIdentity() {
  const head = spawnSync(git, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const files = spawnSync(git, ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).stdout.split(/\r?\n/)
    .map((path) => path.replaceAll('\\', '/')).filter(Boolean)
    .filter((path) => existsSync(resolve(path)))
    .filter((path) => !excludedEvidencePaths.has(path))
    .sort();
  const manifest = files.map((path) => `${sha256(readFileSync(resolve(path)))}  ${path}`).join('\n');
  return { head, buildInputManifestSha256: sha256(manifest), fileCount: files.length };
}

function collectArtifacts(appPath, vsixPath) {
  const candidates = [appPath, vsixPath];
  const bundleRoot = resolve('src-tauri/target/release/bundle');
  if (existsSync(bundleRoot)) candidates.push(...listFiles(bundleRoot).filter((path) => /\.(exe|msi)$/i.test(path)));
  return [...new Set(candidates)].filter(existsSync).map((path) => ({
    path: relative(root, path).replaceAll('\\', '/'),
    fileName: basename(path),
    bytes: statSync(path).size,
    sha256: sha256(readFileSync(path)),
  })).sort((left, right) => left.path.localeCompare(right.path));
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function commandText(command, args) {
  return [command, ...args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
