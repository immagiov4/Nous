const HTML_ELEMENT_ID_PATTERN = /\bid\s*=\s*(["'])([^"']+)\1/gi;
const GET_ELEMENT_BY_ID_PATTERN = /\bdocument\.getElementById\(\s*(["'])([^"']+)\1\s*\)/g;
const UNSAFE_GET_ELEMENT_BY_ID_PATTERN = /\bdocument\.getElementById\([^)]*\)\s*\./g;

export const findMissingStaticHtmlElementIds = (html: string): string[] => {
  const declaredIds = new Set(
    Array.from(html.matchAll(HTML_ELEMENT_ID_PATTERN), match => match[2]).filter(Boolean)
  );
  const missingIds = Array.from(html.matchAll(GET_ELEMENT_BY_ID_PATTERN), match => match[2]).filter(
    (id): id is string => Boolean(id) && !declaredIds.has(id)
  );

  return Array.from(new Set(missingIds)).sort();
};

export const hasUnsafeHtmlElementDereferences = (html: string): boolean =>
  UNSAFE_GET_ELEMENT_BY_ID_PATTERN.test(html);
