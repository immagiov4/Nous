import type {
  AnnotationContextMenuState,
  ContextMenuPlacement,
  ContextMenuState,
  HorizontalViewportBounds,
  SelectionContextMenuState,
  SelectionRect,
} from '../types';
import { normalizeMathSelectionArtifacts, projectMarkdownMathRange } from './markdownCodeRanges.ts';

interface ResolveContextMenuSelectionArgs {
  container: HTMLElement;
  fallbackAnchorX?: number;
  fallbackAnchorY?: number;
  placement: ContextMenuPlacement;
  selection: Selection;
}

interface ResolvedSelectionPayload {
  anchorX: number;
  anchorY: number;
  contextAfter: string;
  contextBefore: string;
  horizontalBounds?: HorizontalViewportBounds;
  selectedText: string;
  selectionRect: SelectionRect;
}

const DEFAULT_CONTEXT_WINDOW = 48;
const KATEX_TEX_ANNOTATION_SELECTOR = 'annotation[encoding="application/x-tex"]';

const projectKatexAnnotationSource = (texSource: string): string => {
  const wrappedExpression = `$${texSource}$`;
  return (
    projectMarkdownMathRange(wrappedExpression, {
      start: 0,
      end: wrappedExpression.length,
    }).text || texSource
  );
};

const extractRangeText = (range: Range, fallbackText = ''): string => {
  try {
    const ownerDocument =
      range.commonAncestorContainer.ownerDocument ||
      (range.commonAncestorContainer.nodeType === 9
        ? (range.commonAncestorContainer as Document)
        : null);
    if (!ownerDocument || typeof range.cloneContents !== 'function') {
      return normalizeMathSelectionArtifacts(fallbackText || range.toString());
    }

    const container = ownerDocument.createElement('div');
    container.append(range.cloneContents());

    Array.from(container.querySelectorAll('.katex')).forEach(katexNode => {
      const texAnnotation = katexNode.querySelector(KATEX_TEX_ANNOTATION_SELECTOR);
      const texSource = texAnnotation?.textContent?.trim();

      if (texSource) {
        const projectedText = projectKatexAnnotationSource(texSource).trim();
        katexNode.replaceWith(ownerDocument.createTextNode(projectedText ? ` ${projectedText} ` : ' '));
        return;
      }

      katexNode.querySelectorAll(KATEX_TEX_ANNOTATION_SELECTOR).forEach(node => node.remove());
      if (katexNode.querySelector('.katex-mathml')) {
        katexNode.querySelectorAll('.katex-html').forEach(node => node.remove());
      }
    });

    container.querySelectorAll(KATEX_TEX_ANNOTATION_SELECTOR).forEach(node => node.remove());
    container.querySelectorAll('script, style').forEach(node => node.remove());

    return normalizeMathSelectionArtifacts(container.textContent || fallbackText || '');
  } catch {
    return normalizeMathSelectionArtifacts(fallbackText || range.toString());
  }
};

export type MobileContextMenuSyncAction = 'open-from-selection' | 'keep-existing-menu' | 'close-menu';

const getNodeForContainmentCheck = (node: Node): Node => {
  return node.nodeType === 3 && node.parentNode ? node.parentNode : node;
};

const getSelectionContext = (
  container: HTMLElement,
  range: Range
): Pick<ResolvedSelectionPayload, 'contextBefore' | 'contextAfter'> => {
  const beforeRange = range.cloneRange();
  beforeRange.selectNodeContents(container);
  beforeRange.setEnd(range.startContainer, range.startOffset);

  const afterRange = range.cloneRange();
  afterRange.selectNodeContents(container);
  afterRange.setStart(range.endContainer, range.endOffset);

  return {
    contextBefore: extractRangeText(beforeRange, beforeRange.toString()).slice(-DEFAULT_CONTEXT_WINDOW),
    contextAfter: extractRangeText(afterRange, afterRange.toString()).slice(0, DEFAULT_CONTEXT_WINDOW),
  };
};

const getSelectionRect = (range: Range): SelectionRect => {
  const rect = range.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
};

export const createClosedContextMenuState = (): ContextMenuState => ({
  type: 'selection',
  visible: false,
  placement: 'desktop-floating',
  selectedText: '',
  contextBefore: '',
  contextAfter: '',
});

export const createAnnotationContextMenuState = ({
  anchorX,
  anchorY,
  annotationId,
  annotationNote,
  horizontalBounds,
  placement,
  selectedText,
  selectionRect,
}: Omit<AnnotationContextMenuState, 'type' | 'visible'>): AnnotationContextMenuState => ({
  type: 'annotation',
  visible: true,
  placement,
  selectedText,
  anchorX,
  anchorY,
  horizontalBounds,
  selectionRect,
  annotationId,
  annotationNote,
});

export const resolveMobileContextMenuSyncAction = ({
  hasSelection,
  isInteractingWithinMenu,
  isMenuFocused,
  isMenuVisible,
}: {
  hasSelection: boolean;
  isInteractingWithinMenu: boolean;
  isMenuFocused: boolean;
  isMenuVisible: boolean;
}): MobileContextMenuSyncAction => {
  if (hasSelection) {
    return 'open-from-selection';
  }

  if (!isMenuVisible) {
    return 'close-menu';
  }

  if (isMenuFocused || isInteractingWithinMenu) {
    return 'keep-existing-menu';
  }

  return 'close-menu';
};

export const resolveContextMenuSelection = ({
  container,
  fallbackAnchorX,
  fallbackAnchorY,
  placement,
  selection,
}: ResolveContextMenuSelectionArgs): SelectionContextMenuState | null => {
  if (selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const selectedText = extractRangeText(range, selection.toString()).trim();
  if (!selectedText) {
    return null;
  }

  const ancestorNode = getNodeForContainmentCheck(range.commonAncestorContainer);
  if (!container.contains(ancestorNode)) {
    return null;
  }

  const selectionRect = getSelectionRect(range);
  const { contextBefore, contextAfter } = getSelectionContext(container, range);
  const containerRect = container.getBoundingClientRect?.();
  const anchorX = fallbackAnchorX ?? selectionRect.left + (selectionRect.width / 2);
  const anchorY = fallbackAnchorY ?? selectionRect.top + selectionRect.height;

  return {
    type: 'selection',
    visible: true,
    placement,
    selectedText,
    anchorX,
    anchorY,
    horizontalBounds: containerRect
      ? {
          left: containerRect.left,
          right: containerRect.right,
        }
      : undefined,
    selectionRect,
    contextBefore,
    contextAfter,
  };
};
