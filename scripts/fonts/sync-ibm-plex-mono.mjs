import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageRoot = join(root, 'node_modules', '@ibm', 'plex-mono');
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const supplementalPackageRoot = join(root, 'node_modules', '@fontsource', 'noto-sans-mono');
const supplementalPackageJson = JSON.parse(readFileSync(join(supplementalPackageRoot, 'package.json'), 'utf8'));
const authoritativeRoot = join(root, 'public', 'fonts', 'vendor', 'ibm-plex-mono');
const mirrorRoot = join(root, 'scie-md-vscode-extension', 'src', 'scie-md', 'styles', 'fonts', 'vendor', 'ibm-plex-mono');
const faces = [
  { weight: 300, style: 'normal', source: 'IBMPlexMono-Light.woff2', file: 'ibm-plex-mono-300-normal.woff2' },
  { weight: 300, style: 'italic', source: 'IBMPlexMono-LightItalic.woff2', file: 'ibm-plex-mono-300-italic.woff2' },
  { weight: 400, style: 'normal', source: 'IBMPlexMono-Regular.woff2', file: 'ibm-plex-mono-400-normal.woff2' },
  { weight: 400, style: 'italic', source: 'IBMPlexMono-Italic.woff2', file: 'ibm-plex-mono-400-italic.woff2' },
  { weight: 500, style: 'normal', source: 'IBMPlexMono-Medium.woff2', file: 'ibm-plex-mono-500-normal.woff2' },
  { weight: 700, style: 'normal', source: 'IBMPlexMono-Bold.woff2', file: 'ibm-plex-mono-700-normal.woff2' },
];

for (const outputRoot of [authoritativeRoot, mirrorRoot]) {
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
}

const files = [];
for (const face of faces) {
  const source = join(packageRoot, 'fonts', 'complete', 'woff2', face.source);
  const buffer = readFileSync(source);
  copyFileSync(source, join(authoritativeRoot, face.file));
  copyFileSync(source, join(mirrorRoot, face.file));
  files.push({ name: face.file, bytes: buffer.length, sha256: sha256(buffer) });
}

const license = canonicalTextAsset(readFileSync(join(packageRoot, 'LICENSE.txt'), 'utf8'));
for (const outputRoot of [authoritativeRoot, mirrorRoot]) {
  writeFileSync(join(outputRoot, 'OFL.txt'), license, 'utf8');
}
files.push({ name: 'OFL.txt', bytes: Buffer.byteLength(license), sha256: sha256(license) });

const supplementalSource = join(supplementalPackageRoot, 'files', 'noto-sans-mono-greek-400-normal.woff2');
const supplementalName = 'noto-sans-mono-greek-400-normal.woff2';
const supplementalBuffer = readFileSync(supplementalSource);
for (const outputRoot of [authoritativeRoot, mirrorRoot]) {
  copyFileSync(supplementalSource, join(outputRoot, supplementalName));
}
files.push({ name: supplementalName, bytes: supplementalBuffer.length, sha256: sha256(supplementalBuffer) });
const supplementalLicense = canonicalTextAsset(readFileSync(join(supplementalPackageRoot, 'LICENSE'), 'utf8'));
for (const outputRoot of [authoritativeRoot, mirrorRoot]) {
  writeFileSync(join(outputRoot, 'OFL-Noto-Sans-Mono.txt'), supplementalLicense, 'utf8');
}
files.push({ name: 'OFL-Noto-Sans-Mono.txt', bytes: Buffer.byteLength(supplementalLicense), sha256: sha256(supplementalLicense) });

const manifest = {
  schemaVersion: 1,
  family: 'IBM Plex Mono',
  package: packageJson.name,
  packageVersion: packageJson.version,
  upstreamFontVersion: packageJson.version,
  source: 'https://github.com/IBM/plex',
  license: packageJson.license,
  authoritativeDirectory: 'public/fonts/vendor/ibm-plex-mono',
  generatedMirror: 'scie-md-vscode-extension/src/scie-md/styles/fonts/vendor/ibm-plex-mono',
  generatedBy: 'scripts/fonts/sync-ibm-plex-mono.mjs',
  faces: faces.map(({ weight, style, file }) => ({ weight, style, file })),
  supplementalGlyphFace: {
    family: 'Noto Sans Mono',
    package: supplementalPackageJson.name,
    packageVersion: supplementalPackageJson.version,
    source: 'https://github.com/notofonts/latin-greek-cyrillic',
    license: 'OFL-1.1',
    unicodeRange: 'U+0370-03FF',
    file: supplementalName,
    purpose: 'Greek glyph coverage within the IBM Plex Mono CSS composite family',
  },
  files,
};
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(join(authoritativeRoot, 'manifest.json'), serialized);
writeFileSync(join(mirrorRoot, 'manifest.json'), serialized);

console.log(`[fonts:ibm-plex-mono] Synced ${files.length} hashed assets from ${packageJson.name}@${packageJson.version}.`);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalTextAsset(value) {
  return value.replace(/\r\n?/g, '\n');
}
