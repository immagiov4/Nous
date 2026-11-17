// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import { captionViewport } from '../../../components/workspace/playback/captionViewport.ts';

function layout() {
  const paragraph = document.createElement('p');
  paragraph.style.width = '400px';
  paragraph.innerHTML =
    '<span class="caption-word"><span>First</span></span><span class="caption-word"><code>code</code></span><span class="caption-word"><strong>Second</strong></span><span class="caption-word"><span>Third</span></span>';
  document.body.append(paragraph);
  const words = Array.from(paragraph.children) as HTMLElement[];
  let offset = 0;
  const rect = (top: number, height: number) =>
    ({ left: 0, right: 400, top, bottom: top + height, width: 400, height }) as DOMRect;
  vi.spyOn(paragraph, 'getBoundingClientRect').mockImplementation(() => rect(0, 102));
  for (const [index, word] of words.entries()) {
    const row = Math.max(0, index - 1) * 51;
    vi.spyOn(word, 'getBoundingClientRect').mockImplementation(() => rect(row - offset, 51));
    const text = word.firstElementChild;
    if (!text) throw new Error('Fixture words must contain text');
    vi.spyOn(text, 'getBoundingClientRect').mockImplementation(() => rect(row + 8 - offset, 35));
  }
  paragraph.scrollTo = vi.fn();
  return {
    paragraph,
    words,
    move: (next: number) => {
      offset = next;
      paragraph.scrollTop = next;
    },
  };
}

test('keeps complete boundary rows while following, scrolling and seeking backwards', () => {
  const { paragraph, words, move } = layout();
  const viewport = captionViewport(paragraph);
  expect(paragraph.style.clipPath).toBe('inset(0px 0 0px 0)');
  viewport.follow(words[2], false);
  expect(paragraph.scrollTo).toHaveBeenLastCalledWith({ top: 51, behavior: 'instant' });
  viewport.follow(words[2], false);
  expect(paragraph.scrollTo).toHaveBeenCalledTimes(1);
  move(20);
  viewport.clip();
  expect(paragraph.style.clipPath).toBe('inset(31px 0 20px 0)');
  const reads = vi.mocked(words[0].getBoundingClientRect).mock.calls.length;
  viewport.clip();
  expect(vi.mocked(words[0].getBoundingClientRect).mock.calls).toHaveLength(reads);
  expect(paragraph.style.clipPath).toBe('inset(31px 0 20px 0)');
  move(51);
  viewport.clip();
  expect(paragraph.style.clipPath).toBe('inset(0px 0 0px 0)');
  viewport.follow(words[0], false);
  expect(paragraph.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'instant' });
  viewport.follow(undefined, false);
  paragraph.remove();
});

test('handles an empty caption without a scroll or clipped content', () => {
  const paragraph = document.createElement('p');
  const viewport = captionViewport(paragraph);
  viewport.clip();
  viewport.follow(undefined, false);
  expect(paragraph.style.clipPath).toBe('');
});

test('manual reading suspends following through remeasurement until a new paragraph', () => {
  const { paragraph, words, move } = layout();
  const viewport = captionViewport(paragraph);
  paragraph.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
  move(30);
  viewport.follow(words[3], false);
  expect(paragraph.scrollTo).not.toHaveBeenCalled();
  const measured = captionViewport(paragraph);
  expect(paragraph.scrollTop).toBe(30);
  measured.follow(words[0], false);
  expect(paragraph.scrollTo).not.toHaveBeenCalled();
  const next = layout();
  captionViewport(next.paragraph).follow(next.words[3], false);
  expect(next.paragraph.scrollTo).toHaveBeenCalledWith({ top: 102, behavior: 'instant' });
  paragraph.remove();
  next.paragraph.remove();
});

test('a press or selection during automatic scrolling does not suspend follow', () => {
  const { paragraph, words, move } = layout();
  const viewport = captionViewport(paragraph);
  viewport.follow(words[2], false);
  paragraph.dispatchEvent(new MouseEvent('pointerdown', { clientX: 20, clientY: 20 }));
  move(20);
  paragraph.dispatchEvent(new Event('scroll'));
  paragraph.dispatchEvent(new MouseEvent('pointerup'));
  viewport.follow(words[3], false);
  expect(paragraph.scrollTo).toHaveBeenCalledTimes(2);
  paragraph.remove();
});

test('dragging the actual scrollbar suspends following', () => {
  const { paragraph, words, move } = layout();
  Object.defineProperties(paragraph, {
    offsetWidth: { value: 400 },
    clientWidth: { value: 385 },
    clientLeft: { value: 0 },
  });
  const viewport = captionViewport(paragraph);
  paragraph.dispatchEvent(new MouseEvent('pointerdown', { clientX: 395, clientY: 20 }));
  move(30);
  paragraph.dispatchEvent(new Event('scroll'));
  paragraph.dispatchEvent(new MouseEvent('pointerup'));
  viewport.follow(words[3], false);
  expect(paragraph.scrollTo).not.toHaveBeenCalled();
  paragraph.remove();
});

test('long-paragraph following waits for the lower threshold and moves in fewer blocks', () => {
  const paragraph = document.createElement('p');
  paragraph.style.width = '400px';
  document.body.append(paragraph);
  const rect = (top: number, height: number) =>
    ({ top, bottom: top + height, left: 0, right: 400, width: 400, height }) as DOMRect;
  vi.spyOn(paragraph, 'getBoundingClientRect').mockImplementation(() => rect(0, 300));
  const words = Array.from({ length: 30 }, (_, index) => {
    const word = document.createElement('span');
    word.className = 'caption-word';
    const ink = document.createElement('span');
    ink.textContent = `Word ${index}`;
    word.append(ink);
    paragraph.append(word);
    vi.spyOn(word, 'getBoundingClientRect').mockImplementation(() =>
      rect(index * 40 - paragraph.scrollTop, 40)
    );
    vi.spyOn(ink, 'getBoundingClientRect').mockImplementation(() =>
      rect(index * 40 + 5 - paragraph.scrollTop, 30)
    );
    return word;
  });
  paragraph.scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
    paragraph.scrollTop = typeof options === 'number' ? (y ?? 0) : (options?.top ?? 0);
  });
  const viewport = captionViewport(paragraph);
  words.slice(0, 5).forEach(word => {
    viewport.follow(word, false);
  });
  const upperMoves = vi.mocked(paragraph.scrollTo).mock.calls.length;
  words.slice(5).forEach(word => {
    viewport.follow(word, false);
  });
  const moves = vi
    .mocked(paragraph.scrollTo)
    .mock.calls.map(([options]) => (options as ScrollToOptions).top);
  console.log('Long paragraph auto-follow movements:', moves.length);
  expect(upperMoves).toBe(0);
  expect(moves).toEqual([200, 400, 600, 800, 1000]);
  paragraph.remove();
});
