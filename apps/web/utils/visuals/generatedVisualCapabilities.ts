export const GENERATED_VISUAL_CAPABILITY_VERSION = 1;

export const GENERATED_VISUAL_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data: blob:',
  'media-src data: blob:',
  "connect-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "manifest-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

const FORBIDDEN_ELEMENTS = new Set(['base', 'embed', 'form', 'iframe', 'link', 'object']);
const EMBEDDED_RESOURCE_ATTRIBUTES = new Set(['poster', 'src']);
const CLASSIC_SCRIPT_TYPES = new Set(['', 'application/javascript', 'text/javascript']);

const isEmbeddedResource = (value: string): boolean => {
  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue.startsWith('data:') || normalizedValue.startsWith('blob:');
};

const hasForbiddenAttribute = (element: Element): boolean => {
  if (element.hasAttribute('action') || element.hasAttribute('formaction')) {
    return true;
  }
  if (element.hasAttribute('srcset') || element.hasAttribute('ping')) {
    return true;
  }

  for (const attributeName of EMBEDDED_RESOURCE_ATTRIBUTES) {
    const value = element.getAttribute(attributeName);
    if (value !== null && !isEmbeddedResource(value)) {
      return true;
    }
  }

  const href = element.getAttribute('href') ?? element.getAttribute('xlink:href');
  if (href === null) {
    return false;
  }
  if (href.trim().startsWith('#')) {
    return false;
  }
  return element.localName !== 'image' || !isEmbeddedResource(href);
};

/** Checks the deterministic browser capabilities requested by generated markup. */
export const supportsGeneratedVisualCapabilities = (code: string): boolean => {
  const template = document.createElement('template');
  template.innerHTML = code;

  for (const element of template.content.querySelectorAll('*')) {
    const elementName = element.localName.toLowerCase();
    if (FORBIDDEN_ELEMENTS.has(elementName)) {
      return false;
    }
    if (elementName === 'meta' && element.hasAttribute('http-equiv')) {
      return false;
    }
    if (elementName === 'script') {
      const scriptType = (element.getAttribute('type') ?? '').trim().toLowerCase();
      if (element.hasAttribute('src') || !CLASSIC_SCRIPT_TYPES.has(scriptType)) {
        return false;
      }
    }
    if (hasForbiddenAttribute(element)) {
      return false;
    }
  }

  return true;
};
