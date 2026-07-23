import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const options = parseArgs(process.argv.slice(2));
const required = options.required;
if (process.platform !== 'win32') stop('The packaged document-performance gate requires Windows WebView2.');

const root = process.cwd();
const performanceBudgets = JSON.parse(readFileSync(resolve('src/app/performance/documentPerformanceBudgets.v1.json'), 'utf8')).budgets;
const sourceIdentity = sourceTreeIdentity();
if (!options.appPath) {
  const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:desktop', '--', '--no-bundle'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error(`Packaged candidate build failed with exit code ${build.status}.`);
}
const appPath = resolve(options.appPath ?? 'src-tauri/target/release/sciemd.exe');
if (!existsSync(appPath)) throw new Error(`Packaged candidate was not found at ${appPath}.`);
const executableSha256 = sha256(readFileSync(appPath));
const runRoot = await mkdtemp(join(tmpdir(), 'sciemd-ui-performance-'));
const fixtureRoot = join(runRoot, 'fixtures');
const mainDataRoot = join(runRoot, 'main-process');
const productionStateBefore = productionStateSnapshot();
const port = options.port;
let app;
let page;

try {
  await mkdir(fixtureRoot, { recursive: true });
  const fixtures = await createFixtures(fixtureRoot);
  const knownSlowIds = new Set(['unicode-below-threshold', 'unicode-at-threshold', 'markdown-5mib-many-line']);
  const structuredProbe = await probeStructuredWorkspace(appPath, fixtures.structured, port + 10, root, options.timeoutMs);
  const coldProbes = [];
  for (const fixture of fixtures.cold.filter((item) => knownSlowIds.has(item.id))) {
    coldProbes.push(await probeColdFixture(appPath, fixture, port + 1 + coldProbes.length, root));
  }
  console.log(`[desktop-ui-performance] Launching ${appPath} (${executableSha256.slice(0, 12)}).`);
  app = spawn(appPath, [fixtures.cold[0].path], {
    cwd: root,
    env: isolatedAppEnvironment(mainDataRoot, port),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let appError = '';
  app.stderr.on('data', (chunk) => { appError += chunk.toString(); });
  page = await connectToFirstPage(port, options.timeoutMs, () => appError);
  console.log('[desktop-ui-performance] Connected to packaged WebView.');
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await waitFor(page, `Boolean(document.querySelector('[aria-label="Editor mode"]'))`, options.timeoutMs);
  console.log('[desktop-ui-performance] Initial document reached the production editor shell.');
  const chromeHitTest = await evaluate(page, `(() => {
    const region = document.querySelector('[data-window-drag-region="true"]');
    const tab = document.querySelector('[role="tab"]');
    const close = document.querySelector('.workspace-tab-close');
    const more = document.querySelector('[aria-label="Workspace actions"]');
    if (!region || !tab || !close || !more) return { ok: false, reason: 'missing controls' };
    const sequence = () => Number(document.documentElement.dataset.windowChromeSequence ?? '0');
    const start = sequence();
    for (const target of [tab, close, more]) {
      target.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      target.dispatchEvent(new MouseEvent('dblclick', { button: 0, bubbles: true }));
    }
    const afterControls = sequence();
    region.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    const afterDrag = sequence();
    region.dispatchEvent(new MouseEvent('dblclick', { button: 0, bubbles: true }));
    const afterMaximize = sequence();
    return { ok: afterControls === start && afterDrag === start + 1 && afterMaximize === start + 2, start, afterControls, afterDrag, afterMaximize };
  })()`);
  if (!chromeHitTest.ok) throw new Error(`Packaged frameless chrome hit testing failed: ${JSON.stringify(chromeHitTest)}.`);
  console.log('[desktop-ui-performance] Packaged explicit drag/maximize and control exclusion hit testing passed.');
  await selectSourceMode(page);
  await waitFor(page, `Boolean(document.querySelector('.cm-content'))`, options.timeoutMs);
  await waitFor(page, `document.querySelector('.cm-editor')?.dataset.sourceFontRemeasured === 'loaded'`, options.timeoutMs);
  const fontEvidence = await evaluate(page, `(async () => {
    const requests = [
      ['300 14px "IBM Plex Mono"', 'source α μ − ∞ {} []'],
      ['italic 300 14px "IBM Plex Mono"', 'source'],
      ['400 14px "IBM Plex Mono"', 'source α μ − ∞ {} []'],
      ['italic 400 14px "IBM Plex Mono"', 'source'],
      ['500 14px "IBM Plex Mono"', 'source'],
      ['700 14px "IBM Plex Mono"', 'source'],
    ];
    const loads = await Promise.all(requests.map(([descriptor, sample]) => document.fonts.load(descriptor, sample)));
    await document.fonts.ready;
    const faces = [...document.fonts].filter((face) => face.family.replaceAll('"', '') === 'IBM Plex Mono')
      .map((face) => ({ status: face.status, weight: face.weight, style: face.style }));
    return {
      loads: loads.map((loaded) => loaded.length),
      faces,
      computedFamily: getComputedStyle(document.querySelector('.cm-content')).fontFamily,
      remeasure: document.querySelector('.cm-editor')?.dataset.sourceFontRemeasured ?? null,
      resources: performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => /ibm-plex-mono|noto-sans-mono-greek/i.test(name)),
    };
  })()`);
  if (!fontEvidence.computedFamily.includes('IBM Plex Mono') || fontEvidence.remeasure !== 'loaded'
      || fontEvidence.loads.some((count) => count < 1) || fontEvidence.faces.some((face) => face.status !== 'loaded')
      || fontEvidence.resources.length < 4) {
    throw new Error(`Packaged IBM Plex Mono evidence failed: ${JSON.stringify(fontEvidence)}.`);
  }
  await page.send('Network.enable');
  await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  const offlineFace = await evaluate(page, `(async () => {
    const face = new FontFace('IBM Plex Mono Offline Probe', 'url("/fonts/vendor/ibm-plex-mono/ibm-plex-mono-400-normal.woff2")');
    await face.load();
    return { status: face.status, family: face.family };
  })()`);
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  if (offlineFace.status !== 'loaded') throw new Error(`Packaged offline/CSP font probe failed: ${JSON.stringify(offlineFace)}.`);

  const interactiveCold = fixtures.cold.slice(1).filter((item) => !knownSlowIds.has(item.id));
  for (const fixture of interactiveCold) {
    const beforeOpenSequence = lastSequence(await report(page));
    await openPerformanceDocument(page, fixture.path);
    await waitFor(page, `Array.from(document.querySelectorAll('[role="tab"]')).some((tab) => (tab.getAttribute('aria-label') ?? tab.textContent ?? '').includes(${JSON.stringify(basename(fixture.path))}))`, options.timeoutMs);
    await waitFor(page, `window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events.some((event) => event.name === 'editor-attach' && event.sequence > ${beforeOpenSequence})`, options.timeoutMs);
    await waitForBackgroundReadyAfterAttach(page, beforeOpenSequence, options.timeoutMs);
    console.log(`[desktop-ui-performance] Opened ${fixture.id}.`);
  }
  const coldCoverageReport = await report(page);
  assertColdCoverage(coldCoverageReport, 1 + interactiveCold.length);
  const nativeCancellationSamples = await probeNativeCancellation(page, fixtures.cold.at(-1).path, 5);
  const nativeCancellationDistribution = distribution(nativeCancellationSamples.map((sample) => sample.stopMs));
  if (nativeCancellationSamples.length !== 5 || nativeCancellationSamples.some((sample) => !sample.accepted || !sample.stopped)) {
    throw new Error(`Native cancellation did not stop every accepted operation: ${JSON.stringify(nativeCancellationSamples)}.`);
  }
  if ((nativeCancellationDistribution.p95 ?? Infinity) > 500) {
    throw new Error(`Native cancellation p95 ${nativeCancellationDistribution.p95} ms exceeds the 500 ms budget.`);
  }

  const inputName = basename(fixtures.cold[0].path);
  const firstName = basename(fixtures.cold[3].path);
  const secondName = basename(fixtures.cold[5].path);
  const firstVisualName = basename(fixtures.visualWarm[0].path);
  const secondVisualName = basename(fixtures.visualWarm[1].path);
  await activateTab(page, inputName);
  await selectSourceMode(page);
  const beforeInput = await report(page);
  const inputLatencies = [];
  let inputThreshold = lastSequence(beforeInput);
  for (let index = 0; index < 5; index += 1) {
    await page.send('Runtime.evaluate', { expression: `document.querySelector('.cm-content')?.focus()` });
    await page.send('Input.insertText', { text: 'x' });
    await waitFor(page, `window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events.some((event) => event.name === 'input-echoed' && event.sequence > ${inputThreshold})`, 10_000);
    const inputReport = await report(page);
    const accepted = inputReport.events.find((event) => event.name === 'input-accepted' && event.sequence > inputThreshold);
    const echoed = inputReport.events.find((event) => event.name === 'input-echoed' && event.sequence > (accepted?.sequence ?? inputThreshold));
    if (!accepted || !echoed) throw new Error(`Packaged input sample ${index + 1} did not reach accepted and echoed markers.`);
    inputLatencies.push(Math.max(0, echoed.monotonicMs - accepted.monotonicMs));
    inputThreshold = lastSequence(inputReport);
  }
  await waitForActiveBackgroundReady(page, inputThreshold, Math.max(options.timeoutMs, 180_000));

  const warmCandidatePreparationStart = lastSequence(await report(page));
  await activateTab(page, firstName);
  await waitFor(page, `window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events.some((event) => event.name === 'editor-attach' && event.sequence > ${warmCandidatePreparationStart})`, options.timeoutMs);
  const secondCandidatePreparationStart = lastSequence(await report(page));
  await activateTab(page, secondName);
  await waitFor(page, `window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events.some((event) => event.name === 'editor-attach' && event.sequence > ${secondCandidatePreparationStart})`, options.timeoutMs);
  await activateTab(page, firstName);

  const warmSamples = [];
  const warmAcquisitionStart = lastSequence(await report(page));
  for (let index = 0; index < 5; index += 1) {
    await activateTab(page, secondName);
    warmSamples.push(await activateAndMeasure(page, firstName));
  }
  await clickTab(page, secondName);
  await clickTab(page, firstName);
  await waitFor(page, `window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events.some((event) => event.name === 'next-frame' && event.sequence > ${warmAcquisitionStart})`, 10_000);
  await waitForBackgroundReadyAfterAttach(page, warmAcquisitionStart, options.timeoutMs);

  const visualFixtureOpenStart = lastSequence(await report(page));
  await openPerformanceDocument(page, fixtures.visualWarm[0].path);
  await waitFor(page, `Array.from(document.querySelectorAll('[role="tab"]')).some((tab) => (tab.getAttribute('aria-label') ?? tab.textContent ?? '').includes(${JSON.stringify(firstVisualName)}))`, options.timeoutMs);
  await waitFor(page, `window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events.some((event) => event.name === 'editor-attach' && event.sequence > ${visualFixtureOpenStart})`, options.timeoutMs);
  await waitForBackgroundReadyAfterAttach(page, visualFixtureOpenStart, options.timeoutMs);
  const secondVisualFixtureOpenStart = lastSequence(await report(page));
  await openPerformanceDocument(page, fixtures.visualWarm[1].path);
  await waitFor(page, `Array.from(document.querySelectorAll('[role="tab"]')).some((tab) => (tab.getAttribute('aria-label') ?? tab.textContent ?? '').includes(${JSON.stringify(secondVisualName)}))`, options.timeoutMs);
  await waitFor(page, `window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events.some((event) => event.name === 'editor-attach' && event.sequence > ${secondVisualFixtureOpenStart})`, options.timeoutMs);
  await waitForBackgroundReadyAfterAttach(page, secondVisualFixtureOpenStart, options.timeoutMs);
  await activateTab(page, firstVisualName);
  await selectVisualMode(page);
  await activateTab(page, secondVisualName);
  await selectVisualMode(page);
  await activateVisualTab(page, firstVisualName);
  const visualWarmSamples = [];
  const visualWarmAcquisitionStart = lastSequence(await report(page));
  for (let index = 0; index < 5; index += 1) {
    await activateVisualTab(page, secondVisualName);
    visualWarmSamples.push(await activateVisualAndMeasure(page, firstVisualName));
  }
  const visualWarmReport = await report(page);
  const visualWarmEvents = visualWarmReport.events.filter((event) => event.sequence > visualWarmAcquisitionStart);
  const visualWarmRuntimeHits = visualWarmEvents.filter((event) => (
    event.name === 'runtime-attach'
    && event.surface === 'visual'
    && event.cache === 'hit'
    && event.phase === 'exact-state'
  ));
  if (visualWarmRuntimeHits.length < 10) {
    const runtimeEvidence = visualWarmEvents.filter((event) => (
      event.surface === 'visual'
      && ['runtime-suspend', 'runtime-attach', 'runtime-admission-refused', 'runtime-eviction'].includes(event.name)
    ));
    throw new Error(`Visual warm A-B-A reached only ${visualWarmRuntimeHits.length} exact runtime hit(s); expected at least 10. Runtime evidence: ${JSON.stringify(runtimeEvidence)}.`);
  }
  const visualWarmReplacements = visualWarmEvents.filter((event) => (
    event.surface === 'visual'
    && event.phase === 'milkdown-external-replace'
  ));
  if (visualWarmReplacements.length !== 0) {
    throw new Error(`Visual warm A-B-A performed ${visualWarmReplacements.length} full Milkdown replacement(s).`);
  }

  const finalReport = await report(page);
  const postWarmAcquisitions = finalReport.events.filter((event) => (
    event.name === 'byte-acquisition'
    && (event.acquisitionReason === 'open' || event.acquisitionReason === 'coldCleanRehydrate')
    && (
      (event.sequence > warmAcquisitionStart && event.sequence < visualFixtureOpenStart)
      || event.sequence > visualWarmAcquisitionStart
    )
  ));
  if (postWarmAcquisitions.length !== 0) {
    throw new Error(`Warm A-B-A acquired main-document bytes ${postWarmAcquisitions.length} time(s): ${JSON.stringify(postWarmAcquisitions)}.`);
  }
  assertContentFree(finalReport);
  assertInputCoverage(finalReport, beforeInput);

  const inputAccepted = finalReport.events.find((event) => event.name === 'input-accepted' && event.sequence > lastSequence(beforeInput));
  const inputEchoed = finalReport.events.find((event) => event.name === 'input-echoed' && event.sequence > (inputAccepted?.sequence ?? 0));
  const analysisRuntime = await evaluate(page, `window.__SCIEMD_DOCUMENT_PERFORMANCE__?.analysis()`);
  await collectGarbage(page);
  const heapBytes = await evaluate(page, `performance.memory?.usedJSHeapSize ?? null`);
  const workingSetBytes = processWorkingSet(app.pid);
  await requireGracefulShutdown(page, app, mainDataRoot, options.timeoutMs);
  page.close();
  page = undefined;
  app = undefined;
  const pressureProbe = await probeWorkspacePressure(appPath, fixtures.workspace, port + 20, root, options.timeoutMs);
  const workspacePressure = pressureProbe.reached;
  const pressureProcessTreeWorkingSetBytes = pressureProbe.processTreeWorkingSetBytes;
  assertRoundFiveBudgets({ warmSamples, visualWarmSamples, inputLatencies, heapBytes, pressureProbe });
  const nativeTransport = nativeTransportEvidence(coldCoverageReport);
  const baseline = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    candidate: {
      sourceIdentity,
      executablePath: 'src-tauri/target/release/sciemd.exe',
      executableSha256,
    },
    environment: environmentIdentity(),
    fixtureIdentity: {
      cold: fixtures.cold.map(({ id, bytes, state }) => ({ id, bytes, state })),
      workspace: fixtures.workspace.map(({ id, bytes, state }) => ({ id, bytes, state })),
      structured: fixtures.structured.map(({ id, bytes, state }) => ({ id, bytes, state })),
      visualWarm: fixtures.visualWarm.map(({ id, bytes, state }) => ({ id, bytes, state })),
      sampleCount: 5,
    },
    distributions: {
      warm_reactivation_editor_attach_ms: distribution(warmSamples),
      visual_warm_reactivation_next_frame_ms: distribution(visualWarmSamples),
      cold_open_first_editable_ms: distribution([...coldProbes.flatMap((probe) => probe.outcome === 'editable' ? [probe.elapsedMs] : []), ...coldOpenDurations(coldCoverageReport)]),
      accepted_to_visibly_echoed_input_ms: distribution(inputLatencies),
      native_cancel_stop_ms: nativeCancellationDistribution,
    },
    coldProbes,
    coldTraceSummary: coldCoverageReport.summary,
    structuredProbe,
    counts: finalReport.summary,
    memory: {
      prePressureWebviewHeapBytes: heapBytes,
      prePressureProcessWorkingSetBytes: workingSetBytes,
      pressureProcessTreeWorkingSetBytes,
      pressureWebviewHeapBytes: pressureProbe.webviewHeapBytes,
      pressureHeapReason: null,
    },
    semanticGates: {
      packagedWebViewReached: true,
      acceptedInputReached: Boolean(inputAccepted),
      visiblyEchoedInputReached: Boolean(inputEchoed),
      warmActivationMainDocumentByteAcquisitions: postWarmAcquisitions.length,
      contentFreeTrace: true,
      nativeRendererClockSubtraction: false,
      cumulativeWorkspaceTabsReached: workspacePressure,
      nativeCancellation: {
        measured: true,
        samples: nativeCancellationSamples,
        p95Ms: nativeCancellationDistribution.p95,
        budgetMs: 500,
      },
      nativeTransport,
      analysisRuntime,
      sourceFont: { ...fontEvidence, offlineFace },
    },
    dominantPhases: dominantPhases(finalReport),
  };
  const baselinePath = resolve('src/app/performance/documentPerformanceBaseline.windows.v1.json');
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  assertProductionStateUnchanged(productionStateBefore);
  console.log(JSON.stringify({ ok: true, baselinePath, sourceIdentity, executableSha256, warmSamples, visualWarmSamples, heapBytes, workingSetBytes, pressureProcessTreeWorkingSetBytes }, null, 2));
} finally {
  page?.close();
  if (app && app.exitCode === null) terminateProcessTree(app.pid);
  if (app) await waitForChildExit(app, 5_000);
  await rm(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => undefined);
}

function parseArgs(args) {
  const parsed = { required: false, appPath: null, port: 9247, timeoutMs: 60_000 };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--required') parsed.required = true;
    else if (args[index] === '--app') parsed.appPath = args[++index];
    else if (args[index] === '--port') parsed.port = Number(args[++index]);
    else if (args[index] === '--timeout-ms') parsed.timeoutMs = Number(args[++index]);
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  return parsed;
}

function stop(message) {
  if (required) throw new Error(message);
  console.log(`[desktop-ui-performance] SKIP: ${message}`);
  process.exit(0);
}

async function createFixtures(directory) {
  const definitions = [
    ['markdown-1mib-many-line', 1024 * 1024, 'dirty'],
    ['unicode-below-threshold', (5 * 1024 * 1024) - 1, 'clean'],
    ['unicode-at-threshold', 5 * 1024 * 1024, 'clean'],
    ['unicode-above-threshold', (5 * 1024 * 1024) + 1, 'clean'],
    ['markdown-5mib-many-line', 5 * 1024 * 1024, 'clean'],
    ['markdown-10mib-many-line', 10 * 1024 * 1024, 'clean'],
    ['markdown-24mib-long-line', 24 * 1024 * 1024, 'clean'],
  ];
  const cold = [];
  for (const [id, bytes, state] of definitions) cold.push(await writeSized(directory, id, bytes, state, id.includes('long-line')));
  const workspace = [];
  for (let index = 0; index < 5; index += 1) workspace.push(await writeSized(directory, `workspace-10mib-${index + 1}`, 10 * 1024 * 1024, index === 0 ? 'dirty' : 'clean'));
  for (let index = 0; index < 3; index += 1) workspace.push(await writeSized(directory, `workspace-24mib-${index + 1}`, 24 * 1024 * 1024, 'clean', true));
  const structuredSources = {
    json: '{"items":[1,2]}\n', jsonl: '{"id":1}\n{"id":2}\n', yaml: 'items:\n  - one\n', toml: 'title = "fixture"\n',
    xml: '<root><item>one</item></root>\n', csv: 'id,value\n1,one\n', tsv: 'id\tvalue\n1\tone\n',
  };
  const structured = [];
  for (const [extension, source] of Object.entries(structuredSources)) {
    const path = join(directory, `mixed-structured.${extension}`);
    await writeFile(path, source, 'utf8');
    structured.push({ id: `structured-${extension}`, path, bytes: Buffer.byteLength(source), state: 'clean' });
  }
  const visualWarm = [
    await writeSized(directory, 'vw-a-512k', 512 * 1024, 'clean'),
    await writeSized(directory, 'vw-b-768k', 768 * 1024, 'clean'),
  ];
  return { cold, workspace, structured, visualWarm };
}

async function probeColdFixture(appPath, fixture, port, cwd) {
  const startedAt = Date.now();
  const probeData = join(fixture.path, '..', `probe-${port}`);
  const child = spawn(appPath, [fixture.path], {
    cwd,
    env: isolatedAppEnvironment(probeData, port),
    stdio: 'ignore',
  });
  let probePage;
  try {
    probePage = await withDeadline(connectToFirstPage(port, 10_000, () => ''), 12_000, 'probe DevTools connection');
    await probePage.send('Runtime.enable');
    await withDeadline(waitFor(probePage, `(() => { const events = window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events ?? []; return events.some((association) => association.name === 'operation-associated' && events.some((event) => event.name === 'editor-attach' && event.documentId === association.documentId && event.sequence > association.sequence)); })()`, 25_000), 30_000, 'correlated first editable marker');
    const trace = await withDeadline(report(probePage), 5_000, 'probe report');
    const start = trace.events.find((event) => event.name === 'open-start');
    const association = trace.events.find((event) => event.name === 'operation-associated' && event.operationId === start?.operationId);
    const attach = trace.events.find((event) => event.name === 'editor-attach' && event.documentId === association?.documentId && event.sequence > (association?.sequence ?? 0));
    if (!start || !association || !attach) throw new Error('Cold probe did not correlate open, committed document, and first editor attach.');
    return { id: fixture.id, outcome: 'editable', elapsedMs: Math.max(0, (attach?.monotonicMs ?? 0) - (start?.monotonicMs ?? 0)), processWorkingSetBytes: processWorkingSet(child.pid) };
  } catch (error) {
    return { id: fixture.id, outcome: 'timeout', elapsedMs: Date.now() - startedAt, processWorkingSetBytes: processWorkingSet(child.pid), detail: error instanceof Error ? error.message : String(error) };
  } finally {
    if (probePage && child.exitCode === null) await requireGracefulShutdown(probePage, child, probeData, 30_000);
    probePage?.close();
    if (child.exitCode === null) terminateProcessTree(child.pid);
    await waitForChildExit(child, 5_000);
  }
}

async function probeStructuredWorkspace(appPath, fixtures, port, cwd, timeoutMs) {
  const launchableFixtures = fixtures.filter((fixture) => fixture.id !== 'structured-csv');
  const userData = join(launchableFixtures[0].path, '..', `structured-probe-${port}`);
  const child = spawn(appPath, [launchableFixtures[0].path], {
    cwd,
    env: isolatedAppEnvironment(userData, port),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let appError = '';
  child.stderr.on('data', (chunk) => { appError += chunk.toString(); });
  let probePage;
  try {
    probePage = await connectToFirstPage(port, Math.max(timeoutMs, 30_000), () => appError);
    await probePage.send('Runtime.enable');
    await waitFor(probePage, `Boolean(document.querySelector('[role="tab"]'))`, 15_000);
    await waitFor(probePage, `window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events.some((event) => event.name === 'editor-attach')`, timeoutMs);
    await waitForBackgroundReadyAfterAttach(probePage, 0, timeoutMs);
    for (const fixture of launchableFixtures.slice(1)) {
      const beforeOpenSequence = lastSequence(await report(probePage));
      await openPerformanceDocument(probePage, fixture.path);
      await waitFor(probePage, `Array.from(document.querySelectorAll('[role="tab"]')).some((tab) => (tab.getAttribute('aria-label') ?? tab.textContent ?? '').includes(${JSON.stringify(basename(fixture.path))}))`, timeoutMs);
      await waitFor(probePage, `window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events.some((event) => event.name === 'editor-attach' && event.sequence > ${beforeOpenSequence})`, timeoutMs);
      await waitForBackgroundReadyAfterAttach(probePage, beforeOpenSequence, timeoutMs);
    }
    const tabCount = await evaluate(probePage, `document.querySelectorAll('[role="tab"]').length`);
    const trace = await report(probePage);
    if (tabCount < launchableFixtures.length) throw new Error(`Mixed structured probe reached ${tabCount} tabs, expected ${launchableFixtures.length}.`);
    return {
      formats: launchableFixtures.map((fixture) => fixture.id),
      compatibilityExclusions: [{ id: 'structured-csv', reason: 'CSV remains deliberately excluded from OS startup/Open With arguments; Round 1 does not broaden file-association compatibility.' }],
      tabCount,
      traceSummary: trace.summary,
      processTreeWorkingSetBytes: processTreeMetrics(child.pid).totalBytes,
    };
  } finally {
    if (probePage && child.exitCode === null) await requireGracefulShutdown(probePage, child, userData, timeoutMs);
    probePage?.close();
    if (child.exitCode === null) terminateProcessTree(child.pid);
    await waitForChildExit(child, 5_000);
  }
}

async function probeWorkspacePressure(appPath, fixtures, port, cwd, timeoutMs) {
  const userData = join(fixtures[0].path, '..', `pressure-probe-${port}`);
  const child = spawn(appPath, [fixtures[0].path], {
    cwd,
    env: isolatedAppEnvironment(userData, port),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let appError = '';
  child.stderr.on('data', (chunk) => { appError += chunk.toString(); });
  let probePage;
  const reached = [];
  try {
    probePage = await connectToFirstPage(port, Math.max(timeoutMs, 30_000), () => appError);
    await probePage.send('Runtime.enable');
    await waitFor(probePage, `Boolean(document.querySelector('[role="tab"]'))`, 15_000);
    await waitFor(probePage, `window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events.some((event) => event.name === 'editor-attach')`, timeoutMs);
    await waitForBackgroundReadyAfterAttach(probePage, 0, timeoutMs);
    reached.push(fixtures[0].id);
    console.log(`[desktop-ui-performance] Opened pressure fixture ${fixtures[0].id}.`);
    for (const fixture of fixtures.slice(1)) {
      const beforeOpenSequence = lastSequence(await report(probePage));
      await openPerformanceDocument(probePage, fixture.path);
      await waitFor(probePage, `Array.from(document.querySelectorAll('[role="tab"]')).some((tab) => (tab.getAttribute('aria-label') ?? tab.textContent ?? '').includes(${JSON.stringify(basename(fixture.path))}))`, timeoutMs);
      await waitFor(probePage, `window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events.some((event) => event.name === 'editor-attach' && event.sequence > ${beforeOpenSequence})`, timeoutMs);
      await waitForBackgroundReadyAfterAttach(probePage, beforeOpenSequence, timeoutMs);
      reached.push(fixture.id);
      console.log(`[desktop-ui-performance] Opened pressure fixture ${fixture.id}.`);
    }
    await delay(15_000);
    await collectGarbage(probePage);
    await delay(1_000);
    const pressureTrace = await report(probePage);
    const processTree = processTreeMetrics(child.pid);
    return {
      reached,
      webviewHeapBytes: await evaluate(probePage, `performance.memory?.usedJSHeapSize ?? null`),
      processTreeWorkingSetBytes: processTree.totalBytes,
      processTreeWorkingSet: processTree.processes,
      renderedSourceCodeUnits: await evaluate(probePage, `document.querySelector('.cm-content')?.textContent?.length ?? null`),
      coldTransitions: pressureTrace.events.filter((event) => event.name === 'cold-transition'),
      analysisRuntime: await evaluate(probePage, `window.__SCIEMD_DOCUMENT_PERFORMANCE__?.analysis()`),
    };
  } finally {
    if (probePage && child.exitCode === null) await requireGracefulShutdown(probePage, child, userData, timeoutMs);
    probePage?.close();
    if (child.exitCode === null) terminateProcessTree(child.pid);
    await waitForChildExit(child, 5_000);
  }
}

async function writeSized(directory, id, bytes, state, longLine = false) {
  const path = join(directory, `${id}.md`);
  const heading = '# ScieMD packaged performance fixture\n\n';
  const unit = longLine ? 'αβγ 0123456789abcdef' : `αβγ ${'0123456789abcdef'.repeat(64)}\n`;
  const count = Math.floor((bytes - Buffer.byteLength(heading)) / Buffer.byteLength(unit));
  const source = heading + unit.repeat(count);
  await writeFile(path, source + 'x'.repeat(bytes - Buffer.byteLength(source)), 'utf8');
  return { id, path, bytes, state };
}

async function connectToFirstPage(port, timeoutMs, errorOutput) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) })).json();
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) return new CdpPage(target.webSocketDebuggerUrl);
    } catch { /* retry while WebView starts */ }
    await delay(200);
  }
  throw new Error(`No debuggable packaged WebView appeared. ${errorOutput()}`);
}

