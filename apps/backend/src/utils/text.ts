// Normalizes backend text values before storage or comparison.
export const normalizeLineEndings = (value: string): string => value.replaceAll(/\r\n?/g, '\n');
