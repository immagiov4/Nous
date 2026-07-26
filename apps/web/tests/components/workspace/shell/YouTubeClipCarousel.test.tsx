// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import YouTubeClipCarousel from '../../../../components/workspace/shell/YouTubeClipCarousel.tsx';
import type { LessonYouTubeClip } from '../../../../types.ts';

const clips: LessonYouTubeClip[] = [
  {
    endSeconds: 30,
    id: 'clip-1',
    note: 'Parla anche di passaggi che non coincidono con questo intervallo.',
    sourceIndex: 0,
    startSeconds: 0,
    title: 'Tecnica completa',
    url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
  },
  {
    endSeconds: 90,
    id: 'clip-2',
    sourceIndex: 0,
    startSeconds: 30,
    title: 'Tecnica completa',
    url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
  },
  {
    endSeconds: 30,
    id: 'clip-3',
    sourceIndex: 1,
    startSeconds: 0,
    title: 'Dettaglio complementare',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  },
];

const signalPlayerReady = (iframe: HTMLIFrameElement): void => {
  globalThis.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ event: 'onReady' }),
      origin: 'https://www.youtube-nocookie.com',
      source: iframe.contentWindow,
    })
  );
};

test('uses one compact player with selectable chapters and no duration-share bars', async () => {
  const user = userEvent.setup();
  const { container } = render(<YouTubeClipCarousel clips={clips} />);

  const chapterTabs = screen.getAllByRole('tab');
  expect(chapterTabs).toHaveLength(3);
  expect(container.querySelector('[data-duration-share]')).toBeNull();
  expect(
    screen.queryByText('Parla anche di passaggi che non coincidono con questo intervallo.')
  ).toBeNull();
  expect(container.querySelectorAll('iframe')).toHaveLength(1);
  expect(screen.getByTitle('Dimostrazione video: Tecnica completa')).toHaveAttribute(
    'src',
    expect.stringContaining('autoplay=0')
  );
  expect(screen.getByTitle('Dimostrazione video: Tecnica completa')).toHaveAttribute(
    'src',
    expect.stringContaining('enablejsapi=1')
  );

  const initialPlayer = screen.getByTitle(
    'Dimostrazione video: Tecnica completa'
  ) as HTMLIFrameElement;
  const postMessage = vi.spyOn(initialPlayer.contentWindow as Window, 'postMessage');
  const initialPlayerSrc = initialPlayer.getAttribute('src');
  fireEvent.load(initialPlayer);
  signalPlayerReady(initialPlayer);
  postMessage.mockClear();
  await user.click(chapterTabs[1] as HTMLElement);
  expect(container.querySelectorAll('iframe')).toHaveLength(1);
  expect(screen.getByTitle('Dimostrazione video: Tecnica completa')).toBe(initialPlayer);
  expect(initialPlayer).toHaveAttribute('src', initialPlayerSrc);
  expect(postMessage).toHaveBeenCalledWith(
    expect.stringContaining('"endSeconds":90,"startSeconds":30'),
    'https://www.youtube-nocookie.com'
  );
  expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true');

  await user.click(chapterTabs[2] as HTMLElement);
  expect(container.querySelectorAll('iframe')).toHaveLength(1);
  expect(screen.getByTitle('Dimostrazione video: Dettaglio complementare')).toHaveAttribute(
    'src',
    expect.stringContaining('/dQw4w9WgXcQ?')
  );
});