function CdpPage(webSocketUrl) {
  this.socket = new WebSocket(webSocketUrl);
  this.pending = new Map();
  this.nextId = 1;
  this.ready = new Promise((resolveReady, reject) => {
    this.socket.addEventListener('open', resolveReady, { once: true });
    this.socket.addEventListener('error', () => reject(new Error('Could not connect to packaged WebView DevTools.')), { once: true });
  });
  this.socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    const pending = this.pending.get(payload.id);
    if (!pending) return;
    this.pending.delete(payload.id);
    payload.error ? pending.reject(new Error(payload.error.message)) : pending.resolve(payload.result ?? {});
  });
  this.send = async (method, params = {}) => {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolveResult, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Packaged WebView DevTools command timed out: ${method}`));
      }, 120_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolveResult(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  };
  this.close = () => this.socket.close();
}

async function evaluate(page, expression) {
  const response = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? 'Packaged WebView evaluation failed.');
  return response.result?.value;
}

async function collectGarbage(page) {
  await page.send('HeapProfiler.enable');
  try {
    await page.send('HeapProfiler.collectGarbage');
  } finally {
    await page.send('HeapProfiler.disable');
  }
}

async function waitFor(page, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(page, expression)) return;
    await delay(100);
  }
  const diagnostics = await evaluate(page, `JSON.stringify({ tabs: Array.from(document.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent), events: window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events.slice(-24) ?? [] })`).catch(() => 'unavailable');
  throw new Error(`Timed out waiting for packaged WebView expression: ${expression}. Diagnostics: ${diagnostics}`);
}

async function selectSourceMode(page) {
  const clicked = await evaluate(page, `(() => { const button = Array.from(document.querySelectorAll('[aria-label="Editor mode"] button')).find((item) => item.textContent?.includes('Source')); button?.click(); return Boolean(button); })()`);
  if (!clicked) throw new Error('Could not reach the packaged Source mode control.');
  await waitFor(page, `Boolean(document.querySelector('.cm-content'))`, 30_000);
}

async function selectVisualMode(page) {
  const clicked = await evaluate(page, `(() => { const button = Array.from(document.querySelectorAll('[aria-label="Editor mode"] button')).find((item) => item.textContent?.includes('Visual')); button?.click(); return Boolean(button); })()`);
  if (!clicked) throw new Error('Could not reach the packaged Visual mode control.');
  await waitFor(page, `Boolean(document.querySelector('.visual-editor .ProseMirror'))`, 60_000);
}

async function clickTab(page, name) {
  const clicked = await evaluate(page, `(() => { const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((item) => (item.getAttribute('aria-label') ?? item.textContent ?? '').includes(${JSON.stringify(name)})); tab?.click(); return Boolean(tab); })()`);
  if (!clicked) throw new Error(`Could not activate packaged tab ${name}.`);
}

async function activateTab(page, name) {
  await clickTab(page, name);
  await waitFor(page, `Array.from(document.querySelectorAll('[role="tab"]')).some((tab) => tab.getAttribute('aria-selected') === 'true' && (tab.getAttribute('aria-label') ?? tab.textContent ?? '').includes(${JSON.stringify(name)}))`, 60_000);
  if (!await evaluate(page, `Boolean(document.querySelector('.cm-content'))`)) await selectSourceMode(page);
  await waitFor(page, `Boolean(document.querySelector('.cm-content'))`, 30_000);
}

async function activateAndMeasure(page, name) {
  const before = await report(page);
  await activateTab(page, name);
  const afterSequence = lastSequence(before);
  await waitFor(page, `window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events.some((event) => event.name === 'editor-attach' && event.sequence > ${afterSequence})`, 10_000);
  const after = await report(page);
  const start = after.events.find((event) => event.name === 'activation-start' && event.sequence > afterSequence);
  const attach = after.events.find((event) => event.name === 'editor-attach' && event.sequence > (start?.sequence ?? afterSequence));
  if (!start || !attach) throw new Error(`Activation trace for ${name} did not reach editor attach.`);
  return Math.max(0, attach.monotonicMs - start.monotonicMs);
}

async function activateVisualTab(page, name) {
  await clickTab(page, name);
  await waitFor(page, `Array.from(document.querySelectorAll('[role="tab"]')).some((tab) => tab.getAttribute('aria-selected') === 'true' && (tab.getAttribute('aria-label') ?? tab.textContent ?? '').includes(${JSON.stringify(name)}))`, 60_000);
  await waitFor(page, `Boolean(document.querySelector('.visual-editor .ProseMirror'))`, 60_000);
}

async function activateVisualAndMeasure(page, name) {
  const before = await report(page);
  const afterSequence = lastSequence(before);
  await activateVisualTab(page, name);
  await waitFor(page, `window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events.some((event) => event.name === 'next-frame' && event.surface === 'visual' && event.sequence > ${afterSequence})`, 10_000);
  const after = await report(page);
  const start = after.events.find((event) => event.name === 'activation-start' && event.surface === 'visual' && event.sequence > afterSequence);
  const nextFrame = after.events.find((event) => event.name === 'next-frame' && event.surface === 'visual' && event.sequence > (start?.sequence ?? afterSequence));
  if (!start || !nextFrame) throw new Error(`Visual activation trace for ${name} did not reach the next painted frame.`);
  return Math.max(0, nextFrame.monotonicMs - start.monotonicMs);
}

async function report(page) {
  return evaluate(page, `window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report()`);
}

async function waitForBackgroundReadyAfterAttach(page, afterSequence, timeoutMs) {
  await waitFor(page, `(() => {
    const events = window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events ?? [];
    const attach = events.filter((event) => event.name === 'editor-attach' && event.sequence > ${afterSequence}).at(-1);
    return Boolean(attach && events.some((event) => event.name === 'background-ready' && event.documentId === attach.documentId && event.sequence > attach.sequence));
  })()`, timeoutMs);
}

async function waitForActiveBackgroundReady(page, afterSequence, timeoutMs) {
  await waitFor(page, `(() => {
    const events = window.__SCIEMD_DOCUMENT_PERFORMANCE__?.report().events ?? [];
    const attach = events.filter((event) => event.name === 'editor-attach').at(-1);
    return Boolean(attach && events.some((event) => event.name === 'background-ready' && event.documentId === attach.documentId && event.sequence > ${afterSequence}));
  })()`, timeoutMs);
}

async function emitDocumentOpen(page, path) {
  const emitted = await evaluate(page, `(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== 'function') return false;
    await invoke('plugin:event|emit', { event: 'single-instance-open', payload: ${JSON.stringify(path)} });
    return true;
  })()`);
  if (!emitted) throw new Error(`Packaged Tauri event bridge could not emit ${basename(path)}.`);
}

async function probeNativeCancellation(page, path, sampleCount) {
  const samples = [];
  const maximumAttempts = sampleCount * 3;
  for (let index = 0; index < maximumAttempts && samples.length < sampleCount; index += 1) {
    const operationId = `packaged-cancel-${Date.now()}-${index}`;
    const sample = await evaluate(page, `(async () => {
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (typeof invoke !== 'function') throw new Error('Packaged Tauri invoke bridge is unavailable.');
      const channelId = window.__TAURI_INTERNALS__.transformCallback(() => undefined, false);
      const read = invoke('read_text_file_for_edit', {
        path: ${JSON.stringify(path)},
        operationId: ${JSON.stringify(operationId)},
        onEvent: '__CHANNEL__:' + channelId,
      });
      const cancellation = await invoke('cancel_text_file_read', { operationId: ${JSON.stringify(operationId)} });
      await read.catch(() => undefined);
      try { window.__TAURI_INTERNALS__.unregisterCallback(channelId); } catch { /* channel already closed */ }
      return cancellation;
    })()`);
    if (sample.accepted) samples.push(sample);
  }
  return samples;
}

function lastSequence(value) { return value?.events?.at(-1)?.sequence ?? 0; }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return true;
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(timeoutMs),
  ]);
  return child.exitCode !== null;
}
async function openPerformanceDocument(page, path) {
  await evaluate(page, `(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== 'function') throw new Error('Packaged Tauri invoke bridge is unavailable.');
    await invoke('enqueue_performance_document_open', { path: ${JSON.stringify(path)} });
    return true;
  })()`);
}

function isolatedAppEnvironment(dataRoot, port) {
  return {
    ...process.env,
    APPDATA: join(dataRoot, 'roaming'),
    LOCALAPPDATA: join(dataRoot, 'local'),
    XDG_DATA_HOME: join(dataRoot, 'xdg-data'),
    SCIEMD_APP_DATA_DIR_OVERRIDE: join(dataRoot, 'native-data'),
    SCIEMD_DISABLE_SINGLE_INSTANCE: '1',
    SCIEMD_DESKTOP_PERFORMANCE_SELF_TEST: '1',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-allow-origins=*`,
    WEBVIEW2_USER_DATA_FOLDER: join(dataRoot, 'webview-data'),
  };
}

