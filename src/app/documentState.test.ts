import { describe, expect, it } from 'vitest';
import {
  DEFAULT_METADATA,
  basename,
  createWindowTitle,
  displayNameForPath,
  isDirty,
  metadataChanged,
  normalizeMarkdownInput,
  untitledNameForFormat,
} from './documentState';

describe('documentState', () => {
  it('derives dirty state from markdown and last saved markdown', () => {
    expect(isDirty('a', 'a')).toBe(false);
    expect(isDirty('a', 'b')).toBe(true);
  });

  it('compares mtime and size for external file changes', () => {
    const known = { ...DEFAULT_METADATA, lastKnownMtimeMs: 1000, lastKnownSizeBytes: 10 };
    expect(metadataChanged(known, { ...known, lastKnownMtimeMs: 1500 }, 1000)).toBe(false);
    expect(metadataChanged(known, { ...known, lastKnownMtimeMs: 1500 })).toBe(true);
    expect(metadataChanged(known, { ...known, lastKnownMtimeMs: 3000 })).toBe(true);
    expect(metadataChanged(known, { ...known, lastKnownSizeBytes: 11 })).toBe(true);
    expect(metadataChanged({ ...known, contentHash: 'a' }, { ...known, contentHash: 'b' })).toBe(true);
  });

  it('normalizes markdown input to LF internally', () => {
    expect(normalizeMarkdownInput('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('creates a dirty title for a document path', () => {
    expect(basename('C:\\tmp\\document.md')).toBe('document.md');
    expect(createWindowTitle({ filePath: '/tmp/document.md', activeDirty: true, unsavedCount: 1 })).toBe('* document.md · 1 unsaved - ScieMD');
  });

  it('uses format-aware display names for unsaved documents', () => {
    expect(untitledNameForFormat('markdown')).toBe('Untitled.md');
    expect(untitledNameForFormat('plainText')).toBe('Untitled.txt');
    expect(untitledNameForFormat('json')).toBe('Untitled.json');
    expect(displayNameForPath(null, 'plainText')).toBe('Untitled.txt');
    expect(displayNameForPath(null, 'yaml')).toBe('Untitled.yaml');
    expect(createWindowTitle({ filePath: null, format: 'plainText', activeDirty: false, unsavedCount: 0 })).toBe('Untitled.txt - ScieMD');
    expect(createWindowTitle({ filePath: null, format: 'json', activeDirty: true, unsavedCount: 2 })).toBe('* Untitled.json · 2 unsaved - ScieMD');
  });

  it('keeps background unsaved work visible when the active document is clean', () => {
    expect(createWindowTitle({
      filePath: 'C:\\docs\\clean.json',
      format: 'json',
      activeDirty: false,
      unsavedCount: 2,
    })).toBe('clean.json · 2 unsaved - ScieMD');
  });
});
