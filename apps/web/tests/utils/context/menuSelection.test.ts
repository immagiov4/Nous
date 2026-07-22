// @vitest-environment jsdom
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createClosedContextMenuState,
  createLessonContextMenuState,
  resolveContextMenuSelection,
  resolveMobileContextMenuSyncAction,
} from '../../../utils/context/menuSelection.ts';
import { applySectionAnnotation } from '../../../utils/learning/sectionAnnotations.ts';

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

test('creates a lesson context menu state anchored to the whole lesson', () => {
  assert.deepEqual(
    createLessonContextMenuState({
      anchorX: 240,
      anchorY: 180,
      horizontalBounds: { left: 120, right: 960 },
      placement: 'desktop-floating',
    }),
    {
      type: 'lesson',
      visible: true,
      placement: 'desktop-floating',
      selectedText: '',
      anchorX: 240,
      anchorY: 180,
      horizontalBounds: { left: 120, right: 960 },
      contextBefore: '',
      contextAfter: '',
    }
  );
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
    querySelector: () => null,
    getBoundingClientRect: () => ({
      left: 384,
      right: 1160,
    }),
  } as unknown as HTMLElement;

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

test('maps a repeated DOM selection past ignored UI to its exact content occurrence', () => {
  const content = 'Alpha Beta gamma.\n\nAlpha Beta gamma.';
  const container = document.createElement('div');
  container.innerHTML =
    '<div data-nous-lesson-content-root="true"><p>Alpha Beta gamma.</p><section data-nous-speech="ignore">Beta quiz ignorato</section><p>Alpha Beta gamma.</p></div>';
  document.body.append(container);
  const secondParagraphText = container.querySelectorAll('p')[1]?.firstChild;
  assert.ok(secondParagraphText);

  const range = document.createRange();
  range.setStart(secondParagraphText, 6);
  range.setEnd(secondParagraphText, 10);
  range.getBoundingClientRect = () => ({ top: 32, left: 16, width: 48, height: 20 }) as DOMRect;
  const selection = {
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => range.toString(),
  } as unknown as Selection;

  const resolved = resolveContextMenuSelection({
    content,
    container,
    placement: 'desktop-floating',
    selection,
  });

  assert.equal(resolved?.selectedText, 'Beta');
  assert.equal(resolved?.selectedTextStart, content.lastIndexOf('Beta'));
  const annotation = applySectionAnnotation({
    annotations: [],
    content,
    contextAfter: resolved?.contextAfter,
    contextBefore: resolved?.contextBefore,
    createId: () => 'second-beta-after-ignored-ui',
    selectedText: resolved?.selectedText || '',
    selectedTextStart: resolved?.selectedTextStart,
  });
  assert.deepEqual(annotation?.annotations[0]?.anchor, {
    kind: 'selection',
    selector: {
      end: content.lastIndexOf('Beta') + 'Beta'.length,
      exact: 'Beta',
      prefix: 'Alpha Beta gamma. Alpha',
      start: content.lastIndexOf('Beta'),
      suffix: 'gamma.',
    },
  });
});

test('rejects a selection inside ignored lesson UI before creating an annotation', () => {
  const content = 'Alpha Beta gamma.\n\nAlpha Beta gamma.';
  const container = document.createElement('div');
  container.innerHTML =
    '<div data-nous-lesson-content-root="true"><p>Alpha Beta gamma.</p><section data-nous-speech="ignore">Beta quiz ignorato</section><p>Alpha Beta gamma.</p></div>';
  document.body.append(container);
  const quizText = container.querySelector('[data-nous-speech="ignore"]')?.firstChild;
  assert.ok(quizText);

  const range = document.createRange();
  range.setStart(quizText, 0);
  range.setEnd(quizText, 'Beta'.length);
  range.getBoundingClientRect = () => ({ top: 32, left: 16, width: 48, height: 20 }) as DOMRect;
  const selection = {
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => range.toString(),
  } as unknown as Selection;

  const resolved = resolveContextMenuSelection({
    content,
    container,
    placement: 'desktop-floating',
    selection,
  });
  const annotation = resolved
    ? applySectionAnnotation({
        annotations: [],
        content,
        contextAfter: resolved.contextAfter,
        contextBefore: resolved.contextBefore,
        selectedText: resolved.selectedText,
        selectedTextStart: resolved.selectedTextStart,
      })
    : null;

  assert.equal(resolved, null);
  assert.equal(annotation, null);
});

test('maps the first lesson occurrence without counting an identical hint sibling', () => {
  const content = 'testo della lezione';
  const container = document.createElement('div');
  container.innerHTML =
    '<aside>Seleziona questo testo per iniziare.</aside><div data-nous-lesson-content-root="true"><p>testo della lezione</p></div>';
  document.body.append(container);
  const lessonText = container.querySelector('[data-nous-lesson-content-root] p')?.firstChild;
  assert.ok(lessonText);

  const range = document.createRange();
  range.setStart(lessonText, 0);
  range.setEnd(lessonText, 'testo'.length);
  range.getBoundingClientRect = () => ({ top: 32, left: 16, width: 48, height: 20 }) as DOMRect;
  const selection = {
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => range.toString(),
  } as unknown as Selection;

  const resolved = resolveContextMenuSelection({
    content,
    container,
    placement: 'desktop-floating',
    selection,
  });

  assert.equal(resolved?.selectedText, 'testo');
  assert.equal(resolved?.selectedTextStart, 0);
  assert.equal(resolved?.contextBefore, '');
  assert.equal(resolved?.contextAfter, ' della lezione');
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
    querySelector: () => null,
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

  assert.equal(
    resolveContextMenuSelection({
      container,
      placement: 'desktop-floating',
      selection: emptySelection,
    }),
    null
  );

  assert.equal(
    resolveContextMenuSelection({
      container,
      placement: 'desktop-floating',
      selection: outsideSelection,
    }),
    null
  );
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