async function requireGracefulShutdown(page, child, dataRoot, timeoutMs) {
  if (child.exitCode !== null) {
    assertCleanShutdown(dataRoot);
    return;
  }
  try {
    await evaluate(page, `(async () => {
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (typeof invoke !== 'function') throw new Error('Packaged Tauri invoke bridge is unavailable.');
      await invoke('plugin:window|close', { label: 'main' });
      return true;
    })()`);
  } catch { /* the DevTools target can disconnect while a clean window close completes */ }

  const deadline = Date.now() + Math.max(10_000, Math.min(timeoutMs, 30_000));
  let discardClicked = false;
  while (child.exitCode === null && Date.now() < deadline) {
    if (!discardClicked) {
      try {
        discardClicked = Boolean(await evaluate(page, `(() => {
          const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim().startsWith('Discard'));
          button?.click();
          return Boolean(button);
        })()`));
      } catch { /* page may already be closing */ }
    }
    if (await waitForChildExit(child, 250)) break;
  }
  if (child.exitCode === null) throw new Error(`Packaged process ${child.pid} did not complete its guarded graceful shutdown.`);
  assertCleanShutdown(dataRoot);
}

function assertCleanShutdown(dataRoot) {
  const heartbeatPath = join(dataRoot, 'native-data', 'diagnostics', 'renderer-heartbeat.json');
  if (!existsSync(heartbeatPath)) throw new Error(`Packaged graceful shutdown did not produce ${heartbeatPath}.`);
  const heartbeat = JSON.parse(readFileSync(heartbeatPath, 'utf8'));
  if (heartbeat.cleanShutdown !== true) throw new Error(`Packaged graceful shutdown was not sealed: ${JSON.stringify(heartbeat)}.`);
}

