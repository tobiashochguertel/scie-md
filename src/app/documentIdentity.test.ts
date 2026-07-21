import { describe, expect, it } from 'vitest';
import {
  canonicalComparisonKey,
  createUntitledLocator,
  fallbackFileLocator,
  mergeFileLocatorAliases,
  normalizeNativeLocator,
  sameDocumentLocator,
} from './documentIdentity';

describe('documentIdentity', () => {
  it('converges Windows drive, separator, verbatim, and UNC aliases', () => {
    expect(canonicalComparisonKey('C:\\Work\\Paper.md')).toBe('c:/work/paper.md');
    expect(canonicalComparisonKey('c:/work/PAPER.md')).toBe('c:/work/paper.md');
    expect(canonicalComparisonKey('\\\\?\\C:\\Work\\Paper.md')).toBe('c:/work/paper.md');
    expect(canonicalComparisonKey('\\\\?\\UNC\\Server\\Share\\Paper.md')).toBe('//server/share/paper.md');
    expect(canonicalComparisonKey('\\\\server\\share\\PAPER.md')).toBe('//server/share/paper.md');
  });

  it('keeps POSIX path comparison case-sensitive', () => {
    expect(canonicalComparisonKey('/tmp/Paper.md')).toBe('/tmp/Paper.md');
    expect(canonicalComparisonKey('/tmp/paper.md')).toBe('/tmp/paper.md');
    expect(sameDocumentLocator(fallbackFileLocator('/tmp/Paper.md'), fallbackFileLocator('/tmp/paper.md'))).toBe(false);
  });

  it('assigns every untitled document a distinct identity', () => {
    const first = createUntitledLocator();
    const second = createUntitledLocator();
    expect(first.untitledId).not.toBe(second.untitledId);
    expect(sameDocumentLocator(first, second)).toBe(false);
  });

  it('uses stable physical identity to converge hardlink aliases', () => {
    const first = normalizeNativeLocator({
      displayPath: 'C:\\work\\first.md',
      comparisonKey: 'c:/work/first.md',
      stableFileId: 'volume:42',
      identityConfidence: 'stableFileId',
    }, 'C:\\work\\first.md');
    const alias = normalizeNativeLocator({
      displayPath: 'C:\\alias\\second.md',
      comparisonKey: 'c:/alias/second.md',
      stableFileId: 'volume:42',
      identityConfidence: 'stableFileId',
    }, 'C:\\alias\\second.md');
    expect(sameDocumentLocator(first, alias)).toBe(true);
    expect(mergeFileLocatorAliases(first, alias)).toMatchObject({
      displayPath: 'C:\\work\\first.md',
      aliases: ['C:\\alias\\second.md'],
    });
  });

  it('does not guess across different path-only keys', () => {
    expect(sameDocumentLocator(
      fallbackFileLocator('C:\\work\\one.md'),
      fallbackFileLocator('C:\\work\\two.md'),
    )).toBe(false);
  });

});