test('resets selection, autoplay, and a queued command when the clip sequence changes', async () => {
  const user = userEvent.setup();
  const { container, rerender } = render(<YouTubeClipCarousel clips={clips} />);
  const initialPlayer = container.querySelector('iframe') as HTMLIFrameElement;
  const postMessage = vi.spyOn(initialPlayer.contentWindow as Window, 'postMessage');

  await user.click(screen.getAllByRole('tab')[1] as HTMLElement);
  expect(container.querySelector('iframe')).not.toBeNull();

  rerender(
    <YouTubeClipCarousel
      clips={[
        {
          endSeconds: 25,
          id: 'replacement-clip',
          sourceIndex: 2,
          startSeconds: 5,
          title: 'Nuova sequenza',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        },
      ]}
    />
  );

  expect(container.querySelectorAll('iframe')).toHaveLength(1);
  expect(screen.getByTitle('Dimostrazione video: Nuova sequenza')).toHaveAttribute(
    'src',
    expect.stringContaining('autoplay=0')
  );
  expect(screen.queryByRole('tab')).toBeNull();
  const replacementPlayer = container.querySelector('iframe') as HTMLIFrameElement;
  fireEvent.load(replacementPlayer);
  signalPlayerReady(replacementPlayer);
  expect(postMessage).not.toHaveBeenCalledWith(
    expect.stringContaining('"func":"loadVideoById"'),
    'https://www.youtube-nocookie.com'
  );
});

test('queues a chapter change made before the existing player loads without changing its src', async () => {
  const user = userEvent.setup();
  const { container } = render(<YouTubeClipCarousel clips={clips} />);
  const initialPlayer = container.querySelector('iframe') as HTMLIFrameElement;
  const initialPlayerSrc = initialPlayer.getAttribute('src');
  const postMessage = vi.spyOn(initialPlayer.contentWindow as Window, 'postMessage');

  await user.click(screen.getAllByRole('tab')[1] as HTMLElement);

  expect(container.querySelector('iframe')).toBe(initialPlayer);
  expect(initialPlayer).toHaveAttribute('src', initialPlayerSrc);
  expect(postMessage).not.toHaveBeenCalled();

  fireEvent.load(initialPlayer);
  expect(postMessage).not.toHaveBeenCalledWith(
    expect.stringContaining('"func":"loadVideoById"'),
    'https://www.youtube-nocookie.com'
  );
  signalPlayerReady(initialPlayer);
  expect(postMessage).toHaveBeenCalledWith(
    expect.stringContaining('"endSeconds":90,"startSeconds":30'),
    'https://www.youtube-nocookie.com'
  );
});

test('ignores a stale ready event from the previous video player', async () => {
  const user = userEvent.setup();
  const secondVideoClips: LessonYouTubeClip[] = [
    clips[0],
    { ...clips[2], id: 'clip-3a' },
    {
      ...clips[2],
      endSeconds: 75,
      id: 'clip-3b',
      startSeconds: 30,
      title: 'Secondo dettaglio complementare',
    },
  ];
  const { container } = render(<YouTubeClipCarousel clips={secondVideoClips} />);
  const firstPlayer = container.querySelector('iframe') as HTMLIFrameElement;

  await user.click(screen.getAllByRole('tab')[1] as HTMLElement);
  await user.click(screen.getAllByRole('tab')[2] as HTMLElement);

  const currentPlayer = container.querySelector('iframe') as HTMLIFrameElement;
  const currentPostMessage = vi.spyOn(currentPlayer.contentWindow as Window, 'postMessage');
  expect(currentPlayer).not.toBe(firstPlayer);

  signalPlayerReady(firstPlayer);
  expect(currentPostMessage).not.toHaveBeenCalledWith(
    expect.stringContaining('"func":"loadVideoById"'),
    'https://www.youtube-nocookie.com'
  );

  fireEvent.load(currentPlayer);
  signalPlayerReady(currentPlayer);
  expect(currentPostMessage).toHaveBeenCalledWith(
    expect.stringContaining('"endSeconds":75,"startSeconds":30'),
    'https://www.youtube-nocookie.com'
  );
});

test('supports standard arrow, Home, and End navigation across the tablist', () => {
  render(<YouTubeClipCarousel clips={clips} />);
  const tabs = screen.getAllByRole('tab');

  tabs[0]?.focus();
  fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'End' });
  expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
  expect(tabs[2]).toHaveFocus();

  fireEvent.keyDown(tabs[2] as HTMLElement, { key: 'Home' });
  expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowRight' });
  expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(tabs[1] as HTMLElement, { key: 'ArrowLeft' });
  expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
});