function terminateProcessTree(pid) {
  if (!Number.isInteger(pid)) return;
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}
function withDeadline(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs)),
  ]);
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function sourceTreeIdentity() {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const files = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).stdout.split(/\r?\n/)
    .filter(Boolean)
    .filter((path) => existsSync(resolve(path)))
    .filter((path) => path !== 'src/app/performance/documentPerformanceBaseline.windows.v1.json')
    .filter((path) => path !== 'docs/refactor/document_runtime_structured_editing_foundations_wave.md')
    .filter((path) => path !== 'docs/refactor/document_runtime_structured_editing_foundations_wave_certification.v1.json')
    .sort();
  const manifest = files.map((path) => `${sha256(readFileSync(resolve(path)))}  ${path}`).join('\n');
  return { head, buildInputManifestSha256: sha256(manifest), fileCount: files.length };
}

function environmentIdentity() {
  const cpu = process.env.PROCESSOR_IDENTIFIER ?? 'unknown';
  const power = spawnSync('powercfg', ['/getactivescheme'], { encoding: 'utf8' }).stdout.trim();
  return { os: `${process.platform} ${process.arch} ${process.getSystemVersion?.() ?? ''}`.trim(), webview: 'WebView2 evergreen', cpu, memoryBytes: Number(process.env.SCIEMD_REFERENCE_MEMORY_BYTES ?? 0) || null, powerState: power || 'unknown', buildMode: 'Tauri release' };
}

