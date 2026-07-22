import type { DocumentId } from './documentIdentity';

export interface ActiveDocumentCompatibilityClearers {
  clearEditorRuntime: () => void;
  clearReviewOverlays: () => void;
  clearPendingDecisions: () => void;
  clearDocumentUi: () => void;
}

/**
 * Clears state that is intentionally compatible with only the active document.
 * The caller remains the single writer for each state surface; this function
 * only makes the document-change policy explicit and independently testable.
 */
export function clearActiveDocumentCompatibilityState(
  previousDocumentId: DocumentId,
  nextDocumentId: DocumentId,
  clearers: ActiveDocumentCompatibilityClearers,
): boolean {
  if (previousDocumentId === nextDocumentId) return false;
  clearers.clearEditorRuntime();
  clearers.clearReviewOverlays();
  clearers.clearPendingDecisions();
  clearers.clearDocumentUi();
  return true;
}
