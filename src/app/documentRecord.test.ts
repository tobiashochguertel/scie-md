import { describe, expect, it } from 'vitest';
import { DEFAULT_METADATA } from './documentState';
import { createDocumentId, createUntitledLocator, fallbackFileLocator, sourceRevision } from './documentIdentity';
import {
  assertValidDocumentRecord,
  createDocumentRecord,
  documentRecordReducer,
  documentCurrentSourceText,
  replaceDocumentRecordSession,
  type DocumentRecord,
} from './documentRecord';

describe('DocumentRecord', () => {
  it('acknowledges source and journal as one guarded structured mutation transaction', () => {
    const record = createDocumentRecord({ format: 'json', sourceText: '{"value":1}\n' });
    const journalEntry = {
      schemaVersion: 2 as const, id: 'entry', format: 'json' as const, operationId: 'replaceScalar', transactionId: 'tx', sourceRevision: 0,
      sourceFingerprint: 'sha256:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      planFingerprint: 'sha256:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      operationLabel: 'Edit JSON value', targetLabel: '$.value', previewLabel: 'Updated $.value.', riskLabel: 'Replace source range',
      appliedAt: 1, line: 1, column: 10,
    };
    const accepted = documentRecordReducer(record, {
      type: 'structuredMutationCommitted', sourceText: '{"value":2}\n', journalEntry,
      changeSet: { documentId: record.id, expectedRevision: record.source.revision, changes: [{ from: 9, to: 10, insert: '2', expectedText: '1' }] },
    });
    expect(documentCurrentSourceText(accepted)).toBe('{"value":2}\n');
    expect(accepted.source.revision).toBe(1);
    expect(accepted.view.structuredEditJournal).toEqual([journalEntry]);
    const rejected = documentRecordReducer(record, {
      type: 'structuredMutationCommitted', sourceText: '{"value":2}\n', journalEntry,
      changeSet: { documentId: record.id, expectedRevision: sourceRevision(1), changes: [{ from: 9, to: 10, insert: '2', expectedText: '1' }] },
    });
    expect(rejected).toBe(record);
  });

  it('owns a serializable initial source, lifecycle, presentation, and view aggregate', () => {
    const record = createDocumentRecord({ sourceText: '# Paper' });
    expect(record).toMatchObject({
      schemaVersion: 2,
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
    expect(record.source.buffer).toMatchObject({ schemaVersion: 1, storageEpoch: 0, current: { revision: 0 }, saved: { revision: 0 } });
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

  it('accepts revision-guarded patches without replacing the compatibility string projection', () => {
    const initial = createDocumentRecord({ sourceText: 'alpha beta' });
    const edited = documentRecordReducer(initial, {
      type: 'sourceChangeSetApplied',
      changeSet: {
        documentId: initial.id,
        expectedRevision: sourceRevision(0),
        changes: [{ from: 6, to: 10, insert: 'BETA', expectedText: 'beta' }],
      },
    });
    expect(edited.source.sourceText).toBe('alpha beta');
    expect(documentCurrentSourceText(edited)).toBe('alpha BETA');
    expect(edited).toMatchObject({ source: { revision: 1, savedRevision: 0 }, lifecycle: { content: 'dirty', recovery: 'pending' } });
    const stale = documentRecordReducer(edited, {
      type: 'sourceChangeSetApplied',
      changeSet: { documentId: initial.id, expectedRevision: sourceRevision(0), changes: [{ from: 0, to: 1, insert: 'A' }] },
    });
    expect(stale).toBe(edited);
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
          schemaVersion: 2, operationId: 'replaceScalar', transactionId: 'edit-a', sourceRevision: 0,
          sourceFingerprint: 'sha256:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          planFingerprint: 'sha256:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
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

  it('atomically drops and baseline-rehydrates only eligible clean file source', () => {
    const baseline = {
      ...DEFAULT_METADATA,
      lastKnownMtimeMs: 10,
      lastKnownSizeBytes: 5,
      contentHash: 'content:alpha',
      originalByteHash: 'bytes:alpha',
    };
    const resident = createDocumentRecord({
      locator: fallbackFileLocator('C:\\lab\\alpha.md'),
      sourceText: 'alpha',
      fileBaseline: baseline,
      residentSince: 1,
    });
    const cold = documentRecordReducer(resident, {
      type: 'sourceTransitionedColdClean', expectedRevision: resident.source.revision, transitionedAt: 20,
    });
    expect(cold.source).toMatchObject({
      sourceText: '', savedSourceText: '', residency: { kind: 'coldClean', since: 20, verifiedBaseline: baseline },
    });
    expect(cold.source.buffer.current.text.length).toBe(0);
    expect(cold.source.revision).toBe(resident.source.revision);
    expect(() => documentCurrentSourceText(cold)).toThrow('must be reacquired');
    expect(documentRecordReducer(cold, { type: 'sourceChanged', sourceText: 'unsafe' })).toBe(cold);

    const rehydrated = documentRecordReducer(cold, {
      type: 'coldSourceRehydrated', expectedRevision: cold.source.revision,
      sourceText: 'alpha', fileBaseline: baseline, rehydratedAt: 30,
    });
    expect(rehydrated.source.residency).toEqual({ kind: 'resident', since: 30 });
    expect(documentCurrentSourceText(rehydrated)).toBe('alpha');
    expect(rehydrated.source.revision).toBe(resident.source.revision);
  });

  it('refuses cold transition for dirty, untitled, saving, conflicted, or unverified records', () => {
    const verified = createDocumentRecord({
      locator: fallbackFileLocator('C:\\lab\\verified.md'), sourceText: 'saved',
      fileBaseline: { ...DEFAULT_METADATA, contentHash: 'verified' },
    });
    const dirty = documentRecordReducer(verified, { type: 'sourceChanged', sourceText: 'dirty' });
    const saving = documentRecordReducer(verified, { type: 'autosaveStatusChanged', autosaveStatus: 'saving' });
    const conflicted = documentRecordReducer(verified, { type: 'externalConflictChanged', externalConflict: true });
    const unverified = createDocumentRecord({ locator: fallbackFileLocator('C:\\lab\\unknown.md'), sourceText: 'saved' });
    const untitled = createDocumentRecord({ sourceText: 'saved' });
    for (const record of [dirty, saving, conflicted, unverified, untitled]) {
      expect(documentRecordReducer(record, {
        type: 'sourceTransitionedColdClean', expectedRevision: record.source.revision, transitionedAt: 1,
      })).toBe(record);
    }
  });
});
