import { describe, expect, it, vi } from 'vitest';
import { createHostReadResponse, DEFAULT_METADATA } from '../documentState';
import { fallbackFileLocator, sourceRevision, type DocumentId } from '../documentIdentity';
import { DocumentHostError } from '../host/documentHostError';
import type { RecoveryCatalogEntry } from '../../services/recoveryCatalog';
import { defaultManifestView, type WorkspaceManifestDocument, type WorkspaceManifestPayload } from '../../services/persistence';
import { restoreWorkspace, selectWorkspaceStartupWinner } from './workspaceRestore';

const enabled = { multiDocumentWorkspaceEnabled: true, activationSurface: { id: 'restore-tests', kind: 'hidden-harness' as const } };
const disabled = { multiDocumentWorkspaceEnabled: false, activationSurface: null };

function document(documentId: string, path: string, recoveryReference: WorkspaceManifestDocument['recoveryReference'] = null): WorkspaceManifestDocument {
  return {
    documentId,
    locator: { ...fallbackFileLocator(path), aliases: [] },
    format: 'markdown',
    view: defaultManifestView(),
    presentation: { visualStyle: null, documentType: null },
    recoveryReference,
  };
}

function manifest(documents: WorkspaceManifestDocument[], activeDocumentId = documents[0]?.documentId ?? null): WorkspaceManifestPayload {
  return {
    tabOrder: documents.map((entry) => entry.documentId),
    activeDocumentId,
    recentlyActiveDocumentIds: documents.map((entry) => entry.documentId),
    documents,
    recoveryReferences: documents.flatMap((entry) => entry.recoveryReference ? [entry.recoveryReference] : []),
    invalidEntries: [],
    savedAt: 1,
  };
}

function recovery(documentId: string, path: string, sourceText: string, savedSourceText: string): RecoveryCatalogEntry {
  return {
    schemaVersion: 1,
    documentId: documentId as DocumentId,
    sourceRevision: sourceRevision(4),
    locator: fallbackFileLocator(path),
    sourceText,
    savedSourceText,
    format: 'markdown',
    mediaType: 'text/markdown',
    savedAt: 2,
    generation: 3,
  };
}

function reader(values: Record<string, string>) {
  return vi.fn(async (path: string) => {
    if (!(path in values)) throw new DocumentHostError('NOT_FOUND', 'missing');
    return createHostReadResponse(values[path], { ...DEFAULT_METADATA, lastKnownSizeBytes: values[path].length });
  });
}

