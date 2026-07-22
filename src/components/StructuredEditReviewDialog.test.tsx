import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStructuredEditReviewPlan, planJsonVisualEdit, structuredEditTransactionFromJsonEdit } from '@sciemd/core';
import { StructuredEditReviewDialog } from './StructuredEditReviewDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

describe('StructuredEditReviewDialog', () => {
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('renders the guarded preview and exposes explicit apply and cancel decisions', () => {
    const source = '{"value":1}\n';
    const intent = { kind: 'deleteObjectField' as const, path: ['value'] };
    const edit = planJsonVisualEdit(source, intent);
    const transaction = structuredEditTransactionFromJsonEdit(source, intent, edit)!;
    const reviewPlan = createStructuredEditReviewPlan({ source, transaction, documentEpoch: 1 })!;
    const onApply = vi.fn(); const onCancel = vi.fn();
    act(() => root.render(<StructuredEditReviewDialog open reviewPlan={reviewPlan} onApply={onApply} onCancel={onCancel} />));
    expect(container.textContent).toContain('Before');
    expect(container.textContent).toContain('After');
    const buttons = Array.from(container.querySelectorAll('button'));
    act(() => buttons.find((button) => button.textContent === reviewPlan.actionLabel)?.click());
    act(() => buttons.find((button) => button.textContent === 'Cancel')?.click());
    expect(onApply).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
