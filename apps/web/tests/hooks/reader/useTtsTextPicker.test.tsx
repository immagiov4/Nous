// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import type { RefObject } from 'react';
import { expect, test, vi } from 'vitest';
import { useTtsTextPicker } from '../../../hooks/reader/useTtsTextPicker.ts';

const createRect = (top: number, height: number): DOMRect =>
  ({
    bottom: top + height,
    height,
    left: 120,
    right: 620,
    top,
    width: 500,
    x: 120,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

test('highlights the hovered reading part and selects its TTS chunk without changing the content', async () => {
  const container = document.createElement('section');
  container.innerHTML = `
    <article class="prose">
      <p>Prima parte della lezione.</p>
      <p>Seconda parte con un esempio.</p>
    </article>
  `;
  document.body.appendChild(container);
  const paragraphs = container.querySelectorAll('p');
  vi.spyOn(paragraphs[0] as HTMLElement, 'getBoundingClientRect').mockReturnValue(
    createRect(80, 40)
  );
  vi.spyOn(paragraphs[1] as HTMLElement, 'getBoundingClientRect').mockReturnValue(
    createRect(140, 60)
  );
  const onSelectChunk = vi.fn();

  const { result } = renderHook(() =>
    useTtsTextPicker({
      chunkTexts: ['Prima parte della lezione.', 'Seconda parte con un esempio.'],
      contentRef: { current: container } as RefObject<HTMLDivElement | null>,
      onSelectChunk,
    })
  );

  act(() => {
    result.current.setIsActive(true);
  });
  await waitFor(() => expect(result.current.isActive).toBe(true));

  act(() => {
    paragraphs[1]?.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 200, clientY: 160 })
    );
  });

  expect(result.current.hoveredChunkIndex).toBe(1);
  expect(result.current.overlayRects).toEqual([{ height: 60, left: 114, top: 140, width: 512 }]);

  act(() => {
    paragraphs[1]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 200, clientY: 160 })
    );
  });

  expect(onSelectChunk).toHaveBeenCalledWith(1);
  expect(result.current.isActive).toBe(false);
  expect(container.textContent).toContain('Seconda parte con un esempio.');
});
