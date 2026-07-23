import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
const licenseSource = join(root, 'scripts', 'fonts', 'google-sans-flex-OFL.txt');
const assets = [
  {
    file: 'google-sans-flex-latin-opsz-slnt-wght-normal.woff2',
    url: 'https://fonts.gstatic.com/s/googlesansflex/v21/t5tQIQcYNIWbFgDgAAzZ34auoVyXkJCOvp3SFWJbN5hF8Ju1x6sKCyp0l9sI40swNJwakXdYAZzz0jbnDYatsQ.woff2',
    sha256: 'a6a58c0a064728c5edb82657c43be716b97b49a22d46677dca3edb150c4af57a',
    unicodeRange: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  },
  {
    file: 'google-sans-flex-latin-ext-opsz-slnt-wght-normal.woff2',
    url: 'https://fonts.gstatic.com/s/googlesansflex/v21/t5tQIQcYNIWbFgDgAAzZ34auoVyXkJCOvp3SFWJbN5hF8Ju1x6sKCyp0l9sI40swNJwakXdYAZzz0jbnDYitsQbx.woff2',
    sha256: 'f9b64321fbb7051843d0199d9915d423d4cef936a60384f151788f801d5da13c',
    unicodeRange: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
  },
];

for (const outputRoot of [authoritativeRoot, mirrorRoot]) {
  mkdirSync(outputRoot, { recursive: true });
}

const files = [];
for (const asset of assets) {
  const response = await fetch(asset.url);
  if (!response.ok) {
    throw new Error(`Could not download ${asset.file}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const actualHash = sha256(buffer);
  if (actualHash !== asset.sha256) {
    throw new Error(`${asset.file} hash mismatch: expected ${asset.sha256}, got ${actualHash}`);
  }
  for (const outputRoot of [authoritativeRoot, mirrorRoot]) {
    writeFileSync(join(outputRoot, asset.file), buffer);
  }
  files.push({ name: asset.file, bytes: buffer.length, sha256: actualHash });
}

const license = readFileSync(licenseSource);
for (const outputRoot of [authoritativeRoot, mirrorRoot]) {
  writeFileSync(join(outputRoot, 'OFL.txt'), license);
}
files.push({ name: 'OFL.txt', bytes: license.length, sha256: sha256(license) });

const manifest = {
  schemaVersion: 1,
  family: 'Google Sans Flex',
  upstreamFontVersion: 'v21',
  upstreamLastModified: '2026-05-21',
  source: 'https://fonts.google.com/specimen/Google+Sans+Flex',
  cssApiQuery: 'https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,slnt,wght@6..144,-10..0,100..1000&display=swap',
  license: 'OFL-1.1',
  copyright: 'Copyright 2015 Google LLC. All Rights Reserved.',
  axes: {
    opsz: { min: 6, default: 18, max: 144 },
    slnt: { min: -10, default: 0, max: 0 },
    wght: { min: 1, default: 400, max: 1000 },
  },
  authoritativeDirectory: 'public/fonts/vendor/google-sans-flex',
  generatedMirror: 'scie-md-vscode-extension/src/scie-md/styles/fonts/vendor/google-sans-flex',
  generatedBy: 'scripts/fonts/sync-google-sans-flex.mjs',
  faces: assets.map(({ file, unicodeRange }) => ({
    file,
    style: 'oblique 0deg 10deg',
    weight: '100 1000',
    unicodeRange,
  })),
  files,
};
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(join(authoritativeRoot, 'manifest.json'), serialized);
writeFileSync(join(mirrorRoot, 'manifest.json'), serialized);

console.log(`[fonts:google-sans-flex] Synced ${files.length} hashed assets from Google Fonts ${manifest.upstreamFontVersion}.`);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
