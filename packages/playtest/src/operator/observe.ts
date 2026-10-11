import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';

export type VisibleNode = {
  ref: string;
  role: string;
  name: string;
  box: { x: number; y: number; w: number; h: number };
};
export type Observation = {
  stepIndex: number;
  url: string;
  screenshotPath: string;
  nodes: VisibleNode[];
};

export type OperatorWindow = typeof globalThis & {
  __playtestOperator?: {
    document: Document;
    prefix: string;
    nextRef: number;
    ids: WeakMap<Element, string>;
    elements: Map<string, Element>;
  };
};

/** Runs in the page: text is checked at glyph rectangles rather than trusting ancestor names. */
function visibleSnapshot({ secrets, prefix }: { secrets: string[]; prefix: string }) {
  const scope = globalThis as OperatorWindow;
  if (!scope.__playtestOperator || scope.__playtestOperator.document !== document) {
    scope.__playtestOperator = {
      document,
      prefix,
      nextRef: 0,
      ids: new WeakMap(),
      elements: new Map(),
    };
  }
  const registry = scope.__playtestOperator;
  for (const [ref, element] of registry.elements) {
    if (!element.isConnected) registry.elements.delete(ref);
  }
  const containsSecret = (text: string) => secrets.some(secret => secret && text.includes(secret));
  const elements = Array.from(document.querySelectorAll('*'));
  const secretTextElements = elements.filter(
    element =>
      containsSecret(element.textContent ?? '') &&
      !Array.from(element.children).some(child => containsSecret(child.textContent ?? ''))
  );
  const visibleAt = (element: Element, rect: DOMRect, textOnly = false) => {
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    if (rect.width <= 0 || rect.height <= 0) return false;
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    // Non-interactive copy still paints; restore its hit testing only while measuring coverage.
    const style = (element as HTMLElement | SVGElement).style;
    const pointerEvents = style.getPropertyValue('pointer-events');
    const priority = style.getPropertyPriority('pointer-events');
    const restoreHitTesting = getComputedStyle(element).pointerEvents === 'none';
    try {
      if (restoreHitTesting) style.setProperty('pointer-events', 'auto', 'important');
      const top = document.elementFromPoint(x, y);
      return top === element || (!textOnly && top !== null && element.contains(top));
    } finally {
      if (restoreHitTesting) {
        if (pointerEvents) style.setProperty('pointer-events', pointerEvents, priority);
        else style.removeProperty('pointer-events');
      }
    }
  };
  const semanticSelector =
    'button, a[href], input, textarea, select, h1, h2, h3, h4, h5, h6, [role], [contenteditable]';
  const names = new Map<Element, string>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const parent = text.parentElement;
    if (!parent || parent.closest('script, style, noscript, template, input, textarea')) continue;
    // Skip the whole secret-bearing label before clipping, so even partial secrets cannot escape.
    if (secretTextElements.some(element => element.contains(parent))) continue;
    const label = parent.closest('label');
    const owner = label?.control ?? parent.closest(semanticSelector) ?? parent;
    let visibleText = '';
    const content = text.textContent ?? '';
    for (let offset = 0; offset < content.length; offset++) {
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      const rect = range.getBoundingClientRect();
      // A character crossing the viewport edge is withheld in full.
      if (
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= innerWidth &&
        rect.bottom <= innerHeight &&
        visibleAt(parent, rect, true)
      ) {
        visibleText += content[offset];
      }
    }
    names.set(owner, `${names.get(owner) ?? ''}${visibleText}`);
  }
  const implicitRole = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (element as HTMLInputElement).type;
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return (
      (
        {
          button: 'button',
          a: 'link',
          textarea: 'textbox',
          select: 'combobox',
          img: 'img',
        } as Record<string, string>
      )[tag] ?? 'text'
    );
  };
  for (const element of elements) {
    if (!element.matches(`${semanticSelector}, img`)) continue;
    // Attribute names and native values have no text rectangles to verify for clipping or coverage.
    if (!names.has(element)) names.set(element, '');
  }
  const nodes: VisibleNode[] = [];
  for (const [element, rawName] of names) {
    const box = element.getBoundingClientRect();
    if (!visibleAt(element, box)) continue;
    const name = containsSecret(rawName) ? '' : rawName.replace(/\s+/g, ' ').trim();
    const declaredRole = element.getAttribute('role');
    const role =
      declaredRole && !containsSecret(declaredRole) ? declaredRole : implicitRole(element);
    if (!name && role === 'text') continue;
    let ref = registry.ids.get(element);
    if (!ref) {
      ref = `${registry.prefix}:${registry.nextRef++}`;
      registry.ids.set(element, ref);
    }
    registry.elements.set(ref, element);
    nodes.push({ ref, role, name, box: { x: box.x, y: box.y, w: box.width, h: box.height } });
  }
  return nodes;
}

/** Credentials, including encoded copies, are withheld from learner-facing URLs and labels. */
function redact(text: string, secrets: string[]): string {
  for (const secret of secrets.filter(Boolean)) {
    const formEncoded = new URLSearchParams({ secret }).toString().slice('secret='.length);
    for (const representation of new Set([
      secret,
      encodeURIComponent(secret),
      encodeURI(secret),
      formEncoded,
    ])) {
      text = text.split(representation).join('[redacted]');
    }
  }
  return text;
}

export async function observePage(options: {
  page: Page;
  stepIndex: number;
  screenshotPath: string;
  secrets: string[];
}): Promise<Observation> {
  const { page, stepIndex, screenshotPath, secrets } = options;
  const nodes = await page.evaluate(visibleSnapshot, {
    secrets,
    prefix: randomUUID(),
  });
  const editable = page.locator('input, textarea, [contenteditable]');
  const secretFields = await editable.evaluateAll(
    (elements, secrets) =>
      elements.flatMap((element, index) => {
        const value =
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.value
            : (element.textContent ?? '');
        return secrets.some(secret => secret && value.includes(secret)) ? [index] : [];
      }),
    secrets
  );
  await page.screenshot({
    path: screenshotPath,
    fullPage: false,
    // Live locators keep credential fields masked even if the app replaces them during capture.
    mask: [
      page.locator(
        'input[type="password"], input[type="email"], input[autocomplete="username"], input[autocomplete="email"]'
      ),
      ...secretFields.map(index => editable.nth(index)),
      ...secrets.filter(Boolean).map(secret => page.getByText(secret)),
    ],
  });
  let url = page.url();
  const location = new URL(url);
  // Inline document payloads expose hidden DOM just as directly as an unfiltered tree.
  if (location.protocol === 'data:') {
    url = `${url.slice(0, url.indexOf(','))},[redacted]`;
  } else {
    location.username = '';
    location.password = '';
    url = location.href;
  }
  return { stepIndex, url: redact(url, secrets), screenshotPath, nodes };
}
