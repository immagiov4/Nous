// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { act, renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';
import { useReaderContext } from '../../../hooks/reader/useReaderContext.ts';

const buildSelection = (_container: HTMLDivElement, textNode: Text, selectedText: string) => {
  const beforeRange = {
    selectNodeContents: () => {},
    setEnd: () => {},
    toString: () => 'Alpha ',
  } as unknown as Range;
  const afterRange = {
    selectNodeContents: () => {},
    setStart: () => {},
    toString: () => ' gamma delta',
  } as unknown as Range;
  let cloneCallCount = 0;
  const range = {
    commonAncestorContainer: textNode,
    startContainer: textNode,
    startOffset: 6,
    endContainer: textNode,
    endOffset: 10,
    cloneRange: () => {
      cloneCallCount += 1;
      return cloneCallCount % 2 === 1 ? beforeRange : afterRange;
    },
    getBoundingClientRect: () => ({
      top: 64,
      left: 32,
      width: 48,
      height: 18,
    }),
  } as unknown as Range;

  return {
    rangeCount: 1,
    toString: () => selectedText,
    getRangeAt: () => range,
  } as unknown as Selection;
};

test('mobile selection sync does not close an already-open selection menu for the same selection', () => {
  const container = document.createElement('div');
  const textNode = document.createTextNode('Alpha beta gamma delta');
  container.append(textNode);
  document.body.append(container);
  const contentRef = { current: container };

  const { result } = renderHook(() =>
    useReaderContext({
      activeSectionId: 'section-1',
      contentRef,
      isMobileViewport: false,
      sectionContent: 'Alpha beta gamma delta',
    })
  );

  const selection = buildSelection(container, textNode, 'beta');

  act(() => {
    result.current.openContextMenuFromSelection(selection, 'desktop-floating');
  });

  assert.equal(result.current.contextMenu.visible, true);
  assert.equal(result.current.contextMenu.placement, 'desktop-floating');

  act(() => {
    result.current.openContextMenuFromSelection(selection, 'mobile-sheet', undefined, undefined, {
      allowToggleClose: false,
    });
  });

  assert.equal(result.current.contextMenu.visible, true);
  assert.equal(result.current.contextMenu.placement, 'mobile-sheet');
  assert.equal(result.current.contextMenu.selectedText, 'beta');
});

test('opening a context answer atomically closes the selection menu and cancels pending sync', () => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  const textNode = document.createTextNode('Alpha beta gamma delta');
  container.append(textNode);
  document.body.append(container);
  const contentRef = { current: container };
  const selection = buildSelection(container, textNode, 'beta');
  const selectionSpy = vi.spyOn(globalThis, 'getSelection').mockReturnValue(selection);

  const { result } = renderHook(() =>
    useReaderContext({
      activeSectionId: 'section-1',
      contentRef,
      isMobileViewport: true,
      sectionContent: 'Alpha beta gamma delta',
    })
  );

  act(() => {
    result.current.openContextMenuFromSelection(selection, 'mobile-sheet');
    document.dispatchEvent(new Event('selectionchange'));
    result.current.openContextAnswer({
      initialQuestion: 'Spiega beta',
      selectedText: 'beta',
    });
  });

  assert.ok(result.current.contextAnswer);
  assert.equal(result.current.contextMenu.visible, false);

  act(() => {
    vi.advanceTimersByTime(1_000);
    result.current.closeContextAnswer();
  });

  assert.equal(result.current.contextAnswer, null);
  assert.equal(result.current.contextMenu.visible, false);
  selectionSpy.mockRestore();
  vi.useRealTimers();
});

test('desktop right pointer-down opens the selection menu immediately', () => {
  const container = document.createElement('div');
  const textNode = document.createTextNode('Alpha beta gamma delta');
  container.append(textNode);
  document.body.append(container);
  const contentRef = { current: container };

  const { result } = renderHook(() =>
    useReaderContext({
      activeSectionId: 'section-1',
      contentRef,
      isMobileViewport: false,
      sectionContent: 'Alpha beta gamma delta',
    })
  );

  const selection = buildSelection(container, textNode, 'beta');
  const selectionSpy = vi.spyOn(globalThis, 'getSelection').mockReturnValue(selection);
  const preventDefault = vi.fn();

  act(() => {
    result.current.handleContentPointerDownCapture({
      button: 2,
      clientX: 128,
      clientY: 96,
      preventDefault,
    } as never);
  });

  assert.equal(result.current.contextMenu.visible, true);
  assert.equal(result.current.contextMenu.placement, 'desktop-floating');
  assert.equal(result.current.contextMenu.anchorX, 128);
  assert.equal(result.current.contextMenu.anchorY, 96);
  assert.equal(preventDefault.mock.calls.length, 1);
  selectionSpy.mockRestore();
});

