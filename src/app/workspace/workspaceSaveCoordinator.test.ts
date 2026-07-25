import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentRecord, documentRecordReducer } from '../documentRecord';
import type { DocumentId } from '../documentIdentity';
import { createWorkspaceSaveCoordinator } from './workspaceSaveCoordinator';

describe('WorkspaceSaveCoordinator', () => {
  afterEach(() => vi.useRealTimers());
  it('serializes each document lane while prioritizing a waiting manual write globally', async () => {
    const first = createDocumentRecord({ sourceText: 'first' });
    const second = createDocumentRecord({ sourceText: 'second' });
    const documents = new Map<DocumentId, typeof first>([[first.id, first], [second.id, second]]);
    const coordinator = createCoordinator(documents);
    const release = deferred<void>();
    const order: string[] = [];
    const firstAutosave = coordinator.begin(first.id, 'autosave')!;
    const secondAutosave = coordinator.begin(second.id, 'autosave')!;
    const manual = coordinator.begin(first.id, 'manual')!;

    const running = coordinator.scheduleNativeWrite(firstAutosave, async () => {
      order.push('first-autosave');
      await release.promise;
    });
    const background = coordinator.scheduleNativeWrite(secondAutosave, async () => { order.push('second-autosave'); });
    const prioritized = coordinator.scheduleNativeWrite(manual, async () => { order.push('manual'); });
    release.resolve();
    await Promise.all([running, background, prioritized]);

    expect(order).toEqual(['first-autosave', 'manual', 'second-autosave']);
  });

  it('commits to the originating document after activation changes and preserves newer edits as dirty', async () => {
    const first = createDocumentRecord({ sourceText: 'saved' });
    const second = createDocumentRecord({ sourceText: 'other' });
    const documents = new Map<DocumentId, typeof first>([[first.id, first], [second.id, second]]);
    const coordinator = createCoordinator(documents);
    const token = coordinator.begin(first.id, 'manual')!;
    documents.set(first.id, documentRecordReducer(first, { type: 'sourceChanged', sourceText: 'newer edit' }));
    let activeDocumentId = second.id;

    const result = coordinator.commitOrigin(token, (current) => {
      const next = documentRecordReducer(current, { type: 'savedBaselineChanged', savedSourceText: 'saved' });
      documents.set(current.id, next);
      return next;
    });

    expect(result.accepted).toBe(true);
    expect(activeDocumentId).toBe(second.id);
    expect(documents.get(first.id)?.source.sourceText).toBe('newer edit');
    expect(documents.get(first.id)?.lifecycle.content).toBe('dirty');
  });

  it('accepts a validated origin commit whose mutation intentionally returns void', () => {
    const document = createDocumentRecord({ sourceText: 'draft' });
    const documents = new Map<DocumentId, typeof document>([[document.id, document]]);
    const coordinator = createCoordinator(documents);
    const token = coordinator.begin(document.id, 'manual')!;

    const result = coordinator.commitOrigin(token, (current) => {
      documents.set(current.id, documentRecordReducer(current, { type: 'savedBaselineChanged', savedSourceText: 'draft' }));
    });

    expect(result.accepted).toBe(true);
    expect(documents.get(document.id)?.lifecycle.content).toBe('clean');
  });

  it('fences a save whose originating locator was rekeyed', () => {
    const document = createDocumentRecord({ sourceText: 'draft' });
    const documents = new Map<DocumentId, typeof document>([[document.id, document]]);
    const coordinator = createCoordinator(documents);
    const token = coordinator.begin(document.id, 'manual')!;
    documents.set(document.id, documentRecordReducer(document, { type: 'filePathChanged', filePath: 'C:\\docs\\other.md' }));
    const mutation = vi.fn();

    expect(coordinator.commitOrigin(token, mutation).accepted).toBe(false);
    expect(mutation).not.toHaveBeenCalled();
    expect(coordinator.diagnostics()).toContainEqual(expect.objectContaining({ code: 'LOCATOR_STALE', documentId: document.id }));
  });

  it('fences stale locator work before a queued native write starts', async () => {
    const first = createDocumentRecord({ sourceText: 'first' });
    const second = createDocumentRecord({ sourceText: 'second' });
    const documents = new Map<DocumentId, typeof first>([[first.id, first], [second.id, second]]);
    const coordinator = createCoordinator(documents);
    const release = deferred<void>();
    const runningToken = coordinator.begin(first.id, 'autosave')!;
    const staleToken = coordinator.begin(second.id, 'manual')!;
    const staleWrite = vi.fn(async () => undefined);
    const running = coordinator.scheduleNativeWrite(runningToken, async () => { await release.promise; });
    const queued = coordinator.scheduleNativeWrite(staleToken, staleWrite);
    documents.set(second.id, documentRecordReducer(second, { type: 'filePathChanged', filePath: 'C:\\docs\\rekeyed.md' }));

    release.resolve();
    await running;
    await expect(queued).rejects.toThrow('Save origin changed');

    expect(staleWrite).not.toHaveBeenCalled();
    expect(coordinator.diagnostics()).toContainEqual(expect.objectContaining({ code: 'LOCATOR_STALE', documentId: second.id }));
  });

  it('retains eligible inactive autosave timers and does not schedule blocked documents', async () => {
    vi.useFakeTimers();
    const first = createDocumentRecord({ sourceText: 'first' });
    const second = createDocumentRecord({ sourceText: 'second' });
    const documents = new Map<DocumentId, typeof first>([[first.id, first], [second.id, second]]);
    const coordinator = createCoordinator(documents);
    const firstSave = vi.fn().mockResolvedValue('first.md');
    const blockedSave = vi.fn().mockResolvedValue('second.md');
    const status = vi.fn();

    coordinator.scheduleAutosave({
      documentId: first.id,
      sourceRevision: first.source.revision,
      eligible: true,
      blocked: false,
      delayMs: 600,
      maxWaitMs: 3000,
      save: firstSave,
      setStatus: status,
    });
    coordinator.scheduleAutosave({
      documentId: second.id,
      sourceRevision: second.source.revision,
      eligible: false,
      blocked: true,
      delayMs: 600,
      maxWaitMs: 3000,
      save: blockedSave,
      setStatus: status,
    });

    await vi.advanceTimersByTimeAsync(600);

    expect(firstSave).toHaveBeenCalledTimes(1);
    expect(blockedSave).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith('paused');
  });

  it('cancels a pending autosave timer and returns its lifecycle to idle', async () => {
    vi.useFakeTimers();
    const document = createDocumentRecord({ sourceText: 'draft' });
    const documents = new Map<DocumentId, typeof document>([[document.id, document]]);
    const coordinator = createCoordinator(documents);
    const save = vi.fn().mockResolvedValue('paper.md');
    const status = vi.fn();

    coordinator.scheduleAutosave({
      documentId: document.id,
      sourceRevision: document.source.revision,
      eligible: true,
      blocked: false,
      delayMs: 600,
      maxWaitMs: 3000,
      save,
      setStatus: status,
    });
    coordinator.cancelAutosave(document.id);
    await vi.advanceTimersByTimeAsync(600);

    expect(save).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith('idle');
  });

  it('coalesces an edit arriving during an autosave into one follow-up write', async () => {
    vi.useFakeTimers();
    const document = createDocumentRecord({ sourceText: 'first' });
    const documents = new Map<DocumentId, typeof document>([[document.id, document]]);
    const coordinator = createCoordinator(documents);
    const firstWrite = deferred<string | false>();
    const firstSave = vi.fn(() => firstWrite.promise);
    const followUpSave = vi.fn().mockResolvedValue('paper.md');
    const candidate = {
      documentId: document.id,
      sourceRevision: document.source.revision,
      eligible: true,
      blocked: false,
      delayMs: 10,
      maxWaitMs: 100,
      save: firstSave,
      setStatus: vi.fn(),
    };
    coordinator.scheduleAutosave(candidate);
    await vi.advanceTimersByTimeAsync(10);

    coordinator.scheduleAutosave({ ...candidate, save: followUpSave });
    await vi.advanceTimersByTimeAsync(10);
    firstWrite.resolve('paper.md');
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(firstSave).toHaveBeenCalledTimes(1);
    expect(followUpSave).toHaveBeenCalledTimes(1);
  });

  it('provides deterministic command-layer Save All ordering', async () => {
    const first = createDocumentRecord({ sourceText: 'first' });
    const second = createDocumentRecord({ sourceText: 'second' });
    const documents = new Map<DocumentId, typeof first>([[first.id, first], [second.id, second]]);
    const coordinator = createCoordinator(documents);
    const order: DocumentId[] = [];
    coordinator.registerActor(first.id, { save: async () => { order.push(first.id); return 'first.md'; } });
    coordinator.registerActor(second.id, { save: async () => { order.push(second.id); return false; } });

    const results = await coordinator.saveAll([second.id, first.id]);

    expect(order).toEqual([second.id, first.id]);
    expect(results.get(second.id)).toBe(false);
    expect(results.get(first.id)).toBe('first.md');
  });
});

function createCoordinator(documents: Map<DocumentId, ReturnType<typeof createDocumentRecord>>) {
  return createWorkspaceSaveCoordinator(
    (id) => documents.get(id) ?? null,
    (id, mutation) => {
      const current = documents.get(id);
      return current ? mutation(current) : undefined;
    },
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
