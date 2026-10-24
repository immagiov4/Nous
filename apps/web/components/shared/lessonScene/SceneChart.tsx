import { LESSON_SCENE_LIMITS, type SceneContentData } from '@shared/lessonScene';
import { useEffect, useRef, useState } from 'react';

/** Chart geometry inherited from the prototype; colors come from the scene tokens. */
const LAYOUT = {
  axisWidth: 1.5,
  barLabelFontSize: 13,
  barLabelInset: 12,
  barLabelMaxWidth: 120,
  barLabelWidthFraction: 0.3,
  donutMaxSize: 240,
  height: 240,
  intervalHeight: 190,
  labelOffset: 16,
  lineInset: 24,
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

const readTheme = (host: HTMLElement, prototype: boolean): ChartTheme => {
  const css = getComputedStyle(host);
  const token = (name: string) => css.getPropertyValue(name).trim();
  return {
    accent: token('--blue'),
    font: css.fontFamily,
    ink: token('--ink'),
    muted: token('--muted'),
    // One --chart-N token per item a scene may hold, so every slice keeps a distinct color.
    palette: Array.from({ length: LESSON_SCENE_LIMITS.items }, (_, index) =>
      token(`--chart-${index}`)
    ),
    surface: prototype ? 'white' : token('--surface'),
  };
};

type Plot = typeof import('@observablehq/plot');

const plotOptions = (plot: Plot, scene: SceneContentData, width: number, theme: ChartTheme) => {
  const items = scene.items.map(item => ({
    label: item.label,
    time: item.time ?? 0,
    value: item.value ?? 0,
  }));
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
    const x = 'time';
    return {
      ...common,
      marks: [
        plot.ruleY([0]),
        plot.lineY(items, {
          stroke: theme.accent,
          strokeWidth: LAYOUT.lineWidth,
          x,
          y: 'value',
        }),
        plot.dot(items, {
          className: 'playback-chart-items',
          fill: theme.accent,
          r: LAYOUT.pointRadius,
          x,
          y: 'value',
        }),
        plot.text(items, {
          dy: -LAYOUT.labelOffset,
          text: 'value',
          x,
          y: 'value',
          ...text,
        }),
      ],
      // A continuous time axis keeps real gaps; each tick shows the lesson's name for that time.
      x: {
        inset: LAYOUT.lineInset,
        label: null,
        tickFormat: (time: number) => items.find(item => item.time === time)?.label ?? '',
        ticks: items.map(item => item.time),
      },
      y: { grid: true, label: null, nice: true, ticks: 4, zero: true },
    };
  }
  if (scene.type === 'bars') {
    const labelWidth = Math.min(LAYOUT.barLabelMaxWidth, width * LAYOUT.barLabelWidthFraction);
    return {
      ...common,
      marginLeft: labelWidth,
      marginRight: 42,
      marks: [
        plot.axisY({
          lineWidth: (labelWidth - LAYOUT.barLabelInset) / LAYOUT.barLabelFontSize,
          fontSize: LAYOUT.barLabelFontSize,
        }),
        plot.barX(items, {
          className: 'playback-chart-items',
          fill: theme.accent,
          rx: 4,
          x: 'value',
          y: 'label',
        }),
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
      y: { axis: null, domain: items.map(item => item.label), label: null },
    };
  }
  if (scene.type === 'distribution') {
    const bins = items.map((item, index) => ({ ...item, end: index + 1, start: index }));
    return {
      ...common,
      marks: [
        plot.rectY(bins, {
          className: 'playback-chart-items',
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
      plot.dot(points, {
        className: 'playback-chart-items',
        fill: theme.accent,
        r: LAYOUT.pointRadius,
        x: 'value',
        y: 'y',
      }),
      plot.dot([{ value: estimate, y: 0 }], {
        className: 'playback-chart-estimate',
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
  scene: SceneContentData,
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
    .attr('data-playback-item', (_, index) => index)
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
    entry.dataset.playbackItem = String(index);
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
  prototype = false,
}: {
  readonly isDarkMode: boolean;
  readonly scene: SceneContentData;
  readonly prototype?: boolean;
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let drawnWidth = 0;
    let drawing = false;
    let disposed = false;
    host.replaceChildren();
    const draw = async () => {
      const width = Math.round(host.getBoundingClientRect().width);
      if (!width || width === drawnWidth || drawing) return;
      drawing = true;
      try {
        const theme = readTheme(host, prototype);
        let chart: HTMLElement | SVGSVGElement;
        if (scene.type === 'donut') {
          chart = await drawDonut(scene, width, theme);
        } else {
          const plot = await import('@observablehq/plot');
          const options = plotOptions(plot, scene, width, theme);
          chart = plot.plot(options as never);
          if (scene.type === 'bars') {
            host.replaceChildren(chart);
            const labelHeight = Math.max(
              ...Array.from(
                chart.querySelectorAll<SVGTextElement>('[aria-label="y-axis tick label"] text'),
                label => label.getBBox().height
              )
            );
            const height = Math.max(
              LAYOUT.height,
              LAYOUT.marginTop +
                LAYOUT.marginBottom +
                scene.items.length * (labelHeight + LAYOUT.barLabelInset)
            );
            if (height > LAYOUT.height) chart = plot.plot({ ...options, height } as never);
          }
          chart
            .querySelectorAll<SVGElement>('.playback-chart-items > *')
            .forEach((element, index) => {
              element.dataset.playbackItem = String(index);
            });
          // The visible estimate overlays the middle point of the interval.
          chart.querySelectorAll<SVGElement>('.playback-chart-estimate > *').forEach(element => {
            element.dataset.playbackItem = '1';
          });
        }
        if (disposed) return;
        host.replaceChildren(chart);
        drawnWidth = width;
        setFailed(false);
      } catch (error) {
        if (disposed) return;
        console.error('Lesson scene chart rendering failed.', error);
        host.replaceChildren();
        drawnWidth = 0;
        setFailed(true);
      } finally {
        drawing = false;
        if (!disposed && Math.round(host.getBoundingClientRect().width) !== width) void draw();
      }
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
  }, [isDarkMode, scene, prototype]);
  return (
    <figure className="data-chart">
      {/* Each drawing labels its own SVG; the donut legend stays readable as a list. */}
      <div ref={hostRef} />
      <figcaption className={failed || scene.type === 'interval' ? 'interval-values' : 'sr-only'}>
        {scene.items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; the list is static
          <span key={`${index}-${item.label}`}>{`${item.label}: ${item.value ?? ''}`}</span>
        ))}
      </figcaption>
    </figure>
  );
};
