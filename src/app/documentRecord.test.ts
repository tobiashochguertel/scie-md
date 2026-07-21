import { describe, expect, it } from 'vitest';
import { DEFAULT_METADATA } from './documentState';
import { createDocumentId, createUntitledLocator, fallbackFileLocator } from './documentIdentity';
import {
  assertValidDocumentRecord,
  createDocumentRecord,
  documentRecordReducer,
  replaceDocumentRecordSession,
  type DocumentRecord,
} from './documentRecord';

describe('DocumentRecord', () => {
  it('owns a serializable initial source, lifecycle, presentation, and view aggregate', () => {
    const record = createDocumentRecord({ sourceText: '# Paper' });
    expect(record).toMatchObject({
      schemaVersion: 1,
      format: 'markdown',
      source: { sourceText: '# Paper', savedSourceText: '# Paper', revision: 0, savedRevision: 0 },
      lifecycle: { content: 'clean', save: 'idle', external: 'inSync', access: 'writable', recovery: 'notRequired' },
      presentation: { visualStyle: null, documentType: null },
      view: {
        mode: 'visual',
        preferredStructuredSurface: null,
        selectedStructuredPath: '$',
        explicitJsonSchemaPath: null,
        selectedVariableName: null,
        authorshipMarks: [],
        structuredEditJournal: [],
      },
    });
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it('transitions source, baseline revisions, and empty dirty content consistently', () => {
    const initial = createDocumentRecord({ sourceText: 'saved' });
    const dirty = documentRecordReducer(initial, { type: 'sourceChanged', sourceText: '' });
    expect(dirty.source).toMatchObject({ sourceText: '', savedSourceText: 'saved', revision: 1, savedRevision: 0 });
    expect(dirty.lifecycle).toMatchObject({ content: 'dirty', recovery: 'pending' });

    const saved = documentRecordReducer(dirty, { type: 'savedBaselineChanged', savedSourceText: '' });
    expect(saved.source.savedRevision).toBe(saved.source.revision);
    expect(saved.lifecycle).toMatchObject({ content: 'clean', recovery: 'notRequired' });
  });

  it('keeps lifecycle facets orthogonal', () => {
    let record = createDocumentRecord({ sourceText: 'saved' });
    record = documentRecordReducer(record, { type: 'sourceChanged', sourceText: 'dirty' });
    record = documentRecordReducer(record, { type: 'autosaveStatusChanged', autosaveStatus: 'saving' });
    record = documentRecordReducer(record, { type: 'externalConflictChanged', externalConflict: true });
    record = documentRecordReducer(record, { type: 'accessChanged', access: 'readOnly' });
    expect(record.lifecycle).toMatchObject({
      content: 'dirty',
      save: 'saving',
      external: 'changed',
      access: 'readOnly',
      recovery: 'pending',
    });
  });

  it('applies typed external observations and targeted disk adoption atomically', () => {
    const initial = documentRecordReducer(createDocumentRecord({ sourceText: 'base' }), { type: 'sourceChanged', sourceText: 'local' });
    const observed = { ...DEFAULT_METADATA, lastKnownMtimeMs: 2, contentHash: 'disk', readOnly: true };
    const conflicted = documentRecordReducer(initial, {
      type: 'externalObservationChanged',
      external: 'changed',
      access: 'readOnly',
      observedExternal: observed,
      autosaveStatus: 'conflict',
    });
    expect(conflicted.lifecycle).toMatchObject({ content: 'dirty', external: 'changed', access: 'readOnly', autosaveStatus: 'conflict' });
    expect(conflicted.observedExternal).toBe(observed);

    const reloaded = documentRecordReducer(conflicted, { type: 'externalDiskAdopted', sourceText: 'disk', fileBaseline: observed });
    expect(reloaded.source).toMatchObject({ sourceText: 'disk', savedSourceText: 'disk', revision: 2, savedRevision: 2 });
    expect(reloaded.lifecycle).toMatchObject({ content: 'clean', external: 'inSync', access: 'readOnly', recovery: 'notRequired' });
    expect(reloaded.observedExternal).toBeNull();
  });

  it('preserves invariants and serialization across the reducer transition matrix', () => {
    let record = createDocumentRecord({ sourceText: 'saved' });
    const actions: Parameters<typeof documentRecordReducer>[1][] = [
      { type: 'sourceChanged', sourceText: 'dirty' },
      { type: 'formatChanged', format: 'json' },
      { type: 'fileBaselineChanged', fileBaseline: { ...DEFAULT_METADATA, contentHash: 'baseline', lastKnownSizeBytes: 5 } },
      { type: 'observedExternalChanged', observedExternal: { ...DEFAULT_METADATA, contentHash: 'external', lastKnownSizeBytes: 8 } },
      { type: 'modeChanged', mode: 'source' },
      { type: 'autosaveStatusChanged', autosaveStatus: 'saving' },
      { type: 'lastAutosavedAtChanged', lastAutosavedAt: 42 },
      { type: 'externalConflictChanged', externalConflict: true },
      { type: 'accessChanged', access: 'readOnly' },
      { type: 'recoveryChanged', recovery: 'current' },
      { type: 'presentationChanged', presentation: { visualStyle: 'scienfy', documentType: 'report' } },
      { type: 'viewChanged', view: { selectedStructuredPath: '$.data' } },
    ];

    for (const action of actions) {
      record = documentRecordReducer(record, action);
      expect(assertValidDocumentRecord(record)).toBe(record);
      expect(JSON.parse(JSON.stringify(record))).toEqual(record);
    }
    expect(record).toMatchObject({
      format: 'json',
      observedExternal: { contentHash: 'external' },
      lifecycle: { content: 'dirty', save: 'saving', external: 'changed', access: 'readOnly', recovery: 'current' },
      presentation: { visualStyle: 'scienfy', documentType: 'report' },
      view: { mode: 'source', selectedStructuredPath: '$.data' },
    });
  });

  it('rejects impossible lifecycle and revision combinations', () => {
    const initial = createDocumentRecord();
    expect(() => assertValidDocumentRecord({
      ...initial,
      lifecycle: { ...initial.lifecycle, content: 'dirty' },
    })).toThrow('Document content lifecycle disagrees');
    expect(() => assertValidDocumentRecord({
      ...initial,
      source: { ...initial.source, savedRevision: 2 as never },
    })).toThrow('Saved revision cannot exceed source revision');
  });

  it('isolates journal, path, schema, authorship, surface, variable, and presentation state between records', () => {
    const recordA = documentRecordReducer(createDocumentRecord(), {
      type: 'viewChanged',
      view: {
        preferredStructuredSurface: 'table',
        selectedStructuredPath: '$.samples[0]',
        explicitJsonSchemaPath: 'C:\\lab\\schema.json',
        selectedVariableName: 'temperature',
        authorshipMarks: [{ id: 'a', start: 0, end: 1, createdAt: 1, label: 'A' }],
        structuredEditJournal: [{
          id: 'edit-a', format: 'json', operationLabel: 'Replace', targetLabel: '$.a',
          previewLabel: '1 -> 2', riskLabel: 'low', appliedAt: 1, line: 1, column: 1,
        }],
      },
    });
    const presentedA = documentRecordReducer(recordA, {
      type: 'presentationChanged',
      presentation: { visualStyle: 'scienfy', documentType: 'report' },
    });
    const recordB = createDocumentRecord();
    expect(presentedA.view.selectedStructuredPath).toBe('$.samples[0]');
    expect(presentedA.presentation.visualStyle).toBe('scienfy');
    expect(recordB.view).toMatchObject({
      preferredStructuredSurface: null,
      selectedStructuredPath: '$',
      explicitJsonSchemaPath: null,
      selectedVariableName: null,
      authorshipMarks: [],
      structuredEditJournal: [],
    });
    expect(recordB.presentation).toEqual({ visualStyle: null, documentType: null });
  });

  it('replaces the compatibility session atomically and clears prior document view state', () => {
    const current = documentRecordReducer(createDocumentRecord(), {
      type: 'viewChanged',
      view: { selectedStructuredPath: '$.old', preferredStructuredSurface: 'tree' },
    });
    const id = createDocumentId();
    const next = replaceDocumentRecordSession(current, {
      id,
      locator: fallbackFileLocator('C:\\lab\\data.json'),
      format: 'json',
      sourceText: '{"ok":true}',
      savedSourceText: '{"ok":true}',
      fileBaseline: DEFAULT_METADATA,
      mode: 'source',
      autosaveStatus: 'saved',
      presentation: { visualStyle: 'science', documentType: 'report' },
    });
    expect(next).toMatchObject({ id, format: 'json', view: { mode: 'source', selectedStructuredPath: '$' } });
    expect(next.view.preferredStructuredSurface).toBeNull();
    expect(next.presentation).toEqual({ visualStyle: 'science', documentType: 'report' });
  });

  it('accepts file and untitled locator transitions without storing runtime objects', () => {
    const initial = documentRecordReducer(createDocumentRecord(), {
      type: 'viewChanged',
      view: { preferredStructuredSurface: 'tree', selectedStructuredPath: '$.preserved' },
    });
    const file = documentRecordReducer(initial, { type: 'locatorChanged', locator: fallbackFileLocator('C:\\lab\\paper.md') });
    const untitled = documentRecordReducer(file, { type: 'locatorChanged', locator: createUntitledLocator() });
    expect(file.locator.kind).toBe('file');
    expect(untitled.locator.kind).toBe('untitled');
    expect(untitled.view).toMatchObject({ preferredStructuredSurface: 'tree', selectedStructuredPath: '$.preserved' });
    expect(JSON.stringify(untitled)).not.toContain('Map');
  });
});
