import { describe, expect, it, vi } from 'vitest';
import {
  applyPersistenceTombstone,
  createPersistenceEnvelope,
  DEFERRED_PERSISTENCE_FAMILIES,
  decodeRecoveryDraft,
  decodeWorkspaceManifest,
  encodePersistenceEnvelope,
  quarantinePersistenceValue,
  reconcilePersistencePublication,
  publishRecoveryBeforeManifest,
  RECOVERY_DRAFT_SCHEMA_VERSION,
} from './persistenceRegistry';
import persistenceFixture from './fixtures/recoveryPersistence.v1.json';
import workspaceFixture from './fixtures/workspaceManifestPersistence.v1.json';

describe('persistence registry', () => {
  it.each(persistenceFixture.legacyRecoveryCases)('migrates released recovery fixture $name sequentially and idempotently', ({ stored, fallbackFormat, expected }) => {
    const migrated = decodeRecoveryDraft(stored, fallbackFormat as 'markdown');
    expect(migrated.status).toBe('ready');
    if (migrated.status !== 'ready') return;
    expect(migrated.envelope.schemaVersion).toBe(RECOVERY_DRAFT_SCHEMA_VERSION);
    expect(migrated.envelope.payload).toEqual(expected);
    const repeated = decodeRecoveryDraft(encodePersistenceEnvelope(migrated.envelope), fallbackFormat as 'markdown');
    expect(repeated).toEqual({ ...migrated, migratedFromVersion: null });
  });

  it('round-trips the versioned recovery-catalog identity extension without weakening legacy payloads', () => {
    const envelope = createPersistenceEnvelope('recoveryDraft', {
      sourceText: '',
      savedAt: 1500,
      format: 'plainText' as const,
      catalogEntry: {
        schemaVersion: 1 as const,
        documentId: 'document-a',
        sourceRevision: 4,
        locator: { kind: 'untitled' as const, untitledId: 'untitled-a' },
        mediaType: 'text/plain',
      },
    }, 2);

    const decoded = decodeRecoveryDraft(encodePersistenceEnvelope(envelope), 'markdown');
    expect(decoded).toMatchObject({
      status: 'ready',
      envelope: { payload: { sourceText: '', catalogEntry: { documentId: 'document-a', sourceRevision: 4, mediaType: 'text/plain' } } },
    });
  });

  it.each([
    ['future-version', JSON.stringify({ family: 'recoveryDraft', schemaVersion: 99, generation: 1, checksum: 'x', commitState: 'committed', payload: {} })],
    ['checksum-mismatch', JSON.stringify({ ...createPersistenceEnvelope('recoveryDraft', { sourceText: 'draft', savedAt: 1, format: 'markdown' }, 1), checksum: 'tampered' })],
    ['interrupted-publication', encodePersistenceEnvelope(createPersistenceEnvelope('recoveryDraft', { sourceText: 'draft', savedAt: 1, format: 'markdown' }, 1, 'pending'))],
    ['invalid-json', '{not-json'],
  ] as const)('fails closed and classifies %s recovery data', (reason, raw) => {
    expect(decodeRecoveryDraft(raw, 'markdown')).toMatchObject({ status: 'quarantine', reason });
  });

  it('preserves unknown data in deterministic quarantine before removing the active key', () => {
    const values = new Map<string, string>([['active', '{future-payload}']]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const first = quarantinePersistenceValue(storage, 'active', '{future-payload}', 'future-version', 'recoveryDraft', 1000);
    const second = quarantinePersistenceValue(storage, 'active', '{future-payload}', 'future-version', 'recoveryDraft', 2000);

    expect(first).toBe(second);
    expect(values.has('active')).toBe(false);
    expect(JSON.parse(values.get(first!)!)).toMatchObject({ raw: '{future-payload}', reason: 'future-version' });
  });

  it.each(workspaceFixture.legacyCases)('migrates workspace manifest fixture $name sequentially and idempotently', ({ stored }) => {
    const migrated = decodeWorkspaceManifest(stored);
    expect(migrated.status).toBe('ready');
    if (migrated.status !== 'ready') return;
    expect(migrated.migratedFromVersion).toBe(1);
    expect(migrated.envelope.schemaVersion).toBe(2);
    expect(migrated.envelope.payload.documents.map((document) => document.documentId)).toEqual(stored.tabOrder);
    expect(JSON.stringify(migrated.envelope.payload)).not.toContain('sourceText');
    expect(decodeWorkspaceManifest(encodePersistenceEnvelope(migrated.envelope))).toEqual({
      ...migrated,
      migratedFromVersion: null,
    });
  });

  it.each([
    ['future-version', JSON.stringify({ family: 'workspaceManifest', schemaVersion: 99, generation: 1, checksum: 'x', commitState: 'committed', payload: {} })],
    ['checksum-mismatch', JSON.stringify({ ...createPersistenceEnvelope('workspaceManifest', { tabOrder: [], activeDocumentId: null, recoveryReferences: [] }, 1), checksum: 'tampered' })],
    ['interrupted-publication', encodePersistenceEnvelope(createPersistenceEnvelope('workspaceManifest', { tabOrder: [], activeDocumentId: null, recoveryReferences: [] }, 1, 'pending'))],
  ] as const)('fails closed for workspace-manifest %s data', (reason, raw) => {
    expect(decodeWorkspaceManifest(raw)).toMatchObject({ status: 'quarantine', reason });
  });

  it('retains the active value when quarantine publication itself fails', () => {
    const values = new Map<string, string>([['active', 'future']]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => { throw new Error('quota'); },
      removeItem: (key: string) => { values.delete(key); },
    };

    expect(quarantinePersistenceValue(storage, 'active', 'future', 'future-version', 'recoveryDraft')).toBeNull();
    expect(values.get('active')).toBe('future');
  });

  it('records settings and path grants as deliberately unadopted families', () => {
    expect(DEFERRED_PERSISTENCE_FAMILIES).toEqual(['settings', 'pathGrants']);
  });

  it('reconciles recovery-first publication and applies tombstones idempotently', () => {
    const first = { id: 'recovery:a', generation: 1, deletedAt: 1000 };
    expect(applyPersistenceTombstone([first], first)).toEqual([first]);
    const tombstones = applyPersistenceTombstone([first], { ...first, generation: 2, deletedAt: 2000 });
    const result = reconcilePersistencePublication(
      [{ id: 'recovery:a', generation: 1 }, { id: 'recovery:b', generation: 3 }],
      [{ id: 'recovery:b', generation: 2 }, { id: 'recovery:missing', generation: 1 }],
      tombstones,
    );

    expect(result.liveEntries).toEqual([{ id: 'recovery:b', generation: 3 }]);
    expect(result.orphanEntries).toEqual([{ id: 'recovery:b', generation: 3 }]);
    expect(result.staleReferences).toEqual([
      { id: 'recovery:b', generation: 2 },
      { id: 'recovery:missing', generation: 1 },
    ]);
  });

  it('commits recovery before publishing its manifest reference and fails closed', async () => {
    const events: string[] = [];
    const result = await publishRecoveryBeforeManifest({
      commitRecovery: async () => { events.push('recovery'); return { id: 'recovery:a', generation: 2 }; },
      commitManifestReference: async (reference) => { events.push(`manifest:${reference.generation}`); return 'published'; },
    });
    expect(result).toBe('published');
    expect(events).toEqual(['recovery', 'manifest:2']);

    const manifest = vi.fn();
    await expect(publishRecoveryBeforeManifest({
      commitRecovery: async () => { throw new Error('recovery failed'); },
      commitManifestReference: manifest,
    })).rejects.toThrow('recovery failed');
    expect(manifest).not.toHaveBeenCalled();
  });
});
