import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentRecord } from '../documentRecord';
import { sourceRevision } from '../documentIdentity';
import { createWorkspaceState } from './workspaceState';
import { createWorkspaceStore } from './workspaceStore';

describe('WorkspaceStore interactive source notification', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('commits source authority immediately and batches view notification to the next frame', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const document = createDocumentRecord({ sourceText: 'alpha', savedSourceText: 'alpha' });
    const store = createWorkspaceStore(createWorkspaceState(document));
    const listener = vi.fn();
    store.subscribe(listener);

    const next = store.dispatchInteractiveSourceChange({
      documentId: document.id,
      expectedRevision: sourceRevision(0),
      changes: [{ from: 5, to: 5, insert: '!' }],
    });

    expect(next.documentsById[document.id].source.revision).toBe(sourceRevision(1));
    expect(store.getState()).toBe(next);
    expect(next.documentsById[document.id].lifecycle).toMatchObject({ content: 'dirty', recovery: 'pending' });
    expect(listener).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);

    frames.shift()?.(16);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('coalesces consecutive edits and lets an ordinary command publish the latest state immediately', () => {
    const frames: FrameRequestCallback[] = [];
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);
    const document = createDocumentRecord({ sourceText: 'alpha', savedSourceText: 'alpha' });
    const store = createWorkspaceStore(createWorkspaceState(document));
    const listener = vi.fn();
    store.subscribe(listener);

    store.dispatchInteractiveSourceChange({
      documentId: document.id,
      expectedRevision: sourceRevision(0),
      changes: [{ from: 5, to: 5, insert: '!' }],
    });
    store.dispatchInteractiveSourceChange({
      documentId: document.id,
      expectedRevision: sourceRevision(1),
      changes: [{ from: 6, to: 6, insert: '?' }],
    });
    expect(frames).toHaveLength(1);

    store.dispatch({ type: 'updateDocument', documentId: document.id, action: { type: 'modeChanged', mode: 'source' } });
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().documentsById[document.id].source.revision).toBe(sourceRevision(2));
  });
});
