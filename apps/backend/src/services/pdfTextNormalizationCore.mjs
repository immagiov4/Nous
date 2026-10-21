const isPageMarkerLine = line => {
  const trimmedLine = line.trim();
  if (!trimmedLine.startsWith('--') || !trimmedLine.endsWith('--')) {
    return false;
  }

  const content = trimmedLine.slice(2, -2).trim();
  const parts = content.split(/\s+/);
  return (
    parts.length === 3 &&
    /^\d+$/u.test(parts[0] || '') &&
    (parts[1] || '').toLowerCase() === 'of' &&
    /^\d+$/u.test(parts[2] || '')
  );
};

export const normalizeExtractedTextSegment = text =>
  text
    .replaceAll(/\r\n?/g, '\n')
    .split('\n')
    .filter(line => !isPageMarkerLine(line))
    .join('\n')
    .replaceAll('\f', '\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
