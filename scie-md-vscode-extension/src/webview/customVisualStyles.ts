import { isVisualStyleId } from '../scie-md/services/visualStyleService';
import type { VisualStyleId } from '../scie-md/services/visualStyleService';
import { VISUAL_STYLE_OPTIONS } from '../scie-md/services/visualStyleService';

/**
 * Custom visual styles loaded from the user's configured styles directory
 * (scieMd.customStyles.directory). The extension host validates *.style.json
 * files and passes them in via window.__SCIE_MD_CUSTOM_VISUAL_STYLES__;
 * this module turns them into menu options and generated CSS.
 */

interface CustomVisualStyleVariables {
  [customProperty: string]: string;
}

interface CustomVisualStyleDefinition {
  id: string;
  label: string;
  shortLabel?: string;
  detail?: string;
  variables?: CustomVisualStyleVariables;
  light?: CustomVisualStyleVariables;
  dark?: CustomVisualStyleVariables;
  sepia?: CustomVisualStyleVariables;
}

export interface VisualStyleMenuEntry {
  id: VisualStyleId;
  label: string;
  shortLabel: string;
  detail: string;
}

declare global {
  interface Window {
    __SCIE_MD_CUSTOM_VISUAL_STYLES__?: CustomVisualStyleDefinition[];
    __SCIE_MD_CUSTOM_STYLE_DIAGNOSTICS__?: string[];
  }
}

function getCustomVisualStyles(): CustomVisualStyleDefinition[] {
  const raw = window.__SCIE_MD_CUSTOM_VISUAL_STYLES__;
  if (!Array.isArray(raw)) return [];
  return raw.filter((style): style is CustomVisualStyleDefinition =>
    !!style && typeof style === 'object' && typeof style.id === 'string' && typeof style.label === 'string');
}

let cachedAllOptions: VisualStyleMenuEntry[] | null = null;

/** Built-in visual styles plus valid custom styles from the styles directory. */
export function allVisualStyleOptions(): VisualStyleMenuEntry[] {
  if (cachedAllOptions) return cachedAllOptions;
  const custom = getCustomVisualStyles().map((style) => ({
      id: style.id as VisualStyleId,
      label: style.label,
      shortLabel: style.shortLabel ?? style.label,
      detail: style.detail ?? 'Custom visual style.',
    }));
  cachedAllOptions = [...VISUAL_STYLE_OPTIONS, ...custom];
  return cachedAllOptions;
}

/** Accepts built-in ids and custom style ids; falls back to 'science'. */
export function resolveVisualStyleId(value: unknown): VisualStyleId {
  if (isVisualStyleId(value)) return value;
  if (typeof value === 'string' && getCustomVisualStyles().some((style) => style.id === value)) {
    return value as VisualStyleId;
  }
  return 'science';
}

function renderVariableBlock(selector: string, variables: CustomVisualStyleVariables | undefined): string {
  if (!variables) return '';
  const declarations = Object.entries(variables)
    .map(([key, value]) => `  ${key}: ${value};`)
    .join('\n');
  return declarations === '' ? '' : `${selector} {\n${declarations}\n}\n`;
}

/** Build one stylesheet covering every custom style definition. */
export function buildCustomVisualStyleCss(): string {
  let css = '';
  for (const style of getCustomVisualStyles()) {
    css += renderVariableBlock(`:root[data-visual-style="${style.id}"]`, style.variables);
    css += renderVariableBlock(`:root[data-theme="light"][data-visual-style="${style.id}"]`, style.light);
    css += renderVariableBlock(`:root[data-theme="dark"][data-visual-style="${style.id}"]`, style.dark);
    css += renderVariableBlock(`:root[data-theme="sepia"][data-visual-style="${style.id}"]`, style.sepia);
  }
  return css;
}

let installed = false;

/** Inject the generated custom visual style rules once, at app boot. */
export function installCustomVisualStyles(): void {
  if (installed) return;
  installed = true;
  const css = buildCustomVisualStyleCss();
  if (css === '') return;
  const element = document.createElement('style');
  element.id = 'scie-md-custom-visual-styles';
  element.textContent = css;
  document.head.appendChild(element);
  for (const diagnostic of window.__SCIE_MD_CUSTOM_STYLE_DIAGNOSTICS__ ?? []) {
    console.warn(diagnostic);
  }
}
