import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EditorAdapter, EditorSurface } from '../components/editorAdapter';
import { DocumentKeyedEditorGateway } from './documentEditorGateway';
import { createDocumentId, sourceRevision } from './documentIdentity';
import { recordDocumentEdit, undoDocumentHistory } from '../markdown/documentHistory';
import { DocumentRuntimeRegistry } from './runtime/documentRuntimeRegistry';

describe('DocumentKeyedEditorGateway', () => {
  it('keeps editor state access behind the one primary gateway writer', () => {
    const roots = [join(process.cwd(), 'src', 'app'), join(process.cwd(), 'src', 'services')];
    const offenders = roots.flatMap(sourceFiles).filter((path) => {
      if (path.endsWith('documentEditorGateway.ts')) return false;
      return readFileSync(path, 'utf8').includes('visualEditorStateSync');
    });
    expect(offenders).toEqual([]);
  });

  it('targets two documents correctly regardless of registration order', () => {
    const gateway = new DocumentKeyedEditorGateway();
    const first = createDocumentId();
    const second = createDocumentId();
    gateway.registerAdapter(second, 'visual', adapter('visual', '# Second'));
    gateway.registerAdapter(first, 'source', adapter('source', '# First'));

    expect(gateway.read(first)?.markdown).toBe('# First');
    expect(gateway.read(second)?.markdown).toBe('# Second');
  });

  it('keeps insert, jump, find, and history handlers document-addressed', () => {
    const gateway = new DocumentKeyedEditorGateway();
    const first = createDocumentId();
    const second = createDocumentId();
    const firstInsert = vi.fn();
    const secondInsert = vi.fn();
    gateway.registerRuntime(first, 'sourceInsert', firstInsert);
    gateway.registerRuntime(second, 'sourceInsert', secondInsert);

    gateway.getRuntime<() => void>(second, 'sourceInsert')?.();
    expect(firstInsert).not.toHaveBeenCalled();
    expect(secondInsert).toHaveBeenCalledTimes(1);
    expect(gateway.getRuntime(first, 'visualFind')).toBeUndefined();
  });

  it('flushes, commits, snapshots, then deactivates while retaining view and isolated history', () => {
    const gateway = new DocumentKeyedEditorGateway();
    const first = createDocumentId();
    const second = createDocumentId();
    const events: string[] = [];
    const firstAdapter = adapter('visual', '# Dirty', true, events);
    gateway.registerAdapter(first, 'visual', firstAdapter);
    gateway.registerRuntime(first, 'visualInsert', vi.fn());
    recordDocumentEdit(gateway.historyFor(first), '# First previous');
    recordDocumentEdit(gateway.historyFor(second), '# Second previous');

    expect(gateway.deactivate(first, (markdown) => events.push(`commit:${markdown}`))).toBe('# Dirty');
    expect(events).toEqual(['flush', 'commit:# Dirty', 'markCommitted', 'snapshot']);
    expect(gateway.read(first)).toBeNull();
    expect(gateway.getRuntime(first, 'visualInsert')).toBeUndefined();
    expect(gateway.getViewSnapshot(first, 'visual')).toMatchObject({ scrollTop: 42, selection: { from: 2, to: 5 } });
    expect(undoDocumentHistory(gateway.historyFor(first), '# Dirty')).toBe('# First previous');
    expect(undoDocumentHistory(gateway.historyFor(second), '# Second current')).toBe('# Second previous');

    const remounted = adapter('visual', '# Dirty');
    gateway.registerAdapter(first, 'visual', remounted);
    expect(remounted.restoreView).toHaveBeenCalledWith(gateway.getViewSnapshot(first, 'visual'));
  });

  it('deactivates a source editor without rematerializing text already handed to the aggregate as patches', () => {
    const gateway = new DocumentKeyedEditorGateway();
    const documentId = createDocumentId();
    const events: string[] = [];
    const sourceAdapter = adapter('source', '# aggregate already current', true, events);
    const commit = vi.fn();
    gateway.registerAdapter(documentId, 'source', sourceAdapter);
    expect(gateway.deactivate(documentId, commit)).toBeNull();
    expect(sourceAdapter.flushPendingEdits).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(events).toEqual(['snapshot']);
  });

  it('treats a revision-matched exact visual state as warm and reattaches it through the gateway', () => {
    const registry = new DocumentRuntimeRegistry({
      lowWatermarkBytes: 8 * 1024 * 1024,
      highWatermarkBytes: 12 * 1024 * 1024,
      hardCeilingBytes: 24 * 1024 * 1024,
      reservedActiveHeadroomBytes: 4 * 1024 * 1024,
      minimumResidencyMs: 0,
    });
    const gateway = new DocumentKeyedEditorGateway(registry);
    const documentId = createDocumentId();
    const parkedState = { proseMirror: 'state' };
    const visual = adapter('visual', '# Visual');
    visual.runtimeKey = () => ({
      documentId,
      sourceRevision: sourceRevision(3),
      surface: 'visual',
      configurationFingerprint: 'visual-host-v1',
    });
    visual.suspendRuntime = () => ({
      key: visual.runtimeKey!()!,
      state: parkedState,
      scrollTop: 42,
      focused: false,
      byteWeight: 1024,
      historyBytes: 128,
      kind: 'exact-state',
    });
    gateway.registerAdapter(documentId, 'visual', visual);
    gateway.deactivate(documentId, vi.fn());

    expect(gateway.hasWarmRuntime(documentId, 'visual')).toBe(true);

    const reattached = adapter('visual', '# Visual');
    reattached.runtimeKey = visual.runtimeKey;
    reattached.attachRuntime = vi.fn((runtime) => runtime.state === parkedState);
    reattached.rebuildRuntime = vi.fn(() => true);
    gateway.registerAdapter(documentId, 'visual', reattached);

    expect(reattached.attachRuntime).toHaveBeenCalledWith(expect.objectContaining({
      state: parkedState,
      kind: 'exact-state',
    }));
    expect(reattached.rebuildRuntime).not.toHaveBeenCalled();
    expect(registry.metrics()).toMatchObject({ hits: 1, misses: 1, entryCount: 0 });
  });

  it('fails safely for missing and stale registrations and focuses only the addressed editor', () => {
    const gateway = new DocumentKeyedEditorGateway();
    const active = createDocumentId();
    const missing = createDocumentId();
    const activeAdapter = adapter('source', '# Active');
    gateway.registerAdapter(active, 'source', activeAdapter);

    expect(gateway.flush(missing)).toBeNull();
    expect(gateway.focus(missing)).toBe(false);
    expect(gateway.focus(active)).toBe(true);
    expect(activeAdapter.focus).toHaveBeenCalledTimes(1);
    const replacement = adapter('source', '# Replacement');
    gateway.registerAdapter(active, 'source', replacement);
    gateway.unregisterAdapter(active, 'source', activeAdapter);
    expect(gateway.read(active)?.markdown).toBe('# Replacement');
    gateway.registerAdapter(active, 'source', undefined);
    expect(gateway.read(active)).toBeNull();
  });
});

function adapter(surface: EditorSurface, markdown: string, changed = false, events: string[] = []): EditorAdapter {
  return {
    surface,
    read: vi.fn(() => ({ surface, markdown, changed })),
    flushPendingEdits: vi.fn(() => {
      events.push('flush');
      return { surface, markdown, changed, markCommitted: () => events.push('markCommitted') };
    }),
    replace: vi.fn(() => true),
    focus: vi.fn(),
    captureView: vi.fn(() => {
      events.push('snapshot');
      return { surface, selection: { from: 2, to: 5 }, scrollTop: 42 };
    }),
    restoreView: vi.fn(() => true),
  };
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) return [];
    if (entry.name.includes('.test.')) return [];
    return [path];
  });
}
