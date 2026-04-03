// @vitest-environment jsdom
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createClosedContextMenuState,
  resolveContextMenuSelection,
  resolveMobileContextMenuSyncAction,
} from './contextMenuSelection.ts';

test('creates a closed context menu state with desktop placement default', () => {
  assert.deepEqual(createClosedContextMenuState(), {
    type: 'selection',
    visible: false,
    placement: 'desktop-floating',
    selectedText: '',
    contextBefore: '',
    contextAfter: '',
  });
});

test('resolves selection payload when the range belongs to the content container', () => {
  const ancestorNode = { nodeType: 1 } as Node;
  const beforeRange = {
    selectNodeContents: () => {},
    setEnd: () => {},
    toString: () => 'prefisso abbastanza lungo per il contesto',
  } as unknown as Range;
  const afterRange = {
    selectNodeContents: () => {},
    setStart: () => {},
    toString: () => 'suffisso abbastanza lungo per il contesto',
  } as unknown as Range;
  let cloneCallCount = 0;
  const range = {
    commonAncestorContainer: ancestorNode,
    startContainer: ancestorNode,
    startOffset: 4,
    endContainer: ancestorNode,
    endOffset: 9,
    cloneRange: () => {
      cloneCallCount += 1;
      return cloneCallCount === 1 ? beforeRange : afterRange;
    },
    getBoundingClientRect: () => ({
      top: 120,
      left: 32,
      width: 80,
      height: 24,
    }),
  } as unknown as Range;
  const selection = {
    rangeCount: 1,
    toString: () => 'testo selezionato',
    getRangeAt: () => range,
  } as unknown as Selection;
  const container = {
    contains: (node: Node) => node === ancestorNode,
    getBoundingClientRect: () => ({
      left: 384,
      right: 1160,
    }),
  } as HTMLElement;

  const resolved = resolveContextMenuSelection({
    container,
    placement: 'mobile-sheet',
    selection,
  });

  assert.equal(resolved?.visible, true);
  assert.equal(resolved?.placement, 'mobile-sheet');
  assert.equal(resolved?.selectedText, 'testo selezionato');
  assert.equal(resolved?.anchorX, 72);
  assert.equal(resolved?.anchorY, 144);
  assert.deepEqual(resolved?.selectionRect, {
    top: 120,
    left: 32,
    width: 80,
    height: 24,
  });
  assert.deepEqual(resolved?.horizontalBounds, {
    left: 384,
    right: 1160,
  });
  assert.match(resolved?.contextBefore ?? '', /prefisso/);
  assert.match(resolved?.contextAfter ?? '', /suffisso/);
});

test('normalizes KaTeX selection text so annotation matching does not receive duplicated formula copies', () => {
  const container = document.createElement('div');
  container.innerHTML = `
    <p>Dal modello analitico al game loop</p>
    <p>
      Un modello analitico produce la soluzione:
      <span class="katex-display">
        <span class="katex">
          <span class="katex-mathml">
            y(t)=12gt2+v0t+y0
            <annotation encoding="application/x-tex">y(t)=\\frac{1}{2}gt^2+v_0t+y_0</annotation>
          </span>
          <span class="katex-html" aria-hidden="true">y(t)=21gt2+v0t+y0</span>
        </span>
      </span>
      ma il videogioco procede per passi.
    </p>
  `;
  document.body.append(container);

  const range = document.createRange();
  range.selectNodeContents(container);
  range.getBoundingClientRect = () =>
    ({
      top: 32,
      left: 16,
      width: 240,
      height: 64,
    }) as DOMRect;

  const selection = {
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => range.toString(),
  } as unknown as Selection;

  const resolved = resolveContextMenuSelection({
    container,
    placement: 'desktop-floating',
    selection,
  });

  assert.ok(resolved);
  assert.ok(resolved.selectedText.includes('y(t)=frac12gt2+v0t+y0'));
  assert.equal((resolved.selectedText.match(/y\(t\)=frac12gt2\+v0t\+y0/gu) || []).length, 1);
  assert.ok(!resolved.selectedText.includes('\\frac'));
  assert.ok(!resolved.selectedText.includes('y(t)=21gt2+v0t+y0'));
});

test('returns null when selection is empty or outside the content container', () => {
  const ancestorNode = { nodeType: 1 } as Node;
  const range = {
    commonAncestorContainer: ancestorNode,
    getBoundingClientRect: () => ({
      top: 0,
      left: 0,
      width: 0,
      height: 0,
    }),
  } as unknown as Range;
  const container = {
    contains: () => false,
  } as unknown as HTMLElement;

  const emptySelection = {
    rangeCount: 0,
    toString: () => '   ',
    getRangeAt: () => range,
  } as unknown as Selection;

  const outsideSelection = {
    rangeCount: 1,
    toString: () => 'fuori',
    getRangeAt: () => range,
  } as unknown as Selection;

  assert.equal(resolveContextMenuSelection({
    container,
    placement: 'desktop-floating',
    selection: emptySelection,
  }), null);

  assert.equal(resolveContextMenuSelection({
    container,
    placement: 'desktop-floating',
    selection: outsideSelection,
  }), null);
});

test('closes the mobile sheet when the native selection disappears', () => {
  assert.equal(
    resolveMobileContextMenuSyncAction({
      hasSelection: false,
      isInteractingWithinMenu: false,
      isMenuFocused: false,
      isMenuVisible: true,
    }),
    'close-menu'
  );
});

test('keeps the mobile sheet open only while the menu itself is focused', () => {
  assert.equal(
    resolveMobileContextMenuSyncAction({
      hasSelection: false,
      isInteractingWithinMenu: false,
      isMenuFocused: true,
      isMenuVisible: true,
    }),
    'keep-existing-menu'
  );
});

test('keeps the mobile sheet open during taps inside the menu even without focus', () => {
  assert.equal(
    resolveMobileContextMenuSyncAction({
      hasSelection: false,
      isInteractingWithinMenu: true,
      isMenuFocused: false,
      isMenuVisible: true,
    }),
    'keep-existing-menu'
  );
});

test('opens the mobile sheet for a live selection and closes it otherwise', () => {
  assert.equal(
    resolveMobileContextMenuSyncAction({
      hasSelection: false,
      isInteractingWithinMenu: false,
      isMenuFocused: false,
      isMenuVisible: false,
    }),
    'close-menu'
  );

  assert.equal(
    resolveMobileContextMenuSyncAction({
      hasSelection: true,
      isInteractingWithinMenu: false,
      isMenuFocused: false,
      isMenuVisible: false,
    }),
    'open-from-selection'
  );
});
