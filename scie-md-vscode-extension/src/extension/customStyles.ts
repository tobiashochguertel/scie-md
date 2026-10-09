import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Custom style directory support.
 *
 * `scieMd.customStyles.directory` points at a directory that can contain:
 *  - `*.css` files      — injected verbatim after the bundled stylesheet
 *                         (same origin, later cascade position, so they
 *                         override built-in rules on equal specificity)
 *  - `*.style.json`     — additional visual styles merged into the Style
 *                         picker in the webview
 *
 * A `*.style.json` file looks like:
 *   {
 *     "id": "acme",                 // required, [a-z][a-z0-9-]{1,39}
 *     "label": "Acme",              // required
 *     "shortLabel": "Acme",         // optional, falls back to label
 *     "detail": "Company style.",   // optional, shown in the picker
 *     "variables": { "--doc-font": "..." },        // applied for all themes
 *     "light":   { "--bg": "#fff" },               // per-theme overrides
 *     "dark":    { "--bg": "#151515" },
 *     "sepia":   { "--bg": "#f6f0e3" }
 *   }
 */

export const CUSTOM_STYLES_DIRECTORY_SETTING = 'scieMd.customStyles.directory';

export interface CustomVisualStyleVariables {
  [customProperty: string]: string;
}

export interface CustomVisualStyleDefinition {
  id: string;
  label: string;
  shortLabel: string;
  detail: string;
  variables: CustomVisualStyleVariables;
  light: CustomVisualStyleVariables;
  dark: CustomVisualStyleVariables;
  sepia: CustomVisualStyleVariables;
}

export interface CustomStylePayload {
  /** Raw CSS text blocks, one per *.css file, in sorted filename order. */
  cssBlocks: string[];
  /** Parsed *.style.json definitions, ready to ship to the webview. */
  visualStyles: CustomVisualStyleDefinition[];
  /** Human-readable problems (missing dir, bad JSON, invalid entries). */
  diagnostics: string[];
}

const EMPTY_PAYLOAD: CustomStylePayload = { cssBlocks: [], visualStyles: [], diagnostics: [] };
const STYLE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const CUSTOM_PROPERTY_PATTERN = /^--[a-zA-Z][a-zA-Z0-9-]*$/;

export function getConfiguredStylesDirectory(): string | undefined {
  const configured = vscode.workspace.getConfiguration().get<string>(CUSTOM_STYLES_DIRECTORY_SETTING, '');
  const trimmed = configured.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function resolveStylesDirectory(configured: string): string {
  let resolved = configured;
  if (resolved === '~') {
    resolved = os.homedir();
  } else if (resolved.startsWith('~/') || resolved.startsWith('~\\')) {
    resolved = path.join(os.homedir(), resolved.slice(2));
  }
  if (!path.isAbsolute(resolved)) {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder) resolved = path.resolve(folder, resolved);
  }
  return path.resolve(resolved);
}

/** Load the configured custom style payload. Never throws — problems are reported via diagnostics. */
export async function loadCustomStylePayload(): Promise<CustomStylePayload> {
  const configured = getConfiguredStylesDirectory();
  if (!configured) return EMPTY_PAYLOAD;

  const directory = resolveStylesDirectory(configured);
  const payload: CustomStylePayload = { cssBlocks: [], visualStyles: [], diagnostics: [] };

  let entries: string[];
  try {
    entries = (await fs.readdir(directory)).sort((a, b) => a.localeCompare(b));
  } catch {
    payload.diagnostics.push(`ScieMD: custom styles directory not readable: ${directory}`);
    return payload;
  }

  for (const entry of entries) {
    const filePath = path.join(directory, entry);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      if (entry.endsWith('.css')) {
        payload.cssBlocks.push(sanitizeCssBlock(await fs.readFile(filePath, 'utf8')));
      } else if (entry.endsWith('.style.json')) {
        const parsed = parseVisualStyleFile(entry, await fs.readFile(filePath, 'utf8'));
        if (typeof parsed === 'string') payload.diagnostics.push(parsed);
        else payload.visualStyles.push(parsed);
      }
    } catch (error) {
      payload.diagnostics.push(`ScieMD: could not read ${entry}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return payload;
}

/** Inline CSS must not be able to break out of its <style> element. */
export function sanitizeCssBlock(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

function sanitizeVariableValue(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  // Values are inlined into a <style> block; keep them free of markup.
  if (text === '' || /[<>{}]/.test(text)) return undefined;
  return text;
}

function sanitizeVariables(raw: unknown): CustomVisualStyleVariables {
  const out: CustomVisualStyleVariables = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!CUSTOM_PROPERTY_PATTERN.test(key)) continue;
    const sanitized = sanitizeVariableValue(value);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

/** Returns the validated definition, or a diagnostic string on failure. */
function parseVisualStyleFile(fileName: string, content: string): CustomVisualStyleDefinition | string {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    return `ScieMD: ${fileName} is not valid JSON: ${error instanceof Error ? error.message : error}`;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return `ScieMD: ${fileName} must contain a JSON object`;
  }
  const def = raw as Record<string, unknown>;
  if (typeof def.id !== 'string' || !STYLE_ID_PATTERN.test(def.id)) {
    return `ScieMD: ${fileName} needs an "id" matching ${STYLE_ID_PATTERN}`;
  }
  if (typeof def.label !== 'string' || def.label.trim() === '') {
    return `ScieMD: ${fileName} needs a non-empty "label"`;
  }
  const themes = (def.themes && typeof def.themes === 'object' ? def.themes : {}) as Record<string, unknown>;
  return {
    id: def.id,
    label: def.label.trim(),
    shortLabel: typeof def.shortLabel === 'string' && def.shortLabel.trim() !== '' ? def.shortLabel.trim() : def.label.trim(),
    detail: typeof def.detail === 'string' ? def.detail : '',
    variables: sanitizeVariables(def.variables),
    light: sanitizeVariables(def.light ?? themes.light),
    dark: sanitizeVariables(def.dark ?? themes.dark),
    sepia: sanitizeVariables(def.sepia ?? themes.sepia),
  };
}
