import type { ElementHandle, Page } from 'playwright';
import type { Observation, OperatorWindow, VisibleNode } from './observe';

export type LearnerAction =
  | { type: 'observe' }
  | { type: 'click'; ref: string }
  | { type: 'type'; ref: string; text: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; direction: 'up' | 'down' }
  | { type: 'drag'; ref: string; dx: number; dy: number }
  | { type: 'fill-credential'; ref: string; field: 'email' | 'password' };

export type ActionResult<View = Observation> =
  | { status: 'ok'; observation: View }
  | { status: 'stale-reference' | 'not-actionable'; observation: View; detail: string }
  | {
      status: 'target-moved';
      observation: View;
      detail: string;
      observedBox: VisibleNode['box'];
      currentBox: VisibleNode['box'];
    };

type ActionExecution =
  | { status: 'ok' | 'stale-reference' | 'not-actionable' }
  | Omit<Extract<ActionResult, { status: 'target-moved' }>, 'observation'>;

async function attached(element: ElementHandle<Element>): Promise<boolean> {
  try {
    return await element.evaluate(element => element.isConnected);
  } catch {
    // Navigation disposes handles from the previous document.
    return false;
  }
}

async function actOnElement(
  page: Page,
  element: ElementHandle<Element>,
  action: Exclude<LearnerAction, { type: 'press' | 'scroll' | 'observe' }>,
  options: {
    credentials: { email: string; password: string };
    observedBox?: VisibleNode['box'];
    mobile: boolean;
  }
): Promise<ActionExecution> {
  const target = await element.evaluate((element, observedBox) => {
    if (!element.isConnected) return { status: 'stale-reference' as const };
    const box = element.getBoundingClientRect();
    const currentBox = { x: box.x, y: box.y, w: box.width, h: box.height };
    const pointBox = observedBox ?? currentBox;
    const x = pointBox.x + pointBox.w / 2;
    const y = pointBox.y + pointBox.h / 2;
    const top = document.elementFromPoint(x, y);
    if (observedBox && !(top && (element === top || element.contains(top)))) {
      return {
        status: 'target-moved' as const,
        observedBox,
        currentBox,
        detail: 'The observed point no longer hits the referenced element.',
      };
    }
    if (
      !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
      box.width <= 0 ||
      box.height <= 0 ||
      x < 0 ||
      y < 0 ||
      x >= innerWidth ||
      y >= innerHeight ||
      !top ||
      !(element === top || element.contains(top)) ||
      element.matches(':disabled, [aria-disabled="true"]')
    ) {
      return { status: 'not-actionable' as const };
    }
    return { status: 'ok' as const, x, y };
  }, options.observedBox);
  if (target.status !== 'ok') return target;
  const { credentials } = options;
  switch (action.type) {
    case 'click':
      if (options.mobile) await page.touchscreen.tap(target.x, target.y);
      else await page.mouse.click(target.x, target.y);
      break;
    case 'type':
    case 'fill-credential': {
      const editable = await element.evaluate(element =>
        element.matches(
          'input:not([readonly]), textarea:not([readonly]), [contenteditable="true"], [contenteditable=""]'
        )
      );
      if (!editable) return { status: 'not-actionable' };
      if (action.type === 'fill-credential') {
        const matchingField = await element.evaluate((element, field) => {
          if (!(element instanceof HTMLInputElement)) return false;
          if (field === 'password') return element.type === 'password';
          return element.type === 'email' || ['email', 'username'].includes(element.autocomplete);
        }, action.field);
        if (!matchingField) return { status: 'not-actionable' };
        await element.fill(credentials[action.field]);
      } else {
        await element.fill('');
        await page.keyboard.type(action.text);
      }
      break;
    }
    case 'drag':
      if (options.mobile) return { status: 'not-actionable' };
      await page.mouse.move(target.x, target.y);
      await page.mouse.down();
      try {
        await page.mouse.move(target.x + action.dx, target.y + action.dy);
      } finally {
        await page.mouse.up();
      }
      break;
  }
  return { status: 'ok' };
}

/** Resolve identity, never a selector that could silently target a replacement element. */
export async function executeAction(
  page: Page,
  action: LearnerAction,
  credentials: { email: string; password: string },
  options: { nodes: VisibleNode[]; mobile: boolean }
): Promise<ActionExecution> {
  if (action.type === 'observe') return { status: 'ok' };
  if (action.type === 'press') {
    try {
      await page.keyboard.press(action.key);
      return { status: 'ok' };
    } catch {
      return { status: 'not-actionable' };
    }
  }
  if (action.type === 'scroll') {
    const height = page.viewportSize()?.height;
    if (!height) throw new Error('Operator viewport must be configured');
    await page.mouse.wheel(0, action.direction === 'down' ? height : -height);
    return { status: 'ok' };
  }
  const handle = await page.evaluateHandle(
    ref => (globalThis as OperatorWindow).__playtestOperator?.elements.get(ref) ?? null,
    action.ref
  );
  const element = handle.asElement() as ElementHandle<Element> | null;
  try {
    if (!element || !(await attached(element))) return { status: 'stale-reference' };
    try {
      const pointerAction = action.type === 'click' || action.type === 'drag';
      const observedBox = options.nodes.find(node => node.ref === action.ref)?.box;
      if (pointerAction && !observedBox) return { status: 'stale-reference' };
      return await actOnElement(page, element, action, {
        credentials,
        mobile: options.mobile,
        observedBox: pointerAction ? observedBox : undefined,
      });
    } catch {
      return { status: (await attached(element)) ? 'not-actionable' : 'stale-reference' };
    }
  } finally {
    await handle.dispose();
  }
}
