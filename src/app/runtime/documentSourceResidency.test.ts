import { describe, expect, it } from 'vitest';
import { createDocumentId, fallbackFileLocator } from '../documentIdentity';
import { createDocumentRecord, documentRecordReducer } from '../documentRecord';
import { createWorkspaceState, workspaceReducer } from '../workspace/workspaceState';
import { planDocumentSourceResidency } from './documentSourceResidency';
import { DEFAULT_METADATA } from '../documentState';

const mib = 1024 * 1024;
const metadata = (bytes: number) => ({
  ...DEFAULT_METADATA,
  lastKnownMtimeMs: 1,
  lastKnownSizeBytes: bytes,
  contentHash: `hash:${bytes}`,
  originalByteHash: `bytes:${bytes}`,
});

function cleanFile(bytes: number, since: number) {
  const id = createDocumentId();
  return createDocumentRecord({
    id,
    locator: fallbackFileLocator(`C:\\fixtures\\${String(id).slice(-8)}-${bytes}.md`),
    sourceText: 'x'.repeat(bytes / 2),
    fileBaseline: metadata(bytes),
    residentSince: since,
  });
}

describe('document source residency policy', () => {
  it('selects eligible inactive documents in LRU order until the low watermark', () => {
    const first = cleanFile(40 * mib, 0);
    const second = cleanFile(40 * mib, 0);
    const active = cleanFile(40 * mib, 0);
    let state = createWorkspaceState(first, { multiDocumentWorkspaceEnabled: true, activationSurface: { id: 'tabs', kind: 'production-tabs' } });
    state = workspaceReducer(state, { type: 'openDocument', document: second });
    state = workspaceReducer(state, { type: 'openDocument', document: active });
    const plan = planDocumentSourceResidency(state, active.id, 2_000, {
      lowWatermarkBytes: 30 * mib,
      highWatermarkBytes: 40 * mib,
      hardCeilingBytes: 100 * mib,
      minimumResidencyMs: 1_000,
    });
    expect(plan.candidates).toEqual([first.id, second.id]);
    expect(plan.projectedBytes).toBeGreaterThan(0);
  });

  it('never selects dirty, untitled, conflicted, saving, recovery-only, or active source', () => {
    const active = cleanFile(20 * mib, 0);
    const dirty = documentRecordReducer(cleanFile(20 * mib, 0), { type: 'sourceChanged', sourceText: 'dirty' });
    const untitled = createDocumentRecord({ sourceText: 'x'.repeat(10 * mib), residentSince: 0 });
    let state = createWorkspaceState(active, { multiDocumentWorkspaceEnabled: true, activationSurface: { id: 'tabs', kind: 'production-tabs' } });
    state = workspaceReducer(state, { type: 'openDocument', document: dirty });
    state = workspaceReducer(state, { type: 'openDocument', document: untitled });
    state = workspaceReducer(state, { type: 'activateDocument', documentId: active.id });
    const plan = planDocumentSourceResidency(state, active.id, 2_000, {
      lowWatermarkBytes: 1,
      highWatermarkBytes: 2,
      hardCeilingBytes: 3,
      minimumResidencyMs: 0,
    });
    expect(plan.candidates).toEqual([]);
  });

  it('honors minimum residency except above the hard ceiling', () => {
    const old = cleanFile(20 * mib, 1_500);
    const active = cleanFile(20 * mib, 1_500);
    let state = createWorkspaceState(old, { multiDocumentWorkspaceEnabled: true, activationSurface: { id: 'tabs', kind: 'production-tabs' } });
    state = workspaceReducer(state, { type: 'openDocument', document: active });
    const soft = planDocumentSourceResidency(state, active.id, 2_000, {
      lowWatermarkBytes: 1,
      highWatermarkBytes: 2,
      hardCeilingBytes: 100 * mib,
      minimumResidencyMs: 1_000,
    });
    expect(soft.candidates).toEqual([]);
    const hard = planDocumentSourceResidency(state, active.id, 2_000, {
      lowWatermarkBytes: 1,
      highWatermarkBytes: 2,
      hardCeilingBytes: 3,
      minimumResidencyMs: 1_000,
    });
    expect(hard.candidates).toEqual([old.id]);
  });
});
