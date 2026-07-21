import { describe, expect, it, vi } from 'vitest';
import { createDocumentId, sourceRevision, type DocumentId } from '../documentIdentity';
import { createDocumentEffectCoordinator } from './documentEffectCoordinator';

describe('DocumentEffectCoordinator', () => {
  it('accepts only the current operation and revision for the addressed document', () => {
    const first = createDocumentId();
    const second = createDocumentId();
    const revisions = new Map<DocumentId, ReturnType<typeof sourceRevision>>([
      [first, sourceRevision(2)],
      [second, sourceRevision(4)],
    ]);
    const effects = createDocumentEffectCoordinator((id) => revisions.get(id) ?? null);
    const staleOperation = effects.begin(first, 'document-validation')!;
    const currentOperation = effects.begin(first, 'document-validation')!;
    const otherOperation = effects.begin(second, 'document-validation')!;
    const firstMutation = vi.fn();
    const secondMutation = vi.fn();

    expect(effects.commit(staleOperation, firstMutation).accepted).toBe(false);
    expect(effects.commit(otherOperation, secondMutation).accepted).toBe(true);
    expect(firstMutation).not.toHaveBeenCalled();
    expect(secondMutation).toHaveBeenCalledTimes(1);

    revisions.set(first, sourceRevision(3));
    expect(effects.commit(currentOperation, firstMutation).accepted).toBe(false);
    expect(effects.diagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CANCELLED', documentId: first }),
      expect.objectContaining({ code: 'OPERATION_STALE', documentId: first }),
      expect.objectContaining({ code: 'REVISION_STALE', documentId: first, currentSourceRevision: 3 }),
    ]));
  });

  it('scopes cancellation to one operation and records no source content', () => {
    const first = createDocumentId();
    const second = createDocumentId();
    const effects = createDocumentEffectCoordinator(() => sourceRevision(0));
    const firstToken = effects.begin(first, 'layer-two-parse')!;
    const secondToken = effects.begin(second, 'layer-two-parse')!;

    expect(effects.cancel(firstToken)).toBe(true);
    expect(effects.isCurrent(firstToken)).toBe(false);
    expect(effects.isCurrent(secondToken)).toBe(true);
    expect(JSON.stringify(effects.diagnostics())).not.toContain('markdown');
  });
});
