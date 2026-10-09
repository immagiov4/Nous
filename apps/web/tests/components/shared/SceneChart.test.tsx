// @vitest-environment jsdom
import type { LessonScene } from '@shared/lessonScene';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { plotMock } = vi.hoisted(() => ({
  plotMock: vi.fn(() => document.createElement('svg')),
}));

vi.mock('@observablehq/plot', () => {
  const mark = () => ({});
  return {
    barX: mark,
    dot: mark,
    frame: mark,
    lineY: mark,
    plot: plotMock,
    rectY: mark,
    ruleX: mark,
    ruleY: mark,
    text: mark,
  };
});

import { SceneChart } from '../../../components/shared/lessonScene/SceneChart.tsx';

const bars: LessonScene = {
  body: '',
  groups: [],
  items: [
    { detail: '', icon: '', label: '2023', value: 4 },
    { detail: '', icon: '', label: '2024', value: 12 },
  ],
  note: '',
  quote: '',
  title: 'Casi per anno',
  type: 'bars',
};

beforeEach(() => {
  plotMock.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 600,
  } as DOMRect);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('redraws a chart at the same width when the theme changes', async () => {
  const { rerender } = render(<SceneChart isDarkMode={false} scene={bars} />);
  await waitFor(() => expect(plotMock).toHaveBeenCalledTimes(1));

  rerender(<SceneChart isDarkMode scene={bars} />);
  await waitFor(() => expect(plotMock).toHaveBeenCalledTimes(2));
});
