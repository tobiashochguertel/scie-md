import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { safeParseScienfyDocument } from '@sciemd/core';
import type { DocumentDiagnostic } from '@sciemd/core';
import { cancelScienfyDocumentParse, isTransientParserWorkerFailure, parseScienfyDocumentAsync } from '../../domain/document/documentParserWorker';
import { parseVariableDataFile } from '@sciemd/core';
import type { VariableDefinition } from '@sciemd/core';
import { resolveRelativeMarkdownAsset } from '../../markdown/documentIntelligence';
import type { DocumentHost } from '../host/documentHost';
import { isTauriRuntime } from '../runtime';
import { canonicalComparisonKey } from '../documentIdentity';
import type { DocumentEffectTarget } from '../effects/documentEffectCoordinator';

export function useLayerTwoDocument(target: DocumentEffectTarget, markdown: string, filePath: string | null, host: Pick<DocumentHost, 'file' | 'watcher'>) {
  const deferredMarkdown = useDeferredValue(markdown);
  const bibliographyWatchScopeRef = useRef(`bibliography:${Math.random().toString(36).slice(2)}`);
  const variableWatchScopeRef = useRef(`variables:${Math.random().toString(36).slice(2)}`);
  const bibliographyOwnerRef = useRef(target.documentId);
  const variableOwnerRef = useRef(target.documentId);
  const [bibliographyText, setBibliographyText] = useState('');
  const [bibliographyDiagnostics, setBibliographyDiagnostics] = useState<DocumentDiagnostic[]>([]);
  const [bibliographyReloadToken, setBibliographyReloadToken] = useState(0);
  const [bibliographyLoading, setBibliographyLoading] = useState(false);
  const [documentParsingPending, setDocumentParsingPending] = useState(false);
  const [externalVariableDefinitions, setExternalVariableDefinitions] = useState<VariableDefinition[]>([]);
  const [variableFileDiagnostics, setVariableFileDiagnostics] = useState<DocumentDiagnostic[]>([]);
  const [linkedVariableLoading, setLinkedVariableLoading] = useState(false);
  const parseOptions = useMemo(
    () => ({
      bibtex: bibliographyOwnerRef.current === target.documentId ? bibliographyText : '',
      variableDefinitions: variableOwnerRef.current === target.documentId ? externalVariableDefinitions : [],
      extraDiagnostics: [
        ...(bibliographyOwnerRef.current === target.documentId ? bibliographyDiagnostics : []),
        ...(variableOwnerRef.current === target.documentId ? variableFileDiagnostics : []),
      ],
    }),
    [bibliographyDiagnostics, bibliographyText, externalVariableDefinitions, target.documentId, variableFileDiagnostics],
  );
  const [parsedState, setParsedState] = useState(() => ({
    documentId: target.documentId,
    markdown,
    document: safeParseScienfyDocument(markdown, parseOptions),
  }));
  const fallbackDocument = useMemo(
    () => safeParseScienfyDocument(markdown, parseOptions),
    [markdown, parseOptions, target.documentId],
  );
  const liveDocument = parsedState.documentId === target.documentId
    ? parsedState.document
    : fallbackDocument;

  useEffect(() => {
    const token = target.effects.begin(target.documentId, 'layer-two-parse');
    if (!token) return undefined;
    target.effects.apply(token, () => setDocumentParsingPending(true));
    void parseScienfyDocumentAsync(deferredMarkdown, parseOptions, token)
      .then((document) => {
        target.effects.commit(token, () => {
          setParsedState({ documentId: target.documentId, markdown: deferredMarkdown, document });
          setDocumentParsingPending(false);
        });
      })
      .catch((error) => {
        if (!target.effects.isCurrent(token)) return;
        if (isTransientParserWorkerFailure(error)) {
          console.warn('Document parser worker could not complete; keeping previous parse until the next successful worker result.', error);
          target.effects.commit(token, () => setDocumentParsingPending(false));
          return;
        }
        target.effects.commit(token, () => {
          setParsedState({ documentId: target.documentId, markdown: deferredMarkdown, document: safeParseScienfyDocument(deferredMarkdown, parseOptions) });
          setDocumentParsingPending(false);
        });
      });
    return () => {
      cancelScienfyDocumentParse(token);
      target.effects.cancel(token);
    };
  }, [deferredMarkdown, parseOptions, target.documentId, target.effects]);

  const bibliographyFilesKey = liveDocument.bibliographyFiles.join('|');
  const variableFilesKey = liveDocument.variableFiles.join('|');
  const bibliographyFiles = useMemo(() => liveDocument.bibliographyFiles, [bibliographyFilesKey]);
  const variableFiles = useMemo(() => liveDocument.variableFiles, [variableFilesKey]);
  const reloadBibliography = useCallback(() => {
    setBibliographyReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    const effectToken = target.effects.begin(target.documentId, 'bibliography-refresh');
    if (!effectToken) return undefined;
    const mutate = (mutation: () => void) => target.effects.apply(effectToken, () => {
      bibliographyOwnerRef.current = target.documentId;
      mutation();
    });
    let cancelled = false;
    let requestSequence = 0;
    let previousFileSignature = '';
    let hasLoaded = false;
    let interval: number | null = null;
    let refreshInFlight = false;
    let refreshQueued = false;
    let unlisten: (() => void) | undefined;
    let watchDisposed = false;
    if (!isTauriRuntime() || !filePath || bibliographyFiles.length === 0) {
      target.effects.commit(effectToken, () => {
        bibliographyOwnerRef.current = target.documentId;
        setBibliographyText((current) => current === '' ? current : '');
        setBibliographyDiagnostics((current) => current.length === 0 ? current : []);
        setBibliographyLoading(false);
      });
      return undefined;
    }
    mutate(() => setBibliographyDiagnostics((current) => current.length === 0 ? current : []));

    const loadBibliography = async () => {
      if (document.visibilityState === 'hidden') return;
      const sequence = ++requestSequence;
      mutate(() => setBibliographyLoading(true));
      try {
        const signature = await linkedFilesSignature(host.file, filePath, bibliographyFiles);
        if (cancelled || sequence !== requestSequence || !target.effects.isCurrent(effectToken)) return;
        if (hasLoaded && signature && signature === previousFileSignature) return;
        const results = await Promise.all(bibliographyFiles.map(async (bibliographyPath) => {
          const resolvedPath = resolveRelativeMarkdownAsset(filePath, bibliographyPath);
          if (!resolvedPath) {
            return {
              content: '',
              diagnostic: bibliographyDiagnostic(bibliographyPath, 'Could not resolve bibliography file path.'),
            };
          }
          try {
            const response = await host.file.readTextFile(resolvedPath);
            return {
              content: response.content,
              diagnostic: response.content.trim()
                ? null
                : bibliographyDiagnostic(bibliographyPath, 'Bibliography file is empty.'),
            };
          } catch {
            return {
              content: '',
              diagnostic: bibliographyDiagnostic(bibliographyPath, 'Could not read bibliography file.'),
            };
          }
        }));
        if (cancelled || sequence !== requestSequence || !target.effects.isCurrent(effectToken)) return;
        if (signature) previousFileSignature = signature;
        hasLoaded = true;
        const nextBibliographyText = results.map((result) => result.content).filter(Boolean).join('\n\n');
        const nextDiagnostics = results
          .map((result) => result.diagnostic)
          .filter((diagnostic): diagnostic is DocumentDiagnostic => Boolean(diagnostic));
        mutate(() => {
          setBibliographyText((current) => current === nextBibliographyText ? current : nextBibliographyText);
          setBibliographyDiagnostics((current) => diagnosticsEqual(current, nextDiagnostics) ? current : nextDiagnostics);
        });
      } catch {
        if (!cancelled && sequence === requestSequence) {
          const nextDiagnostics = [bibliographyDiagnostic(bibliographyFiles.join(', '), 'Could not refresh bibliography files.')];
          mutate(() => {
            setBibliographyText((current) => current === '' ? current : '');
            setBibliographyDiagnostics((current) => diagnosticsEqual(current, nextDiagnostics) ? current : nextDiagnostics);
          });
        }
      } finally {
        if (!cancelled && sequence === requestSequence) mutate(() => setBibliographyLoading(false));
      }
    };

    const loadBibliographyInBackground = () => {
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }
      refreshInFlight = true;
      void loadBibliography()
        .catch((error) => {
          console.warn('Bibliography refresh failed.', error);
        })
        .finally(() => {
          refreshInFlight = false;
          if (!cancelled && refreshQueued) {
            refreshQueued = false;
            loadBibliographyInBackground();
          }
        });
    };

    const startFallbackPolling = () => {
      if (interval !== null) return;
      interval = window.setInterval(loadBibliographyInBackground, 10000);
    };

    const timer = window.setTimeout(() => {
      loadBibliographyInBackground();
    }, 250);
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') loadBibliographyInBackground();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const watchedPaths = resolvedLinkedFilePaths(filePath, bibliographyFiles);
    if (watchedPaths.length > 0) {
      void host.watcher.listenFileWatchChanges((event) => {
        if (eventTouchesWatchedPath(event.paths, watchedPaths)) loadBibliographyInBackground();
      }).then((dispose) => {
        if (watchDisposed) {
          dispose();
          return;
        }
        unlisten = dispose;
      }).catch((error) => {
        console.warn('Bibliography file watcher listener failed.', error);
        if (!cancelled) startFallbackPolling();
      });
      void host.watcher.updateWatchedFiles(bibliographyWatchScopeRef.current, watchedPaths).then((active) => {
        if (!active && !cancelled) startFallbackPolling();
      }).catch((error) => {
        console.warn('Bibliography file watcher update failed.', error);
        if (!cancelled) startFallbackPolling();
      });
    } else {
      startFallbackPolling();
    }

    return () => {
      cancelled = true;
      watchDisposed = true;
      window.clearTimeout(timer);
      if (interval !== null) window.clearInterval(interval);
      unlisten?.();
      void host.watcher.clearWatchedFiles(bibliographyWatchScopeRef.current).catch((error) => {
        console.warn('Bibliography file watcher cleanup failed.', error);
      });
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      target.effects.cancel(effectToken);
    };
  }, [bibliographyFiles, bibliographyFilesKey, bibliographyReloadToken, filePath, host, target.documentId, target.effects]);

  useEffect(() => {
    const effectToken = target.effects.begin(target.documentId, 'linked-variable-refresh');
    if (!effectToken) return undefined;
    const mutate = (mutation: () => void) => target.effects.apply(effectToken, () => {
      variableOwnerRef.current = target.documentId;
      mutation();
    });
    let cancelled = false;
    let requestSequence = 0;
    let previousFileSignature = '';
    let hasLoaded = false;
    let previousSignature = '';
    let interval: number | null = null;
    let refreshInFlight = false;
    let refreshQueued = false;
    let unlisten: (() => void) | undefined;
    let watchDisposed = false;
    if (!isTauriRuntime() || !filePath || variableFiles.length === 0) {
      target.effects.commit(effectToken, () => {
        variableOwnerRef.current = target.documentId;
        setExternalVariableDefinitions((current) => current.length === 0 ? current : []);
        setVariableFileDiagnostics((current) => current.length === 0 ? current : []);
        setLinkedVariableLoading(false);
      });
      return undefined;
    }
    mutate(() => {
      setExternalVariableDefinitions((current) => current.length === 0 ? current : []);
      setVariableFileDiagnostics((current) => current.length === 0 ? current : []);
    });

    const loadVariables = async () => {
      if (document.visibilityState === 'hidden') return;
      const sequence = ++requestSequence;
      mutate(() => setLinkedVariableLoading(true));
      let fileSignature = '';
      let definitions: VariableDefinition[] = [];
      let diagnostics: DocumentDiagnostic[] = [];
      try {
        try {
          fileSignature = await linkedFilesSignature(host.file, filePath, variableFiles);
          if (cancelled || sequence !== requestSequence || !target.effects.isCurrent(effectToken)) return;
          if (hasLoaded && fileSignature && fileSignature === previousFileSignature) return;
          const results = await Promise.all(variableFiles.map(async (variablePath) => {
            const resolvedPath = resolveRelativeMarkdownAsset(filePath, variablePath);
            if (!resolvedPath) {
              return {
                definitions: [],
                diagnostic: variableFileDiagnostic(variablePath, 'Could not resolve linked variable file path.'),
              };
            }
            try {
              const response = await host.file.readTextFile(resolvedPath);
              const parsedDefinitions = parseVariableDataFile(response.content, variablePath);
              return {
                definitions: parsedDefinitions,
                diagnostic: response.content.trim() && parsedDefinitions.length === 0
                  ? variableFileDiagnostic(variablePath, 'Linked variable file did not contain readable JSON or CSV variables.')
                  : null,
              };
            } catch {
              return {
                definitions: [],
                diagnostic: variableFileDiagnostic(variablePath, 'Could not read linked variable file.'),
              };
            }
          }));
          definitions = results.flatMap((result) => result.definitions);
          diagnostics = results
            .map((result) => result.diagnostic)
            .filter((diagnostic): diagnostic is DocumentDiagnostic => Boolean(diagnostic));
        } catch {
          if (cancelled || sequence !== requestSequence) return;
          diagnostics = [variableFileDiagnostic(variableFiles.join(', '), 'Could not refresh linked variable files.')];
        }

        const signature = definitions
          .map((definition) => `${definition.file ?? ''}:${definition.name}=${definition.value}`)
          .join('\n') + diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.message}`).join('\n');
        if (cancelled || sequence !== requestSequence || !target.effects.isCurrent(effectToken)) return;
        if (fileSignature) previousFileSignature = fileSignature;
        hasLoaded = true;
        if (signature !== previousSignature) {
          previousSignature = signature;
          mutate(() => {
            setExternalVariableDefinitions((current) => variableDefinitionsEqual(current, definitions) ? current : definitions);
            setVariableFileDiagnostics((current) => diagnosticsEqual(current, diagnostics) ? current : diagnostics);
          });
        }
      } finally {
        if (!cancelled && sequence === requestSequence) mutate(() => setLinkedVariableLoading(false));
      }
    };

    const loadVariablesInBackground = () => {
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }
      refreshInFlight = true;
      void loadVariables()
        .catch((error) => {
          console.warn('Variable file refresh failed.', error);
        })
        .finally(() => {
          refreshInFlight = false;
          if (!cancelled && refreshQueued) {
            refreshQueued = false;
            loadVariablesInBackground();
          }
        });
    };

    const startFallbackPolling = () => {
      if (interval !== null) return;
      interval = window.setInterval(loadVariablesInBackground, 5000);
    };

    const timer = window.setTimeout(loadVariablesInBackground, 250);
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') loadVariablesInBackground();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const watchedPaths = resolvedLinkedFilePaths(filePath, variableFiles);
    if (watchedPaths.length > 0) {
      void host.watcher.listenFileWatchChanges((event) => {
        if (eventTouchesWatchedPath(event.paths, watchedPaths)) loadVariablesInBackground();
      }).then((dispose) => {
        if (watchDisposed) {
          dispose();
          return;
        }
        unlisten = dispose;
      }).catch((error) => {
        console.warn('Variable file watcher listener failed.', error);
        if (!cancelled) startFallbackPolling();
      });
      void host.watcher.updateWatchedFiles(variableWatchScopeRef.current, watchedPaths).then((active) => {
        if (!active && !cancelled) startFallbackPolling();
      }).catch((error) => {
        console.warn('Variable file watcher update failed.', error);
        if (!cancelled) startFallbackPolling();
      });
    } else {
      startFallbackPolling();
    }
    return () => {
      cancelled = true;
      watchDisposed = true;
      window.clearTimeout(timer);
      if (interval !== null) window.clearInterval(interval);
      unlisten?.();
      void host.watcher.clearWatchedFiles(variableWatchScopeRef.current).catch((error) => {
        console.warn('Variable file watcher cleanup failed.', error);
      });
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      target.effects.cancel(effectToken);
    };
  }, [filePath, host, target.documentId, target.effects, variableFiles, variableFilesKey]);

  return {
    document: liveDocument,
    parsedMarkdown: parsedState.documentId === target.documentId ? parsedState.markdown : '',
    bibliographyLoading,
    documentParsingPending,
    linkedVariableLoading,
    reloadBibliography,
  };
}

function resolvedLinkedFilePaths(documentPath: string, linkedPaths: string[]): string[] {
  return linkedPaths
    .map((linkedPath) => resolveRelativeMarkdownAsset(documentPath, linkedPath))
    .filter((resolvedPath): resolvedPath is string => Boolean(resolvedPath));
}

function eventTouchesWatchedPath(eventPaths: string[], watchedPaths: string[]): boolean {
  if (eventPaths.length === 0) return true;
  const watched = new Set(watchedPaths.map(canonicalComparisonKey));
  return eventPaths.some((path) => watched.has(canonicalComparisonKey(path)));
}

async function linkedFilesSignature(fileHost: Pick<DocumentHost['file'], 'statFile'>, documentPath: string, linkedPaths: string[]): Promise<string> {
  const entries = await Promise.all(linkedPaths.map(async (linkedPath) => {
    const resolvedPath = resolveRelativeMarkdownAsset(documentPath, linkedPath);
    if (!resolvedPath) return `${linkedPath}:unresolved`;
    try {
      const metadata = await fileHost.statFile(resolvedPath, { contentHash: false });
      return `${resolvedPath}:${metadata.lastKnownMtimeMs}:${metadata.lastKnownSizeBytes}`;
    } catch {
      return `${resolvedPath}:unreadable`;
    }
  }));
  return entries.join('\n');
}

function diagnosticsEqual(left: DocumentDiagnostic[], right: DocumentDiagnostic[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((diagnostic, index) => {
    const other = right[index];
    return diagnostic.severity === other.severity
      && diagnostic.code === other.code
      && diagnostic.message === other.message
      && diagnostic.line === other.line;
  });
}

function variableDefinitionsEqual(left: VariableDefinition[], right: VariableDefinition[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((definition, index) => {
    const other = right[index];
    return definition.name === other.name
      && definition.value === other.value
      && definition.source === other.source
      && definition.file === other.file;
  });
}

function variableFileDiagnostic(filePath: string, message: string): DocumentDiagnostic {
  return {
    severity: 'warning',
    code: 'variable-file-unreadable',
    message: `${message} (${filePath})`,
  };
}

function bibliographyDiagnostic(filePath: string, message: string): DocumentDiagnostic {
  return {
    severity: 'warning',
    code: 'bibliography-file-unreadable',
    message: `${message} (${filePath})`,
  };
}
