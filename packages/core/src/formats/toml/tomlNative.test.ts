import { describe, expect, it } from 'vitest';
import { createTomlContent } from './parseTomlDocument';
import { parseTomlNativeReport, validateTomlNativeMutationPlan, type TomlNativeSourceMapReport } from './tomlNative';

describe('native TOML projection', () => {
  it('projects one native identity into value, source navigation, and operation capabilities', () => {
    const source = '# Ω\r\ntitle = "Dataset"\r\n';
    const report: TomlNativeSourceMapReport = {
      dtoVersion: 'toml-native-dto-v1', plannerVersion: 'toml-edit-native-v1', status: 'valid', value: { title: 'Dataset' }, diagnostics: [],
      nodes: [
        { path: [], pointer: '', displayPath: '$', kind: 'table', valueType: 'table', span: null, valueSpan: null, keySpan: null, editableCandidate: true, editableOperations: ['addObjectField'] },
        { path: ['title'], pointer: '/title', displayPath: '$.title', kind: 'scalar', valueType: 'string', span: { offset: 13, length: 9, line: 2, column: 9 }, valueSpan: { offset: 13, length: 9, line: 2, column: 9 }, keySpan: { offset: 5, length: 5, line: 2, column: 1 }, editableCandidate: true, editableOperations: ['replaceScalar', 'renameObjectKey', 'deleteObjectField'] },
      ],
      unsupportedFeatures: [],
      summary: { nodeCount: 2, spannedNodeCount: 1, unsupportedFeatureCount: 0, noOpRoundTripPreserved: true, visualWritesEnabled: true, boundaryStatus: 'production-source-preserving', commandScope: 'inspect-and-plan-guarded-patches' },
    };
    const result = parseTomlNativeReport(createTomlContent(source), report);
    expect(result.parsed?.value).toEqual({ title: 'Dataset' });
    expect(result.parsed?.sourceMap.nodesByPointer['/title']).toMatchObject({ displayPath: '$.title', editable: true, editableOperations: ['replaceScalar', 'renameObjectKey', 'deleteObjectField'] });
    expect(result.parsed?.nativeIdentity).toEqual({ dtoVersion: 'toml-native-dto-v1', plannerVersion: 'toml-edit-native-v1', boundaryStatus: 'production-source-preserving' });
  });

  it('fails closed for future DTOs and malformed mutation envelopes', () => {
    expect(validateTomlNativeMutationPlan({
      dtoVersion: 'future', plannerVersion: 'toml-edit-native-v1', status: 'planned', operationId: 'replaceScalar', path: ['title'],
      patches: [{ from: 0, to: 1, insert: 'x', expectedText: 'y' }], nextSource: 'x', nextValue: { title: 'x' }, diagnostics: [], untouchedRegionsExact: true,
    })).toContain('DTO version');
  });
});
