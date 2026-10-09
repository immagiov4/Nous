// @vitest-environment jsdom
import type { LessonScene } from '@shared/lessonScene';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { lineYMock, plotMock } = vi.hoisted(() => ({
  lineYMock: vi.fn((..._args: unknown[]) => ({})),
  plotMock: vi.fn(() => document.createElement('svg')),
}));

vi.mock('@observablehq/plot', () => {
  const mark = () => ({});
  return {
    barX: mark,
    dot: mark,
    frame: mark,
    lineY: lineYMock,
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

test('places line points at their real distance in time', async () => {
  const line: LessonScene = {
    ...bars,
    items: [
      { detail: '', icon: '', label: '2020', time: 2020, value: 10 },
      { detail: '', icon: '', label: '2021', time: 2021, value: 12 },
      { detail: '', icon: '', label: '2030', time: 2030, value: 40 },
    ],
    type: 'line',
  };
  render(<SceneChart isDarkMode={false} scene={line} />);

  await waitFor(() => expect(plotMock).toHaveBeenCalled());
  const options = (plotMock.mock.calls[0] as unknown[])[0] as {
    x: { tickFormat: (time: number) => string; ticks: number[] };
  };
  expect(options.x.ticks).toEqual([2020, 2021, 2030]);
  expect(lineYMock).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ time: 2030 })]),
    expect.objectContaining({ x: 'time' })
  );
  expect(options.x.tickFormat(2030)).toBe('2030');
});
