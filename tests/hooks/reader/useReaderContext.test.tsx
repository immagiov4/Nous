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
  const selectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue(selection);
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
