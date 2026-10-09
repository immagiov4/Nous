// @vitest-environment jsdom
import type { LessonScene } from '@shared/lessonScene';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { lineYMock, plotMock } = vi.hoisted(() => ({
  lineYMock: vi.fn((..._args: unknown[]) => ({})),
  plotMock: vi.fn((..._args: unknown[]) => document.createElement('svg')),
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

let notifyResize: () => void;

beforeEach(() => {
  plotMock.mockReset().mockImplementation(() => document.createElement('svg'));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 600,
  } as DOMRect);
});

test('keeps values visible after a drawing failure and retries at the same width', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  plotMock.mockImplementationOnce(() => {
    throw new Error('Plot failed');
  });
  const { container } = render(<SceneChart isDarkMode={false} scene={bars} />);
  await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
  expect(container.querySelector('figcaption')).toHaveClass('interval-values');
  expect(screen.getByText('2024: 12')).toBeVisible();

  act(() => notifyResize());
  await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
  expect(container.querySelector('figcaption')).toHaveClass('sr-only');
  expect(plotMock).toHaveBeenCalledTimes(2);
});

test('deduplicates initial observer notifications while a drawing is pending', async () => {
  render(<SceneChart isDarkMode={false} scene={bars} />);
  act(() => notifyResize());
  await waitFor(() => expect(plotMock).toHaveBeenCalledTimes(1));
});

test('keeps repeated labels distinct in the numeric caption', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const scene = { ...bars, items: [bars.items[0], bars.items[0]] };
  const { container } = render(<SceneChart isDarkMode={false} scene={scene} />);
  await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
  expect(container.querySelectorAll('figcaption > span')).toHaveLength(2);
  expect(errors).not.toHaveBeenCalled();
});

test('redraws at a previously successful width after a resized drawing fails', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { container } = render(<SceneChart isDarkMode={false} scene={bars} />);
  await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
  plotMock.mockImplementationOnce(() => {
    throw new Error('Resized drawing failed');
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 800,
  } as DOMRect);
  act(() => notifyResize());
  await waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
  expect(container.querySelector('svg')).toBeNull();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 600,
  } as DOMRect);
  act(() => notifyResize());
  await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
  expect(plotMock).toHaveBeenCalledTimes(3);
});

test('preserves a new width received while the first drawing is pending', async () => {
  plotMock.mockImplementation((options: unknown) => {
    const svg = document.createElement('svg');
    svg.setAttribute('data-width', String((options as { width: number }).width));
    return svg;
  });
  const { container } = render(<SceneChart isDarkMode={false} scene={bars} />);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 800,
  } as DOMRect);
  act(() => notifyResize());
  await waitFor(() => expect(container.querySelector('svg')).toHaveAttribute('data-width', '800'));
});

test('removes the previous scene drawing when the replacement cannot be drawn', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { container, rerender } = render(<SceneChart isDarkMode={false} scene={bars} />);
  await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
  plotMock.mockImplementationOnce(() => {
    throw new Error('Replacement failed');
  });
  rerender(
    <SceneChart isDarkMode={false} scene={{ ...bars, items: [{ ...bars.items[0], value: 20 }] }} />
  );
  await waitFor(() => expect(container.querySelector('figcaption')).toHaveClass('interval-values'));
  expect(container.querySelector('svg')).toBeNull();
  expect(screen.getByText('2023: 20')).toBeVisible();
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
