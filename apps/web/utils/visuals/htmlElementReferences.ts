export {
  findMissingStaticHtmlElementIds,
  hasInvalidInlineJavaScript,
  hasUnsafeHtmlElementDereferences,
} from '@shared/htmlElementReferences';

const DIRECT_GET_ELEMENT_BY_ID_DEREFERENCE_PATTERN =
  /\bdocument\.getElementById\(\s*(["'])([^"']+)\1\s*\)\s*\./g;

const compareElementIdsByCodeUnit = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

export const findMissingDirectlyDereferencedHtmlElementIds = (html: string): string[] => {
  const HTML_RAW_TEXT_ELEMENT_PATTERN = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  const HTML_ELEMENT_ID_PATTERN = /\bid\s*=\s*(["'])([^"']+)\1/gi;
  const staticMarkup = html.replaceAll(HTML_RAW_TEXT_ELEMENT_PATTERN, '');
  const declaredIds = new Set(
    Array.from(staticMarkup.matchAll(HTML_ELEMENT_ID_PATTERN), match => match[2]).filter(Boolean)
  );
  const missingIds = Array.from(
    html.matchAll(DIRECT_GET_ELEMENT_BY_ID_DEREFERENCE_PATTERN),
    match => match[2]
  ).filter((id): id is string => Boolean(id) && !declaredIds.has(id));

  return Array.from(new Set(missingIds)).sort(compareElementIdsByCodeUnit);
};
