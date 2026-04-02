import type {
  AnnotationContextMenuState,
  ContextMenuPlacement,
  ContextMenuState,
  SelectionContextMenuState,
  SelectionRect,
} from '../types';

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
  selectedText: string;
  selectionRect: SelectionRect;
}

const DEFAULT_CONTEXT_WINDOW = 48;

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
    contextBefore: beforeRange.toString().slice(-DEFAULT_CONTEXT_WINDOW),
    contextAfter: afterRange.toString().slice(0, DEFAULT_CONTEXT_WINDOW),
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
  const selectedText = selection.toString().trim();
  if (!selectedText || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const ancestorNode = getNodeForContainmentCheck(range.commonAncestorContainer);
  if (!container.contains(ancestorNode)) {
    return null;
  }

  const selectionRect = getSelectionRect(range);
  const { contextBefore, contextAfter } = getSelectionContext(container, range);
  const anchorX = fallbackAnchorX ?? selectionRect.left + (selectionRect.width / 2);
  const anchorY = fallbackAnchorY ?? selectionRect.top + selectionRect.height;

  return {
    type: 'selection',
    visible: true,
    placement,
    selectedText,
    anchorX,
    anchorY,
    selectionRect,
    contextBefore,
    contextAfter,
  };
};
