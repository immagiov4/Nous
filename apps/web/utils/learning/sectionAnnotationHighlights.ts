import type { SectionAnnotation, SectionAnnotationTextSelector } from '../../types.ts';
import { projectKatexAnnotationSource } from '../markdown/codeRanges.ts';
import { isSelectionAnnotation } from './sectionAnnotationAnchors.ts';

const ANNOTATION_HIGHLIGHT_NAME = 'nous-annotations';
const NOTE_HIGHLIGHT_NAME = 'nous-annotation-notes';
const SELECTOR_CONTEXT_LENGTH = 48;
const PROJECTION_IGNORED_SELECTOR = 'script, style, [data-nous-speech="ignore"]';
const HIGHLIGHT_IGNORED_SELECTOR = 'pre, .katex, [data-nous-speech="ignore"]';
const KATEX_SELECTOR = '.katex';
const KATEX_TEX_ANNOTATION_SELECTOR = 'annotation[encoding="application/x-tex"]';
const BLOCK_SELECTOR = 'p, div, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, pre';

interface ProjectionCharacter {
  highlightElement?: Element;
  node: Text;
  offset: number;
}

interface DomTextProjection {
  characters: ProjectionCharacter[];
  text: string;
}

export interface SectionAnnotationHighlightEntry {
  annotationId: string;
  hasAttachedNote: boolean;
  ranges: Range[];
  selectedText: string;
}

export interface SectionAnnotationHighlightHit {
  annotationId: string;
  rect: DOMRect;
  selectedText: string;
}

const highlightHitsByEvent = new WeakMap<Event, SectionAnnotationHighlightHit>();
const activeHighlightEntries = new Set<SectionAnnotationHighlightEntry>();

export const supportsSectionAnnotationHighlights = (): boolean =>
  typeof CSS !== 'undefined' &&
  'highlights' in CSS &&
  typeof Highlight !== 'undefined' &&
  typeof document !== 'undefined';

const appendProjectionCharacter = (
  projection: DomTextProjection,
  character: string,
  node: Text,
  offset: number,
  highlightElement?: Element
) => {
  projection.text += character;
  projection.characters.push({ highlightElement, node, offset });
};

const appendNormalizedText = (projection: DomTextProjection, node: Text) => {
  for (let offset = 0; offset < node.data.length; offset += 1) {
    const character = node.data[offset];
    if (/\s/u.test(character)) {
      if (projection.text.length > 0 && !projection.text.endsWith(' ')) {
        appendProjectionCharacter(projection, ' ', node, offset);
      }
      continue;
    }

    appendProjectionCharacter(projection, character, node, offset);
  }
};

const appendProjectedMath = (
  projection: DomTextProjection,
  katexNode: Element,
  node: Text,
  texSource: string
) => {
  const projectedText = projectKatexAnnotationSource(texSource).trim() || texSource;
  const highlightElement = katexNode.closest('.katex-display')
    ? undefined
    : katexNode.querySelector('.katex-html') || undefined;
  for (let index = 0; index < projectedText.length; index += 1) {
    appendProjectionCharacter(
      projection,
      projectedText[index],
      node,
      Math.min(index, Math.max(0, node.data.length - 1)),
      highlightElement
    );
  }
};

const buildDomTextProjection = (root: HTMLElement): DomTextProjection => {
  const projection: DomTextProjection = { characters: [], text: '' };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const projectedKatexNodes = new Set<Element>();
  let previousBlock: Element | null = null;

  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const node = current as Text;
    const parent = node.parentElement;
    if (!parent || parent.closest(PROJECTION_IGNORED_SELECTOR)) {
      continue;
    }

    const block = parent.closest(BLOCK_SELECTOR);
    const katexNode = parent.closest(KATEX_SELECTOR);
    if (
      previousBlock &&
      block &&
      previousBlock !== block &&
      projection.text.length > 0 &&
      !projection.text.endsWith(' ')
    ) {
      appendProjectionCharacter(projection, ' ', node, 0);
    }

    if (katexNode) {
      if (!projectedKatexNodes.has(katexNode)) {
        projectedKatexNodes.add(katexNode);
        const texSource = katexNode
          .querySelector(KATEX_TEX_ANNOTATION_SELECTOR)
          ?.textContent?.trim();
        if (texSource) {
          appendProjectedMath(projection, katexNode, node, texSource);
        }
      }
    } else {
      appendNormalizedText(projection, node);
    }
    previousBlock = block;
  }

  if (projection.text.endsWith(' ')) {
    projection.text = projection.text.slice(0, -1);
    projection.characters.pop();
  }

  return projection;
};

