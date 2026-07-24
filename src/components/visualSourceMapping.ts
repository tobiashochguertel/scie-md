import type { Node as ProseNode } from '@milkdown/prose/model';
import { parseFrontmatter } from '@sciemd/core';

interface VisualTextblockRange {
  start: number;
  end: number;
  line: number;
}

interface VisualSourcePositionIndex {
  lineAt(position: number): number | null;
}

const sourcePositionIndexCache = new WeakMap<ProseNode, {
  sourceMarkdown: string;
  index: VisualSourcePositionIndex;
}>();

export function visualSourceLineForPosition(doc: ProseNode, position: number, sourceMarkdown: string): number | null {
  const cached = sourcePositionIndexCache.get(doc);
  if (cached?.sourceMarkdown === sourceMarkdown) return cached.index.lineAt(position);
  const index = createVisualSourcePositionIndex(doc, sourceMarkdown);
  sourcePositionIndexCache.set(doc, { sourceMarkdown, index });
  return index.lineAt(position);
}

export function createVisualSourcePositionIndex(
  doc: ProseNode,
  sourceMarkdown: string,
): VisualSourcePositionIndex {
  const startLines = markdownTextblockStartLines(sourceMarkdown);
  const ranges: VisualTextblockRange[] = [];
  let blockIndex = 0;
  doc.descendants((node, nodePosition) => {
    if (!node.isTextblock) return true;
    const line = startLines[blockIndex];
    if (line !== undefined) {
      ranges.push({
        start: nodePosition,
        end: nodePosition + node.nodeSize,
        line,
      });
    }
    blockIndex += 1;
    return true;
  });

  return {
    lineAt(position: number): number | null {
      const safePosition = Math.max(0, Math.min(position, doc.content.size));
      let low = 0;
      let high = ranges.length - 1;
      let candidate: VisualTextblockRange | undefined;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        const range = ranges[middle];
        if (range.start <= safePosition) {
          candidate = range;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      return candidate && safePosition <= candidate.end ? candidate.line : null;
    },
  };
}

export function textblockIndexAtPosition(doc: ProseNode, position: number): number | null {
  const safePosition = Math.max(0, Math.min(position, doc.content.size));
  let index = 0;
  let found: number | null = null;

  doc.descendants((node, nodePosition) => {
    if (found !== null) return false;
    if (!node.isTextblock) return true;

    const start = nodePosition;
    const end = nodePosition + node.nodeSize;
    if (safePosition >= start && safePosition <= end) {
      found = index;
      return false;
    }
    index += 1;
    return true;
  });

  return found;
}

export function markdownTextblockStartLines(markdown: string): number[] {
  const frontmatter = parseFrontmatter(markdown);
  const body = frontmatter.hasFrontmatter && !frontmatter.error ? frontmatter.body : markdown;
  const baseLine = frontmatter.hasFrontmatter && !frontmatter.error ? frontmatter.endLine + 1 : 1;
  const lines = splitMarkdownLines(body);
  const starts: number[] = [];
  let inParagraph = false;
  let inScieMDComment = false;
  let inScieMDVariant = false;
  let inScieMDDelimitedComment = false;
  let fenceChar: '`' | '~' | null = null;
  let fenceLength = 0;

  lines.forEach((line, index) => {
    const absoluteLine = baseLine + index;
    if (inScieMDVariant) {
      if (/^\s*<!--\s*scie_md:variant:end\s*-->\s*$/.test(line)) inScieMDVariant = false;
      return;
    }
    if (inScieMDDelimitedComment) {
      if (/^\s*<!--\s*scie_md:comment:end\s*-->\s*$/.test(line)) inScieMDDelimitedComment = false;
      return;
    }
    if (inScieMDComment) {
      if (line.includes('-->')) inScieMDComment = false;
      return;
    }

    if (/^\s*<!--\s*scie_md:variant:group\b/.test(line)) {
      inScieMDVariant = !/^\s*<!--\s*scie_md:variant:end\s*-->\s*$/.test(line);
      inParagraph = false;
      return;
    }
    if (/^\s*<!--\s*scie_md:comment(?!:)[^>]*-->\s*$/.test(line)) {
      inScieMDDelimitedComment = true;
      inParagraph = false;
      return;
    }
    if (/^\s*<!--\s*scie_md:/.test(line)) {
      if (!line.includes('-->')) inScieMDComment = true;
      inParagraph = false;
      return;
    }

    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1];
      const markerChar = marker[0] as '`' | '~';
      if (!fenceChar) {
        starts.push(absoluteLine);
        fenceChar = markerChar;
        fenceLength = marker.length;
      } else if (markerChar === fenceChar && marker.length >= fenceLength) {
        fenceChar = null;
        fenceLength = 0;
      }
      inParagraph = false;
      return;
    }
    if (fenceChar) return;

    if (!line.trim()) {
      inParagraph = false;
      return;
    }

    if (isTableSeparator(line)) {
      inParagraph = false;
      return;
    }
    if (isTableRow(line)) {
      const cellCount = splitMarkdownTableCells(line).length;
      for (let cellIndex = 0; cellIndex < Math.max(1, cellCount); cellIndex += 1) {
        starts.push(absoluteLine);
      }
      inParagraph = false;
      return;
    }

    const structural = line.replace(/^\s{0,3}>\s?/, '');
    if (isTextblockStartLine(structural)) {
      starts.push(absoluteLine);
      inParagraph = false;
      return;
    }

    if (!inParagraph) {
      starts.push(absoluteLine);
      inParagraph = true;
    }
  });

  return starts;
}

function splitMarkdownLines(markdown: string): string[] {
  return markdown.split(/\r\n|\n|\r/);
}

function isTextblockStartLine(line: string): boolean {
  return /^\s{0,3}(?:[-+*]|\d+[.)])\s+/.test(line)
    || /^\s{0,3}#{1,6}\s+/.test(line);
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && splitMarkdownTableCells(line).length > 1;
}

function isTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableCells(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitMarkdownTableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return [];
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
}
