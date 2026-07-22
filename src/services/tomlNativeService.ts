import { invoke } from '@tauri-apps/api/core';
import type { TomlNativeMutationIntent, TomlNativeMutationPlanReport, TomlNativeSourceMapReport } from '@sciemd/core';

export function inspectTomlSourceMap(sourceText: string): Promise<TomlNativeSourceMapReport> {
  return invoke<TomlNativeSourceMapReport>('inspect_toml_source_map', { sourceText });
}

export function planTomlMutation(sourceText: string, intent: TomlNativeMutationIntent): Promise<TomlNativeMutationPlanReport> {
  return invoke<TomlNativeMutationPlanReport>('plan_toml_mutation', { sourceText, intent });
}
