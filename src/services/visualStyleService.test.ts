import { describe, expect, it } from 'vitest';
import {
  getVisualStyleOption,
  isVisualStyleId,
  nextVisualStyle,
  normalizeVisualStyleId,
  VISUAL_STYLE_OPTIONS,
} from './visualStyleService';

describe('visualStyleService', () => {
  it('exposes the release style presets without retired style aliases', () => {
    const ids = VISUAL_STYLE_OPTIONS.map((style) => style.id);

    expect(ids).toEqual([
      'cursor',
      'lab-notebook',
      'codex',
      'scienfy',
      'science',
      'nature',
      'claude',
    ]);
    expect(isVisualStyleId('amin')).toBe(false);
    expect(isVisualStyleId('scie-sans')).toBe(false);
    expect(isVisualStyleId('scie-sans-compact')).toBe(false);
  });

  it('falls back to the first style and cycles through all styles', () => {
    expect(getVisualStyleOption('science').label).toBe('Science');
    expect(getVisualStyleOption('cursor').label).toBe('Cursor');
    expect(getVisualStyleOption('scienfy').label).toBe('Scienfy');
    expect(getVisualStyleOption('claude').label).toBe('Claude');
    expect(nextVisualStyle('nature')).toBe('claude');
    expect(nextVisualStyle('claude')).toBe('cursor');
  });

  it('normalizes retired style ids without exposing them as selectable styles', () => {
    expect(normalizeVisualStyleId('scientific-draft')).toBe('cursor');
    expect(normalizeVisualStyleId('journal-manuscript')).toBe('cursor');
    expect(normalizeVisualStyleId('technical-code')).toBe('cursor');
    expect(isVisualStyleId('scientific-draft')).toBe(false);
    expect(isVisualStyleId('journal-manuscript')).toBe(false);
    expect(isVisualStyleId('technical-code')).toBe(false);
    expect(normalizeVisualStyleId('amin')).toBe('scienfy');
    expect(normalizeVisualStyleId('amin-style')).toBe('scienfy');
    expect(normalizeVisualStyleId('research-statement')).toBe('scienfy');
    expect(normalizeVisualStyleId('scie-sans')).toBe('scienfy');
    expect(normalizeVisualStyleId('scie-sans-compact')).toBe('scienfy');
    expect(normalizeVisualStyleId('missing')).toBeNull();
  });
});
