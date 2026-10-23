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
    ({ top, bottom: top + height, width: 400, height }) as DOMRect;
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
  viewport.follow(words[2], true);
  expect(paragraph.scrollTo).toHaveBeenLastCalledWith({ top: 51, behavior: 'smooth' });
  viewport.follow(words[2], true);
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
