import type { LessonPlaybackBlock, PlaybackContentBlock } from '@shared/lessonPlayback';
import { buildVisibleProjection } from '../markdown/textProjection.ts';

const isInlineWhitespace = (character: string): boolean => character === ' ' || character === '\t';
const MARKDOWN_LINE_ENDING_PATTERN = /\r\n?/gu;
const normalizeMarkdownLineEndings = (text: string): string =>
  text.replaceAll(MARKDOWN_LINE_ENDING_PATTERN, '\n');

const trimTrailingInlineSpace = (characters: string[]): void => {
  while (characters.at(-1) === ' ') {
    characters.pop();
  }
};

const appendInlineSpace = (characters: string[]): void => {
  if (characters.length > 0 && characters.at(-1) !== ' ') {
    characters.push(' ');
  }
};

const appendCollapsedNewline = (characters: string[], consecutiveNewlines: number): void => {
  trimTrailingInlineSpace(characters);
  if (consecutiveNewlines <= 2) {
    characters.push('\n');
  }
};

const collapseWhitespace = (text: string): string => {
  const characters: string[] = [];
  let consecutiveNewlines = 0;

  for (const character of normalizeMarkdownLineEndings(text)) {
    if (isInlineWhitespace(character)) {
      appendInlineSpace(characters);
      continue;
    }

    if (character === '\n') {
      consecutiveNewlines += 1;
      appendCollapsedNewline(characters, consecutiveNewlines);
      continue;
    }

    consecutiveNewlines = 0;
    characters.push(character);
  }

  return characters.join('').trim();
};

export const READER_NON_SPEECH_SELECTOR =
  'figure, figcaption, img, picture, svg, canvas, [data-nous-speech="ignore"]';
const READABLE_TEXT_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote';
const PROSE_READABLE_TEXT_SELECTOR = READABLE_TEXT_SELECTOR.split(', ')
  .map(selector => `.prose ${selector}`)
  .join(', ');

export interface ReadableTextElement {
  element: HTMLElement;
  text: string;
}

const extractReadableElementText = (element: HTMLElement): string => {
  const clone = element.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(`pre, .katex, .katex-display, script, style, ${READER_NON_SPEECH_SELECTOR}`)
    .forEach(node => {
      node.remove();
    });

  return collapseWhitespace(clone.innerText || clone.textContent || '');
};

export const buildReadableTextElements = (container: HTMLElement): ReadableTextElement[] => {
  const proseTextElements = container.querySelectorAll(PROSE_READABLE_TEXT_SELECTOR);
  const textElements =
    proseTextElements.length > 0
      ? proseTextElements
      : container.querySelectorAll(READABLE_TEXT_SELECTOR);

  return Array.from(textElements)
    .filter(node => !(node as HTMLElement).closest(READER_NON_SPEECH_SELECTOR))
    .map(node => {
      const element = node as HTMLElement;
      return { element, text: extractReadableElementText(element) };
    })
    .filter(item => item.text.length > 0);
};

/** Map speech-source ranges to the rendered prose used by the text picker, including entities. */
export const projectReadableSpeech = (
  blocks: readonly LessonPlaybackBlock[],
  content: readonly PlaybackContentBlock[]
): string[] => {
  const projections = content.map(block =>
    block.type === 'markdown' ? buildVisibleProjection(block.markdown) : null
  );
  return blocks.map(block =>
    collapseWhitespace(
      block.spans
        .map(span => {
          if (span.math || span.fencedCode) return '';
          if (span.source.start === span.source.end)
            return block.speech.slice(span.speech.start, span.speech.end);
          const projection = projections[span.sourceBlockIndex];
          if (!projection) throw new Error('Speech text must have a Markdown source.');
          const start = projection.sourceIndexes.findIndex(
            index => index >= span.source.start && index < span.source.end
          );
          if (start < 0) return '';
          const end = projection.sourceIndexes.findIndex(
            (sourceIndex, visibleIndex) => visibleIndex >= start && sourceIndex >= span.source.end
          );
          return projection.text.slice(start, end < 0 ? undefined : end);
        })
        .join('')
    )
  );
};
