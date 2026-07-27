const collapseInternalNewlines = (value: string): string =>
  value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ');

const unwrapWholeFenceBlock = (value: string): string | null => {
  const lines = value.split('\n');
  if (lines.length < 3) return null;

  const openingLine = lines[0]?.trim() || '';
  const closingLine = lines.at(-1)?.trim() || '';
  if (!/^```(?:[a-z0-9_+-]+)?$/iu.test(openingLine) || closingLine !== '```') return null;

  return collapseInternalNewlines(lines.slice(1, -1).join('\n').trim());
};

const unwrapWholeInlineCode = (value: string): string | null => {
  let fenceLength = 0;
  while (value[fenceLength] === '`') fenceLength += 1;
  if (fenceLength === 0) return null;

  const fence = '`'.repeat(fenceLength);
  if (!value.endsWith(fence) || value.length <= fenceLength * 2) return null;

  const unwrapped = value.slice(fenceLength, value.length - fenceLength).trim();
  return unwrapped ? collapseInternalNewlines(unwrapped) : null;
};

export const unwrapWholeQuizCodeFormatting = (value: string): string => {
  const trimmedValue = value.trim();
  if (!trimmedValue) return '';

  const fencedBlock = unwrapWholeFenceBlock(trimmedValue);
  if (fencedBlock !== null) return fencedBlock;

  return unwrapWholeInlineCode(trimmedValue) ?? trimmedValue;
};
