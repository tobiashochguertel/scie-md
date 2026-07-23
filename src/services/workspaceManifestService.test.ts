import { beforeEach, describe, expect, it } from 'vitest';
import { createDocumentRecord, documentRecordReducer } from '../app/documentRecord';
import { fallbackFileLocator } from '../app/documentIdentity';
import { createWorkspaceState } from '../app/workspace/workspaceState';
import { checkpointRecoveryEntrySync, resetRecoveryCatalogForTests } from './recoveryCatalog';
import {
  createWorkspaceManifestPayload,
  loadWorkspaceManifest,
  resetWorkspaceManifestForTests,
  saveWorkspaceManifest,
  WORKSPACE_MANIFEST_STORAGE_KEY,
} from './workspaceManifestService';

describe('workspace manifest persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWorkspaceManifestForTests();
    resetRecoveryCatalogForTests();
  });

  it('persists identity, order, view, presentation and recovery references without clean source text', async () => {
    const initial = createDocumentRecord({ locator: fallbackFileLocator('C:\\paper.md'), sourceText: 'SECRET CLEAN SOURCE' });
    const dirty = documentRecordReducer(initial, { type: 'sourceChanged', sourceText: 'dirty source' });
    const state = createWorkspaceState(dirty);
    const recovery = checkpointRecoveryEntrySync({
      documentId: dirty.id,
      sourceRevision: dirty.source.revision,
      locator: dirty.locator,
      sourceText: dirty.source.sourceText,
      savedSourceText: dirty.source.savedSourceText,
      format: dirty.format,
    });
    const payload = createWorkspaceManifestPayload(state, [recovery], null, 100);
    await saveWorkspaceManifest(payload);
    const raw = localStorage.getItem(WORKSPACE_MANIFEST_STORAGE_KEY)!;
    expect(raw).not.toContain('SECRET CLEAN SOURCE');
    expect(raw).not.toContain('dirty source');
    expect((await loadWorkspaceManifest()).manifest).toMatchObject({
      tabOrder: [dirty.id],
      activeDocumentId: dirty.id,
      documents: [{ documentId: dirty.id, recoveryReference: { id: dirty.id, sourceRevision: dirty.source.revision } }],
    });
  });

  it('recovers the previous committed generation and quarantines interrupted publication', async () => {
    const first = createWorkspaceManifestPayload(createWorkspaceState(createDocumentRecord({ sourceText: 'one' })), [], null, 1);
    const second = { ...first, savedAt: 2 };
    await saveWorkspaceManifest(first);
    await saveWorkspaceManifest(second);
    localStorage.setItem(WORKSPACE_MANIFEST_STORAGE_KEY, '{broken');
    localStorage.setItem('scie_md.workspaceManifest.v2.pending', JSON.stringify({ interrupted: true }));
    const loaded = await loadWorkspaceManifest();
    expect(loaded.recoveredFromPrevious).toBe(true);
    expect(loaded.manifest?.savedAt).toBe(1);
    expect(loaded.quarantinedReasons).toEqual(['invalid-shape', 'invalid-json']);
    expect(Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)))
      .toEqual(expect.arrayContaining([expect.stringContaining('.quarantine.')]))
  });

  it('loads and rewrites the released schema-1 fixture shape', async () => {
    localStorage.setItem(WORKSPACE_MANIFEST_STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      tabOrder: ['legacy'],
      activeDocumentId: 'legacy',
      recoveryReferences: [{ id: 'legacy', generation: 2 }],
    }));
    const loaded = await loadWorkspaceManifest();
    expect(loaded.migratedFromVersion).toBe(1);
    expect(loaded.manifest?.documents[0]).toMatchObject({ documentId: 'legacy', locator: { kind: 'untitled' } });
    expect(JSON.parse(localStorage.getItem(WORKSPACE_MANIFEST_STORAGE_KEY)!).schemaVersion).toBe(2);
  });

  it('preserves capability-gated records and isolated invalid entries across writes', () => {
    const visible = createDocumentRecord({ locator: fallbackFileLocator('C:\\visible.md') });
    const preserved = createWorkspaceManifestPayload(createWorkspaceState(createDocumentRecord({ locator: fallbackFileLocator('C:\\hidden.md') })), [], null, 1);
    preserved.invalidEntries.push({ documentId: 'bad', reason: 'invalid-shape' });
    const next = createWorkspaceManifestPayload(
      createWorkspaceState(visible),
      [],
      preserved,
      2,
      new Set(preserved.tabOrder),
    );
    expect(next.tabOrder).toEqual([visible.id, preserved.tabOrder[0]]);
    expect(next.invalidEntries).toEqual([{ documentId: 'bad', reason: 'invalid-shape' }]);
  });

  it('does not resurrect an instantiated document after the user closes it', () => {
    const closed = createDocumentRecord({ locator: fallbackFileLocator('C:\\closed.md') });
    const remaining = createDocumentRecord({ locator: fallbackFileLocator('C:\\remaining.md') });
    const preserved = createWorkspaceManifestPayload(createWorkspaceState(closed), [], null, 1);

    const next = createWorkspaceManifestPayload(createWorkspaceState(remaining), [], preserved, 2);

    expect(next.tabOrder).toEqual([remaining.id]);
    expect(next.documents.map((entry) => entry.documentId)).toEqual([remaining.id]);
  });
});
