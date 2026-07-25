import type {
  AnnotationContextMenuState,
  ContextMenuPlacement,
  ContextMenuState,
  HorizontalViewportBounds,
  LessonContextMenuState,
  SelectionContextMenuState,
  SelectionRect,
} from '../../types';
import {
  normalizeMathSelectionArtifacts,
  projectKatexAnnotationSource,
} from '../markdown/codeRanges.ts';
import { buildVisibleProjection } from '../markdown/textProjection.ts';
import { READER_NON_SPEECH_SELECTOR } from '../reader/readingText.ts';

interface ResolveContextMenuSelectionArgs {
  content?: string;
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
  selectedTextStart?: number;
  selectionRect: SelectionRect;
}

const DEFAULT_CONTEXT_WINDOW = 48;
const KATEX_TEX_ANNOTATION_SELECTOR = 'annotation[encoding="application/x-tex"]';
const LESSON_CONTENT_ROOT_SELECTOR = '[data-nous-lesson-content-root="true"]';

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
    container.querySelectorAll(READER_NON_SPEECH_SELECTOR).forEach(node => {
      node.remove();
    });

    Array.from(container.querySelectorAll('.katex')).forEach(katexNode => {
      const texAnnotation = katexNode.querySelector(KATEX_TEX_ANNOTATION_SELECTOR);
      const texSource = texAnnotation?.textContent?.trim();

      if (texSource) {
        const projectedText = projectKatexAnnotationSource(texSource).trim() || texSource;
        katexNode.replaceWith(ownerDocument.createTextNode(projectedText));
        return;
      }

      katexNode.querySelectorAll(KATEX_TEX_ANNOTATION_SELECTOR).forEach(node => {
        node.remove();
      });
      if (katexNode.querySelector('.katex-mathml')) {
        katexNode.querySelectorAll('.katex-html').forEach(node => {
          node.remove();
        });
      }
    });

    container.querySelectorAll(KATEX_TEX_ANNOTATION_SELECTOR).forEach(node => {
      node.remove();
    });
    container.querySelectorAll('script, style').forEach(node => {
      node.remove();
    });

    return normalizeMathSelectionArtifacts(container.textContent || fallbackText || '');
  } catch {
    // intentional: fallback to default
    return normalizeMathSelectionArtifacts(fallbackText || range.toString());
  }
};

export type MobileContextMenuSyncAction =
  | 'open-from-selection'
  | 'keep-existing-menu'
  | 'close-menu';

const getNodeForContainmentCheck = (node: Node): Node => {
  return node.nodeType === 3 && node.parentNode ? node.parentNode : node;
};

const isWithinNonSpeechSurface = (node: Node): boolean => {
  const containmentNode = getNodeForContainmentCheck(node);
  return (
    containmentNode.nodeType === 1 &&
    typeof (containmentNode as Element).closest === 'function' &&
    Boolean((containmentNode as Element).closest(READER_NON_SPEECH_SELECTOR))
  );
};

const getSelectionContext = (
  container: HTMLElement,
  range: Range,
  content: string | undefined,
  selectedText: string
): Pick<ResolvedSelectionPayload, 'contextBefore' | 'contextAfter' | 'selectedTextStart'> => {
  const beforeRange = range.cloneRange();
  beforeRange.selectNodeContents(container);
  beforeRange.setEnd(range.startContainer, range.startOffset);

  const afterRange = range.cloneRange();
  afterRange.selectNodeContents(container);
  afterRange.setStart(range.endContainer, range.endOffset);

  const textBeforeSelection = extractRangeText(beforeRange, beforeRange.toString());
  const precedingOccurrenceCount = selectedText
    ? textBeforeSelection.split(selectedText).length - 1
    : 0;
  const projectedContent = content ? buildVisibleProjection(content).text : '';
  let selectedTextStart: number | undefined;
  let searchStart = 0;
  for (let occurrence = 0; occurrence <= precedingOccurrenceCount; occurrence += 1) {
    const occurrenceStart = projectedContent.indexOf(selectedText, searchStart);
    if (occurrenceStart === -1) {
      selectedTextStart = undefined;
      break;
    }
    selectedTextStart = occurrenceStart;
    searchStart = occurrenceStart + selectedText.length;
  }

  const projectedContextBefore =
    selectedTextStart === undefined
      ? textBeforeSelection
      : projectedContent.slice(
          Math.max(0, selectedTextStart - DEFAULT_CONTEXT_WINDOW),
          selectedTextStart
        );
  const projectedContextAfter =
    selectedTextStart === undefined
      ? extractRangeText(afterRange, afterRange.toString())
      : projectedContent.slice(
          selectedTextStart + selectedText.length,
          selectedTextStart + selectedText.length + DEFAULT_CONTEXT_WINDOW
        );

  return {
    contextBefore: projectedContextBefore.slice(-DEFAULT_CONTEXT_WINDOW),
    contextAfter: projectedContextAfter.slice(0, DEFAULT_CONTEXT_WINDOW),
    selectedTextStart,
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

export const createLessonContextMenuState = ({
  anchorX,
  anchorY,
  horizontalBounds,
  placement,
}: {
  anchorX: number;
  anchorY: number;
  horizontalBounds?: HorizontalViewportBounds;
  placement: ContextMenuPlacement;
}): LessonContextMenuState => ({
  type: 'lesson',
  visible: true,
  placement,
  selectedText: '',
  anchorX,
  anchorY,
  horizontalBounds,
  contextBefore: '',
  contextAfter: '',
});

export const createAnnotationContextMenuState = ({
  anchorX,
  anchorY,
  annotationId,
  annotationArtifactRefs,
  annotationNote,
  contextAfter,
  contextBefore,
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
  annotationArtifactRefs,
  annotationNote,
  contextBefore,
  contextAfter,
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
  content,
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
  const lessonContentRoot = container.querySelector<HTMLElement>(LESSON_CONTENT_ROOT_SELECTOR);
  const selectionContainer = lessonContentRoot || container;
  const ancestorNode = getNodeForContainmentCheck(range.commonAncestorContainer);
  if (
    !selectionContainer.contains(ancestorNode) ||
    isWithinNonSpeechSurface(range.startContainer) ||
    isWithinNonSpeechSurface(range.endContainer)
  ) {
    return null;
  }

  const selectedText = extractRangeText(range, selection.toString()).trim();
  if (!selectedText) {
    return null;
  }

  const selectionRect = getSelectionRect(range);
  const { contextBefore, contextAfter, selectedTextStart } = getSelectionContext(
    selectionContainer,
    range,
    content,
    selectedText
  );
  const containerRect = container.getBoundingClientRect?.();
  const anchorX = fallbackAnchorX ?? selectionRect.left + selectionRect.width / 2;
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
    selectedTextStart,
  };
};
