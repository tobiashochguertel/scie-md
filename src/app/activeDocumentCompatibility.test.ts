import { describe, expect, it, vi } from 'vitest';
import { clearActiveDocumentCompatibilityState } from './activeDocumentCompatibility';
import { createDocumentId } from './documentIdentity';

describe('active document compatibility state', () => {
  it('clears every active-only state class before another document becomes active', () => {
    const previousDocumentId = createDocumentId();
    const nextDocumentId = createDocumentId();
    const clearers = {
      clearEditorRuntime: vi.fn(),
      clearReviewOverlays: vi.fn(),
      clearPendingDecisions: vi.fn(),
      clearDocumentUi: vi.fn(),
    };

    expect(clearActiveDocumentCompatibilityState(previousDocumentId, nextDocumentId, clearers)).toBe(true);
    expect(clearers.clearEditorRuntime).toHaveBeenCalledOnce();
    expect(clearers.clearReviewOverlays).toHaveBeenCalledOnce();
    expect(clearers.clearPendingDecisions).toHaveBeenCalledOnce();
    expect(clearers.clearDocumentUi).toHaveBeenCalledOnce();
  });

  it('preserves active-only state while the document identity is unchanged', () => {
    const documentId = createDocumentId();
    const clearers = {
      clearEditorRuntime: vi.fn(),
      clearReviewOverlays: vi.fn(),
      clearPendingDecisions: vi.fn(),
      clearDocumentUi: vi.fn(),
    };

    expect(clearActiveDocumentCompatibilityState(documentId, documentId, clearers)).toBe(false);
    expect(clearers.clearEditorRuntime).not.toHaveBeenCalled();
    expect(clearers.clearReviewOverlays).not.toHaveBeenCalled();
    expect(clearers.clearPendingDecisions).not.toHaveBeenCalled();
    expect(clearers.clearDocumentUi).not.toHaveBeenCalled();
  });
});
