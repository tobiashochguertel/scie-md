import { describe, expect, it } from 'vitest';
import { validateWorkspaceManifestPayload } from './workspaceManifestSchema';

function manifest(journalEntry: Record<string, unknown>) {
  return {
    tabOrder: ['doc'], activeDocumentId: 'doc', recentlyActiveDocumentIds: ['doc'], recoveryReferences: [], invalidEntries: [], savedAt: 1,
    documents: [{
      documentId: 'doc', locator: { kind: 'untitled', untitledId: 'doc' }, format: 'json',
      view: { mode: 'visual', preferredStructuredSurface: 'tree', selectedStructuredPath: '$', activeStructuredNavigationTargetKey: null, explicitJsonSchemaPath: null, selectedVariableName: null, authorshipMarks: [], structuredEditJournal: [journalEntry] },
      presentation: { visualStyle: null, documentType: null }, recoveryReference: null,
    }],
  };
}

const legacy = { id: 'legacy', format: 'json', operationLabel: 'Edit', targetLabel: '$.value', previewLabel: 'Updated', riskLabel: 'Replace', appliedAt: 1, line: 1, column: 1 };

describe('workspace manifest structured journal migration', () => {
  it('migrates legacy journal entries to the current registry-backed envelope', () => {
    const result = validateWorkspaceManifestPayload(manifest(legacy));
    expect(result?.documents[0]?.view.structuredEditJournal[0]).toMatchObject({ schemaVersion: 2, format: 'json', operationId: 'legacy-unknown', sourceRevision: 0 });
  });

  it('accepts current entries and quarantines unknown future journal versions', () => {
    const current = { ...legacy, schemaVersion: 2, operationId: 'replaceScalar', transactionId: 'tx', sourceRevision: 2,
      sourceFingerprint: 'sha256:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      planFingerprint: 'sha256:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    expect(validateWorkspaceManifestPayload(manifest(current))).not.toBeNull();
    expect(validateWorkspaceManifestPayload(manifest({ ...current, schemaVersion: 3 }))).toMatchObject({
      documents: [], invalidEntries: [{ documentId: 'doc', reason: 'invalid-shape' }],
    });
  });
});
