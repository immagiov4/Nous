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
