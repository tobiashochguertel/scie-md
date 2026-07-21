import { act, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeParseScienfyDocument } from '@sciemd/core';
import { createDocumentEffectCoordinator } from '../effects/documentEffectCoordinator';
import { createDocumentId, sourceRevision, type DocumentId } from '../documentIdentity';
import { useDocumentValidator } from './useDocumentValidator';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useDocumentValidator', () => {
  let root: Root;
  let container: HTMLDivElement;
  const revisions = new Map<DocumentId, ReturnType<typeof sourceRevision>>();
  const effects = createDocumentEffectCoordinator((id) => revisions.get(id) ?? null);
  let latest: ReturnType<typeof useDocumentValidator> | null;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    revisions.clear();
    vi.useRealTimers();
  });

  it('does not project a delayed validation result onto another document', () => {
    const first = createDocumentId();
    const second = createDocumentId();
    revisions.set(first, sourceRevision(0));
    revisions.set(second, sourceRevision(0));
    render(first, 'one two three');
    render(second, 'second');

    act(() => vi.advanceTimersByTime(500));

    expect(latest?.validation.wordCount).toBe(1);
    expect(latest?.validationPending).toBe(false);
  });

  it('rejects the old timer when the same document revision advances', () => {
    const documentId = createDocumentId();
    revisions.set(documentId, sourceRevision(0));
    render(documentId, 'old words');
    revisions.set(documentId, sourceRevision(1));
    render(documentId, 'new');

    act(() => vi.advanceTimersByTime(500));

    expect(latest?.validation.wordCount).toBe(1);
    expect(effects.diagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId, code: 'CANCELLED' }),
    ]));
  });

  function render(documentId: DocumentId, markdown: string) {
    act(() => root.render(<Harness documentId={documentId} markdown={markdown} />));
  }

  function Harness({ documentId, markdown }: { documentId: DocumentId; markdown: string }) {
    const parsed = useMemo(() => safeParseScienfyDocument(markdown), [markdown]);
    const state = useDocumentValidator(
      { documentId, effects },
      markdown,
      parsed,
      markdown,
    );
    latest = state;
    return null;
  }
});
