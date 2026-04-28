const collapseWhitespace = (text: string): string =>
  text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const BLOCK_PAUSE_WEIGHT = 200;
const NON_SPEECH_SELECTOR =
  'figure, figcaption, img, picture, svg, canvas, [data-nous-speech="ignore"]';

const getReadingWeight = (text: string): number => {
  const baseLength = text.length;
  const periods = (text.match(/[.!?]/g) || []).length;
  const commas = (text.match(/[,;:]/g) || []).length;
  return baseLength + periods * 60 + commas * 20;
};

export interface ReadableSegment {
  startAudio: number;
  endAudio: number;
  top: number;
  bottom: number;
}

export interface ReadableBlock extends ReadableSegment {
  text: string;
  hitTop: number;
  hitBottom: number;
}

export const prepareMarkdownForSpeech = (content: string): string => {
  const cleanedContent = content
    .replace(/\{\{PDF_IMAGE:[^}]+\}\}/g, ' ')
    .replace(/\{\{VISUAL_EXAMPLE:[^}]+\}\}/g, ' ')
    .replace(/<figure\b[\s\S]*?<\/figure>/gi, ' ')
    .replace(/<picture\b[\s\S]*?<\/picture>/gi, ' ')
    .replace(/<figcaption\b[\s\S]*?<\/figcaption>/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<\/?mark\b[^>]*>/g, '')
    .replace(/<\/?span[^>]*>/g, '')
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/`[^`]+`/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, '\n')
    .replace(/\\\[[\s\S]*?\\\]/g, '\n')
    .replace(/\$(?!\s)[^$\n]+?\$/g, ' ')
    .replace(/\\\(([\s\S]*?)\\\)/g, ' ')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|-|\*|\+|\d+\.)\s+/gm, '')
    .replace(/[*_~|]+/g, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ');

  return collapseWhitespace(cleanedContent);
};

export const extractReadableElementText = (element: HTMLElement): string => {
  const clone = element.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(`pre, code, .katex, .katex-display, script, style, ${NON_SPEECH_SELECTOR}`)
    .forEach(node => {
      node.remove();
    });

  return collapseWhitespace(clone.innerText ?? clone.textContent ?? '');
};

export const buildReadableBlocks = (container: HTMLElement): ReadableBlock[] => {
  const containerRect = container.getBoundingClientRect();
  const proseContainer = container.querySelector('.prose') || container;
  const textElements = proseContainer.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote');

  let totalWeight = 0;
  const weightedElements = Array.from(textElements)
    .filter(node => !(node as HTMLElement).closest(NON_SPEECH_SELECTOR))
    .map(node => {
      const element = node as HTMLElement;
      const text = extractReadableElementText(element);
      const weight = getReadingWeight(text);
      totalWeight += weight > 0 ? weight + BLOCK_PAUSE_WEIGHT : 0;
      return { element, weight };
    })
    .filter(item => item.weight > 0);

  if (totalWeight === 0) {
    return [];
  }

  const blocks: Array<Omit<ReadableBlock, 'hitTop' | 'hitBottom'>> = [];
  let weightSoFar = 0;

  weightedElements.forEach(({ element, weight }) => {
    const text = extractReadableElementText(element);
    const startPct = weightSoFar / totalWeight;
    const endPct = (weightSoFar + weight) / totalWeight;
    const elementRect = element.getBoundingClientRect();
    const elementTop = elementRect.top - containerRect.top;

    blocks.push({
      startAudio: startPct,
      endAudio: endPct,
      top: elementTop,
      bottom: elementTop + elementRect.height,
      text,
    });

    weightSoFar += weight + BLOCK_PAUSE_WEIGHT;
  });

  return blocks.map((block, index) => {
    const previousBlock = blocks[index - 1];
    const nextBlock = blocks[index + 1];

    return {
      ...block,
      hitTop: previousBlock ? (previousBlock.bottom + block.top) / 2 : block.top,
      hitBottom: nextBlock ? (block.bottom + nextBlock.top) / 2 : block.bottom,
    };
  });
};

export const buildReadableSegments = (container: HTMLElement): ReadableSegment[] =>
  buildReadableBlocks(container).map(({ startAudio, endAudio, top, bottom }) => ({
    startAudio,
    endAudio,
    top,
    bottom,
  }));
