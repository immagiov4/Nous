// @vitest-environment jsdom
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import LessonPlaybackStage from '../../../components/workspace/playback/LessonPlaybackStage.tsx';
import type { WorkspaceReaderContentModel } from '../../../components/workspace/shell/types.ts';
import { useShouldAnimate } from '../../../utils/motion/useShouldAnimate.ts';

vi.mock('../../../utils/motion/useShouldAnimate.ts', () => ({ useShouldAnimate: vi.fn() }));

test.each([true, false])('moves the active line to the top past halfway (animate=%s)', animate => {
  vi.mocked(useShouldAnimate).mockReturnValue(animate);
  const block = segmentLessonPlayback([
    { type: 'markdown', markdown: 'Uno due tre quattro cinque sei.' },
  ])[0];
  const content = { isDarkMode: false } as WorkspaceReaderContentModel;
  const props = { block, content, duration: 6 };
  const { container, rerender } = render(<LessonPlaybackStage {...props} time={0} />);
  const paragraph = container.querySelector('p');
  if (!paragraph) throw new Error('Captions must be rendered');
  const scrollTo = vi.fn();
  paragraph.scrollTo = scrollTo;
  Object.defineProperty(paragraph, 'clientHeight', { value: 200 });
  const lines = [0, 80, 100, 100, 180, 200];
  paragraph.querySelectorAll('span').forEach((word, index) => {
    Object.defineProperties(word, {
      offsetTop: { value: lines[index] },
      offsetHeight: { value: 20 },
    });
  });

  rerender(<LessonPlaybackStage {...props} time={1} />);
  expect(scrollTo).not.toHaveBeenCalled();
  rerender(<LessonPlaybackStage {...props} time={2} />);
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 100, behavior: animate ? 'smooth' : 'instant' });
  rerender(<LessonPlaybackStage {...props} time={3} />);
  rerender(<LessonPlaybackStage {...props} time={4} />);
  expect(scrollTo).toHaveBeenCalledTimes(1);
  rerender(<LessonPlaybackStage {...props} time={5} />);
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 200, behavior: animate ? 'smooth' : 'instant' });

  paragraph.scrollTop = 200;
  rerender(<LessonPlaybackStage {...props} block={{ ...block, id: 'next' }} time={0} />);
  expect(paragraph.scrollTop).toBe(0);
  rerender(<LessonPlaybackStage {...props} block={{ ...block, id: 'next' }} time={2} />);
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 100, behavior: animate ? 'smooth' : 'instant' });
  expect(scrollTo).toHaveBeenCalledTimes(3);
});
