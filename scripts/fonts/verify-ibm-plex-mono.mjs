import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const authoritativeRoot = join(root, 'public', 'fonts', 'vendor', 'ibm-plex-mono');
const mirrorRoot = join(root, 'scie-md-vscode-extension', 'src', 'scie-md', 'styles', 'fonts', 'vendor', 'ibm-plex-mono');
const manifestPath = join(authoritativeRoot, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const packageJson = JSON.parse(readFileSync(join(root, 'node_modules', '@ibm', 'plex-mono', 'package.json'), 'utf8'));
const failures = [];

expect(manifest.family === 'IBM Plex Mono', `Unexpected family ${manifest.family}.`);
expect(manifest.packageVersion === packageJson.version, `Manifest package ${manifest.packageVersion} does not match installed ${packageJson.version}.`);
expect(packageJson.version === '2.5.0', `IBM Plex Mono must remain exactly pinned to 2.5.0, got ${packageJson.version}.`);
expect(manifest.license === 'OFL-1.1', `Unexpected license ${manifest.license}.`);

const ibmSourceGlyphs = 'µ−≤≥→∞∑√≈≠±×÷{}[]()<>:=+-*/_#@|&%!?.,;';
for (const face of manifest.faces) {
  const authoritative = join(authoritativeRoot, face.file);
  const mirrored = join(mirrorRoot, face.file);
  expectFile(authoritative);
  expectFile(mirrored);
  if (!existsSync(authoritative) || !existsSync(mirrored)) continue;
  expect(sha256(readFileSync(authoritative)) === sha256(readFileSync(mirrored)), `${face.file} mirror hash differs.`);
  const font = fontkit.openSync(authoritative);
  expect(font.familyName.startsWith('IBM Plex Mono'), `${face.file} metadata family is ${font.familyName}.`);
  expect(face.style === 'italic' ? font.italicAngle < 0 : font.italicAngle === 0, `${face.file} italic metadata is ${font.italicAngle}.`);
  expect(font['OS/2']?.usWeightClass === face.weight, `${face.file} weight metadata is ${font['OS/2']?.usWeightClass}.`);
  const missing = [...ibmSourceGlyphs].filter((glyph) => !font.hasGlyphForCodePoint(glyph.codePointAt(0)));
  expect(missing.length === 0, `${face.file} lacks required glyphs: ${missing.join(' ')}`);
}

const supplementalPath = join(authoritativeRoot, manifest.supplementalGlyphFace.file);
const supplementalFont = fontkit.openSync(supplementalPath);
const missingGreek = [...'αβγΔμ'].filter((glyph) => !supplementalFont.hasGlyphForCodePoint(glyph.codePointAt(0)));
expect(missingGreek.length === 0, `Supplemental Greek face lacks: ${missingGreek.join(' ')}`);
expect(manifest.supplementalGlyphFace.packageVersion === '5.2.10', `Noto Sans Mono must remain exactly pinned to 5.2.10, got ${manifest.supplementalGlyphFace.packageVersion}.`);

for (const file of manifest.files) {
  for (const directory of [authoritativeRoot, mirrorRoot]) {
    const candidate = join(directory, file.name);
    expectFile(candidate);
    if (existsSync(candidate)) {
      const buffer = readFileSync(candidate);
      expect(buffer.length === file.bytes, `${candidate} size differs from manifest.`);
      expect(sha256(buffer) === file.sha256, `${candidate} hash differs from manifest.`);
    }
  }
}
expect(readFileSync(join(authoritativeRoot, 'manifest.json'), 'utf8') === readFileSync(join(mirrorRoot, 'manifest.json'), 'utf8'), 'Generated mirror manifest differs.');
expect(readFileSync(join(authoritativeRoot, 'OFL.txt'), 'utf8').includes('SIL OPEN FONT LICENSE Version 1.1'), 'OFL text is missing or invalid.');

const desktopTokens = readFileSync(join(root, 'src', 'styles', 'app.tokens.css'), 'utf8');
const extensionTokens = readFileSync(join(root, 'scie-md-vscode-extension', 'src', 'scie-md', 'styles', 'app.tokens.css'), 'utf8');
for (const [label, css, urlPrefix, assetRoot] of [
  ['desktop', desktopTokens, '/fonts/vendor/ibm-plex-mono/', join(root, 'public', 'fonts', 'vendor', 'ibm-plex-mono')],
  ['extension', extensionTokens, './fonts/vendor/ibm-plex-mono/', mirrorRoot],
]) {
  const blocks = css.match(/@font-face\s*{[\s\S]*?font-family:\s*"IBM Plex Mono";[\s\S]*?}/g) ?? [];
  expect(blocks.length === manifest.faces.length + 1, `${label} declares ${blocks.length} IBM Plex Mono composite faces.`);
  for (const face of manifest.faces) {
    expect(css.includes(`url("${urlPrefix}${face.file}")`), `${label} CSS is missing ${face.file}.`);
    expect(existsSync(join(assetRoot, face.file)), `${label} CSS URL target is missing: ${face.file}.`);
  }
  expect(css.includes(`url("${urlPrefix}${manifest.supplementalGlyphFace.file}")`), `${label} CSS is missing the supplemental Greek face.`);
  expect(css.includes('unicode-range: U+0370-03FF;'), `${label} CSS is missing the bounded Greek unicode range.`);
}

const allDesktopCss = ['app.tokens.css', 'app.source-editor.css', 'app.panels.css']
  .map((name) => readFileSync(join(root, 'src', 'styles', name), 'utf8')).join('\n');
expect((allDesktopCss.match(/--source-editor-font\s*:/g) ?? []).length === 1, 'Desktop source token must have exactly one writer.');
expect(desktopTokens.includes('--source-editor-font: "IBM Plex Mono", monospace;'), 'Desktop source token is not IBM Plex Mono.');
expect(!/data-visual-style[\s\S]{0,500}--source-editor-font\s*:/.test(desktopTokens), 'A visual-style block overrides the desktop source token.');
expect(readFileSync(join(root, 'src', 'styles', 'app.source-editor.css'), 'utf8').includes('font-family: var(--source-editor-font);'), 'Desktop CodeMirror does not consume the dedicated token.');
expect(readFileSync(join(root, 'src', 'styles', 'app.source-editor.css'), 'utf8').includes('font-weight: 300;'), 'Desktop CodeMirror does not consume the light source weight.');
expect(readFileSync(join(root, 'src', 'styles', 'app.panels.css'), 'utf8').includes('font: 300 14px/1.65 var(--source-editor-font);'), 'Desktop raw fallback does not consume the dedicated light source weight.');

const webviewStyles = readFileSync(join(root, 'scie-md-vscode-extension', 'src', 'webview', 'styles.css'), 'utf8');
expect(webviewStyles.includes('--source-editor-font: var(--vscode-editor-font-family, "IBM Plex Mono", monospace);'), 'VS Code host-font precedence or IBM fallback is missing.');
expect(webviewStyles.includes('--editor-font: var(--vscode-editor-font-family, "JetBrains Mono", monospace);'), 'Extension structured-preview font contract drifted.');

if (failures.length) {
  console.error('[fonts:verify] IBM Plex Mono verification failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`[fonts:verify] IBM Plex Mono ${manifest.packageVersion}/${manifest.upstreamFontVersion}: ${manifest.faces.length} faces, hashes, glyphs, CSS URLs, license, and generated mirror passed.`);

function expect(condition, message) { if (!condition) failures.push(message); }
function expectFile(path) { expect(existsSync(path), `Missing ${path}.`); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