const normalizeWhitespace = (value: string): string => value.replaceAll(/\s+/gu, ' ').trim();

const hasIgnoredDomGap = (
  previousCharacter: ProjectionCharacter,
  character: ProjectionCharacter
): boolean => {
  if (previousCharacter.node === character.node) {
    return false;
  }

  const gapRange = document.createRange();
  gapRange.setStart(previousCharacter.node, previousCharacter.offset + 1);
  gapRange.setEnd(character.node, character.offset);
  return Boolean(gapRange.cloneContents().querySelector(PROJECTION_IGNORED_SELECTOR));
};

const contextMatches = (
  text: string,
  matchStart: number,
  matchLength: number,
  selector: SectionAnnotationTextSelector
): boolean => {
  const before = normalizeWhitespace(
    text.slice(Math.max(0, matchStart - SELECTOR_CONTEXT_LENGTH - 16), matchStart)
  );
  const after = normalizeWhitespace(
    text.slice(matchStart + matchLength, matchStart + matchLength + SELECTOR_CONTEXT_LENGTH + 16)
  );
  const prefix = normalizeWhitespace(selector.prefix);
  const suffix = normalizeWhitespace(selector.suffix);
  return (
    (!prefix || before.endsWith(prefix) || prefix.endsWith(before)) &&
    (!suffix || after.startsWith(suffix) || suffix.startsWith(after))
  );
};

const findSelectorRange = (
  projection: DomTextProjection,
  selector: SectionAnnotationTextSelector
): { end: number; start: number } | null => {
  const exact = normalizeWhitespace(selector.exact);
  if (!exact) {
    return null;
  }

  const matches: number[] = [];
  let searchFrom = 0;
  while (searchFrom <= projection.text.length - exact.length) {
    const matchStart = projection.text.indexOf(exact, searchFrom);
    if (matchStart < 0) {
      break;
    }
    matches.push(matchStart);
    searchFrom = matchStart + 1;
  }

  const contextualMatches = matches.filter(matchStart =>
    contextMatches(projection.text, matchStart, exact.length, selector)
  );
  const candidates = contextualMatches.length > 0 ? contextualMatches : matches;
  return candidates.length === 1
    ? { start: candidates[0], end: candidates[0] + exact.length }
    : null;
};

const createHighlightRanges = (
  projection: DomTextProjection,
  start: number,
  end: number
): Range[] => {
  const ranges: Range[] = [];
  let currentRange: Range | null = null;
  let previousHighlightElement: Element | null = null;
  let previousCharacter: ProjectionCharacter | null = null;

  for (let index = start; index < end; index += 1) {
    const character = projection.characters[index];
    if (character?.highlightElement) {
      if (currentRange) {
        ranges.push(currentRange);
        currentRange = null;
      }
      if (previousHighlightElement !== character.highlightElement) {
        const mathRange = document.createRange();
        mathRange.selectNodeContents(character.highlightElement);
        ranges.push(mathRange);
      }
      previousHighlightElement = character.highlightElement;
      previousCharacter = null;
      continue;
    }

    previousHighlightElement = null;
    if (!character || character.node.parentElement?.closest(HIGHLIGHT_IGNORED_SELECTOR)) {
      if (currentRange) {
        ranges.push(currentRange);
        currentRange = null;
      }
      previousCharacter = null;
      continue;
    }

    if (previousCharacter && hasIgnoredDomGap(previousCharacter, character)) {
      if (currentRange) {
        ranges.push(currentRange);
      }
      currentRange = null;
    }

    if (!currentRange) {
      currentRange = document.createRange();
      currentRange.setStart(character.node, character.offset);
    }

    currentRange.setEnd(character.node, character.offset + 1);
    previousCharacter = character;
  }

  if (currentRange) {
    ranges.push(currentRange);
  }

  return ranges;
};