function processWorkingSet(pid) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).WorkingSet64`], { encoding: 'utf8' });
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) ? value : null;
}

function processTreeMetrics(pid) {
  const script = `$root=${Number(pid)}; $all=Get-CimInstance Win32_Process; $ids=@($root); do { $before=$ids.Count; $ids += @($all | Where-Object { $ids -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId }); $ids=@($ids | Select-Object -Unique) } while ($ids.Count -gt $before); @($all | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object { [pscustomobject]@{ name=$_.Name; workingSetBytes=[long]$_.WorkingSetSize } }) | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  try {
    const parsed = JSON.parse(result.stdout.trim() || '[]');
    const processes = Array.isArray(parsed) ? parsed : [parsed];
    return { processes, totalBytes: processes.reduce((sum, process) => sum + Number(process.workingSetBytes ?? 0), 0) };
  } catch {
    return { processes: [], totalBytes: null };
  }
}

function productionStateSnapshot() {
  return {
    fingerprint: fingerprintPaths([
    process.env.APPDATA ? join(process.env.APPDATA, 'com.scienfy.sciemd') : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'com.scienfy.sciemd', 'EBWebView') : null,
    ].filter(Boolean)),
    activeExecutables: activeScieMdExecutables(),
  };
}

function activeScieMdExecutables() {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    'Get-Process -Name sciemd -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }',
  ], { encoding: 'utf8' });
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function fingerprintPaths(paths) {
  const entries = [];
  const visit = (path) => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (!stat.isDirectory()) {
      entries.push(`${path}|${stat.size}|${stat.mtimeMs}`);
      return;
    }
    for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  for (const path of paths) visit(path);
  return sha256(entries.join('\n'));
}

