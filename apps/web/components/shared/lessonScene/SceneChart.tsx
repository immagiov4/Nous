import type { LessonScene } from '@shared/lessonScene';
import { useEffect, useRef } from 'react';

/** Chart geometry inherited from the prototype; colors come from the scene tokens. */
const LAYOUT = {
  axisWidth: 1.5,
  donutMaxSize: 240,
  height: 240,
  intervalHeight: 190,
  labelOffset: 16,
  lineWidth: 2.5,
  marginBottom: 40,
  marginLeft: 42,
  marginRight: 28,
  marginTop: 28,
  pointRadius: 4,
} as const;

interface ChartTheme {
  readonly accent: string;
  readonly font: string;
  readonly ink: string;
  readonly muted: string;
  readonly palette: readonly string[];
  readonly surface: string;
}

const readTheme = (host: HTMLElement): ChartTheme => {
  const css = getComputedStyle(host);
  const token = (name: string) => css.getPropertyValue(name).trim();
  return {
    accent: token('--blue'),
    font: css.fontFamily,
    ink: token('--ink'),
    muted: token('--muted'),
    palette: [0, 1, 2].map(index => token(`--chart-${index}`)),
    surface: token('--surface'),
  };
};

type Plot = typeof import('@observablehq/plot');

const plotOptions = (plot: Plot, scene: LessonScene, width: number, theme: ChartTheme) => {
  const items = scene.items.map(item => ({ label: item.label, value: item.value ?? 0 }));
  const common = {
    ariaLabel: scene.title,
    height: LAYOUT.height,
    marginBottom: LAYOUT.marginBottom,
    marginLeft: LAYOUT.marginLeft,
    marginRight: LAYOUT.marginRight,
    marginTop: LAYOUT.marginTop,
    style: {
      background: 'transparent',
      color: theme.muted,
      fontFamily: theme.font,
      fontSize: '13px',
    },
    width,
  };
  const text = { fill: theme.ink, fontSize: 14, fontWeight: 550 };
  if (scene.type === 'line') {
    return {
      ...common,
      marks: [
        plot.ruleY([0]),
        plot.lineY(items, {
          stroke: theme.accent,
          strokeWidth: LAYOUT.lineWidth,
          x: 'label',
          y: 'value',
        }),
        plot.dot(items, { fill: theme.accent, r: LAYOUT.pointRadius, x: 'label', y: 'value' }),
        plot.text(items, {
          dy: -LAYOUT.labelOffset,
          text: 'value',
          x: 'label',
          y: 'value',
          ...text,
        }),
      ],
      x: { domain: items.map(item => item.label), label: null, padding: 0.25 },
      y: { grid: true, label: null, nice: true, ticks: 4, zero: true },
    };
  }
  if (scene.type === 'bars') {
    return {
      ...common,
      marginLeft: Math.min(120, width * 0.3),
      marginRight: 42,
      marks: [
        plot.barX(items, { fill: theme.accent, rx: 4, x: 'value', y: 'label' }),
        plot.ruleX([0]),
        plot.text(items, {
          dx: 8,
          text: 'value',
          textAnchor: 'start',
          x: 'value',
          y: 'label',
          ...text,
        }),
      ],
      x: { grid: true, label: null, nice: true, ticks: 4, zero: true },
      y: { domain: items.map(item => item.label), label: null },
    };
  }
  if (scene.type === 'distribution') {
    const bins = items.map((item, index) => ({ ...item, end: index + 1, start: index }));
    return {
      ...common,
      marks: [
        plot.rectY(bins, {
          fill: theme.palette[2],
          inset: 0,
          stroke: theme.accent,
          x1: 'start',
          x2: 'end',
          y: 'value',
        }),
        plot.ruleY([0]),
        plot.text(bins, {
          dy: -LAYOUT.labelOffset,
          text: 'value',
          x: (bin: { start: number }) => bin.start + 0.5,
          y: 'value',
          ...text,
        }),
      ],
      x: {
        domain: [0, items.length],
        label: null,
        tickFormat: (_: unknown, index: number) => items[index]?.label ?? '',
        ticks: bins.map(bin => bin.start + 0.5),
      },
      y: { grid: true, label: null, nice: true, ticks: 4, zero: true },
    };
  }
  const [low = 0, estimate = 0, high = 0] = items.map(item => item.value);
  const span = high - low || Math.abs(low) || 1;
  const points = items.map(item => ({ ...item, y: 0 }));
  return {
    ...common,
    height: LAYOUT.intervalHeight,
    marginLeft: 24,
    marginRight: 24,
    marks: [
      plot.frame({ anchor: 'bottom', stroke: theme.muted, strokeWidth: LAYOUT.axisWidth }),
      plot.ruleY([{ high, low }], {
        stroke: theme.accent,
        strokeWidth: LAYOUT.lineWidth,
        x1: 'low',
        x2: 'high',
        y: 0,
      }),
      plot.dot(points, { fill: theme.accent, r: LAYOUT.pointRadius, x: 'value', y: 'y' }),
      plot.dot([{ value: estimate, y: 0 }], {
        fill: theme.surface,
        r: 6,
        stroke: theme.accent,
        strokeWidth: 2,
        x: 'value',
        y: 'y',
      }),
      plot.text(points, { dy: -20, text: 'value', x: 'value', y: 'y', ...text }),
    ],
    x: { domain: [low - span * 0.2, high + span * 0.2], label: null, nice: true, ticks: 5 },
    y: { axis: null, domain: [-1, 1] },
  };
};

