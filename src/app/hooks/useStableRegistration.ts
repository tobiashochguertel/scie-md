import { useCallback, useEffect, useState } from 'react';
import type { DocumentId } from '../documentIdentity';
import type { DocumentKeyedEditorGateway, DocumentRuntimeSlot } from '../documentEditorGateway';

export function useStableRegistration<T>(
  documentId: DocumentId,
  slot: DocumentRuntimeSlot,
  gateway: DocumentKeyedEditorGateway,
) {
  const [registration, setRegistration] = useState<{ documentId: DocumentId; handler: T } | null>(null);

  const register = useCallback((nextHandler: T | undefined) => {
    gateway.registerRuntime(documentId, slot, nextHandler);
    setRegistration((current) => {
      if (nextHandler === undefined) return current?.documentId === documentId ? null : current;
      if (current?.documentId === documentId && current.handler === nextHandler) return current;
      return { documentId, handler: nextHandler };
    });
  }, [documentId, gateway, slot]);

  useEffect(() => () => {
    gateway.registerRuntime(documentId, slot, undefined);
  }, [documentId, gateway, slot]);

  const handler = registration?.documentId === documentId ? registration.handler : undefined;
  return [handler, register] as const;
}