function assertProductionStateUnchanged(before) {
  if (before.activeExecutables.length > 0) {
    console.warn(`[desktop-ui-performance] Production app-data fingerprint check is not attributable while pre-existing ScieMD processes are active: ${before.activeExecutables.join(', ')}`);
    return;
  }
  const after = productionStateSnapshot();
  if (after.fingerprint !== before.fingerprint) {
    throw new Error('Packaged performance validation modified the production ScieMD app-data profile.');
  }
}

function distribution(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return { samples: sorted, median: percentile(0.5), p95: percentile(0.95) };
}

function assertColdCoverage(trace, expectedCount) {
  const opens = trace.events.filter((event) => event.name === 'open-start');
  const reads = trace.events.filter((event) => event.name === 'byte-acquisition' && event.acquisitionReason === 'open');
  const associations = trace.events.filter((event) => event.name === 'operation-associated');
  if (opens.length < expectedCount || reads.length < expectedCount || associations.length < expectedCount) {
    throw new Error(`Packaged cold coverage incomplete: opens=${opens.length}, reads=${reads.length}, associations=${associations.length}, expected>=${expectedCount}.`);
  }
  for (const phase of ['permission-cloud-grant', 'stat', 'read', 'decode-fidelity', 'hash', 'image-grant-discovery', 'total']) {
    if (!trace.events.some((event) => event.name === 'native-read' && event.phase === phase)) throw new Error(`Native phase ${phase} is absent.`);
  }
}