export const resolveSectionAnnotationHighlightEntries = (
  root: HTMLElement,
  annotations?: SectionAnnotation[]
): SectionAnnotationHighlightEntry[] => {
  const selectionAnnotations = (annotations || []).filter(isSelectionAnnotation);
  if (selectionAnnotations.length === 0) {
    return [];
  }

  const projection = buildDomTextProjection(root);
  return selectionAnnotations.flatMap(annotation => {
    const projectionRange = findSelectorRange(projection, annotation.anchor.selector);
    if (!projectionRange) {
      return [];
    }

    const ranges = createHighlightRanges(projection, projectionRange.start, projectionRange.end);
    return ranges.length > 0
      ? [
          {
            annotationId: annotation.id,
            hasAttachedNote:
              annotation.note.trim().length > 0 || (annotation.artifactRefs?.length || 0) > 0,
            ranges,
            selectedText: annotation.anchor.selector.exact,
          },
        ]
      : [];
  });
};

export const registerSectionAnnotationHighlights = (
  entries: SectionAnnotationHighlightEntry[]
): (() => void) => {
  if (!supportsSectionAnnotationHighlights()) {
    return () => undefined;
  }

  const annotationHighlight = CSS.highlights.get(ANNOTATION_HIGHLIGHT_NAME) || new Highlight();
  const noteHighlight = CSS.highlights.get(NOTE_HIGHLIGHT_NAME) || new Highlight();
  CSS.highlights.set(ANNOTATION_HIGHLIGHT_NAME, annotationHighlight);
  CSS.highlights.set(NOTE_HIGHLIGHT_NAME, noteHighlight);

  for (const entry of entries) {
    activeHighlightEntries.add(entry);
    for (const range of entry.ranges) {
      annotationHighlight.add(range);
      if (entry.hasAttachedNote) {
        noteHighlight.add(range);
      }
    }
  }

  return () => {
    for (const entry of entries) {
      activeHighlightEntries.delete(entry);
      for (const range of entry.ranges) {
        annotationHighlight.delete(range);
        noteHighlight.delete(range);
      }
    }
  };
};

const getCaretPoint = (x: number, y: number): { node: Node; offset: number } | null => {
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) {
    return { node: position.offsetNode, offset: position.offset };
  }

  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
};

export const findSectionAnnotationHighlightHit = (
  entries: SectionAnnotationHighlightEntry[],
  x: number,
  y: number
): SectionAnnotationHighlightHit | null => {
  const point = getCaretPoint(x, y);

  for (const entry of entries) {
    const range = point
      ? entry.ranges.find(candidate => candidate.isPointInRange(point.node, point.offset))
      : undefined;
    if (range) {
      return {
        annotationId: entry.annotationId,
        rect: range.getBoundingClientRect(),
        selectedText: entry.selectedText,
      };
    }

    for (const candidate of entry.ranges) {
      const rect = Array.from(candidate.getClientRects()).find(
        candidateRect =>
          x >= candidateRect.left &&
          x <= candidateRect.right &&
          y >= candidateRect.top &&
          y <= candidateRect.bottom
      );
      if (rect) {
        return {
          annotationId: entry.annotationId,
          rect,
          selectedText: entry.selectedText,
        };
      }
    }
  }

  return null;
};

export const findActiveSectionAnnotationHighlightHit = (
  x: number,
  y: number
): SectionAnnotationHighlightHit | null =>
  findSectionAnnotationHighlightHit(Array.from(activeHighlightEntries), x, y);

export const setSectionAnnotationHighlightHit = (
  event: Event,
  hit: SectionAnnotationHighlightHit
) => {
  highlightHitsByEvent.set(event, hit);
};

export const getSectionAnnotationHighlightHit = (
  event: Event
): SectionAnnotationHighlightHit | undefined => highlightHitsByEvent.get(event);
