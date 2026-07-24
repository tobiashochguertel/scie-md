import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appCssModuleOrder } from './appCssBundle';

const appIndexCss = readFileSync(join(process.cwd(), 'src/styles/app.css'), 'utf8');
const appCss = appCssModuleOrder
  .map((fileName) => readFileSync(join(process.cwd(), 'src/styles', fileName), 'utf8'))
  .join('\n');
const scientificDocumentCss = readFileSync(join(process.cwd(), 'src/styles/scientific-document.css'), 'utf8');
const styleFiles = [appCss, scientificDocumentCss];
const combinedCss = styleFiles.join('\n');

describe('style CSS variables', () => {
  it('keeps app.css as the explicit ownership index for runtime imports', () => {
    const imports = appIndexCss
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith("@import './"))
      .map((line) => line.slice("@import './".length, -2));

    expect(imports).toEqual([...appCssModuleOrder]);
    expect(appIndexCss).toContain('ScieMD app style index');
    expect(appIndexCss).toContain('appCssBundle.ts');
  });

  it('defines every CSS custom property referenced by app styles', () => {
    const definitions = new Set<string>();
    const usages = new Set<string>();

    for (const css of styleFiles) {
      for (const match of css.matchAll(/--([A-Za-z0-9_-]+)\s*:/g)) {
        definitions.add(match[1]);
      }
      for (const match of css.matchAll(/var\(--([A-Za-z0-9_-]+)(?:,[^)]+)?\)/g)) {
        usages.add(match[1]);
      }
    }

    const missing = [...usages].filter((name) => !definitions.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it('does not clip topbar dropdown menus or window controls', () => {
    expect(appCss).toMatch(/\.topbar\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*max-content\)\s+minmax\(72px,\s*1fr\)\s+max-content;/);
    expect(appCss).toMatch(/\.topbar-left\s*{[^}]*overflow:\s*visible;/);
    expect(appCss).toMatch(/\.topbar-right\s*{[^}]*min-width:\s*max-content;/);
    expect(appCss).toMatch(/\.window-controls\s*{[^}]*min-width:\s*calc\(\(var\(--control-height\)\s*\*\s*3\)\s*\+\s*6px\);/);
    expect(appCss).toContain('.app-menu-button');
    expect(appCss).toMatch(/@media \(max-width:\s*1500px\)\s*{[\s\S]*\.app-menu-button\.is-secondary-menu\s*{[\s\S]*display:\s*none;/);
    expect(appCss).toContain('.quick-toolbar > button');
    expect(appCss).not.toMatch(/@media \(max-width:\s*1400px\)\s*{\s*\.topbar-left button\s*{/);
    expect(appCss).not.toMatch(/@media \(max-width:\s*900px\)\s*{[\s\S]*\.app-menubar\s*{[\s\S]*display:\s*none;/);
  });

  it('keeps the selected editor mode legible while hovered or pressed', () => {
    expect(appCss).toMatch(/\.editor-mode-toggle button\.selected:hover:not\(:disabled\),\s*\.editor-mode-toggle button\.selected:active:not\(:disabled\)\s*{[\s\S]*background:\s*transparent;[\s\S]*color:\s*var\(--surface\);[\s\S]*transform:\s*none;/);
  });

  it('keeps visual caret and hover block highlights faint and independent', () => {
    expect(appCss).toMatch(/\.visual-editor \.ProseMirror \.visual-active-block::after\s*{[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--accent\),\s*transparent 93%\);/);
    expect(appCss).toMatch(/\.visual-editor \.ProseMirror :is\(p, h1, h2, h3, h4, h5, h6, pre\):hover::after\s*{[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--source-syntax-link\),\s*transparent 96%\);/);
  });

  it('keeps structured surface tabs visibly selected without the moving mode pill', () => {
    expect(appCss).toMatch(/\.structured-surface-toggle button\.selected\s*{[\s\S]*border-color:\s*color-mix\(in srgb,\s*var\(--accent\),\s*var\(--border\)\s*22%\);[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--accent\),\s*transparent\s*88%\);[\s\S]*color:\s*var\(--accent\);[\s\S]*font-weight:\s*750;/);
    expect(appCss).toMatch(/\.structured-surface-toggle button\.selected:hover:not\(:disabled\),\s*\.structured-surface-toggle button\.selected:active:not\(:disabled\)\s*{[\s\S]*border-color:\s*var\(--accent\);[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--accent\),\s*transparent\s*84%\);[\s\S]*color:\s*var\(--accent\);[\s\S]*transform:\s*none;/);
  });

  it('keeps app tooltips legible at viewport edges', () => {
    expect(appCss).toMatch(/\.app-tooltip\s*{[\s\S]*width:\s*max-content;[\s\S]*max-width:\s*min\(320px,\s*calc\(100vw - 16px\)\);/);
    expect(appCss).toMatch(/\.app-tooltip\s*{[\s\S]*overflow-wrap:\s*break-word;[\s\S]*word-break:\s*normal;/);
  });

  it('keeps review dialog actions fixed while the change list scrolls', () => {
    expect(appCss).toMatch(/\.review-dialog\s*{[\s\S]*grid-template-areas:\s*"header"\s*"notice"\s*"body"\s*"actions";/);
    expect(appCss).toMatch(/\.review-card-list\s*{[\s\S]*grid-area:\s*body;[\s\S]*overflow:\s*auto;[\s\S]*scrollbar-gutter:\s*stable;/);
    expect(appCss).toMatch(/\.review-dialog-actions\s*{[\s\S]*grid-area:\s*actions;[\s\S]*position:\s*sticky;[\s\S]*bottom:\s*0;/);
  });

  it('keeps the Scienfy dotted reading surface subtle, scoped, and motion-safe', () => {
    expect(scientificDocumentCss).toContain(':root[data-visual-style="scienfy"] .visual-editor [data-milkdown-root]');
    expect(scientificDocumentCss).toContain('radial-gradient(circle at 1px 1px, var(--scienfy-reading-page-dot');
    expect(scientificDocumentCss).toMatch(/:root\[data-visual-style="scienfy"\]\s+\.visual-editor \.milkdown\s*{[\s\S]*background:\s*transparent;[\s\S]*box-shadow:\s*none;/);
    expect(scientificDocumentCss).not.toContain('--scienfy-reading-frame-color');
    expect(appCss).toMatch(/:root\[data-visual-style="scienfy"\]\s+\.editor-stage:hover,[\s\S]*--scienfy-reading-page-dot:\s*var\(--scienfy-reading-dot-focus-color\);/);
    expect(combinedCss).toMatch(/@media print[\s\S]*\.editor-stage::before\s*{[\s\S]*display:\s*none !important;/);
    expect(combinedCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition:\s*none(?:\s*!important)?;/);
  });

  it('scopes the sampled layered dark UI palette to Scienfy', () => {
    expect(appCss).toMatch(/:root\[data-theme="dark"\]\[data-visual-style="scienfy"\]\s*{[\s\S]*--bg:\s*#0d1117;[\s\S]*--editor-bg:\s*#0d1117;[\s\S]*--surface:\s*#1c2125;[\s\S]*--surface-soft:\s*#21252b;[\s\S]*--surface-subtle:\s*#101419;[\s\S]*--surface-muted:\s*#171a20;[\s\S]*--border:\s*#292d32;[\s\S]*--border-strong:\s*#373c40;[\s\S]*--button-bg:\s*#171a20;[\s\S]*--button-hover:\s*#21252b;[\s\S]*--text:\s*#c8d0d9;[\s\S]*--text-strong:\s*#e6edf3;[\s\S]*--text-muted:\s*#83898f;[\s\S]*--text-secondary:\s*#a2a7ad;[\s\S]*--focus-ring:\s*#a2a7ad;/);
    expect(appCss).toMatch(/:root\[data-theme="dark"\]:is\(\[data-visual-style="scie-sans"\], \[data-visual-style="scie-sans-compact"\], \[data-visual-style="scienfy"\]\)\s*{[^}]*--bg:\s*#16191a;/);
  });

  it('keeps Scienfy semantic blocks color-led, unfilled, and regular-weight', () => {
    expect(appCss).toMatch(/:root\[data-visual-style="scienfy"\]\s+\.directive-card\.is-rendered:not\(\.directive-figure\),[\s\S]*--directive-pad-x:\s*1\.1em;[\s\S]*--directive-text:\s*var\(--directive-tint\);[\s\S]*--directive-label:\s*var\(--directive-tint\);[\s\S]*--directive-bg:\s*transparent;[\s\S]*--directive-label-weight:\s*700;[\s\S]*--directive-separator-color:\s*var\(--directive-text\);[\s\S]*--directive-separator-strong-width:\s*7rem;[\s\S]*border:\s*0;[\s\S]*background:\s*transparent;/);
    expect(appCss).toMatch(/:root\[data-visual-style="scienfy"\]\s+\.directive-card\.is-rendered:not\(\.directive-figure\) \.directive-render-body::before\s*{[\s\S]*margin-bottom:\s*0\.38em;[\s\S]*border:\s*0;[\s\S]*padding-bottom:\s*0\.3em;[\s\S]*var\(--directive-separator-strong-width\) 3px no-repeat,[\s\S]*100% 1px no-repeat;/);
    expect(appCss).toMatch(/:root\[data-visual-style="scienfy"\]\s+\.scie-md-visual-atom-content > \.directive-card\.is-rendered:not\(\.directive-figure\) header\s*{[\s\S]*margin-bottom:\s*0\.38em;[\s\S]*border:\s*0;[\s\S]*padding-bottom:\s*0\.3em;[\s\S]*var\(--directive-separator-strong-width\) 3px no-repeat,[\s\S]*100% 1px no-repeat;/);
    expect(appCss).toMatch(/:root\[data-visual-style="scienfy"\]\s+\.directive-card\.is-rendered:not\(\.directive-figure\) \.directive-render-body,[\s\S]*\.directive-card-body-rendered\s*{[\s\S]*font-weight:\s*400;/);
    expect(appCss).toMatch(/:root\[data-theme="dark"\]\[data-visual-style="scienfy"\][\s\S]*--directive-text:\s*var\(--directive-tint\);[\s\S]*--directive-bg:\s*transparent;[\s\S]*border:\s*0;[\s\S]*background:\s*transparent;/);
    expect(appCss).toMatch(/:root\[data-theme="dark"\]\[data-visual-style="scienfy"\]\s+\.directive-card\.is-rendered\.directive-tip,[\s\S]*--directive-tint:\s*#67c99a;/);
    expect(appCss).toMatch(/:root\[data-theme="dark"\]\[data-visual-style="scienfy"\]\s+\.directive-card\.is-rendered\.directive-callout,[\s\S]*--directive-tint:\s*#72afe8;/);
    expect(appCss).toMatch(/:root\[data-visual-style="scienfy"\]\s+\.directive-card\.is-rendered\.directive-result,[\s\S]*--directive-tint:\s*#c44a00;/);
    expect(appCss).toMatch(/:root\[data-visual-style="scienfy"\]\s+\.directive-card\.is-rendered\.directive-warning,[\s\S]*--directive-tint:\s*#c44a00;/);
    expect(appCss).toMatch(/:root\[data-visual-style="scienfy"\]\s+\.directive-card\.is-rendered\.directive-important,[\s\S]*--directive-tint:\s*#b82024;/);
    expect(appCss).toMatch(/:root\[data-theme="dark"\]\[data-visual-style="scienfy"\]\s+\.directive-card\.is-rendered\.directive-result,[\s\S]*--directive-tint:\s*#f1b467;/);
    expect(appCss).toMatch(/:root\[data-theme="dark"\]\[data-visual-style="scienfy"\]\s+\.directive-card\.is-rendered\.directive-warning,[\s\S]*--directive-tint:\s*#f1b467;/);
    expect(appCss).toMatch(/:root\[data-theme="dark"\]\[data-visual-style="scienfy"\]\s+\.directive-card\.is-rendered\.directive-important,[\s\S]*--directive-tint:\s*#e05256;/);
    expect(appCss).toMatch(/:root\[data-visual-style="scienfy"\]\s+\.visual-editor \.ProseMirror > \.scie-md-directive-atom\s*{[\s\S]*margin-top:[\s\S]*1\.08\);[\s\S]*margin-bottom:[\s\S]*0\.72\);/);
    expect(appCss).toMatch(/:root\[data-visual-style="scienfy"\]\s+\.visual-editor \.ProseMirror > \.scie-md-directive-atom \.directive-card\.is-rendered:not\(\.directive-figure\)\s*{[\s\S]*padding-top:\s*0\.62em;[\s\S]*padding-bottom:\s*0\.26em;/);
  });

  it('keeps Scienfy document headings in a clear manuscript hierarchy', () => {
    expect(appCss).toMatch(/:root\[data-visual-style="scienfy"\]\s*{[\s\S]*--ui-font:\s*"Scie Sans Text", sans-serif;[\s\S]*--doc-font:\s*"Scie Sans Text", sans-serif;[\s\S]*--mono-font:\s*"Scie Sans Text", sans-serif;[\s\S]*--editor-line-height:\s*1\.52;[\s\S]*--visual-heading-weight:\s*730;/);
    expect(scientificDocumentCss).toMatch(/:root\[data-visual-style="scienfy"\][\s\S]*font-family:\s*"Scie Sans Text Compact", "Scie Sans Text", sans-serif;/);
    expect(scientificDocumentCss).toMatch(/:root\[data-visual-style="scienfy"\]\s+\.visual-editor \.ProseMirror h1\s*{[\s\S]*font-weight:\s*760;[\s\S]*line-height:\s*1\.08;/);
    expect(scientificDocumentCss).toMatch(/:root\[data-visual-style="scienfy"\]\s+\.visual-editor \.ProseMirror h2\s*{[\s\S]*font-weight:\s*720;[\s\S]*line-height:\s*1\.14;/);
    expect(scientificDocumentCss).toMatch(/:root\[data-visual-style="scienfy"\]\s+\.visual-editor \.ProseMirror h3\s*{[\s\S]*font-weight:\s*660;[\s\S]*line-height:\s*1\.18;/);
    expect(scientificDocumentCss).toMatch(/:root\[data-visual-style="scienfy"\]\s+\.visual-editor \.ProseMirror h4,[\s\S]*font-weight:\s*640;/);
  });

  it('keeps Cursor semantic blocks faint, borderless, and high-contrast', () => {
    expect(appCss).toMatch(/:root\[data-visual-style="cursor"\]\s+\.directive-card\.is-rendered:not\(\.directive-figure\)\s*{[\s\S]*--directive-rail-width:\s*0;[\s\S]*--directive-bg:\s*color-mix\(in srgb,\s*var\(--directive-accent\),\s*transparent 95%\);[\s\S]*--directive-label:\s*var\(--directive-accent\);[\s\S]*--directive-text:\s*color-mix\(in srgb,\s*var\(--directive-accent\) 42%,\s*var\(--text-strong\)\);[\s\S]*--directive-body-size:\s*0\.91em;[\s\S]*border:\s*0;[\s\S]*background:\s*var\(--directive-bg\);/);
    expect(appCss).toMatch(/:root\[data-visual-style="cursor"\]\s+\.directive-card\.is-rendered:not\(\.directive-figure\) \.directive-render-body\s*{[\s\S]*font-weight:\s*400;/);
    expect(appCss).toMatch(/:root\[data-visual-style="cursor"\]\s+\.scie-md-visual-atom-content\s*>\s*\.directive-card\.is-rendered:not\(\.directive-figure\)\s*{[\s\S]*--directive-rail-width:\s*0;[\s\S]*--directive-bg:\s*color-mix\(in srgb,\s*var\(--directive-accent\),\s*transparent 95%\);[\s\S]*--directive-text:\s*color-mix\(in srgb,\s*var\(--directive-accent\) 42%,\s*var\(--text-strong\)\);[\s\S]*--directive-body-size:\s*0\.91em;[\s\S]*border:\s*0;[\s\S]*background:\s*var\(--directive-bg\);/);
    expect(appCss).toMatch(/:root\[data-visual-style="cursor"\]\s+\.scie-md-visual-atom-content\s*>\s*\.directive-card\.is-rendered:not\(\.directive-figure\) \.directive-card-body-rendered\s*{[\s\S]*font-weight:\s*400;/);
    expect(scientificDocumentCss).toMatch(/:root\[data-visual-style="cursor"\]\s+\.visual-editor \.ProseMirror h1:not\(:first-child\)\s*{[\s\S]*margin-top:[\s\S]*1\.18\);/);
    expect(scientificDocumentCss).toMatch(/:root\[data-visual-style="cursor"\]\s+\.visual-editor \.ProseMirror h2\s*{[\s\S]*margin-top:[\s\S]*1\.18\);/);
    expect(scientificDocumentCss).toMatch(/:root\[data-visual-style="cursor"\]\s+\.visual-editor \.ProseMirror h3\s*{[\s\S]*margin-top:[\s\S]*1\.2\);/);
    expect(scientificDocumentCss).toMatch(/:root\[data-visual-style="cursor"\]\s+\.visual-editor \.ProseMirror h4,[\s\S]*margin:[\s\S]*1\.04\)/);
  });

  it('keeps muted text colors at WCAG AA contrast against their theme backgrounds', () => {
    const pairs = [
      ['#55645f', '#eef2f0'],
      ['#9cafaa', '#121715'],
      ['#726552', '#f1eadc'],
      ['#aaa59b', '#121715'],
      ['#57606a', '#ffffff'],
      ['#52596b', '#ffffff'],
      ['#c2aa82', '#1a1a19'],
      ['#56666e', '#ffffff'],
      ['#a8bbc2', '#111719'],
      ['#5f5f5f', '#f7f6f4'],
      ['#b7b7b7', '#111111'],
      ['#575757', '#f7f7f5'],
      ['#b8b8b8', '#111111'],
    ] as const;

    for (const [foreground, background] of pairs) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps table and Mermaid label palettes legible in every theme family', () => {
    const pairs = [
      ['#1f2933', '#ffffff'],
      ['#12251f', '#eef2f0'],
      ['#eef7f3', '#151b19'],
      ['#ffffff', '#202a27'],
      ['#3a3024', '#fffaf1'],
      ['#251e16', '#f2e6d0'],
      ['#e3dfd6', '#1f160d'],
      ['#f4efe5', '#342515'],
      ['#f0f6fc', '#0d1117'],
      ['#ffffff', '#21262d'],
      ['#c8d0d9', '#0d1117'],
      ['#e6edf3', '#21252b'],
      ['#f2f2f2', '#151515'],
      ['#ffffff', '#252525'],
      ['#f1f1f1', '#151515'],
      ['#f0eee6', '#262624'],
      ['#ffffff', '#30302e'],
      ['#172033', '#e9efff'],
      ['#f2f6ff', '#273247'],
      ['#2e251a', '#f1e7d4'],
    ] as const;

    for (const [foreground, background] of pairs) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }

    expect(appCss).toContain('--diagram-node-text: #172033');
    expect(appCss).toContain('--diagram-node-text: #f2f6ff');
    expect(appCss).toContain('--diagram-node-text: #2e251a');
    expect(scientificDocumentCss).toContain('.visual-editor .ProseMirror th :where(p, li, strong, em)');
  });

  it('overrides fixed Milkdown typography so document-wide font scaling reaches body content', () => {
    expect(scientificDocumentCss).toMatch(/\.visual-editor \.ProseMirror p\s*{\s*font-size:\s*inherit;/);
    expect(scientificDocumentCss).toMatch(/\.visual-editor \.ProseMirror h5\s*{\s*font-size:\s*0\.95em;/);
    expect(scientificDocumentCss).toMatch(/\.visual-editor \.ProseMirror h6\s*{\s*font-size:\s*0\.9em;/);
    expect(scientificDocumentCss).toMatch(/\.visual-editor \.ProseMirror pre\s*{[\s\S]*font-size:\s*calc\(var\(--document-body-size\) \* var\(--font-scale\) \* 0\.9\);/);
    expect(scientificDocumentCss).toMatch(/\.visual-editor \.ProseMirror pre code\s*{[\s\S]*font-size:\s*inherit;/);
  });
});

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: string): number {
  const [red, green, blue] = color.match(/[a-f0-9]{2}/gi)!.map((value) => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