test('desktop contextmenu keeps the selection captured before the native right-click mutation', () => {
  const container = document.createElement('div');
  const textNode = document.createTextNode('Alpha beta gamma delta');
  container.append(textNode);
  document.body.append(container);
  const contentRef = { current: container };

  const { result } = renderHook(() =>
    useReaderContext({
      activeSectionId: 'section-1',
      contentRef,
      isMobileViewport: false,
      sectionContent: 'Alpha beta gamma delta',
    })
  );

  const pointerSelection = buildSelection(container, textNode, 'beta gamma');
  const mutatedContextMenuSelection = buildSelection(container, textNode, 'beta');
  const selectionSpy = vi
    .spyOn(globalThis, 'getSelection')
    .mockReturnValueOnce(pointerSelection)
    .mockReturnValue(mutatedContextMenuSelection);
  const pointerPreventDefault = vi.fn();
  const contextMenuPreventDefault = vi.fn();

  act(() => {
    result.current.handleContentPointerDownCapture({
      button: 2,
      clientX: 128,
      clientY: 96,
      preventDefault: pointerPreventDefault,
    } as never);
    result.current.handleContentContextMenu({
      clientX: 128,
      clientY: 96,
      preventDefault: contextMenuPreventDefault,
    } as never);
  });

  assert.equal(result.current.contextMenu.selectedText, 'beta gamma');
  assert.equal(pointerPreventDefault.mock.calls.length, 1);
  assert.equal(contextMenuPreventDefault.mock.calls.length, 1);
  selectionSpy.mockRestore();
});

test('desktop context menu without selection opens a whole-lesson menu inside content only', () => {
  const container = document.createElement('div');
  container.innerHTML = '<p>Alpha beta gamma delta</p><button type="button">Azione</button>';
  document.body.append(container);
  container.getBoundingClientRect = () =>
    ({
      bottom: 640,
      height: 600,
      left: 24,
      right: 420,
      top: 40,
      width: 396,
      x: 24,
      y: 40,
      toJSON: () => ({}),
    }) as DOMRect;
  const contentRef = { current: container };
  const paragraph = container.querySelector('p');
  const button = container.querySelector('button');
  assert.ok(paragraph);
  assert.ok(button);

  const selectionSpy = vi.spyOn(globalThis, 'getSelection').mockReturnValue({
    rangeCount: 0,
    toString: () => '',
  } as unknown as Selection);
  const preventDefault = vi.fn();

  const { result } = renderHook(() =>
    useReaderContext({
      activeSectionId: 'section-1',
      contentRef,
      isMobileViewport: false,
      sectionContent: 'Alpha beta gamma delta',
    })
  );

  act(() => {
    result.current.handleContentContextMenu({
      clientX: 240,
      clientY: 180,
      preventDefault,
      target: paragraph,
    } as never);
  });

  assert.equal(result.current.contextMenu.visible, true);
  assert.equal(result.current.contextMenu.type, 'lesson');
  assert.equal(result.current.contextMenu.anchorX, 240);
  assert.equal(result.current.contextMenu.anchorY, 180);
  assert.equal(preventDefault.mock.calls.length, 1);

  act(() => {
    result.current.closeContextMenu();
  });

  act(() => {
    result.current.handleContentContextMenu({
      clientX: 320,
      clientY: 220,
      preventDefault,
      target: button,
    } as never);
  });

  assert.equal(result.current.contextMenu.visible, false);
  assert.equal(preventDefault.mock.calls.length, 1);
  selectionSpy.mockRestore();
});

test('clicking the same annotation mark toggles its menu closed', () => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  container.innerHTML = 'Alpha <mark data-nous-annotation-id="annotation-1">beta</mark> gamma';
  document.body.append(container);
  const contentRef = { current: container };
  const mark = container.querySelector('mark');
  assert.ok(mark);
  mark.getBoundingClientRect = () =>
    ({
      bottom: 120,
      height: 20,
      left: 40,
      right: 82,
      top: 100,
      width: 42,
      x: 40,
      y: 100,
      toJSON: () => ({}),
    }) as DOMRect;
  container.getBoundingClientRect = () =>
    ({
      bottom: 640,
      height: 600,
      left: 24,
      right: 420,
      top: 40,
      width: 396,
      x: 24,
      y: 40,
      toJSON: () => ({}),
    }) as DOMRect;

  const selectionSpy = vi.spyOn(globalThis, 'getSelection').mockReturnValue({
    isCollapsed: true,
    rangeCount: 0,
    toString: () => '',
  } as unknown as Selection);

  const { result } = renderHook(() =>
    useReaderContext({
      activeSectionId: 'section-1',
      contentRef,
      isMobileViewport: true,
      sectionAnnotations: [
        {
          artifactRefs: [
            {
              artifactId: 'visual-draft-1',
              kind: 'generated-visual',
              title: 'Mappa salvata',
            },
          ],
          anchor: {
            kind: 'selection',
            selector: {
              end: 10,
              exact: 'beta',
              prefix: 'Alpha',
              start: 6,
              suffix: 'gamma',
            },
          },
          id: 'annotation-1',
          note: 'Nota',
          createdAt: '',
          updatedAt: '',
        },
      ],
      sectionContent: 'Alpha beta gamma',
    })
  );

  act(() => {
    result.current.handleContentClick({ target: mark } as never);
  });

  assert.equal(result.current.contextMenu.visible, true);
  assert.equal(result.current.contextMenu.type, 'annotation');
  if (result.current.contextMenu.type === 'annotation') {
    assert.equal(result.current.contextMenu.annotationNote, 'Nota');
    assert.equal(
      result.current.contextMenu.annotationArtifactRefs?.[0]?.artifactId,
      'visual-draft-1'
    );
  }

  act(() => {
    vi.advanceTimersByTime(100);
    result.current.handleContentClick({ target: mark } as never);
  });

  assert.equal(result.current.contextMenu.visible, false);
  selectionSpy.mockRestore();
  vi.useRealTimers();
});