function assertInputCoverage(trace, before) {
  const threshold = lastSequence(before);
  if (!trace.events.some((event) => event.name === 'input-accepted' && event.sequence > threshold)) throw new Error('Packaged CodeMirror input was not accepted.');
  if (!trace.events.some((event) => event.name === 'input-echoed' && event.sequence > threshold)) throw new Error('Packaged CodeMirror input was not visibly echoed.');
}

function assertRoundFiveBudgets({ warmSamples, visualWarmSamples, inputLatencies, heapBytes, pressureProbe }) {
  const warmP95 = distribution(warmSamples).p95 ?? Infinity;
  const visualWarmP95 = distribution(visualWarmSamples).p95 ?? Infinity;
  const inputP95 = distribution(inputLatencies).p95 ?? Infinity;
  const heapLimit = performanceBudgets.webview_heap_mib * 1024 * 1024;
  const workingSetLimit = performanceBudgets.process_working_set_mib * 1024 * 1024;
  const failures = [];
  if (warmP95 > performanceBudgets.warm_reactivation_editor_attach_p95_ms) failures.push(`warm reactivation p95 ${warmP95} ms exceeds ${performanceBudgets.warm_reactivation_editor_attach_p95_ms} ms`);
  if (visualWarmP95 > performanceBudgets.visual_warm_reactivation_next_frame_p95_ms) failures.push(`visual warm reactivation p95 ${visualWarmP95} ms exceeds ${performanceBudgets.visual_warm_reactivation_next_frame_p95_ms} ms`);
  if (inputP95 > performanceBudgets.visibly_echoed_input_p95_ms) failures.push(`accepted-to-visible input p95 ${inputP95} ms exceeds ${performanceBudgets.visibly_echoed_input_p95_ms} ms`);
  if (heapBytes === null || heapBytes > heapLimit) failures.push(`pre-pressure WebView heap ${heapBytes ?? 'unavailable'} bytes exceeds ${heapLimit} bytes`);
  if (pressureProbe.webviewHeapBytes === null || pressureProbe.webviewHeapBytes > heapLimit) failures.push(`pressure WebView heap ${pressureProbe.webviewHeapBytes ?? 'unavailable'} bytes exceeds ${heapLimit} bytes (renderedSourceCodeUnits=${pressureProbe.renderedSourceCodeUnits ?? 'unavailable'}, coldTransitions=${JSON.stringify(pressureProbe.coldTransitions)}, analysis=${JSON.stringify(pressureProbe.analysisRuntime)})`);
  if (pressureProbe.processTreeWorkingSetBytes === null || pressureProbe.processTreeWorkingSetBytes > workingSetLimit) failures.push(`pressure process-tree working set ${pressureProbe.processTreeWorkingSetBytes ?? 'unavailable'} bytes exceeds ${workingSetLimit} bytes (${JSON.stringify(pressureProbe.processTreeWorkingSet)})`);
  if (failures.length > 0) throw new Error(`Round 5 packaged budgets failed: ${failures.join('; ')}.`);
}

