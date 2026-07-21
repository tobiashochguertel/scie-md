import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeNativeRecoverySnapshot } from './nativeRecoveryService';
import { createDocumentId, createUntitledLocator, sourceRevision } from '../app/documentIdentity';
import { resetRecoveryCatalogForTests } from './recoveryCatalog';
import {
  RAW_RESCUE_SESSION_STORAGE_MAX_BYTES,
  exportRawDocumentRescueMarkdown,
  flushRawDocumentRescueSnapshotForTests,
  nativeRescueMarkdown,
  listRawDocumentRescueSnapshots,
  rawDocumentRescuePolicy,
  updateRawDocumentRescue,
} from './rawDocumentRescue';

vi.mock('./nativeRecoveryService', () => ({
  readNativeRecoverySnapshot: vi.fn(async () => null),
  listNativeRecoverySnapshots: vi.fn(async () => []),
  clearNativeRecoverySnapshot: vi.fn(async () => true),
  writeNativeRecoverySnapshot: vi.fn(async () => true),
}));

const RESCUE_SNAPSHOT_KEY = 'scie-md:raw-document-rescue';

describe('raw document rescue policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
    localStorage.clear();
    resetRecoveryCatalogForTests();
    vi.mocked(writeNativeRecoverySnapshot).mockClear();
  });

  afterEach(() => {
    window.sessionStorage.clear();
    vi.useRealTimers();
  });

  it('keeps small rescue snapshots in sessionStorage and native storage', async () => {
    updateRawDocumentRescue('# Small draft', 'C:\\Lab\\paper.md');
    await vi.runOnlyPendingTimersAsync();
    await flushRawDocumentRescueSnapshotForTests();

    expect(JSON.parse(window.sessionStorage.getItem(RESCUE_SNAPSHOT_KEY) ?? '{}')).toMatchObject({
      markdown: '# Small draft',
      filePath: 'C:\\Lab\\paper.md',
    });
    expect(writeNativeRecoverySnapshot).toHaveBeenCalledWith(expect.objectContaining({
      markdown: '# Small draft',
      filePath: 'C:\\Lab\\paper.md',
    }));
  });

  it('skips sessionStorage for large markdown and writes native fallback immediately', async () => {
    const largeMarkdown = `# Large\n\n${'x'.repeat(RAW_RESCUE_SESSION_STORAGE_MAX_BYTES + 1)}`;

    updateRawDocumentRescue(largeMarkdown, 'C:\\Lab\\large.md');
    await flushRawDocumentRescueSnapshotForTests();

    const sessionPayload = JSON.parse(window.sessionStorage.getItem(RESCUE_SNAPSHOT_KEY) ?? '{}');
    expect(sessionPayload).toMatchObject({
      markdown: '',
      nativeFallbackOnly: true,
      filePath: 'C:\\Lab\\large.md',
    });
    expect(writeNativeRecoverySnapshot).toHaveBeenCalledWith(expect.objectContaining({
      markdown: largeMarkdown,
      filePath: 'C:\\Lab\\large.md',
    }));
  });

  it('marks native rescue markdown when the native cap requires truncation', () => {
    const markdown = [
      '# Head',
      'A'.repeat(128),
      'B'.repeat(128),
      'Tail marker',
    ].join('\n');

    expect(rawDocumentRescuePolicy(markdown, 120)).toMatchObject({
      nativeStorage: 'truncated',
    });
    const rescue = nativeRescueMarkdown(markdown, 120);

    expect(rescue).toContain('ScieMD rescue snapshot truncated');
    expect(rescue).toContain('Original markdown bytes:');
    expect(rescue).toContain('Native rescue cap bytes: 120');
    expect(rescue).toContain('Tail marker');
  });

  it('keeps generic rescue snapshots independently by DocumentId and format', async () => {
    const jsonId = createDocumentId();
    const plainId = createDocumentId();
    updateRawDocumentRescue('{"dirty":true}', null, {
      documentId: jsonId,
      locator: createUntitledLocator(),
      format: 'json',
      sourceRevision: sourceRevision(2),
    });
    updateRawDocumentRescue('', null, {
      documentId: plainId,
      locator: createUntitledLocator(),
      format: 'plainText',
      sourceRevision: sourceRevision(3),
    });
    await flushRawDocumentRescueSnapshotForTests();

    expect(listRawDocumentRescueSnapshots()).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: jsonId, sourceText: '{"dirty":true}', format: 'json', sourceRevision: 2 }),
      expect.objectContaining({ documentId: plainId, sourceText: '', format: 'plainText', sourceRevision: 3 }),
    ]));
  });

  it('exports with the canonical format extension and media type', async () => {
    const documentId = createDocumentId();
    let downloadedName = '';
    const downloadedBlobs: Blob[] = [];
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      downloadedBlobs.push(blob as Blob);
      return 'blob:recovery-test';
    });
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function captureDownload(this: HTMLAnchorElement) {
      downloadedName = this.download;
    });
    updateRawDocumentRescue('# recover', null, {
      documentId,
      locator: createUntitledLocator(),
      format: 'markdown',
      sourceRevision: sourceRevision(4),
    });
    await flushRawDocumentRescueSnapshotForTests();

    expect(await exportRawDocumentRescueMarkdown(documentId)).toBe(true);
    expect(downloadedName).toBe('scie-md-rescue.md');
    expect(downloadedBlobs[0]?.type).toBe('text/markdown;charset=utf-8');

    createUrl.mockRestore();
    revokeUrl.mockRestore();
    click.mockRestore();
  });
});
