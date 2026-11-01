import { sliceSourceText } from '@shared/sourceTextSlice';

export const clipText = (value: string, maxChars: number, suffix: string): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${sliceSourceText(value, 0, maxChars).trimEnd()}\n\n${suffix}`;
};

export const normalizeLineEndings = (value: string): string => value.replaceAll(/\r\n?/g, '\n');
