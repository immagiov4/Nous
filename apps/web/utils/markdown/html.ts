const ALLOWED_RAW_HTML_TAGS = new Set(['mark']);

export const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const escapeDisallowedRawHtml = (value: string): string =>
  value.replace(/<\/?([A-Za-z][A-Za-z0-9-]*)\b[^>]*>/g, match => {
    const tagNameMatch = match.match(/^<\/?\s*([A-Za-z][A-Za-z0-9-]*)/);
    const tagName = tagNameMatch?.[1]?.toLowerCase() || '';
    return ALLOWED_RAW_HTML_TAGS.has(tagName) ? match : escapeHtml(match);
  });
