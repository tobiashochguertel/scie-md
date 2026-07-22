import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const formatIndex = args.indexOf('--format');
const format = formatIndex >= 0 ? args[formatIndex + 1] : null;
const required = args.includes('--required');
if (format !== 'toml') throw new Error('Desktop structured-edit validation currently requires --format toml.');
const candidates = ['src-tauri/target/release/sciemd.exe', 'src-tauri/target/release/ScieMD.exe'];
const appPath = candidates.map((candidate) => resolve(candidate)).find(existsSync);
if (!appPath) {
  if (required) throw new Error('A packaged release executable is required. Run npm run build:desktop first.');
  console.log('Desktop TOML structured-edit validation skipped: no packaged release executable.');
  process.exit(0);
}
const inputs = [
  'src-tauri/src/commands/toml_source_map.rs', 'src-tauri/src/lib.rs', 'src/services/tomlNativeService.ts',
  'src/app/structured/structuredMutationExecutor.ts', 'src/app/App.tsx',
].map((input) => resolve(input));
const appMtime = statSync(appPath).mtimeMs;
const stale = inputs.filter((path) => statSync(path).mtimeMs > appMtime);
if (stale.length > 0) throw new Error(`Packaged executable predates TOML production inputs: ${stale.map((path) => basename(path)).join(', ')}.`);

const integration = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'src/app/structured/tomlNativeIntegration.test.ts'], { cwd: resolve('.'), stdio: 'inherit', windowsHide: true });
if (integration.status !== 0) throw new Error('Shared executor TOML integration validation failed.');

const root = await mkdtemp(join(tmpdir(), 'sciemd-toml-structured-edit-'));
try {
  const workspace = join(root, 'workspace'); const appData = join(root, 'app-data');
  await mkdir(workspace, { recursive: true });
  const tomlPath = join(workspace, 'native-edit.toml'); const reportPath = join(root, 'report.json');
  const before = '# packaged native TOML\r\ntitle = "Before"\r\nitems = [1, 2]\r\n';
  await writeFile(tomlPath, before, 'utf8');
  const child = spawn(appPath, [], {
    cwd: resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, SCIEMD_DESKTOP_SMOKE_DISABLE_SINGLE_INSTANCE: '1', SCIEMD_DESKTOP_SMOKE_SELF_TEST: '1',
      SCIEMD_DESKTOP_SMOKE_SCENARIO: 'toml-structured-edit', SCIEMD_DESKTOP_SMOKE_REPORT: reportPath,
      SCIEMD_DESKTOP_SMOKE_TOML_PATH: tomlPath, SCIEMD_APP_DATA_DIR_OVERRIDE: join(appData, 'ScieMD'),
      APPDATA: join(appData, 'Roaming'), LOCALAPPDATA: join(appData, 'Local'), XDG_DATA_HOME: join(appData, 'xdg-data'),
    },
  });
  let stderr = ''; child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => { child.kill(); rejectExit(new Error('Packaged TOML structured-edit self-test timed out.')); }, 30_000);
    child.once('error', rejectExit); child.once('exit', (code) => { clearTimeout(timer); resolveExit(code ?? 1); });
  });
  const report = existsSync(reportPath) ? JSON.parse(await readFile(reportPath, 'utf8')) : null;
  const after = await readFile(tomlPath, 'utf8');
  if (exitCode !== 0 || !report?.ok || report.tomlNativePatchCount !== 1 || report.tomlNativeNoDirectWrite !== true || !after.includes('title = "After"')) {
    throw new Error(`Packaged TOML structured-edit path failed: exit=${exitCode}, report=${JSON.stringify(report)}, saved=${JSON.stringify(after)}.${stderr ? ` ${stderr.trim()}` : ''}`);
  }
  console.log(JSON.stringify({ ok: true, format, appPath, nativePlan: true, sharedExecutor: true, aggregateSave: true, noNativeDirectWrite: true }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
