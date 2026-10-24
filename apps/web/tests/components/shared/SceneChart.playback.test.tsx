// @vitest-environment jsdom
import type { LessonScene } from '@shared/lessonScene';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SceneChart } from '../../../components/shared/lessonScene/SceneChart.tsx';
import { sceneElements } from '../../../components/workspace/playback/stageMotion.ts';

let theme: HTMLStyleElement;
beforeEach(() => {
  // jsdom has no SVG layout; real label geometry is checked in PlaybackCausalLayout.
  Object.defineProperty(SVGElement.prototype, 'getBBox', {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 30, height: 14 }),
  });
  theme = document.createElement('style');
  theme.textContent =
    '.data-chart > div { --blue: #123456; --ink: #222222; --muted: #777777; --surface: #ffffff; --chart-0: #111111; --chart-1: #222222; --chart-2: #333333; --chart-3: #444444; --chart-4: #555555; --chart-5: #666666; }';
  document.head.append(theme);
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
  theme.remove();
  Reflect.deleteProperty(SVGElement.prototype, 'getBBox');
});

const scene: LessonScene = {
  type: 'line',
  title: 'Osservazioni',
  body: '',
  groups: [],
  note: '',
  quote: '',
  items: [2000, 2001, 2020].map((time, index) => ({
    label: String(time),
    time,
    value: index + 1,
    detail: '',
    icon: '',
  })),
};

test('a superseded pending draw never attaches its chart to the reused host', async () => {
  const attachedTitles: string[] = [];
  const replaceChildren = HTMLElement.prototype.replaceChildren;
  vi.spyOn(HTMLElement.prototype, 'replaceChildren').mockImplementation(function (...nodes) {
    for (const node of nodes) {
      if (node instanceof Element) attachedTitles.push(node.getAttribute('aria-label') ?? '');
    }
    replaceChildren.apply(this, nodes);
  });
  const bars = { ...scene, type: 'bars' as const };
  const { container, rerender } = render(<SceneChart isDarkMode={false} scene={bars} />);
  rerender(<SceneChart isDarkMode={false} scene={{ ...bars, title: 'New scene' }} />);
  await waitFor(() =>
    expect(container.querySelector('svg')).toHaveAttribute('aria-label', 'New scene')
  );
  expect(attachedTitles).not.toContain(bars.title);
});

test.each([
  'bars',
  'line',
  'donut',
  'distribution',
  'interval',
] as const)('rendered %s items expose every validated motion target', async type => {
  const chart = { ...scene, type };
  const { container } = render(<SceneChart scene={chart} isDarkMode={false} prototype />);
  await waitFor(() => expect(sceneElements(container, chart).size).toBe(3));
  const targets = sceneElements(container, chart);
  for (const [index] of scene.items.entries()) {
    const nodes = targets.get(`item:${index}`);
    expect(nodes?.some(node => node instanceof SVGElement)).toBe(true);
    if (type === 'donut') expect(nodes?.some(node => node.tagName === 'LI')).toBe(true);
  }
});

test('playback line points retain the real time gaps', async () => {
  const { container } = render(<SceneChart scene={scene} isDarkMode={false} prototype />);
  await waitFor(() => expect(sceneElements(container, scene).size).toBe(3));
  const positions = Array.from(
    container.querySelectorAll('.playback-chart-items > circle'),
    point => Number(point.getAttribute('cx'))
  );
  expect(positions).toHaveLength(3);
  expect((positions[2] - positions[1]) / (positions[1] - positions[0])).toBeCloseTo(19);
});

test('the visible interval estimate shares the middle item motion target', async () => {
  const chart = { ...scene, type: 'interval' as const };
  const { container } = render(<SceneChart scene={chart} isDarkMode={false} prototype />);
  await waitFor(() => expect(sceneElements(container, chart).size).toBe(3));
  const targets = sceneElements(container, chart).get('item:1');
  const visibleEstimate = container.querySelector('.playback-chart-estimate > circle');
  expect(visibleEstimate).not.toBeNull();
  expect(targets).toContain(visibleEstimate);
  expect(targets).toHaveLength(2);
});

test('six playback donut slices keep distinct colors in the legend', async () => {
  const style = document.createElement('style');
  style.textContent =
    '.data-chart > div { --chart-0: #111111; --chart-1: #222222; --chart-2: #333333; --chart-3: #444444; --chart-4: #555555; --chart-5: #666666; }';
  document.head.append(style);
  try {
    const chart = {
      ...scene,
      type: 'donut' as const,
      items: Array.from({ length: 6 }, (_, index) => ({
        ...scene.items[0],
        label: String(index),
        value: index + 1,
      })),
    };
    const { container } = render(<SceneChart scene={chart} isDarkMode={false} prototype />);
    await waitFor(() =>
      expect(container.querySelectorAll('path[data-playback-item]')).toHaveLength(6)
    );
    const fills = Array.from(container.querySelectorAll('path[data-playback-item]'), slice =>
      slice.getAttribute('fill')
    );
    expect(new Set(fills).size).toBe(6);
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>('.legend-swatch'),
        swatch => swatch.style.background
      )
    ).toEqual(
      fills.map(fill => {
        const probe = document.createElement('span');
        probe.style.background = fill ?? '';
        return probe.style.background;
      })
    );
  } finally {
    style.remove();
  }
});
