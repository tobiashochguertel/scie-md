import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

if (!process.argv.includes('--required')) throw new Error('Tab visual validation must be invoked with --required.');
const fixture = JSON.parse(readFileSync(resolve('src/app/workspace/tabVisualFixture.v1.json'), 'utf8'));
const devPort = Number(process.env.SCIEMD_TAB_VISUAL_PORT ?? 5196);
const cdpPort = Number(process.env.SCIEMD_TAB_VISUAL_CDP_PORT ?? 9336);
const outputDir = resolve('artifacts', 'tab-visuals');
const userDataDir = resolve('tmp', `tab-visual-browser-${process.pid}`);
rmSync(userDataDir, { recursive: true, force: true }); mkdirSync(userDataDir, { recursive: true }); mkdirSync(outputDir, { recursive: true });
const vite = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(devPort), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let viteOutput = ''; vite.stdout.on('data', (chunk) => { viteOutput += chunk; }); vite.stderr.on('data', (chunk) => { viteOutput += chunk; });
const browser = spawn(resolveBrowserPath(), ['--headless=new', `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*', `--user-data-dir=${userDataDir}`, '--no-first-run', '--disable-extensions', `--window-size=${fixture.viewport.width},${fixture.viewport.height}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let browserOutput = ''; browser.stderr.on('data', (chunk) => { browserOutput += chunk; });

try {
  await waitForHttp(`http://127.0.0.1:${devPort}/tab-visual-harness.html`);
  const page = await connect(cdpPort);
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Accessibility.enable');
  const results = [];
  for (const count of fixture.tabCounts) {
    await page.send('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'forced-colors', value: 'none' }, { name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await page.send('Emulation.setDeviceMetricsOverride', { width: fixture.viewport.width, height: fixture.viewport.height, deviceScaleFactor: fixture.deviceScaleFactor, mobile: false });
    await page.send('Page.navigate', { url: `http://127.0.0.1:${devPort}/tab-visual-harness.html?count=${count}` });
    await waitFor(page, `document.querySelectorAll('[role="tab"]').length === ${count}`);
    results.push(await assertLayout(page, count, 1, false));
  }
  for (const [zoom, forcedColors] of [[2, false], [1, true]]) {
    await page.send('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'forced-colors', value: forcedColors ? 'active' : 'none' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await evaluate(page, `document.body.style.zoom = ${zoom}`);
    results.push(await assertLayout(page, 60, zoom, forcedColors));
  }
  const ax = await page.send('Accessibility.getFullAXTree');
  const tabRoles = ax.nodes.filter((node) => node.role?.value === 'tab');
  const selectedTabs = tabRoles.filter((node) => node.properties?.some((property) => property.name === 'selected' && property.value?.value === true));
  if (tabRoles.length !== 60 || selectedTabs.length !== 1) throw new Error(`Accessibility tree expected 60 tabs and one selected tab; got ${tabRoles.length}/${selectedTabs.length}.`);
  const screenshotA = (await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true })).data;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  const screenshotB = (await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true })).data;
  const pixelDifference = screenshotA === screenshotB ? 0 : 1;
  if (pixelDifference > fixture.assertions.pixelThreshold) throw new Error(`Deterministic screenshot difference ${pixelDifference} exceeds ${fixture.assertions.pixelThreshold}.`);
  const screenshotPath = resolve(outputDir, `${fixture.id}.png`);
  writeFileSync(screenshotPath, Buffer.from(screenshotA, 'base64'));
  console.log(JSON.stringify({ ok: true, fixture: fixture.id, sourceFont: fixture.sourceFont, cases: results, accessibility: { tabs: tabRoles.length, selected: selectedTabs.length }, forcedColors: 'rendered', reducedMotion: 'rendered', screenshot: screenshotPath, screenshotSha256: sha256(Buffer.from(screenshotA, 'base64')), pixelDifference }, null, 2));
} finally {
  browser.kill(); vite.kill(); await Promise.allSettled([waitForExit(browser), waitForExit(vite)]); rmSync(userDataDir, { recursive: true, force: true });
}

