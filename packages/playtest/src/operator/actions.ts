import type { ElementHandle, Page } from 'playwright';
import { recordDiagnostic } from '../diagnostics';
import type { Observation, OperatorWindow, VisibleNode } from './observe';

export type LearnerAction =
  | { type: 'observe' }
  | { type: 'click'; ref: string; button?: 'left' | 'right' }
  | { type: 'select'; ref: string; label: string }
  | { type: 'type'; ref: string; text: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; direction: 'up' | 'down'; ref?: string }
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
  } catch (error) {
    recordDiagnostic('target-resolution', error);
    // Navigation disposes handles from the previous document.
    return false;
  }
}

async function clickAtPoint(
  page: Page,
  point: { x: number; y: number },
  button: 'left' | 'right' | undefined,
  mobile: boolean
): Promise<ActionExecution> {
  if (mobile && button === 'right') return { status: 'not-actionable' };
  if (mobile) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y, { button });
  return { status: 'ok' };
}

async function selectNativeOption(
  element: ElementHandle<Element>,
  label: string
): Promise<ActionExecution> {
  if (!(await element.evaluate(element => element instanceof HTMLSelectElement)))
    return { status: 'not-actionable' };
  await element.selectOption({ label });
  return { status: 'ok' };
}

async function actOnElement(
  page: Page,
  element: ElementHandle<Element>,
  action: Exclude<LearnerAction, { type: 'press' | 'observe' }>,
  options: {
    credentials: { email: string; password: string };
    observedBox?: VisibleNode['box'];
    observedPoint?: NonNullable<VisibleNode['point']>;
    mobile: boolean;
  }
): Promise<ActionExecution> {
  const target = await element.evaluate(
    (element, { observedBox, observedPoint }) => {
      if (!element.isConnected) return { status: 'stale-reference' as const };
      const box = element.getBoundingClientRect();
      const currentBox = { x: box.x, y: box.y, w: box.width, h: box.height };
      const pointBox = observedBox ?? currentBox;
      const x =
        observedPoint?.x ??
        Math.max(0, pointBox.x) +
          (Math.min(innerWidth, pointBox.x + pointBox.w) - Math.max(0, pointBox.x)) / 2;
      const y =
        observedPoint?.y ??
        Math.max(0, pointBox.y) +
          (Math.min(innerHeight, pointBox.y + pointBox.h) - Math.max(0, pointBox.y)) / 2;
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
    },
    { observedBox: options.observedBox, observedPoint: options.observedPoint }
  );
  if (target.status !== 'ok') return target;
  const { credentials } = options;
  switch (action.type) {
    case 'click':
      return clickAtPoint(page, target, action.button, options.mobile);
    case 'scroll':
      await page.mouse.move(target.x, target.y);
      return executeGlobalAction(page, action);
    case 'select':
      return selectNativeOption(element, action.label);
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

async function executeGlobalAction(
  page: Page,
  action: Extract<LearnerAction, { type: 'observe' | 'press' | 'scroll' }>
): Promise<ActionExecution> {
  if (action.type === 'observe') return { status: 'ok' };
  if (action.type === 'press') {
    try {
      await page.keyboard.press(action.key);
      return { status: 'ok' };
    } catch (error) {
      recordDiagnostic('keyboard', error);
      return { status: 'not-actionable' };
    }
  }
  if (action.type === 'scroll') {
    const height = page.viewportSize()?.height;
    if (!height) throw new Error('Operator viewport must be configured');
    await page.mouse.wheel(0, action.direction === 'down' ? height : -height);
    return { status: 'ok' };
  }
  throw new Error('Unknown global action.');
}

/** Resolve identity, never a selector that could silently target a replacement element. */
export async function executeAction(
  page: Page,
  action: LearnerAction,
  credentials: { email: string; password: string },
  options: { nodes: VisibleNode[]; mobile: boolean }
): Promise<ActionExecution> {
  if (
    action.type === 'observe' ||
    action.type === 'press' ||
    (action.type === 'scroll' && action.ref === undefined)
  )
    return executeGlobalAction(page, action);
  const handle = await page.evaluateHandle(
    ref => (globalThis as OperatorWindow).__playtestOperator?.elements.get(ref) ?? null,
    action.ref as string
  );
  const element = handle.asElement() as ElementHandle<Element> | null;
  try {
    if (!element) return { status: 'stale-reference' };
    try {
      const pointerAction = ['click', 'drag', 'scroll', 'select'].includes(action.type);
      const observed = options.nodes.find(node => node.ref === action.ref);
      if (pointerAction && !observed) return { status: 'stale-reference' };
      return await actOnElement(page, element, action, {
        credentials,
        mobile: options.mobile,
        observedBox: pointerAction ? observed?.box : undefined,
        observedPoint: pointerAction ? observed?.point : undefined,
      });
    } catch (error) {
      recordDiagnostic('element-action', error);
      return { status: (await attached(element)) ? 'not-actionable' : 'stale-reference' };
    }
  } finally {
    await handle.dispose();
  }
}
