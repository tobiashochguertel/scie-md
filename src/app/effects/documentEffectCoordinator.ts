import type { DocumentId, SourceRevision } from '../documentIdentity';
import { sourceRevision } from '../documentIdentity';
import type { SourceSnapshotLease } from '../source/sourceSnapshotService';

export type DocumentEffectKind =
  | 'open'
  | 'recovery'
  | 'source-format-diagnostics'
  | 'layer-two-parse'
  | 'bibliography-refresh'
  | 'linked-variable-refresh'
  | 'document-validation'
  | 'document-metrics'
  | 'markdown-artifacts'
  | 'json-schema-discovery'
  | 'conflict-review'
  | 'locator-resolution'
  | 'asset-insertion';

export type EffectOperationId = string & { readonly __effectOperationId: unique symbol };

export interface EffectToken {
  documentId: DocumentId;
  operationId: EffectOperationId;
  sourceRevision: SourceRevision;
}

export interface DocumentEffectTarget {
  documentId: DocumentId;
  effects: DocumentEffectCoordinator;
  sourceRevision?: SourceRevision;
  sourceByteLength?: number;
  leaseSource?: (revision: SourceRevision) => SourceSnapshotLease | null;
}

export interface EffectDiagnostic {
  sequence: number;
  code: 'TARGET_MISSING' | 'REVISION_STALE' | 'OPERATION_STALE' | 'CANCELLED';
  kind: DocumentEffectKind;
  documentId: DocumentId;
  operationId: EffectOperationId;
  sourceRevision: SourceRevision;
  currentSourceRevision: SourceRevision | null;
}

export interface EffectCommitResult<T> {
  accepted: boolean;
  value?: T;
}

export interface DocumentEffectCoordinator {
  begin(documentId: DocumentId, kind: DocumentEffectKind): EffectToken | null;
  isCurrent(token: EffectToken): boolean;
  apply<T>(token: EffectToken, mutation: () => T): EffectCommitResult<T>;
  commit<T>(token: EffectToken, mutation: () => T): EffectCommitResult<T>;
  cancel(token: EffectToken): boolean;
  cancelDocument(documentId: DocumentId): number;
  diagnostics(): readonly EffectDiagnostic[];
}

interface ActiveEffect {
  kind: DocumentEffectKind;
  token: EffectToken;
}

const MAX_EFFECT_DIAGNOSTICS = 100;

export function createDocumentEffectCoordinator(
  getSourceRevision: (documentId: DocumentId) => SourceRevision | null,
): DocumentEffectCoordinator {
  const activeByDocument = new Map<DocumentId, Map<DocumentEffectKind, ActiveEffect>>();
  const diagnostics: EffectDiagnostic[] = [];
  let operationSequence = 0;
  let diagnosticSequence = 0;

  const record = (
    code: EffectDiagnostic['code'],
    active: ActiveEffect,
    currentSourceRevision: SourceRevision | null,
  ) => {
    diagnostics.push({
      sequence: ++diagnosticSequence,
      code,
      kind: active.kind,
      documentId: active.token.documentId,
      operationId: active.token.operationId,
      sourceRevision: active.token.sourceRevision,
      currentSourceRevision,
    });
    if (diagnostics.length > MAX_EFFECT_DIAGNOSTICS) diagnostics.splice(0, diagnostics.length - MAX_EFFECT_DIAGNOSTICS);
  };

  const find = (token: EffectToken): ActiveEffect | null => {
    const channels = activeByDocument.get(token.documentId);
    if (!channels) return null;
    for (const active of channels.values()) {
      if (active.token.operationId === token.operationId) return active;
    }
    return null;
  };

  const validate = (token: EffectToken, report: boolean): ActiveEffect | null => {
    const currentRevision = getSourceRevision(token.documentId);
    const active = find(token);
    if (!active) {
      if (report) record('OPERATION_STALE', { kind: operationKind(token.operationId), token }, currentRevision);
      return null;
    }
    if (currentRevision === null) {
      if (report) record('TARGET_MISSING', active, null);
      return null;
    }
    if (currentRevision !== token.sourceRevision) {
      if (report) record('REVISION_STALE', active, currentRevision);
      return null;
    }
    return active;
  };

  return {
    begin(documentId, kind) {
      const revision = getSourceRevision(documentId);
      if (revision === null) return null;
      const token: EffectToken = {
        documentId,
        operationId: `${kind}:${++operationSequence}` as EffectOperationId,
        sourceRevision: sourceRevision(revision),
      };
      const channels = activeByDocument.get(documentId) ?? new Map<DocumentEffectKind, ActiveEffect>();
      const previous = channels.get(kind);
      if (previous) record('CANCELLED', previous, revision);
      channels.set(kind, { kind, token });
      activeByDocument.set(documentId, channels);
      return token;
    },
    isCurrent(token) {
      return validate(token, false) !== null;
    },
    apply(token, mutation) {
      if (!validate(token, true)) return { accepted: false };
      return { accepted: true, value: mutation() };
    },
    commit(token, mutation) {
      const active = validate(token, true);
      if (!active) return { accepted: false };
      const value = mutation();
      const channels = activeByDocument.get(token.documentId);
      if (channels?.get(active.kind)?.token.operationId === token.operationId) {
        channels.delete(active.kind);
        if (channels.size === 0) activeByDocument.delete(token.documentId);
      }
      return { accepted: true, value };
    },
    cancel(token) {
      const active = find(token);
      if (!active) return false;
      const channels = activeByDocument.get(token.documentId);
      if (channels?.get(active.kind)?.token.operationId !== token.operationId) return false;
      channels.delete(active.kind);
      if (channels.size === 0) activeByDocument.delete(token.documentId);
      record('CANCELLED', active, getSourceRevision(token.documentId));
      return true;
    },
    cancelDocument(documentId) {
      const channels = activeByDocument.get(documentId);
      if (!channels) return 0;
      const revision = getSourceRevision(documentId);
      for (const active of channels.values()) record('CANCELLED', active, revision);
      const count = channels.size;
      activeByDocument.delete(documentId);
      return count;
    },
    diagnostics: () => diagnostics.slice(),
  };
}

function operationKind(operationId: EffectOperationId): DocumentEffectKind {
  return operationId.slice(0, operationId.lastIndexOf(':')) as DocumentEffectKind;
}
