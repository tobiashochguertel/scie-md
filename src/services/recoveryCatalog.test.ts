import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocumentId, createUntitledLocator, fallbackFileLocator, sourceRevision } from '../app/documentIdentity';
import {
  checkpointRecoveryEntry,
  checkpointRecoveryEntrySync,
  clearRecoveryCatalogEntry,
  createRecoveryCenterModel,
  loadRecoveryCatalog,
  RECOVERY_CATALOG_SOFT_QUOTA_BYTES,
  recoveryQuotaState,
  resetRecoveryCatalogForTests,
} from './recoveryCatalog';
import { createPersistenceEnvelope, encodePersistenceEnvelope, PERSISTENCE_QUARANTINE_PREFIX } from './persistence/persistenceRegistry';
import recoveryFixture from './persistence/fixtures/recoveryPersistence.v1.json';

const native = vi.hoisted(() => ({ snapshots: [] as Array<Record<string, unknown>> }));

vi.mock('./nativeRecoveryService', () => ({
  writeNativeRecoverySnapshot: vi.fn().mockResolvedValue(true),
  clearNativeRecoverySnapshot: vi.fn().mockResolvedValue(true),
  listNativeRecoverySnapshots: vi.fn(async () => native.snapshots),
}));

describe('recoveryCatalog', () => {
  beforeEach(() => {
    localStorage.clear();
    native.snapshots = [];
    resetRecoveryCatalogForTests();
  });

  it.each(recoveryFixture.catalogCases)('adopts shared catalog fixture $name with format-correct metadata', async (fixture) => {
    const documentId = fixture.documentId as ReturnType<typeof createDocumentId>;
    checkpointRecoveryEntrySync({
      documentId,
      sourceRevision: sourceRevision(fixture.sourceRevision),
      locator: fixture.filePath ? fallbackFileLocator(fixture.filePath) : createUntitledLocator(),
      sourceText: fixture.sourceText,
      format: fixture.format as 'markdown' | 'json' | 'plainText',
      savedAt: 900,
    });

    expect((await loadRecoveryCatalog()).find((entry) => entry.documentId === documentId)).toMatchObject({
      sourceText: fixture.sourceText,
      format: fixture.format,
      mediaType: fixture.mediaType,
    });
  });

  it('keeps several untitled and saved documents independently with format-correct metadata and empty source', async () => {
    const markdownId = createDocumentId();
    const jsonId = createDocumentId();
    const plainId = createDocumentId();
    checkpointRecoveryEntrySync({
      documentId: markdownId,
      sourceRevision: sourceRevision(2),
      locator: fallbackFileLocator('C:\\Lab\\paper.md'),
      sourceText: '# Dirty\n',
      format: 'markdown',
      savedAt: 1000,
    });
    checkpointRecoveryEntrySync({
      documentId: jsonId,
      sourceRevision: sourceRevision(3),
      locator: createUntitledLocator(),
      sourceText: '{"dirty":true}\n',
      format: 'json',
      savedAt: 1100,
    });
    checkpointRecoveryEntrySync({
      documentId: plainId,
      sourceRevision: sourceRevision(4),
      locator: createUntitledLocator(),
      sourceText: '',
      format: 'plainText',
      savedAt: 1200,
    });

    const entries = await loadRecoveryCatalog();
    expect(entries).toHaveLength(3);
    expect(entries.find((entry) => entry.documentId === markdownId)).toMatchObject({ mediaType: 'text/markdown', format: 'markdown' });
    expect(entries.find((entry) => entry.documentId === jsonId)).toMatchObject({ mediaType: 'application/json', format: 'json' });
    expect(entries.find((entry) => entry.documentId === plainId)).toMatchObject({ sourceText: '', mediaType: 'text/plain', format: 'plainText' });
    const model = await createRecoveryCenterModel();
    expect(model).toMatchObject({ schemaVersion: 1, pruningPolicy: 'never-delete-current-dirty-entry', quotaState: 'within-budget' });
    expect(model.entries.find((entry) => entry.documentId === plainId)?.emptySource).toBe(true);
  });

  it('fences stale cleanup so one save cannot clear a newer checkpoint', async () => {
    const documentId = createDocumentId();
    const locator = createUntitledLocator();
    await checkpointRecoveryEntry({ documentId, sourceRevision: sourceRevision(5), locator, sourceText: 'newest', format: 'plainText', savedAt: 2000 });

    expect(await clearRecoveryCatalogEntry(documentId, sourceRevision(4))).toBe(false);
    expect((await loadRecoveryCatalog()).find((entry) => entry.documentId === documentId)?.sourceText).toBe('newest');
    expect(await clearRecoveryCatalogEntry(documentId, sourceRevision(5))).toBe(true);
    expect((await loadRecoveryCatalog()).find((entry) => entry.documentId === documentId)).toBeUndefined();
    expect(await clearRecoveryCatalogEntry(documentId, sourceRevision(5))).toBe(true);
    native.snapshots = [{
      generation: 1,
      documentId,
      sourceRevision: 5,
      catalogSchemaVersion: 1,
      mediaType: 'text/plain',
      markdown: 'stale native copy',
      filePath: null,
      format: 'plainText',
      updatedAtMs: 2000,
      markdownBytes: 17,
    }];
    expect((await loadRecoveryCatalog()).find((entry) => entry.documentId === documentId)).toBeUndefined();
  });

  it('clears only the addressed document and retains another current dirty representation', async () => {
    const first = createDocumentId();
    const second = createDocumentId();
    checkpointRecoveryEntrySync({ documentId: first, sourceRevision: sourceRevision(1), locator: createUntitledLocator(), sourceText: 'first', format: 'plainText' });
    checkpointRecoveryEntrySync({ documentId: second, sourceRevision: sourceRevision(1), locator: createUntitledLocator(), sourceText: 'second', format: 'plainText' });

    await clearRecoveryCatalogEntry(first, sourceRevision(1));

    const entries = await loadRecoveryCatalog();
    expect(entries.find((entry) => entry.documentId === first)).toBeUndefined();
    expect(entries.find((entry) => entry.documentId === second)?.sourceText).toBe('second');
  });

  it('quarantines corrupt and interrupted catalog publications without losing the last committed generation', async () => {
    const documentId = createDocumentId();
    checkpointRecoveryEntrySync({
      documentId,
      sourceRevision: sourceRevision(1),
      locator: createUntitledLocator(),
      sourceText: 'committed',
      format: 'plainText',
      savedAt: 3000,
    });
    const activeKey = Object.keys(localStorage).find((key) => key.startsWith('scie_md.recoveryCatalog.v1.'))!;
    const pending = encodePersistenceEnvelope(createPersistenceEnvelope('recoveryDraft', {
      sourceText: 'interrupted',
      savedAt: 3100,
      format: 'plainText',
      catalogEntry: {
        schemaVersion: 1,
        documentId,
        sourceRevision: 2,
        locator: { kind: 'untitled', untitledId: 'pending' },
        mediaType: 'text/plain',
      },
    }, 2, 'pending'));
    localStorage.setItem(`${activeKey}.pending`, pending);

    expect((await loadRecoveryCatalog()).find((entry) => entry.documentId === documentId)?.sourceText).toBe('committed');
    expect(localStorage.getItem(`${activeKey}.pending`)).toBeNull();
    expect(Object.keys(localStorage).some((key) => key.startsWith(PERSISTENCE_QUARANTINE_PREFIX))).toBe(true);

    const tampered = JSON.parse(localStorage.getItem(activeKey)!) as { checksum: string };
    tampered.checksum = 'corrupt';
    localStorage.setItem(activeKey, JSON.stringify(tampered));
    resetRecoveryCatalogForTests();
    expect(await loadRecoveryCatalog()).toEqual([]);
    expect(localStorage.getItem(activeKey)).toBeNull();
  });

  it('adopts native catalog entries with the same document/revision/format identity', async () => {
    const documentId = createDocumentId();
    native.snapshots = [{
      schemaVersion: 3,
      generation: 7,
      documentId,
      sourceRevision: 9,
      catalogSchemaVersion: 1,
      mediaType: 'application/json',
      markdown: '{"native":true}',
      filePath: 'C:\\Lab\\native.json',
      format: 'json',
      updatedAtMs: 4000,
      markdownBytes: 15,
    }];

    expect(await loadRecoveryCatalog()).toEqual([
      expect.objectContaining({ documentId, sourceRevision: 9, generation: 7, sourceText: '{"native":true}', format: 'json', mediaType: 'application/json' }),
    ]);
  });

  it('reports quota pressure without selecting a dirty entry for pruning', () => {
    expect(recoveryQuotaState(RECOVERY_CATALOG_SOFT_QUOTA_BYTES)).toBe('within-budget');
    expect(recoveryQuotaState(RECOVERY_CATALOG_SOFT_QUOTA_BYTES + 1)).toBe('attention-required');
  });
});
