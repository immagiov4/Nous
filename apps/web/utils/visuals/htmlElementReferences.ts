import { parse } from 'acorn';

const HTML_RAW_TEXT_ELEMENT_PATTERN = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const HTML_ELEMENT_ID_PATTERN = /\bid\s*=\s*(["'])([^"']+)\1/gi;
const GET_ELEMENT_BY_ID_PATTERN = /\bdocument\.getElementById\(\s*(["'])([^"']+)\1\s*\)/g;
const DIRECT_GET_ELEMENT_BY_ID_DEREFERENCE_PATTERN =
  /\bdocument\.getElementById\(\s*(["'])([^"']+)\1\s*\)\s*\./g;
const UNSAFE_GET_ELEMENT_BY_ID_PATTERN = /\bdocument\.getElementById\(\s*(?!["'])[^)]*\)\s*\./;
const INLINE_SCRIPT_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SCRIPT_SOURCE_ATTRIBUTE_PATTERN = /\bsrc\s*=/i;
const SCRIPT_TYPE_ATTRIBUTE_PATTERN = /\btype\s*=\s*(["'])([^"']+)\1/i;

const isJavaScriptType = (type: string): boolean =>
  !type || type === 'module' || type === 'text/javascript' || type === 'application/javascript';

export const findMissingStaticHtmlElementIds = (html: string): string[] => {
  const staticMarkup = html.replace(HTML_RAW_TEXT_ELEMENT_PATTERN, '');
  const declaredIds = new Set(
    Array.from(staticMarkup.matchAll(HTML_ELEMENT_ID_PATTERN), match => match[2]).filter(Boolean)
  );
  const missingIds = Array.from(html.matchAll(GET_ELEMENT_BY_ID_PATTERN), match => match[2]).filter(
    (id): id is string => Boolean(id) && !declaredIds.has(id)
  );

  return Array.from(new Set(missingIds)).sort();
};

export const findMissingDirectlyDereferencedHtmlElementIds = (html: string): string[] => {
  const staticMarkup = html.replace(HTML_RAW_TEXT_ELEMENT_PATTERN, '');
  const declaredIds = new Set(
    Array.from(staticMarkup.matchAll(HTML_ELEMENT_ID_PATTERN), match => match[2]).filter(Boolean)
  );
  const missingIds = Array.from(
    html.matchAll(DIRECT_GET_ELEMENT_BY_ID_DEREFERENCE_PATTERN),
    match => match[2]
  ).filter((id): id is string => Boolean(id) && !declaredIds.has(id));

  return Array.from(new Set(missingIds)).sort();
};

export const hasUnsafeHtmlElementDereferences = (html: string): boolean =>
  UNSAFE_GET_ELEMENT_BY_ID_PATTERN.test(html);

export const hasInvalidInlineJavaScript = (html: string): boolean => {
  for (const match of html.matchAll(INLINE_SCRIPT_PATTERN)) {
    const attributes = match[1] || '';
    const source = match[2] || '';
    const type = SCRIPT_TYPE_ATTRIBUTE_PATTERN.exec(attributes)?.[2]?.trim().toLowerCase() || '';
    if (SCRIPT_SOURCE_ATTRIBUTE_PATTERN.test(attributes) || !isJavaScriptType(type)) {
      continue;
    }

    try {
      parse(source, { ecmaVersion: 'latest', sourceType: type === 'module' ? 'module' : 'script' });
    } catch {
      return true;
    }
  }

  return false;
};
