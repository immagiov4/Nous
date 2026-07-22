// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
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

test('uses one compact player with selectable chapters and no duration-share bars', async () => {
  const user = userEvent.setup();
  const { container } = render(<YouTubeClipCarousel clips={clips} />);

  const chapterTabs = screen.getAllByRole('tab');
  expect(chapterTabs).toHaveLength(3);
  expect(container.querySelector('[data-duration-share]')).toBeNull();
  expect(
    screen.queryByText('Parla anche di passaggi che non coincidono con questo intervallo.')
  ).toBeNull();
  expect(container.querySelector('iframe')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Riproduci la dimostrazione (0:00–0:30)' }));
  expect(container.querySelectorAll('iframe')).toHaveLength(1);
  expect(screen.getByTitle('Dimostrazione video: Tecnica completa')).toHaveAttribute(
    'src',
    expect.stringContaining('autoplay=0')
  );

  await user.click(chapterTabs[1] as HTMLElement);
  expect(container.querySelector('iframe')).toBeNull();
  expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true');

  await user.click(chapterTabs[2] as HTMLElement);
  await user.click(screen.getByRole('button', { name: 'Riproduci la dimostrazione (0:00–0:30)' }));
  expect(container.querySelectorAll('iframe')).toHaveLength(1);
  expect(screen.getByTitle('Dimostrazione video: Dettaglio complementare')).toHaveAttribute(
    'src',
    expect.stringContaining('/dQw4w9WgXcQ?')
  );
});

test('resets selection and player visibility when the clip sequence identity changes', async () => {
  const user = userEvent.setup();
  const { container, rerender } = render(<YouTubeClipCarousel clips={clips} />);

  await user.click(screen.getAllByRole('tab')[1] as HTMLElement);
  await user.click(screen.getByRole('button', { name: 'Riproduci la dimostrazione (0:30–1:30)' }));
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

  expect(container.querySelector('iframe')).toBeNull();
  expect(screen.queryByRole('tab')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Riproduci la dimostrazione (0:05–0:25)' })
  ).toBeInTheDocument();
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
