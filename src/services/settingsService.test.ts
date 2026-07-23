import { beforeEach, describe, expect, it } from 'vitest';
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  forgetRecentFile,
  loadSettings,
  rememberRecentFile,
  stepFontScale,
  updateSettings,
} from './settingsService';

describe('settingsService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('remembers at most fifteen recent files in most-recent-first order', () => {
    for (let index = 0; index < 17; index += 1) {
      rememberRecentFile(`/tmp/${index}.md`);
    }

    expect(loadSettings().recentFiles).toEqual([
      '/tmp/16.md',
      '/tmp/15.md',
      '/tmp/14.md',
      '/tmp/13.md',
      '/tmp/12.md',
      '/tmp/11.md',
      '/tmp/10.md',
      '/tmp/9.md',
      '/tmp/8.md',
      '/tmp/7.md',
      '/tmp/6.md',
      '/tmp/5.md',
      '/tmp/4.md',
      '/tmp/3.md',
      '/tmp/2.md',
    ]);
  });

  it('starts first-run users in Science dark-mode defaults', () => {
    expect(loadSettings()).toMatchObject({
      themeMode: 'dark',
      visualStyle: 'science',
      sidebarView: 'outline',
      sidebarWidth: 360,
      documentType: 'report',
      onboardingComplete: false,
      inkscapePath: null,
    });
  });

  it('migrates the old Scienfy default to Science once', () => {
    localStorage.setItem('scienfy.markdown.settings.v1', JSON.stringify({
      recentFiles: [],
      themeMode: 'dark',
      fontScale: 1,
      visualStyle: 'scienfy',
      sidebarView: 'outline',
      documentType: 'report',
    }));

    expect(loadSettings().visualStyle).toBe('science');
    expect(JSON.parse(localStorage.getItem('scienfy.markdown.settings.v1') ?? '{}').visualStyle).toBe('science');
  });

  it('preserves Scienfy after the user explicitly selects it post-migration', () => {
    updateSettings({ visualStyle: 'scienfy' });

    expect(loadSettings().visualStyle).toBe('scienfy');
  });

  it('forgets missing recent files', () => {
    rememberRecentFile('/tmp/a.md');
    rememberRecentFile('/tmp/b.md');
    forgetRecentFile('/tmp/a.md');

    expect(loadSettings().recentFiles).toEqual(['/tmp/b.md']);
  });

  it('converges Windows aliases through the canonical comparison authority', () => {
    rememberRecentFile('C:\\Lab\\Paper.md');
    rememberRecentFile('\\\\?\\C:\\lab\\paper.md');

    expect(loadSettings().recentFiles).toEqual(['\\\\?\\C:\\lab\\paper.md']);
    forgetRecentFile('c:/LAB/PAPER.md');
    expect(loadSettings().recentFiles).toEqual([]);
  });

  it('deduplicates persisted recent aliases without changing the stored schema', () => {
    localStorage.setItem('scienfy.markdown.settings.v1', JSON.stringify({
      recentFiles: ['C:\\Lab\\Paper.md', 'c:/lab/paper.md'],
    }));

    expect(loadSettings().recentFiles).toEqual(['C:\\Lab\\Paper.md']);
  });

  it('migrates a retired persisted visual style to Cursor', () => {
    localStorage.setItem('scienfy.markdown.settings.v1', JSON.stringify({
      visualStyle: 'technical-code',
    }));

    expect(loadSettings().visualStyle).toBe('cursor');
  });

  it('persists display settings without losing recent files', () => {
    rememberRecentFile('/tmp/a.md');
    updateSettings({
      themeMode: 'sepia',
      fontScale: 1.2,
      visualStyle: 'cursor',
      outlineOpen: false,
      sidebarWidth: 420,
      sidebarView: 'files',
      explorerRootPath: '/tmp',
      inspectorOpen: false,
      authorshipVisible: false,
      focusMode: true,
      documentType: 'report',
      onboardingComplete: true,
      inkscapePath: 'C:\\Program Files\\Inkscape\\bin\\inkscape.exe',
    });

    expect(loadSettings()).toMatchObject({
      recentFiles: ['/tmp/a.md'],
      themeMode: 'sepia',
      fontScale: 1.2,
      visualStyle: 'cursor',
      outlineOpen: false,
      sidebarWidth: 420,
      sidebarView: 'files',
      explorerRootPath: '/tmp',
      inspectorOpen: false,
      authorshipVisible: false,
      focusMode: true,
      documentType: 'report',
      onboardingComplete: true,
      inkscapePath: 'C:\\Program Files\\Inkscape\\bin\\inkscape.exe',
    });
  });

  it('preserves an explicitly saved Science style selection', () => {
    localStorage.setItem('scienfy.markdown.settings.v1', JSON.stringify({
      recentFiles: ['/tmp/a.md'],
      themeMode: 'dark',
      fontScale: 1,
      visualStyle: 'science',
      sidebarView: 'files',
      documentType: 'report',
    }));

    expect(loadSettings()).toMatchObject({
      recentFiles: ['/tmp/a.md'],
      visualStyle: 'science',
    });
  });

  it('persists the data sidebar view', () => {
    updateSettings({ sidebarView: 'data' });

    expect(loadSettings().sidebarView).toBe('data');
  });

  it('normalizes invalid persisted display settings', () => {
    localStorage.setItem('scienfy.markdown.settings.v1', JSON.stringify({
      themeMode: 'neon',
      fontScale: 100,
      visualStyle: 'poster',
      sidebarWidth: 9999,
      sidebarView: 'tree',
      explorerRootPath: 42,
      inkscapePath: '',
      documentType: 'book',
      recentFiles: [],
    }));

    expect(loadSettings()).toMatchObject({
      themeMode: 'dark',
      fontScale: 2,
      visualStyle: 'science',
      sidebarWidth: 560,
      sidebarView: 'outline',
      explorerRootPath: null,
      inkscapePath: null,
      documentType: 'report',
    });
  });

  it('steps across the widened font range and clamps at its bounds', () => {
    expect(FONT_SCALE_MIN).toBe(0.3);
    expect(FONT_SCALE_MAX).toBe(2);
    expect(stepFontScale(1, 0.05)).toBe(1.05);
    expect(stepFontScale(1, -0.05)).toBe(0.95);
    expect(stepFontScale(0.35, -0.05)).toBe(0.3);
    expect(stepFontScale(FONT_SCALE_MAX, 0.05)).toBe(FONT_SCALE_MAX);
    expect(stepFontScale(FONT_SCALE_MIN, -0.05)).toBe(FONT_SCALE_MIN);
  });
});
