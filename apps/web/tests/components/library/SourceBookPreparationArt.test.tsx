// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
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
  test('resumes interrupted playback after the tab becomes visible', async () => {
    let rejectPlay!: (error: Error) => void;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPlay = reject;
        })
    );
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { container } = render(art('reading'));
    const video = container.querySelector('video');
    visibility.mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => rejectPlay(new DOMException('Playback paused', 'AbortError')));
    expect(container.querySelector('video')).toBe(video);
    visibility.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  });
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
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const list = document.createElement('div');
    list.scrollLeft = 0;
    const run = (time: number) => {
      const pending = [...frames.values()];
      frames.clear();
      for (const frame of pending) frame(time);
    };

    glideScrollBy(list, 200, 800);
    run(200);
    expect(list.scrollLeft).toBeCloseTo(12.5); // slow start: 4 * 0.25^3 of the distance
    run(400);
    expect(list.scrollLeft).toBeCloseTo(100);
    run(800);
    expect(list.scrollLeft).toBe(200);
    expect(frames.size).toBe(0);

    now.mockReturnValue(1000);
    glideScrollBy(list, -200, 800);
    const unrelated = vi.fn();
    requestAnimationFrame(unrelated);
    fireEvent.wheel(list);
    run(1400);
    expect(list.scrollLeft).toBe(200);
    expect(unrelated).toHaveBeenCalledOnce();
  });
});
