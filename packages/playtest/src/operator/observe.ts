import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { CapturedDom, ProbeWindow } from '../probes/pageProbes';

export const SCREENSHOT_PRIVACY_MASK = {
  color: '#FF00FF',
  shape: 'opaque bounding-box rectangles',
  scope: 'credential-bearing controls and reflected secret text',
  purpose: 'Harness privacy redactions, not application UI or defects.',
} as const;

export type VisibleNode = {
  ref: string;
  role: string;
  name: string;
  box: { x: number; y: number; w: number; h: number };
  point?: { x: number; y: number };
};
export type Observation = {
  stepIndex: number;
  url: string;
  screenshotPath: string;
  nodes: VisibleNode[];
  dom?: CapturedDom;
  inspectionEligible?: boolean;
  diagnostics?: { capture: { unstable: true } };
};

export type OperatorWindow = typeof globalThis & {
  __playtestCapture?: {
    version: number;
    observer: MutationObserver;
    count(records: MutationRecord[]): number;
    resume(): void;
  };
  __playtestOperator?: {
    document: Document;
    prefix: string;
    nextRef: number;
    ids: WeakMap<Element, string>;
    elements: Map<string, Element>;
  };
};

/** Same-document changes invalidate captures just as navigation does. */
export function initializeCaptureCounter(): void {
  const scope = globalThis as OperatorWindow;
  const count = (records: MutationRecord[]) =>
    records.filter(record => {
      // Playwright's screenshot masks add/remove this glass pane; mixed app mutations still count.
      const instrumental =
        record.type === 'childList' &&
        record.target === document.documentElement &&
        [...record.addedNodes, ...record.removedNodes].every(
          node => node instanceof Element && node.localName === 'x-pw-glass'
        );
      return !instrumental;
    }).length;
  const capture = {
    version: 0,
    count,
    observer: new MutationObserver(records => {
      capture.version += count(records);
    }),
    resume() {
      capture.observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    },
  };
  capture.resume();
  scope.__playtestCapture = capture;
}

