import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { Node as ProseNode, ResolvedPos } from '@milkdown/prose/model';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import type { EditorView } from '@milkdown/prose/view';

interface FocusModeState {
  decorations: DecorationSet;
  activeBlockPos: number;
}

const focusModePluginKey = new PluginKey<FocusModeState>('scieMdFocusMode');

export const focusModePlugin = $prose(() => new Plugin({
  key: focusModePluginKey,
  state: {
    init: (_config, state) => buildFocusModeState(state.doc, state.selection.from),
    apply(transaction, previous, _oldState, newState) {
      if (!transaction.docChanged && !transaction.selectionSet) return previous;
      return buildFocusModeState(newState.doc, newState.selection.from);
    },
  },
  props: {
    decorations(state) {
      return focusModePluginKey.getState(state)?.decorations ?? DecorationSet.empty;
    },
  },
  view(view) {
    let lastSelection = view.state.selection.from;
    return {
      update(nextView) {
        const currentSelection = nextView.state.selection.from;
        if (currentSelection === lastSelection) return;
        lastSelection = currentSelection;
        maybeTypewriterScroll(nextView);
      },
    };
  },
}));

function buildFocusModeState(doc: ProseNode, selectionFrom: number): FocusModeState {
  const resolved = doc.resolve(Math.max(0, Math.min(selectionFrom, doc.content.size)));
  const activeBlock = findTopLevelBlockRange(resolved);
  const activeBlockPos = activeBlock?.from ?? 0;
  const decorations: Decoration[] = [];
  const activeTextblock = findActiveTextblockRange(resolved);

  if (activeBlock) {
    decorations.push(Decoration.node(activeBlock.from, activeBlock.to, {
      class: activeTextblock
        && activeTextblock.from === activeBlock.from
        && activeTextblock.to === activeBlock.to
        ? 'focus-active-block visual-active-block'
        : 'focus-active-block',
    }));
  }

  if (activeTextblock && (
    !activeBlock
    || activeTextblock.from !== activeBlock.from
    || activeTextblock.to !== activeBlock.to
  )) {
    decorations.push(Decoration.node(activeTextblock.from, activeTextblock.to, {
      class: 'visual-active-block',
    }));
  }

  return {
    decorations: DecorationSet.create(doc, decorations),
    activeBlockPos,
  };
}

function findActiveTextblockRange(
  resolved: ResolvedPos,
): { from: number; to: number } | null {
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const node = resolved.node(depth);
    if (!node.isTextblock) continue;
    const from = resolved.before(depth);
    return { from, to: from + node.nodeSize };
  }
  const nodeAfter = resolved.nodeAfter;
  if (!nodeAfter?.isTextblock) return null;
  return { from: resolved.pos, to: resolved.pos + nodeAfter.nodeSize };
}

function findTopLevelBlockRange(resolved: ResolvedPos): { from: number; to: number } | null {
  if (resolved.depth > 0) {
    const from = resolved.before(1);
    return { from, to: from + resolved.node(1).nodeSize };
  }
  const nodeAfter = resolved.nodeAfter;
  if (!nodeAfter) return null;
  return { from: resolved.pos, to: resolved.pos + nodeAfter.nodeSize };
}

function maybeTypewriterScroll(view: EditorView): void {
  if (!document.querySelector('.app-shell.focus-mode')) return;
  window.requestAnimationFrame(() => {
    const coords = view.coordsAtPos(view.state.selection.from);
    const scroller = nearestScrollableAncestor(view.dom);
    if (!scroller) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const target = scroller.scrollTop + coords.top - scrollerRect.top - scroller.clientHeight * 0.42;
    scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  });
}

function nearestScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element;
  while (current) {
    const style = window.getComputedStyle(current);
    if (/(auto|scroll)/.test(`${style.overflowY}${style.overflow}`) && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
}
