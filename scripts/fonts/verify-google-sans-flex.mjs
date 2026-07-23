import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const authoritativeRoot = join(root, 'public', 'fonts', 'vendor', 'google-sans-flex');
const mirrorRoot = join(
  root,
  'scie-md-vscode-extension',
  'src',
  'scie-md',
  'styles',
  'fonts',
  'vendor',
  'google-sans-flex',
);
const manifestPath = join(authoritativeRoot, 'manifest.json');
expect(existsSync(manifestPath), `Missing ${manifestPath}`);
const manifestText = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestText);

expect(manifest.family === 'Google Sans Flex', 'Unexpected font family in manifest.');
expect(manifest.license === 'OFL-1.1', 'Google Sans Flex must remain OFL-1.1.');
expect(manifest.axes?.opsz?.min === 6 && manifest.axes?.wght?.max === 1000, 'Variable-axis contract drifted.');
expect(readFileSync(join(mirrorRoot, 'manifest.json'), 'utf8') === manifestText, 'Extension manifest is not an exact projection.');

for (const file of manifest.files) {
  const authoritativePath = join(authoritativeRoot, file.name);
  const mirrorPath = join(mirrorRoot, file.name);
  expect(existsSync(authoritativePath), `Missing authoritative asset ${file.name}.`);
  expect(existsSync(mirrorPath), `Missing extension asset ${file.name}.`);
  const authoritative = readFileSync(authoritativePath);
  const mirror = readFileSync(mirrorPath);
  expect(authoritative.length === file.bytes, `${file.name} byte count drifted.`);
  expect(sha256(authoritative) === file.sha256, `${file.name} authoritative hash drifted.`);
  expect(sha256(mirror) === file.sha256, `${file.name} mirror hash drifted.`);
}

const desktopTokens = readFileSync(join(root, 'src', 'styles', 'app.tokens.css'), 'utf8');
const extensionTokens = readFileSync(
  join(root, 'scie-md-vscode-extension', 'src', 'scie-md', 'styles', 'app.tokens.css'),
  'utf8',
);
const desktopStyles = readFileSync(join(root, 'src', 'styles', 'scientific-document.css'), 'utf8');
const desktopExport = readFileSync(join(root, 'src', 'markdown', 'htmlExport.ts'), 'utf8');
const visualStyles = readFileSync(join(root, 'src', 'services', 'visualStyleService.ts'), 'utf8');

for (const css of [desktopTokens, extensionTokens]) {
  expect(css.includes('font-family: "Google Sans Flex";'), 'Missing Google Sans Flex font-face.');
  expect(css.includes(':root[data-visual-style="cursor"]'), 'Missing Cursor token block.');
  expect(css.includes('--doc-font: "Google Sans Flex", sans-serif;'), 'Cursor does not select Google Sans Flex.');
}
expect(desktopStyles.includes('font-family: "Google Sans Flex", sans-serif;'), 'Cursor document typography is not active.');
expect(desktopExport.includes("case 'cursor':") && desktopExport.includes("families.add('Google Sans Flex');"), 'HTML export does not embed Cursor font assets.');
expect(!/id:\s*'(scientific-draft|journal-manuscript|technical-code)'/.test(visualStyles), 'A retired style remains selectable.');
for (const retired of ['scientific-draft', 'journal-manuscript', 'technical-code']) {
  expect(visualStyles.includes(`'${retired}': 'cursor'`), `Missing ${retired} compatibility migration.`);
}

console.log(`[fonts:verify-google-sans-flex] Verified ${manifest.files.length} hashed assets, both production bundles, Cursor adoption, export embedding, and retired-style migrations.`);

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
