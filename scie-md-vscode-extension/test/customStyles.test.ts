import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCustomStylePayload, resolveStylesDirectory, sanitizeCssBlock } from '../src/extension/customStyles';

let configuredDirectory = '';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback: string) => configuredDirectory || fallback,
    }),
    workspaceFolders: [{ uri: { fsPath: '/workspace/project' } }],
  },
}));

const tempDirs: string[] = [];

async function makeStylesDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sciemd-styles-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  configuredDirectory = '';
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolveStylesDirectory', () => {
  it('keeps absolute paths', () => {
    expect(resolveStylesDirectory('/tmp/styles')).toBe('/tmp/styles');
  });

  it('expands ~ to the home directory', () => {
    expect(resolveStylesDirectory('~/scie-styles')).toBe(path.join(process.env.HOME ?? '', 'scie-styles'));
  });

  it('resolves relative paths against the first workspace folder', () => {
    expect(resolveStylesDirectory('styles')).toBe('/workspace/project/styles');
  });
});

describe('sanitizeCssBlock', () => {
  it('escapes </style so the payload cannot break out of its element', () => {
    expect(sanitizeCssBlock('a { color: red; }</style><script>x</script>')).not.toContain('</style');
  });

  it('leaves ordinary CSS untouched', () => {
    const css = '.table { color: #111; }';
    expect(sanitizeCssBlock(css)).toBe(css);
  });
});

describe('loadCustomStylePayload', () => {
  it('returns an empty payload when no directory is configured', async () => {
    const payload = await loadCustomStylePayload();
    expect(payload.cssBlocks).toEqual([]);
    expect(payload.visualStyles).toEqual([]);
    expect(payload.diagnostics).toEqual([]);
  });

  it('reports a diagnostic for a missing directory', async () => {
    configuredDirectory = '/definitely/not/here';
    const payload = await loadCustomStylePayload();
    expect(payload.diagnostics[0]).toContain('not readable');
  });

  it('loads *.css files in sorted order', async () => {
    const dir = await makeStylesDir();
    await writeFile(path.join(dir, 'b.css'), '.b { color: red; }');
    await writeFile(path.join(dir, 'a.css'), '.a { color: blue; }');
    configuredDirectory = dir;
    const payload = await loadCustomStylePayload();
    expect(payload.cssBlocks).toEqual(['.a { color: blue; }', '.b { color: red; }']);
  });

  it('parses valid *.style.json definitions', async () => {
    const dir = await makeStylesDir();
    await writeFile(
      path.join(dir, 'acme.style.json'),
      JSON.stringify({
        id: 'acme',
        label: 'Acme',
        detail: 'Company style.',
        variables: { '--document-body-size': '16px' },
        dark: { '--bg': '#151515' },
      }),
    );
    configuredDirectory = dir;
    const payload = await loadCustomStylePayload();
    expect(payload.diagnostics).toEqual([]);
    expect(payload.visualStyles).toEqual([
      {
        id: 'acme',
        label: 'Acme',
        shortLabel: 'Acme',
        detail: 'Company style.',
        variables: { '--document-body-size': '16px' },
        light: {},
        dark: { '--bg': '#151515' },
        sepia: {},
      },
    ]);
  });

  it('reports diagnostics for invalid JSON and invalid ids', async () => {
    const dir = await makeStylesDir();
    await writeFile(path.join(dir, 'broken.style.json'), '{ not json');
    await writeFile(path.join(dir, 'badid.style.json'), JSON.stringify({ id: 'Bad ID!', label: 'X' }));
    await writeFile(path.join(dir, 'nolabel.style.json'), JSON.stringify({ id: 'ok' }));
    configuredDirectory = dir;
    const payload = await loadCustomStylePayload();
    expect(payload.visualStyles).toEqual([]);
    expect(payload.diagnostics).toHaveLength(3);
    expect(payload.diagnostics.join(' ')).toContain('not valid JSON');
    expect(payload.diagnostics.join(' ')).toContain('"id"');
    expect(payload.diagnostics.join(' ')).toContain('"label"');
  });

  it('drops non-custom-property keys and unsafe values', async () => {
    const dir = await makeStylesDir();
    await writeFile(
      path.join(dir, 'sneaky.style.json'),
      JSON.stringify({
        id: 'sneaky',
        label: 'Sneaky',
        variables: {
          color: 'red',
          '--ok': '#123456',
          '--bad': '</style><img>',
          '--num': 12,
        },
      }),
    );
    configuredDirectory = dir;
    const payload = await loadCustomStylePayload();
    expect(payload.visualStyles[0]?.variables).toEqual({ '--ok': '#123456', '--num': '12' });
  });
});
