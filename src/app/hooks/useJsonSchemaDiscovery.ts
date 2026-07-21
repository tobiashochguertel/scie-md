import { useEffect, useMemo, useState } from 'react';
import type { DocumentFormat, JsonSchemaSource } from '@sciemd/core';
import type { DocumentEffectTarget } from '../effects/documentEffectCoordinator';

export interface JsonSchemaDiscoveryState {
  schemaSource: JsonSchemaSource | null;
  loading: boolean;
  error: string | null;
  siblingCandidates: string[];
}

interface TargetedJsonSchemaDiscoveryState extends JsonSchemaDiscoveryState {
  documentId: DocumentEffectTarget['documentId'];
}

interface UseJsonSchemaDiscoveryOptions {
  target: DocumentEffectTarget;
  format: DocumentFormat;
  filePath: string | null;
  explicitSchemaPath: string | null;
  fileHost: {
    readTextFile(path: string): Promise<{ content: string }>;
  };
}

export function useJsonSchemaDiscovery({
  target,
  format,
  filePath,
  explicitSchemaPath,
  fileHost,
}: UseJsonSchemaDiscoveryOptions): JsonSchemaDiscoveryState {
  const readTextFile = fileHost.readTextFile;
  const siblingCandidates = useMemo(
    () => format === 'json' && filePath ? jsonSchemaSiblingCandidates(filePath) : [],
    [filePath, format],
  );
  const [state, setState] = useState<TargetedJsonSchemaDiscoveryState>({
    documentId: target.documentId,
    schemaSource: null,
    loading: false,
    error: null,
    siblingCandidates: [],
  });

  useEffect(() => {
    const token = target.effects.begin(target.documentId, 'json-schema-discovery');
    if (!token) return undefined;
    if (format !== 'json') {
      target.effects.commit(token, () => setState({ documentId: target.documentId, schemaSource: null, loading: false, error: null, siblingCandidates: [] }));
      return undefined;
    }

    target.effects.apply(token, () => setState((current) => ({
      documentId: target.documentId,
      schemaSource: current.schemaSource,
      loading: true,
      error: null,
      siblingCandidates,
    })));

    void (async () => {
      if (explicitSchemaPath) {
        const response = await readTextFile(explicitSchemaPath);
        target.effects.commit(token, () => setState({
          documentId: target.documentId,
          schemaSource: {
            kind: 'explicit',
            path: explicitSchemaPath,
            text: response.content,
            label: 'Selected schema',
          },
          loading: false,
          error: null,
          siblingCandidates,
        }));
        return;
      }

      for (const candidate of siblingCandidates) {
        try {
          const response = await readTextFile(candidate);
          target.effects.commit(token, () => setState({
            documentId: target.documentId,
            schemaSource: {
              kind: 'sibling',
              path: candidate,
              text: response.content,
              label: 'Sibling schema',
            },
            loading: false,
            error: null,
            siblingCandidates,
          }));
          return;
        } catch {
          // Missing or ungranted sibling schemas are expected. Keep discovery silent.
        }
      }

      target.effects.commit(token, () => setState({
        documentId: target.documentId,
        schemaSource: null,
        loading: false,
        error: null,
        siblingCandidates,
      }));
    })().catch((error) => {
      target.effects.commit(token, () => setState({
        documentId: target.documentId,
        schemaSource: null,
        loading: false,
        error: error instanceof Error ? error.message : String(error || 'Could not load JSON Schema.'),
        siblingCandidates,
      }));
    });

    return () => {
      target.effects.cancel(token);
    };
  }, [explicitSchemaPath, format, readTextFile, siblingCandidates, target.documentId, target.effects]);

  if (state.documentId !== target.documentId) {
    return { schemaSource: null, loading: format === 'json', error: null, siblingCandidates };
  }
  return state;
}

export function jsonSchemaSiblingCandidates(filePath: string): string[] {
  const normalized = filePath.replace(/\\/g, '/');
  const slashIndex = normalized.lastIndexOf('/');
  const directory = slashIndex >= 0 ? normalized.slice(0, slashIndex + 1) : '';
  const fileName = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
  const dotIndex = fileName.lastIndexOf('.');
  const stem = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  const candidates = [
    `${directory}${stem}.schema.json`,
    `${directory}${fileName}.schema.json`,
    `${directory}schema.json`,
  ];
  return filePath.includes('\\') ? candidates.map((candidate) => candidate.replace(/\//g, '\\')) : candidates;
}
