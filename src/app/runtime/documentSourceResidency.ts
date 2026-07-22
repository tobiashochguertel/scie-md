import type { DocumentId } from '../documentIdentity';
import { documentEligibleForColdClean, documentSourceResidentWeight } from '../documentRecord';
import type { WorkspaceState } from '../workspace/workspaceState';

export interface DocumentSourceResidencyBudgets {
  lowWatermarkBytes: number;
  highWatermarkBytes: number;
  hardCeilingBytes: number;
  minimumResidencyMs: number;
}

export const DOCUMENT_SOURCE_RESIDENCY_BUDGETS: Readonly<DocumentSourceResidencyBudgets> = Object.freeze({
  lowWatermarkBytes: 48 * 1024 * 1024,
  highWatermarkBytes: 64 * 1024 * 1024,
  hardCeilingBytes: 96 * 1024 * 1024,
  minimumResidencyMs: 1_000,
});

export interface DocumentSourceResidencyPlan {
  residentBytes: number;
  projectedBytes: number;
  hardPressure: boolean;
  candidates: readonly DocumentId[];
}

/** Pure source-shedding policy. The workspace aggregate remains the sole transition writer. */
export function planDocumentSourceResidency(
  state: WorkspaceState,
  activeDocumentId: DocumentId | null,
  now: number,
  budgets: Readonly<DocumentSourceResidencyBudgets> = DOCUMENT_SOURCE_RESIDENCY_BUDGETS,
): DocumentSourceResidencyPlan {
  const residentBytes = state.tabOrder.reduce((total, documentId) => {
    const record = state.documentsById[documentId];
    return total + (record ? documentSourceResidentWeight(record) : 0);
  }, 0);
  if (residentBytes <= budgets.highWatermarkBytes) {
    return { residentBytes, projectedBytes: residentBytes, hardPressure: false, candidates: [] };
  }
  const hardPressure = residentBytes > budgets.hardCeilingBytes;
  const lru = [...state.recentlyActiveDocumentIds].reverse();
  const candidates: DocumentId[] = [];
  let projectedBytes = residentBytes;
  for (const documentId of lru) {
    if (projectedBytes <= budgets.lowWatermarkBytes) break;
    if (documentId === activeDocumentId) continue;
    const record = state.documentsById[documentId];
    if (!record || !documentEligibleForColdClean(record)) continue;
    if (!hardPressure && now - record.source.residency.since < budgets.minimumResidencyMs) continue;
    candidates.push(documentId);
    projectedBytes = Math.max(0, projectedBytes - documentSourceResidentWeight(record));
  }
  return { residentBytes, projectedBytes, hardPressure, candidates };
}
