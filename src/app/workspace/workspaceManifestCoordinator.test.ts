import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocumentRecord, documentRecordReducer } from '../documentRecord';
import { createWorkspaceState } from './workspaceState';
import { createWorkspaceManifestCoordinator } from './workspaceManifestCoordinator';
import { checkpointRecoveryEntrySync, resetRecoveryCatalogForTests } from '../../services/recoveryCatalog';
import { loadWorkspaceManifest, resetWorkspaceManifestForTests } from '../../services/workspaceManifestService';
import type { WorkspaceRecoveryCoordinator } from './workspaceRecoveryCoordinator';

describe('workspace manifest coordinator', () => {
  beforeEach(() => {
    localStorage.clear();
    resetRecoveryCatalogForTests();
    resetWorkspaceManifestForTests();
  });

  it('keeps recovery as the first writer and publishes the manifest through the store-owned coordinator', async () => {
    const dirty = documentRecordReducer(createDocumentRecord({ sourceText: 'saved' }), { type: 'sourceChanged', sourceText: 'dirty' });
    const state = createWorkspaceState(dirty);
    const events: string[] = [];
    const recovery = {
      flushAll: vi.fn(async () => {
        events.push('recovery');
        checkpointRecoveryEntrySync({
          documentId: dirty.id,
          sourceRevision: dirty.source.revision,
          locator: dirty.locator,
          sourceText: dirty.source.sourceText,
          savedSourceText: dirty.source.savedSourceText,
          format: dirty.format,
        });
        return [];
      }),
    } as unknown as WorkspaceRecoveryCoordinator;
    const coordinator = createWorkspaceManifestCoordinator(() => state, recovery, () => 42);
    coordinator.activate();
    const generation = await coordinator.flush();
    events.push('manifest');

    expect(generation).toBe(1);
    expect(events).toEqual(['recovery', 'manifest']);
    expect((await loadWorkspaceManifest()).manifest?.documents[0].recoveryReference).toMatchObject({
      id: dirty.id,
      sourceRevision: dirty.source.revision,
    });
    expect(coordinator.metrics()).toMatchObject({ publicationCount: 1, failedPublicationCount: 0, pending: false });
    coordinator.destroy();
  });

  it('does not write dormant infrastructure before startup activation', async () => {
    const state = createWorkspaceState(createDocumentRecord());
    const recovery = { flushAll: vi.fn() } as unknown as WorkspaceRecoveryCoordinator;
    const coordinator = createWorkspaceManifestCoordinator(() => state, recovery);
    coordinator.observe(state);
    expect(await coordinator.flush()).toBeNull();
    expect(recovery.flushAll).not.toHaveBeenCalled();
    coordinator.destroy();
  });
});
