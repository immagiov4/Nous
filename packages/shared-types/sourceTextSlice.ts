/** Move a UTF-16 cut past a complete supplementary character, retaining source offsets. */
export const sourceTextEndOffset = (text: string, offset: number): number => {
  const end = Math.min(text.length, Math.max(0, offset));
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? end + 1
    : end;
};

/** Sample non-negative UTF-16 offsets, including the whole character at either cut. */
export const sliceSourceText = (text: string, start: number, end = text.length): string => {
  if (end <= start) return '';
  const alignedStart = sourceTextEndOffset(text, start);
  return text.slice(alignedStart > start ? start - 1 : start, sourceTextEndOffset(text, end));
};
