// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import SourceBookPreparationArt from '../../../components/library/SourceBookPreparationArt.tsx';
import { glideScrollBy } from '../../../utils/motion/glideScroll.ts';

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const art = (state: 'reading' | 'done') => <SourceBookPreparationArt state={state} color="sage" />;

describe('SourceBookPreparationArt motion', () => {
  test('finishes the current reading pass before closing, without cutting mid-gesture', () => {
    const { container, rerender } = render(art('reading'));
    const video = container.querySelector('video');
    if (!video) throw new Error('Missing player');
    expect(video).toHaveAttribute('poster', '/source-shelf/preparation-sage-closed.webp');
    fireEvent.playing(video);
    // The boundary poster is set while playback hides it, so no clip switch repaints a stale one.
    expect(video).toHaveAttribute('poster', '/source-shelf/preparation-sage-reading.webp');
    fireEvent.ended(video);
    expect(video).toHaveAttribute('data-phase', 'search');
    expect(video).toHaveAttribute('loop');

    rerender(art('done'));
    // Real completion stops the loop at once, but the playing pass ends at the shared rest pose.
    expect(container.querySelector('video')).toBe(video);
    expect(video).toHaveAttribute('data-phase', 'search');
    expect(video).not.toHaveAttribute('loop');
    expect(video).toHaveAttribute('poster', '/source-shelf/preparation-sage-reading.webp');

    fireEvent.ended(video);
    expect(video).toHaveAttribute('src', '/source-shelf/preparation-sage-complete.webm');
    expect(video).not.toHaveAttribute('loop');
    fireEvent.ended(video);
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      '/source-shelf/preparation-sage-complete.webp'
    );
  });

  test('closes straight after the opening when completion arrives before the reading loop', () => {
    const { container, rerender } = render(art('reading'));
    const video = container.querySelector('video');
    if (!video) throw new Error('Missing player');
    fireEvent.playing(video);
    rerender(art('done'));
    expect(video).toHaveAttribute('data-phase', 'reading');
    fireEvent.ended(video);
    expect(video).toHaveAttribute('data-phase', 'complete');
  });

  test('a visibly reading book that loses the stage closes on screen instead of snapping shut', () => {
    const { container, rerender } = render(
      <SourceBookPreparationArt state="reading" color="blue" />
    );
    const video = container.querySelector('video');
    if (!video) throw new Error('Missing player');
    fireEvent.playing(video);
    fireEvent.ended(video);
    rerender(<SourceBookPreparationArt state="idle" color="blue" />);
    expect(container.querySelector('video')).toBe(video);
    expect(video).not.toHaveAttribute('loop');
    fireEvent.ended(video);
    expect(video).toHaveAttribute('data-phase', 'complete');
    fireEvent.ended(video);
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      '/source-shelf/preparation-blue-complete.webp'
    );
    rerender(<SourceBookPreparationArt state="reading" color="blue" />);
    expect(container.querySelector('video')).toHaveAttribute('data-phase', 'reading');
  });
});

describe('glideScrollBy', () => {
  test('moves on the shared ease-in-out curve, lands exactly, and yields to user input', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback)
    );
    vi.stubGlobal('cancelAnimationFrame', () => frames.splice(0));
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const list = document.createElement('div');
    list.scrollLeft = 0;
    const run = (time: number) => {
      for (const frame of frames.splice(0)) frame(time);
    };

    glideScrollBy(list, 200, 800);
    run(200);
    expect(list.scrollLeft).toBeCloseTo(12.5); // slow start: 4 * 0.25^3 of the distance
    run(400);
    expect(list.scrollLeft).toBeCloseTo(100);
    run(800);
    expect(list.scrollLeft).toBe(200);
    expect(frames).toHaveLength(0);

    now.mockReturnValue(1000);
    glideScrollBy(list, -200, 800);
    fireEvent.wheel(list);
    run(1400);
    expect(list.scrollLeft).toBe(200);
  });
});
