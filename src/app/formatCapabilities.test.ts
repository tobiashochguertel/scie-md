import { describe, expect, it } from 'vitest';
import { formatContributionCatalog } from '@sciemd/core';
import { formatCapabilitiesFor } from './formatCapabilities';

describe('formatCapabilitiesFor', () => {
  it('derives structured surfaces from core adapter declarations', () => {
    expect(formatCapabilitiesFor('json')).toMatchObject({
      canUseStructuredVisualMode: true,
      canEditJsonVisualTree: true,
      canUseRecordList: false,
      canUseTablePreview: false,
      sourceLanguage: 'json',
      sourceEditor: {
        codeMirrorLanguage: 'json',
        lintProfile: 'json',
      },
    });
    expect(formatCapabilitiesFor('jsonl')).toMatchObject({
      canUseStructuredVisualMode: false,
      canUseRecordList: true,
      canUseTablePreview: false,
      sourceLanguage: 'jsonl',
      sourceEditor: {
        codeMirrorLanguage: 'json',
        lintProfile: 'jsonl',
      },
    });
    expect(formatCapabilitiesFor('csv')).toMatchObject({
      canUseStructuredVisualMode: false,
      canUseRecordList: false,
      canUseTablePreview: true,
      sourceLanguage: 'csv',
      sourceEditor: {
        codeMirrorLanguage: 'plainText',
        lintProfile: 'tabular',
      },
    });
    expect(formatCapabilitiesFor('xml')).toMatchObject({
      canUseStructuredVisualMode: true,
      canEditJsonVisualTree: false,
      canUseRecordList: false,
      canUseTablePreview: false,
      sourceLanguage: 'xml',
      sourceEditor: {
        codeMirrorLanguage: 'xml',
        lintProfile: 'structured',
      },
    });
  });

  it('resolves every contribution, including explicit source-only plain text', () => {
    for (const contribution of formatContributionCatalog.formats) {
      const capabilities = formatCapabilitiesFor(contribution.format);
      expect(capabilities.sourceLanguage).toBe(contribution.sourceLanguageId);
      expect(capabilities.canUseVisualMarkdown).toBe(contribution.workbench.surfaces.includes('markdownVisual'));
      expect(capabilities.canUseStructuredVisualMode).toBe(contribution.workbench.surfaces.includes('structuredTree'));
      expect(capabilities.canUseRecordList).toBe(contribution.workbench.surfaces.includes('recordList'));
      expect(capabilities.canUseTablePreview).toBe(contribution.workbench.surfaces.includes('tablePreview'));
    }
    expect(formatCapabilitiesFor('plainText')).toMatchObject({
      canUseVisualMarkdown: false,
      canUseStructuredVisualMode: false,
      canUseRecordList: false,
      canUseTablePreview: false,
      sourceLanguage: 'plainText',
    });
  });
});