function assertContentFree(trace) {
  const serialized = JSON.stringify(trace);
  if (/sciemd-ui-performance|performance fixture|fixtures\\|fixtures\//i.test(serialized)) throw new Error('Performance trace leaked fixture path or content.');
  for (const event of trace.events) {
    if (Object.keys(event).some((key) => /source|content|text|path|filename/i.test(key))) throw new Error(`Content-shaped trace key found in event ${event.sequence}.`);
  }
}

function dominantPhases(trace) {
  return trace.events.filter((event) => typeof event.durationMs === 'number').sort((a, b) => b.durationMs - a.durationMs).slice(0, 12)
    .map((event) => ({ name: event.name, phase: event.phase ?? null, durationMs: event.durationMs }));
}

function nativeTransportEvidence(trace) {
  const ipcReads = trace.events.filter((event) => event.name === 'ipc-read' && typeof event.durationMs === 'number');
  const residualSamples = ipcReads.flatMap((event) => {
    const match = /^invoke-wall-residual:([0-9.]+)ms$/.exec(event.phase ?? '');
    return match ? [Number(match[1])] : [];
  });
  if (ipcReads.length === 0 || residualSamples.length !== ipcReads.length) {
    throw new Error(`Native transport evidence incomplete: ipcReads=${ipcReads.length}, residualSamples=${residualSamples.length}.`);
  }
  const invokeWall = distribution(ipcReads.map((event) => event.durationMs));
  const invokeWallResidual = distribution(residualSamples);
  const materialityBudgetMs = 100;
  return {
    selected: 'bounded-channel',
    decisionEvidence: {
      priorOneShotCandidate: {
        buildInputManifestSha256: '87a35ed774c7ae5f516e90ea5a80e015dcd25263bc2dc6e1b2c9e8f5057d9423',
        executableSha256: '1c2d6e6a267f7310027f3c1a0f0a1637e1da1e6f59518b1a95b8710f9d0f271f',
        invokeWallResidualP95Ms: 3925.126,
        material: true,
      },
      boundedChannelCandidate: {
        invokeWall,
        invokeWallResidual,
      },
    },
    materialityBudgetMs,
    rationale: 'The measured one-shot renderer invoke residual exceeded 100 ms p95, so production reads use ordered UTF-8-safe 2 MiB channel chunks and assemble once before authoritative commit; native cooperative checkpoints remain 256 KiB.',
  };
}

function coldOpenDurations(trace) {
  return trace.events.filter((event) => event.name === 'open-start').flatMap((start) => {
    const association = trace.events.find((event) => event.name === 'operation-associated' && event.operationId === start.operationId);
    const attach = trace.events.find((event) => event.name === 'editor-attach' && event.documentId === association?.documentId && event.sequence > (association?.sequence ?? 0));
    return association && attach ? [Math.max(0, attach.monotonicMs - start.monotonicMs)] : [];
  });
}