const drawDonut = async (
  scene: LessonScene,
  width: number,
  theme: ChartTheme
): Promise<HTMLElement> => {
  const { arc, pie, select } = await import('d3');
  const size = Math.min(width, LAYOUT.donutMaxSize);
  const radius = size / 2 - 10;
  const items = scene.items.map(item => ({ label: item.label, value: item.value ?? 0 }));
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const wrapper = document.createElement('div');
  wrapper.className = 'ring-chart';
  const svg = select(wrapper)
    .append('svg')
    .attr('viewBox', `0 0 ${size} ${size}`)
    .attr('width', size)
    .attr('height', size)
    .attr('role', 'img')
    .attr('aria-label', scene.title);
  const root = svg.append('g').attr('transform', `translate(${size / 2},${size / 2})`);
  const slice = arc<{ value: number }>()
    .innerRadius(radius * 0.64)
    .outerRadius(radius);
  root
    .selectAll('path')
    .data(
      pie<{ label: string; value: number }>()
        .sort(null)
        .value(item => item.value)(items)
    )
    .join('path')
    .attr('d', datum => slice(datum as never))
    .attr('fill', (_, index) => theme.palette[index % theme.palette.length] ?? theme.accent)
    .attr('stroke', theme.surface)
    .attr('stroke-width', 2);
  root
    .append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', '.35em')
    .attr('fill', theme.ink)
    .attr('font-size', 28)
    .text(total);
  const list = document.createElement('ul');
  list.className = 'chart-values';
  items.forEach((item, index) => {
    const entry = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = theme.palette[index % theme.palette.length] ?? theme.accent;
    entry.append(
      swatch,
      document.createTextNode(
        `${item.label} · ${item.value} (${Math.round((item.value / total) * 100)}%)`
      )
    );
    list.append(entry);
  });
  wrapper.append(list);
  return wrapper;
};

/** Quantitative scene drawn with Observable Plot or d3; values stay readable in the caption. */
/** `isDarkMode` only triggers a redraw: chart colors are read from the theme tokens at draw time. */
export const SceneChart = ({
  isDarkMode,
  scene,
}: {
  readonly isDarkMode: boolean;
  readonly scene: LessonScene;
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let drawnWidth = 0;
    let disposed = false;
    const draw = async () => {
      const width = Math.round(host.getBoundingClientRect().width);
      if (!width || width === drawnWidth) return;
      drawnWidth = width;
      const theme = readTheme(host);
      const chart =
        scene.type === 'donut'
          ? await drawDonut(scene, width, theme)
          : (await import('@observablehq/plot')).plot(
              plotOptions(await import('@observablehq/plot'), scene, width, theme) as never
            );
      if (disposed) return;
      host.replaceChildren(chart);
    };
    const observer = new ResizeObserver(() => {
      void draw();
    });
    observer.observe(host);
    void draw();
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [isDarkMode, scene]);
  return (
    <figure className="data-chart">
      <div ref={hostRef} aria-label={scene.title} role="img" />
      <figcaption className={scene.type === 'interval' ? 'interval-values' : 'sr-only'}>
        {scene.items.map(item => (
          <span key={item.label}>{`${item.label}: ${item.value ?? ''}`}</span>
        ))}
      </figcaption>
    </figure>
  );
};
