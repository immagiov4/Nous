const ALLOWED_RAW_HTML_TAGS = new Set(['mark']);
const RAW_HTML_TAG_REGEX = /<\/?([A-Za-z][A-Za-z0-9-]*)\b[^>]*>/g;

export interface RawHtmlProjection {
  content: string;
  sourceOffsets: number[];
}

export interface RawHtmlTagRange {
  end: number;
  start: number;
}

export const getAllowedRawHtmlTagRanges = (value: string, sourceStart = 0): RawHtmlTagRange[] =>
  Array.from(value.matchAll(RAW_HTML_TAG_REGEX)).flatMap(match => {
    if (!ALLOWED_RAW_HTML_TAGS.has(match[1].toLowerCase())) return [];
    const start = sourceStart + match.index;
    return [{ start, end: start + match[0].length }];
  });

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

  for (const match of value.matchAll(RAW_HTML_TAG_REGEX)) {
    const start = match.index;
    appendSource(cursor, start, false);
    appendSource(
      start,
      start + match[0].length,
      !ALLOWED_RAW_HTML_TAGS.has(match[1].toLowerCase())
    );
    cursor = start + match[0].length;
  }
  appendSource(cursor, value.length, false);
  sourceOffsets.push(value.length);
  return { content: characters.join(''), sourceOffsets };
};

export const escapeDisallowedRawHtml = (value: string): string =>
  projectDisallowedRawHtml(value).content;
