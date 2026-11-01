/** Move a UTF-16 cut past a complete supplementary character, retaining source offsets. */
export const sourceTextEndOffset = (text: string, offset: number): number => {
  const end = Math.min(text.length, Math.max(0, offset));
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? end + 1
    : end;
};

/** Move a non-negative UTF-16 cut back when a whole character would exceed a hard budget. */
export const sourceTextStartOffset = (text: string, offset: number): number => {
  const end = sourceTextEndOffset(text, offset);
  return end > offset ? offset - 1 : end;
};

/** Sample non-negative UTF-16 ranges without extending either boundary. */
export const sliceSourceText = (text: string, start: number, end = text.length): string => {
  if (end <= start) return '';
  return text.slice(sourceTextEndOffset(text, start), sourceTextStartOffset(text, end));
};

/** Project historical UTF-16 samples without incomplete boundary characters. */
export const clipSourceExcerptText = (text: string): string => {
  const first = text.charCodeAt(0);
  const last = text.charCodeAt(text.length - 1);
  return text.slice(
    first >= 0xdc00 && first <= 0xdfff ? 1 : 0,
    last >= 0xd800 && last <= 0xdbff ? text.length - 1 : text.length
  );
};
