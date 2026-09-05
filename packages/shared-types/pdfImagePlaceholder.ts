export interface PdfImagePlaceholderInput {
  alt?: string;
  assetId: string;
  caption?: string;
}

export interface PdfImagePlaceholderOccurrence extends PdfImagePlaceholderInput {
  fullMatch: string;
}

const PDF_IMAGE_PLACEHOLDER_PREFIX = '{{PDF_IMAGE:';
const PDF_IMAGE_PLACEHOLDER_PAYLOAD = /^([^|{}]+)(?:\|alt=([^|]*))?(?:\|caption=(.*))?$/su;

const sanitizePdfImagePlaceholderField = (value: string): string =>
  value.replaceAll(/[|{}]/gu, ' ').replaceAll(/\s+/gu, ' ').trim();

export const buildPdfImagePlaceholder = (input: PdfImagePlaceholderInput): string => {
  const assetId = sanitizePdfImagePlaceholderField(input.assetId);
  const alt = sanitizePdfImagePlaceholderField(input.alt || 'Figura dal PDF');
  const caption = sanitizePdfImagePlaceholderField(input.caption || '');
  return caption
    ? `{{PDF_IMAGE:${assetId}|alt=${alt}|caption=${caption}}}`
    : `{{PDF_IMAGE:${assetId}|alt=${alt}}}`;
};

/** Retain canonical tokens and serialize brace-bearing legacy metadata for the reader. */
export const normalizePdfImagePlaceholder = (occurrence: PdfImagePlaceholderOccurrence): string =>
  occurrence.alt?.includes('{') || occurrence.caption?.includes('{')
    ? buildPdfImagePlaceholder(occurrence)
    : occurrence.fullMatch;

const findPdfImagePlaceholderEnd = (content: string, startIndex: number): number | null => {
  let braceDepth = 0;
  let legacyEndCandidate: number | null = null;
  for (
    let index = startIndex + PDF_IMAGE_PLACEHOLDER_PREFIX.length;
    index < content.length;
    index += 1
  ) {
    if (content.startsWith(PDF_IMAGE_PLACEHOLDER_PREFIX, index)) {
      return legacyEndCandidate;
    }
    if (content[index] === '{') {
      braceDepth += 1;
      continue;
    }
    if (content[index] !== '}') continue;

    const closesPlaceholder = content[index + 1] === '}';
    if (closesPlaceholder && legacyEndCandidate === null) {
      legacyEndCandidate = index + 2;
    }
    if (braceDepth > 0) {
      braceDepth -= 1;
      continue;
    }
    if (closesPlaceholder) return index + 2;
    return legacyEndCandidate === index + 1 ? legacyEndCandidate : null;
  }
  return legacyEndCandidate;
};

const parsePdfImagePlaceholder = (
  content: string,
  startIndex: number,
  endIndex: number
): PdfImagePlaceholderOccurrence | null => {
  const fullMatch = content.slice(startIndex, endIndex);
  const payload = fullMatch.slice(PDF_IMAGE_PLACEHOLDER_PREFIX.length, -2);
  const match = payload.match(PDF_IMAGE_PLACEHOLDER_PAYLOAD);
  if (!match) return null;
  return {
    assetId: match[1] ?? '',
    ...(match[2] === undefined ? {} : { alt: match[2] }),
    ...(match[3] === undefined ? {} : { caption: match[3] }),
    fullMatch,
  };
};

const rewriteClosedPdfImagePlaceholders = (
  content: string,
  rewrite: (input: {
    fullMatch: string;
    occurrence: PdfImagePlaceholderOccurrence | null;
  }) => string,
  rewriteText: (text: string) => string = text => text
): string => {
  const rewritten: string[] = [];
  let retainedUntil = 0;
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const startIndex = content.indexOf(PDF_IMAGE_PLACEHOLDER_PREFIX, searchFrom);
    if (startIndex < 0) break;
    const endIndex = findPdfImagePlaceholderEnd(content, startIndex);
    if (endIndex === null) {
      searchFrom = startIndex + PDF_IMAGE_PLACEHOLDER_PREFIX.length;
      continue;
    }
    const fullMatch = content.slice(startIndex, endIndex);
    const occurrence = parsePdfImagePlaceholder(content, startIndex, endIndex);
    rewritten.push(
      rewriteText(content.slice(retainedUntil, startIndex)),
      rewrite({ fullMatch, occurrence })
    );
    retainedUntil = endIndex;
    searchFrom = endIndex;
  }
  rewritten.push(rewriteText(content.slice(retainedUntil)));
  return rewritten.join('');
};

export const rewritePdfImagePlaceholders = (
  content: string,
  rewrite: (occurrence: PdfImagePlaceholderOccurrence) => string,
  rewriteText: (text: string) => string = text => text
): string =>
  rewriteClosedPdfImagePlaceholders(
    content,
    ({ fullMatch, occurrence }) => (occurrence ? rewrite(occurrence) : rewriteText(fullMatch)),
    rewriteText
  );

export const hasTextOutsidePdfImagePlaceholders = (content: string): boolean =>
  Boolean(rewritePdfImagePlaceholders(content, () => '').trim());
