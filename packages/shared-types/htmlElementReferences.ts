import { parse } from 'acorn';

const HTML_RAW_TEXT_ELEMENT_PATTERN = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const HTML_ELEMENT_ID_PATTERN = /\bid\s*=\s*(["'])([^"']+)\1/giu;
const GET_ELEMENT_BY_ID_PATTERN = /\bdocument\.getElementById\(\s*(["'])([^"']+)\1\s*\)/gu;
const INLINE_SCRIPT_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu;
const SCRIPT_SOURCE_ATTRIBUTE_PATTERN = /\bsrc\s*=/iu;
const SCRIPT_TYPE_ATTRIBUTE_PATTERN = /\btype\s*=\s*(["'])([^"']+)\1/iu;

const compareByCodeUnit = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const isJavaScriptType = (type: string): boolean =>
  !type || type === 'module' || type === 'text/javascript' || type === 'application/javascript';

export const findMissingStaticHtmlElementIds = (html: string): string[] => {
  const staticMarkup = html.replaceAll(HTML_RAW_TEXT_ELEMENT_PATTERN, '');
  const declaredIds = new Set(
    Array.from(staticMarkup.matchAll(HTML_ELEMENT_ID_PATTERN), match => match[2]).filter(Boolean)
  );
  const missingIds = Array.from(html.matchAll(GET_ELEMENT_BY_ID_PATTERN), match => match[2]).filter(
    (id): id is string => Boolean(id) && !declaredIds.has(id)
  );
  return Array.from(new Set(missingIds)).sort(compareByCodeUnit);
};

const isWhitespace = (character: string | undefined): boolean =>
  character === ' ' || character === '\n' || character === '\r' || character === '\t';

export const hasUnsafeHtmlElementDereferences = (html: string): boolean => {
  const callPrefix = 'document.getElementById(';
  let searchFrom = 0;
  while (searchFrom < html.length) {
    const callStart = html.indexOf(callPrefix, searchFrom);
    if (callStart < 0) return false;
    let argumentStart = callStart + callPrefix.length;
    while (isWhitespace(html[argumentStart])) argumentStart += 1;
    const argumentQuote = html[argumentStart];
    const callEnd = html.indexOf(')', argumentStart);
    if (callEnd < 0) return false;
    let dereferenceStart = callEnd + 1;
    while (isWhitespace(html[dereferenceStart])) dereferenceStart += 1;
    if (argumentQuote !== '"' && argumentQuote !== "'" && html[dereferenceStart] === '.') {
      return true;
    }
    searchFrom = callEnd + 1;
  }
  return false;
};

export const hasInvalidInlineJavaScript = (html: string): boolean => {
  for (const match of html.matchAll(INLINE_SCRIPT_PATTERN)) {
    const attributes = match[1] || '';
    const source = match[2] || '';
    const type = SCRIPT_TYPE_ATTRIBUTE_PATTERN.exec(attributes)?.[2]?.trim().toLowerCase() || '';
    if (SCRIPT_SOURCE_ATTRIBUTE_PATTERN.test(attributes) || !isJavaScriptType(type)) continue;
    try {
      parse(source, { ecmaVersion: 'latest', sourceType: type === 'module' ? 'module' : 'script' });
    } catch {
      return true;
    }
  }
  return false;
};
