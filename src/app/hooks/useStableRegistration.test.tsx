import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocumentId } from '../documentIdentity';
import { DocumentKeyedEditorGateway } from '../documentEditorGateway';
import { useStableRegistration } from './useStableRegistration';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('document-keyed stable registration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('clears the compatibility slot before rebinding another document', () => {
    const registry = new DocumentKeyedEditorGateway();
    const firstId = createDocumentId();
    const secondId = createDocumentId();
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    let register: ((handler: (() => void) | undefined) => void) | null = null;
    let projectedHandler: (() => void) | undefined;

    render(firstId);
    act(() => register?.(firstHandler));
    expect(registry.getRuntime(firstId, 'sourceInsert')).toBe(firstHandler);
    expect(projectedHandler).toBe(firstHandler);

    render(secondId);
    expect(registry.getRuntime(firstId, 'sourceInsert')).toBeUndefined();
    expect(registry.getRuntime(secondId, 'sourceInsert')).toBeUndefined();
    expect(projectedHandler).toBeUndefined();

    act(() => register?.(secondHandler));
    expect(registry.getRuntime(secondId, 'sourceInsert')).toBe(secondHandler);
    expect(projectedHandler).toBe(secondHandler);

    act(() => root.unmount());
    expect(registry.getRuntime(secondId, 'sourceInsert')).toBeUndefined();

    function render(documentId: ReturnType<typeof createDocumentId>) {
      act(() => root.render(
        <Harness
          documentId={documentId}
          registry={registry}
          onRegister={(next) => { register = next; }}
          onHandler={(next) => { projectedHandler = next; }}
        />,
      ));
    }
  });
});

function Harness({
  documentId,
  registry,
  onRegister,
  onHandler,
}: {
  documentId: ReturnType<typeof createDocumentId>;
  registry: DocumentKeyedEditorGateway;
  onRegister: (register: (handler: (() => void) | undefined) => void) => void;
  onHandler: (handler: (() => void) | undefined) => void;
}) {
  const [handler, register] = useStableRegistration<() => void>(documentId, 'sourceInsert', registry);
  onRegister(register);
  onHandler(handler);
  return null;
}
