import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appCssModuleOrder } from './appCssBundle';

const productionFontFiles = [
  'src/styles/app.css',
  ...appCssModuleOrder.map((fileName) => `src/styles/${fileName}`),
  'src/styles/scientific-document.css',
  'src/styles/appCssBundle.ts',
  'src/markdown/htmlExport.ts',
  'src/app/App.tsx',
  'src/app/hooks/useSlashCommandMenu.ts',
  'src/samples/welcome.md',
  'public/assets/scie-md-workflow.svg',
];

const proprietaryFontNames = [
  'Aptos',
  'Aptos Display',
  'Segoe UI',
  'Segoe UI Symbol',
  'Georgia',
  'Times New Roman',
  'Iowan Old Style',
  'Arial',
  'Helvetica',
  'Consolas',
  'SFMono-Regular',
  'Apple Color Emoji',
  'Inter',
];

describe('production font stacks', () => {
  it('bundles and mirrors the licensed Google Sans Flex assets used by Cursor', () => {
    const root = process.cwd();
    const manifest = readFileSync(join(root, 'public/fonts/vendor/google-sans-flex/manifest.json'), 'utf8');
    const mirrorManifest = readFileSync(join(root, 'scie-md-vscode-extension/src/scie-md/styles/fonts/vendor/google-sans-flex/manifest.json'), 'utf8');
    const tokens = readFileSync(join(root, 'src/styles/app.tokens.css'), 'utf8');
    const exportSource = readFileSync(join(root, 'src/markdown/htmlExport.ts'), 'utf8');

    expect(mirrorManifest).toBe(manifest);
    expect(JSON.parse(manifest)).toMatchObject({
      family: 'Google Sans Flex',
      upstreamFontVersion: 'v21',
      license: 'OFL-1.1',
    });
    expect(readFileSync(join(root, 'public/fonts/vendor/google-sans-flex/OFL.txt'), 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(tokens).toContain('--doc-font: "Google Sans Flex", sans-serif;');
    expect(exportSource).toContain("families.add('Google Sans Flex');");
  });

  it('uses one invariant IBM Plex Mono token only on desktop source surfaces', () => {
    const root = process.cwd();
    const tokens = readFileSync(join(root, 'src/styles/app.tokens.css'), 'utf8');
    const source = readFileSync(join(root, 'src/styles/app.source-editor.css'), 'utf8');
    const panels = readFileSync(join(root, 'src/styles/app.panels.css'), 'utf8');
    const allStyleCss = productionFontFiles
      .filter((file) => file.endsWith('.css'))
      .map((file) => readFileSync(join(root, file), 'utf8'))
      .join('\n');

    expect(tokens.match(/--source-editor-font\s*:/g)).toHaveLength(1);
    expect(tokens).toContain('--source-editor-font: "IBM Plex Mono", monospace;');
    expect(source).toContain('font-family: var(--source-editor-font);');
    expect(source).toContain('font-weight: 300;');
    expect(panels).toContain('font: 300 14px/1.65 var(--source-editor-font);');
    expect(allStyleCss.match(/--source-editor-font\s*:/g)).toHaveLength(1);
    expect(tokens.match(/:root\[data-visual-style=[\s\S]*?--source-editor-font\s*:/g)).toBeNull();
  });

  it('do not reference proprietary named fonts', () => {
    const root = process.cwd();
    const failures: string[] = [];

    for (const file of productionFontFiles) {
      const contents = readFileSync(join(root, file), 'utf8');
      for (const fontName of proprietaryFontNames) {
        const escaped = fontName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const namedFontPattern = new RegExp(`(^|[^A-Za-z])${escaped}([^A-Za-z]|$)`);
        if (namedFontPattern.test(contents)) {
          failures.push(`${file}: ${fontName}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