async function assertLayout(page, expectedCount, zoom, forcedColors) {
  const geometry = await evaluate(page, `(() => {
    const strip = document.querySelector('.workspace-tabs'); const scroll = document.querySelector('.workspace-tab-scroll'); const tools = document.querySelector('.workspace-tab-tools'); const tabs = [...document.querySelectorAll('.workspace-tab-item')]; const active = document.querySelector('[role="tab"][aria-selected="true"]');
    const sr = scroll.getBoundingClientRect(); const ar = active.getBoundingClientRect(); const rows = new Set(tabs.map((tab) => Math.round(tab.getBoundingClientRect().top)));
    const nested = [...document.querySelectorAll('[role="tab"]')].some((tab) => tab.querySelector('button,input,select,[role="button"]'));
    return { stripHeight: strip.getBoundingClientRect().height, toolWidth: tools.getBoundingClientRect().width, rows: rows.size, count: tabs.length, activeVisible: ar.right > sr.left && ar.left < sr.right, minClose: Math.min(...[...document.querySelectorAll('.workspace-tab-close')].map((node) => node.getBoundingClientRect().width)), nested, panelCount: document.querySelectorAll('[role="tabpanel"]').length };
  })()`);
  const expectedHeight = fixture.assertions.rowHeightCssPx * zoom;
  if (geometry.count !== expectedCount || geometry.rows !== 1 || geometry.nested || geometry.panelCount !== 1 || !geometry.activeVisible) throw new Error(`Invalid tab geometry: ${JSON.stringify({ expectedCount, zoom, forcedColors, geometry })}.`);
  if (Math.abs(geometry.stripHeight - expectedHeight) > 2 || geometry.toolWidth > fixture.assertions.maxToolZoneCssPx * zoom || geometry.minClose < fixture.assertions.minimumPointerTargetCssPx * zoom - 1) throw new Error(`Tab dimensions failed: ${JSON.stringify({ expectedHeight, zoom, forcedColors, geometry })}.`);
  return { expectedCount, zoom, forcedColors, ...geometry };
}

function resolveBrowserPath() { for (const candidate of ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']) if (existsSync(candidate)) return candidate; if (process.platform !== 'win32') for (const candidate of ['google-chrome', 'chromium', 'microsoft-edge']) { const found = spawnSync('which', [candidate], { encoding: 'utf8' }); if (found.status === 0) return found.stdout.trim(); } throw new Error('Chrome or Edge is required.'); }
async function waitForHttp(url) { const deadline = Date.now() + 30000; while (Date.now() < deadline) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((resolveDelay) => setTimeout(resolveDelay, 200)); } throw new Error(`Vite did not start. ${viteOutput}`); }
async function connect(port) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { try { const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()); const target = targets.find((item) => item.type === 'page') ?? targets[0]; if (target?.webSocketDebuggerUrl) return cdp(target.webSocketDebuggerUrl); } catch {} await new Promise((resolveDelay) => setTimeout(resolveDelay, 200)); } throw new Error(`Browser CDP unavailable. ${browserOutput}`); }
async function cdp(url) { const socket = new WebSocket(url); await new Promise((resolveSocket, rejectSocket) => { socket.addEventListener('open', resolveSocket, { once: true }); socket.addEventListener('error', rejectSocket, { once: true }); }); let id = 0; const pending = new Map(); socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result); }); return { send(method, params = {}) { const commandId = ++id; socket.send(JSON.stringify({ id: commandId, method, params })); return new Promise((resolveCommand, reject) => pending.set(commandId, { resolve: resolveCommand, reject })); } }; }
async function evaluate(page, expression) { const result = await page.send('Runtime.evaluate', { expression, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; }
async function waitFor(page, expression) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (await evaluate(page, expression)) return; await new Promise((resolveDelay) => setTimeout(resolveDelay, 100)); } throw new Error(`Timed out: ${expression}`); }
function waitForExit(child) { return new Promise((resolveExit) => { const timer = setTimeout(resolveExit, 5000); child.once('exit', () => { clearTimeout(timer); resolveExit(); }); }); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
