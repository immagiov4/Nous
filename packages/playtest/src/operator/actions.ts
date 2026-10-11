import type { ElementHandle, Page } from 'playwright';
import type { Observation, OperatorWindow } from './observe';

export type LearnerAction =
  | { type: 'observe' }
  | { type: 'click'; ref: string }
  | { type: 'type'; ref: string; text: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; direction: 'up' | 'down' }
  | { type: 'drag'; ref: string; dx: number; dy: number }
  | { type: 'fill-credential'; ref: string; field: 'email' | 'password' };

export type ActionResult =
  | { status: 'ok'; observation: Observation }
  | { status: 'stale-reference' | 'not-actionable'; observation: Observation; detail: string };

type ActionStatus = ActionResult['status'];

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
  credentials: { email: string; password: string }
): Promise<ActionStatus> {
  const target = await element.evaluate(element => {
    if (!element.isConnected) return { status: 'stale-reference' as const };
    const box = element.getBoundingClientRect();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const top = document.elementFromPoint(x, y);
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
  });
  if (target.status !== 'ok') return target.status;
  switch (action.type) {
    case 'click':
      await element.click();
      break;
    case 'type':
    case 'fill-credential': {
      const editable = await element.evaluate(element =>
        element.matches(
          'input:not([readonly]), textarea:not([readonly]), [contenteditable="true"], [contenteditable=""]'
        )
      );
      if (!editable) return 'not-actionable';
      if (action.type === 'fill-credential') {
        const matchingField = await element.evaluate((element, field) => {
          if (!(element instanceof HTMLInputElement)) return false;
          if (field === 'password') return element.type === 'password';
          return element.type === 'email' || ['email', 'username'].includes(element.autocomplete);
        }, action.field);
        if (!matchingField) return 'not-actionable';
        await element.fill(credentials[action.field]);
      } else {
        await element.fill('');
        await page.keyboard.type(action.text);
      }
      break;
    }
    case 'drag':
      await page.mouse.move(target.x, target.y);
      await page.mouse.down();
      try {
        await page.mouse.move(target.x + action.dx, target.y + action.dy);
      } finally {
        await page.mouse.up();
      }
      break;
  }
  return 'ok';
}

/** Resolve identity, never a selector that could silently target a replacement element. */
export async function executeAction(
  page: Page,
  action: LearnerAction,
  credentials: { email: string; password: string }
): Promise<ActionStatus> {
  if (action.type === 'observe') return 'ok';
  if (action.type === 'press') {
    try {
      await page.keyboard.press(action.key);
      return 'ok';
    } catch {
      return 'not-actionable';
    }
  }
  if (action.type === 'scroll') {
    const height = page.viewportSize()?.height;
    if (!height) throw new Error('Operator viewport must be configured');
    await page.mouse.wheel(0, action.direction === 'down' ? height : -height);
    await page.evaluate(
      () =>
        new Promise<void>(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    return 'ok';
  }
  const handle = await page.evaluateHandle(
    ref => (globalThis as OperatorWindow).__playtestOperator?.elements.get(ref) ?? null,
    action.ref
  );
  const element = handle.asElement() as ElementHandle<Element> | null;
  try {
    if (!element || !(await attached(element))) return 'stale-reference';
    try {
      return await actOnElement(page, element, action, credentials);
    } catch {
      return (await attached(element)) ? 'not-actionable' : 'stale-reference';
    }
  } finally {
    await handle.dispose();
  }
}