describe('workspace restart restoration', () => {
  it('migrates retired visual styles in persisted workspace tabs to Cursor', async () => {
    const storedDocument = document('legacy-style', 'C:\\legacy-style.md');
    storedDocument.presentation = { visualStyle: 'journal-manuscript', documentType: 'report' };
    const result = await restoreWorkspace({
      manifest: manifest([storedDocument]),
      recoveryEntries: [],
      capability: enabled,
      readFile: reader({ 'C:\\legacy-style.md': '# Legacy' }),
    });

    expect(result.records[0]?.presentation).toEqual({ visualStyle: 'cursor', documentType: 'report' });
  });

  it('applies the cold-start precedence and never lets a manifest override an explicit launch', async () => {
    const dirty = recovery('dirty', 'C:\\dirty.md', 'recovered', 'disk');
    const stored = manifest([
      document('clean', 'C:\\clean.md'),
      document('dirty', 'C:\\dirty.md', { id: 'dirty', generation: 3, sourceRevision: 4 }),
    ], 'dirty');
    expect(selectWorkspaceStartupWinner({ manifest: stored, recoveryEntries: [dirty] })).toEqual({ kind: 'recovery', documentId: 'dirty' });
    expect(selectWorkspaceStartupWinner({ explicitLaunchPath: 'C:\\launch.md', manifest: stored, recoveryEntries: [dirty] }))
      .toEqual({ kind: 'explicit-launch', path: 'C:\\launch.md' });
    const explicit = await restoreWorkspace({ explicitLaunchPath: 'C:\\launch.md', manifest: stored, recoveryEntries: [dirty], capability: enabled, readFile: reader({}) });
    expect(explicit.records).toEqual([]);
  });

  it('hydrates the active dirty document first, then bounded remaining documents, using disk only as the clean baseline', async () => {
    const dirty = recovery('dirty', 'C:\\dirty.md', '', 'disk baseline');
    const thirdDirty = recovery('third', 'C:\\third.md', 'third recovered', 'third disk');
    const stored = manifest([
      document('clean', 'C:\\clean.md'),
      document('dirty', 'C:\\dirty.md', { id: 'dirty', generation: 3, sourceRevision: 4 }),
      document('third', 'C:\\third.md', { id: 'third', generation: 3, sourceRevision: 4 }),
    ], 'dirty');
    const result = await restoreWorkspace({
      manifest: stored,
      recoveryEntries: [dirty, thirdDirty],
      capability: enabled,
      readFile: reader({ 'C:\\clean.md': 'clean disk', 'C:\\dirty.md': 'newer disk ignored as source', 'C:\\third.md': 'third disk' }),
      maxConcurrentHydrations: 2,
    });
    expect(result.hydrationOrder).toEqual(['dirty', 'clean', 'third']);
    expect(result.activeDocumentId).toBe('dirty');
    expect(result.records.find((entry) => entry.id === 'dirty')?.source).toMatchObject({ sourceText: '', savedSourceText: 'disk baseline' });
    expect(result.records.find((entry) => entry.id === 'clean')?.source.sourceText).toBe('clean disk');
    expect(result.records.find((entry) => entry.id === 'third')?.source.sourceText).toBe('third recovered');
    expect(result.outcomes.map((entry) => entry.status)).toContain('restored-recovery');
  });

  it('classifies missing, moved, and permission-lost entries independently and repeats deterministically', async () => {
    const moved = document('moved', 'C:\\old.md');
    moved.locator = { ...moved.locator as Extract<typeof moved.locator, { kind: 'file' }>, stableFileId: 'volume:42', identityConfidence: 'stableFileId' };
    const stored = manifest([moved, document('denied', 'C:\\denied.md'), document('healthy', 'C:\\healthy.md')], 'healthy');
    const read = vi.fn(async (path: string) => {
      if (path.endsWith('old.md')) throw new DocumentHostError('NOT_FOUND', 'The stable file moved or is unavailable.');
      if (path.endsWith('denied.md')) throw new DocumentHostError('PERMISSION_DENIED', 'Permission lost.');
      return createHostReadResponse('healthy', DEFAULT_METADATA);
    });
    const first = await restoreWorkspace({ manifest: stored, recoveryEntries: [], capability: enabled, readFile: read });
    const second = await restoreWorkspace({ manifest: stored, recoveryEntries: [], capability: enabled, readFile: read });
    expect(first.outcomes.map(({ documentId, status, issues }) => ({ documentId, status, issues })))
      .toEqual(second.outcomes.map(({ documentId, status, issues }) => ({ documentId, status, issues })));
    expect(first.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: 'moved', issues: ['moved-file'] }),
      expect.objectContaining({ documentId: 'denied', issues: ['permission-lost'] }),
      expect.objectContaining({ documentId: 'healthy', status: 'restored-clean' }),
    ]));
  });

  it('restores only one usable record while capability is off and preserves the remaining manifest for later activation', async () => {
    const stored = manifest([document('missing', 'C:\\missing.md'), document('healthy', 'C:\\healthy.md')], 'missing');
    const result = await restoreWorkspace({ manifest: stored, recoveryEntries: [], capability: disabled, readFile: reader({ 'C:\\healthy.md': 'healthy' }) });
    expect(result.records.map((entry) => entry.id)).toEqual(['healthy']);
    expect(result.preservedManifest?.tabOrder).toEqual(['missing', 'healthy']);
    expect(result.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: 'missing', status: 'action-required', instantiated: false }),
    ]));

    const later = await restoreWorkspace({ manifest: result.preservedManifest, recoveryEntries: [], capability: enabled, readFile: reader({ 'C:\\healthy.md': 'healthy' }) });
    expect(later.records.map((entry) => entry.id)).toEqual(['missing', 'healthy']);
  });

  it('isolates corrupt and duplicate entries without blocking healthy restoration', async () => {
    const duplicate = document('duplicate', 'C:\\same.md');
    const stored = manifest([document('owner', 'C:\\same.md'), duplicate, document('healthy', 'C:\\healthy.md')], 'owner');
    stored.invalidEntries.push({ documentId: 'bad-shape', reason: 'invalid-shape' });
    const result = await restoreWorkspace({ manifest: stored, recoveryEntries: [], capability: enabled, readFile: reader({ 'C:\\same.md': 'one', 'C:\\healthy.md': 'two' }) });
    expect(result.records.map((entry) => entry.id)).toEqual(['owner', 'healthy']);
    expect(result.outcomes.filter((entry) => entry.status === 'corrupt-manifest-entry').map((entry) => entry.documentId))
      .toEqual(['duplicate', 'bad-shape']);
  });

  it('restores both untitled and file-backed orphan recovery when the manifest is unavailable', async () => {
    const untitled: RecoveryCatalogEntry = { ...recovery('untitled', 'C:\\unused.md', 'draft', ''), locator: { kind: 'untitled', untitledId: 'untitled:one' as never } };
    const savedOrphan = recovery('saved-orphan', 'C:\\saved.md', 'draft', 'disk');
    const result = await restoreWorkspace({ manifest: null, recoveryEntries: [savedOrphan, untitled], capability: enabled, readFile: reader({}) });
    expect(result.winner).toEqual({ kind: 'orphan-untitled-recovery', documentId: 'untitled' });
    expect(result.records.map((entry) => entry.id)).toEqual(['untitled', 'saved-orphan']);
    expect(result.records.find((entry) => entry.id === 'saved-orphan')?.source.sourceText).toBe('draft');
  });

  it('keeps a missing referenced recovery action-required even when disk is readable', async () => {
    const stored = manifest([
      document('dirty-missing', 'C:\\paper.md', { id: 'dirty-missing', generation: 7, sourceRevision: 4 }),
    ]);
    const result = await restoreWorkspace({
      manifest: stored,
      recoveryEntries: [],
      capability: enabled,
      readFile: reader({ 'C:\\paper.md': 'disk baseline' }),
    });

    expect(result.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        documentId: 'dirty-missing',
        status: 'action-required',
        issues: ['missing-recovery'],
      }),
    ]));
    expect(result.records[0]?.lifecycle.recovery).toBe('failed');
  });
});
