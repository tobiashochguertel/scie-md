import { useCallback, useEffect, useRef } from 'react';
import type { DocumentId } from '../documentIdentity';
import type { WorkspaceExternalChangeCoordinator } from '../workspace/workspaceExternalChangeCoordinator';

interface UseExternalChangeDetectionOptions {
  documentId: DocumentId;
  coordinator: WorkspaceExternalChangeCoordinator;
  onCloudPlaceholder?: (message: string) => void;
}

/**
 * Active-document compatibility projection for the workspace-owned watcher.
 * Listener, registration, polling, retry, coalescing, and state mutation remain
 * owned by one WorkspaceExternalChangeCoordinator regardless of editor mounts.
 */
export function useExternalChangeDetection({
  documentId,
  coordinator,
  onCloudPlaceholder,
}: UseExternalChangeDetectionOptions) {
  const onCloudPlaceholderRef = useRef(onCloudPlaceholder);
  useEffect(() => { onCloudPlaceholderRef.current = onCloudPlaceholder; }, [onCloudPlaceholder]);

  useEffect(() => coordinator.subscribe((event) => {
    if (event.documentId !== documentId) return;
    if (event.type === 'access' && event.detail === 'cloud-unavailable') {
      onCloudPlaceholderRef.current?.('This document is in a cloud placeholder state. ScieMD will wait until it is locally available.');
    }
  }), [coordinator, documentId]);

  return useCallback(() => coordinator.checkDocument(documentId), [coordinator, documentId]);
}
