const ALLOWED_RAW_HTML_TAGS = new Set(['mark']);

interface RawHtmlTag extends RawHtmlTagRange {
  name: string;
}

export interface RawHtmlProjection {
  content: string;
  sourceOffsets: number[];
}

export interface RawHtmlTagRange {
  end: number;
  start: number;
}

const getRawHtmlTags = (value: string): RawHtmlTag[] => {
  const tags: RawHtmlTag[] = [];
  let start = value.indexOf('<');
  while (start !== -1) {
    let cursor = start + 1;
    if (value[cursor] === '/') cursor += 1;
    const nameStart = cursor;
    if (!/[A-Za-z]/u.test(value[cursor] || '')) {
      start = value.indexOf('<', start + 1);
      continue;
    }
    cursor += 1;
    while (/[A-Za-z0-9-]/u.test(value[cursor] || '')) cursor += 1;
    const name = value.slice(nameStart, cursor);
    let quote: '"' | "'" | null = null;
    while (cursor < value.length) {
      const character = value[cursor];
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        tags.push({ start, end: cursor + 1, name });
        break;
      }
      cursor += 1;
    }
    start = value.indexOf('<', Math.max(start + 1, cursor + 1));
  }
  return tags;
};

export const getRawHtmlTagRanges = (value: string, sourceStart = 0): RawHtmlTagRange[] =>
  getRawHtmlTags(value).map(range => ({
    start: sourceStart + range.start,
    end: sourceStart + range.end,
  }));

export const getAllowedRawHtmlTagRanges = (value: string, sourceStart = 0): RawHtmlTagRange[] =>
  getRawHtmlTags(value).flatMap(range =>
    ALLOWED_RAW_HTML_TAGS.has(range.name.toLowerCase())
      ? [{ start: sourceStart + range.start, end: sourceStart + range.end }]
      : []
  );

const escapeHtmlCharacter = (character: string): string => {
  if (character === '&') return '&amp;';
  if (character === '<') return '&lt;';
  if (character === '>') return '&gt;';
  return character;
};

export const escapeRegExp = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

export const projectDisallowedRawHtml = (value: string): RawHtmlProjection => {
  const characters: string[] = [];
  const sourceOffsets: number[] = [];
  let cursor = 0;

  const appendSource = (start: number, end: number, shouldEscape: boolean) => {
    for (let index = start; index < end; index += 1) {
      const output = shouldEscape ? escapeHtmlCharacter(value[index]) : value[index];
      characters.push(...output);
      sourceOffsets.push(...Array.from({ length: output.length }, () => index));
    }
  };

  for (const match of getRawHtmlTags(value)) {
    const start = match.start;
    appendSource(cursor, start, false);
    appendSource(start, match.end, !ALLOWED_RAW_HTML_TAGS.has(match.name.toLowerCase()));
    cursor = match.end;
  }
  appendSource(cursor, value.length, false);
  sourceOffsets.push(value.length);
  return { content: characters.join(''), sourceOffsets };
};

export const escapeDisallowedRawHtml = (value: string): string =>
  projectDisallowedRawHtml(value).content;