test('mobile duplicate annotation clicks within 100 ms produce one stable transition', () => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  container.innerHTML = '<mark data-nous-annotation-id="annotation-1">beta</mark>';
  document.body.append(container);
  const mark = container.querySelector('mark');
  assert.ok(mark);
  mark.getBoundingClientRect = () =>
    ({ bottom: 120, height: 20, left: 40, right: 82, top: 100, width: 42 }) as DOMRect;
  container.getBoundingClientRect = () => ({ left: 24, right: 420 }) as DOMRect;
  const selectionSpy = vi.spyOn(globalThis, 'getSelection').mockReturnValue({
    isCollapsed: true,
    rangeCount: 0,
    toString: () => '',
  } as unknown as Selection);
  const contentRef = { current: container };

  const { result } = renderHook(() =>
    useReaderContext({
      activeSectionId: 'section-1',
      contentRef,
      isMobileViewport: true,
      sectionAnnotations: [
        {
          anchor: {
            kind: 'selection',
            selector: { end: 4, exact: 'beta', prefix: '', start: 0, suffix: '' },
          },
          id: 'annotation-1',
          note: '',
          createdAt: '',
          updatedAt: '',
        },
      ],
      sectionContent: 'beta',
    })
  );

  act(() => {
    result.current.handleContentClick({ target: mark } as never);
    result.current.handleContentClick({ target: mark } as never);
  });
  assert.equal(result.current.contextMenu.visible, true);

  act(() => {
    vi.advanceTimersByTime(100);
    result.current.handleContentClick({ target: mark } as never);
  });
  assert.equal(result.current.contextMenu.visible, false);

  selectionSpy.mockRestore();
  vi.useRealTimers();
});

test('mobile annotation taps close the current menu before another annotation can open', () => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  container.innerHTML = [
    '<mark data-nous-annotation-id="annotation-1">beta</mark>',
    '<mark data-nous-annotation-id="annotation-2">gamma</mark>',
  ].join(' ');
  document.body.append(container);
  const marks = container.querySelectorAll('mark');
  assert.equal(marks.length, 2);
  marks.forEach((mark, index) => {
    mark.getBoundingClientRect = () =>
      ({
        bottom: 120,
        height: 20,
        left: 40 + index * 60,
        right: 82 + index * 60,
        top: 100,
        width: 42,
      }) as DOMRect;
  });
  container.getBoundingClientRect = () => ({ left: 24, right: 420 }) as DOMRect;
  const selectionSpy = vi.spyOn(globalThis, 'getSelection').mockReturnValue({
    isCollapsed: true,
    rangeCount: 0,
    toString: () => '',
  } as unknown as Selection);
  const contentRef = { current: container };

  const { result } = renderHook(() =>
    useReaderContext({
      activeSectionId: 'section-1',
      contentRef,
      isMobileViewport: true,
      sectionAnnotations: [
        {
          anchor: {
            kind: 'selection',
            selector: { end: 4, exact: 'beta', prefix: '', start: 0, suffix: 'gamma' },
          },
          id: 'annotation-1',
          note: 'Nota',
          createdAt: '',
          updatedAt: '',
        },
        {
          anchor: {
            kind: 'selection',
            selector: { end: 10, exact: 'gamma', prefix: 'beta', start: 5, suffix: '' },
          },
          id: 'annotation-2',
          note: '',
          createdAt: '',
          updatedAt: '',
        },
      ],
      sectionContent: 'beta gamma',
    })
  );

  act(() => {
    result.current.handleContentClick({ target: marks[0] } as never);
  });
  assert.equal(result.current.contextMenu.type, 'annotation');
  assert.equal(
    result.current.contextMenu.type === 'annotation'
      ? result.current.contextMenu.annotationId
      : null,
    'annotation-1'
  );

  act(() => {
    vi.advanceTimersByTime(100);
    result.current.handleContentClick({ target: marks[1] } as never);
  });
  assert.equal(result.current.contextMenu.visible, false);

  act(() => {
    vi.advanceTimersByTime(100);
    result.current.handleContentClick({ target: marks[1] } as never);
  });
  assert.equal(
    result.current.contextMenu.type === 'annotation'
      ? result.current.contextMenu.annotationId
      : null,
    'annotation-2'
  );

  selectionSpy.mockRestore();
  vi.useRealTimers();
});
