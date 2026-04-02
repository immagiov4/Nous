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
  assert.match(resolved?.contextBefore ?? '', /prefisso/);
  assert.match(resolved?.contextAfter ?? '', /suffisso/);
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