/** Runs in the page: text is checked at glyph rectangles rather than trusting ancestor names. */
function visibleSnapshot({
  secrets,
  prefix,
  inspectionSelector,
}: {
  secrets: string[];
  prefix: string;
  inspectionSelector?: string;
}) {
  const scope = globalThis as OperatorWindow;
  if (scope.__playtestOperator?.document !== document) {
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
  const hitsElement = (element: Element, x: number, y: number, textOnly = false) => {
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
  const visibleAt = (element: Element, rect: DOMRect, textOnly = false) => {
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    if (rect.width <= 0 || rect.height <= 0) return false;
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    return (
      x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && hitsElement(element, x, y, textOnly)
    );
  };
  const coverageEdges = ({
    left,
    right,
    top,
    bottom,
  }: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }) => {
    const xs = new Set([left, right]),
      ys = new Set([top, bottom]);
    for (const other of elements) {
      const box = other.getBoundingClientRect();
      if (box.right <= left || box.left >= right || box.bottom <= top || box.top >= bottom)
        continue;
      xs.add(Math.max(left, box.left));
      xs.add(Math.min(right, box.right));
      ys.add(Math.max(top, box.top));
      ys.add(Math.min(bottom, box.bottom));
    }
    return { columns: [...xs].sort((a, b) => a - b), rows: [...ys].sort((a, b) => a - b) };
  };
  const uncoveredPoint = (element: Element, rect: DOMRect) => {
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return;
    const left = Math.max(0, rect.left),
      right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top),
      bottom = Math.min(innerHeight, rect.bottom);
    if (left >= right || top >= bottom) return;
    const centre = { x: (left + right) / 2, y: (top + bottom) / 2 };
    if (hitsElement(element, centre.x, centre.y)) return centre;
    // Rectangle edges partition the intersection into cells with constant rectangular coverage.
    const { columns, rows } = coverageEdges({ left, right, top, bottom });
    for (let column = 1; column < columns.length; column++) {
      for (let row = 1; row < rows.length; row++) {
        const point = {
          x: (columns[column - 1] + columns[column]) / 2,
          y: (rows[row - 1] + rows[row]) / 2,
        };
        if (hitsElement(element, point.x, point.y)) return point;
      }
    }
  };
  const semanticSelector =
    'button, a[href], input, textarea, select, h1, h2, h3, h4, h5, h6, [role], [contenteditable]';
  const names = new Map<Element, string>();
  const textRuns = new Map<Element, string[]>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const collectNames = () => {
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const parent = text.parentElement;
      if (!parent || parent.closest('script, style, noscript, template, input, textarea')) continue;
      // Skip the whole secret-bearing label before clipping, so even partial secrets cannot escape.
      if (secretTextElements.some(element => element.contains(parent))) continue;
      const label = parent.closest('label');
      const owner = label?.control ?? parent.closest(semanticSelector) ?? parent;
      names.set(owner, `${names.get(owner) ?? ''}${readVisibleText(text, parent)}`);
    }
  };
  const readVisibleText = (text: Node, parent: Element) => {
    let visibleText = '';
    // Keep DOM-node and occlusion boundaries: joining separated runs can invent missing spaces.
    let run = '';
    const runs: string[] = [];
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
        run += content[offset];
      } else if (run) {
        runs.push(run);
        run = '';
      }
    }
    if (run) runs.push(run);
    textRuns.set(parent, [...(textRuns.get(parent) ?? []), ...runs]);
    return visibleText;
  };
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
  const registeredNodes = () => {
    const nodes: VisibleNode[] = [];
    for (const [element, rawName] of names) {
      const box = element.getBoundingClientRect();
      const point = uncoveredPoint(element, box);
      if (!point) continue;
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
      nodes.push({
        ref,
        role,
        name,
        box: { x: box.x, y: box.y, w: box.width, h: box.height },
        point,
      });
    }
    return nodes;
  };
  const capture = scope.__playtestCapture;
  if (capture) {
    capture.version += capture.count(capture.observer.takeRecords());
    // Measurement temporarily changes pointer-events; synchronous page code cannot interleave here.
    capture.observer.disconnect();
  }
  try {
    collectNames();
    for (const element of elements) {
      if (!element.matches(`${semanticSelector}, img`)) continue;
      // Attribute names and native values have no text rectangles to verify for clipping or coverage.
      if (!names.has(element)) names.set(element, '');
    }
    const inspectionEligible =
      inspectionSelector === undefined
        ? undefined
        : elements.some(
            element =>
              element.matches(inspectionSelector) &&
              uncoveredPoint(element, element.getBoundingClientRect()) !== undefined
          );
    return {
      nodes: registeredNodes(),
      inspectionEligible,
      dom: (scope as ProbeWindow).__playtestProbes?.snapshot(secrets, textRuns),
    };
  } finally {
    capture?.resume();
  }
}

/** Credentials, including encoded copies, are withheld from learner-facing URLs and labels. */
export function redact(text: string, secrets: string[]): string {
  for (const secret of secrets.filter(Boolean)) {
    const formEncoded = new URLSearchParams({ secret }).toString().slice('secret='.length);
    for (const representation of new Set([
      secret,
      encodeURIComponent(secret),
      encodeURI(secret),
      formEncoded,
    ])) {
      text = text.replaceAll(representation, '[redacted]');
    }
  }
  return text;
}

export async function observePage(options: {
  page: Page;
  stepIndex: number;
  screenshotPath: string;
  secrets: string[];
  inspectionSelector?: string;
}): Promise<Observation> {
  const { page, stepIndex, screenshotPath, secrets } = options;
  const { nodes, inspectionEligible, dom } = await page.evaluate(visibleSnapshot, {
    secrets,
    prefix: randomUUID(),
    inspectionSelector: options.inspectionSelector,
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
    // Hiding the caret mutates editable styles and would invalidate this capture's DOM counter.
    caret: 'initial',
    maskColor: SCREENSHOT_PRIVACY_MASK.color,
    // Only controls that actually hold a generated secret are masked, so an empty login form
    // looks to the learner exactly as it looks to a person.
    mask: [
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
  return {
    stepIndex,
    url: redact(url, secrets),
    screenshotPath,
    nodes,
    dom,
    ...(inspectionEligible === undefined ? {} : { inspectionEligible }),
  };
}
