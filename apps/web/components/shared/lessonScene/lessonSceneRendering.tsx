import type { LessonScene, LessonSceneGroup, LessonSceneItem } from '@shared/lessonScene';
import type { ReadSceneAnimationFrame } from '@shared/lessonSceneAnimation';
import { type CSSProperties, Fragment, type ReactNode } from 'react';

import { SceneIcon as Icon } from './SceneIcon.tsx';
import { SceneText } from './SceneText.tsx';

/** Shared content and playback context for the web scene renderers. */
export interface SceneRenderContext {
  scene: LessonScene;
  isDarkMode: boolean;
  prototype: boolean;
  playback: boolean;
  tableKeyboardAccess: boolean;
  readFrame?: ReadSceneAnimationFrame;
  labels: { comparison: string; criterion: string; becomes: string };
  relationSymbols: Readonly<Record<string, string>>;
}

export const concepts = (
  { scene }: SceneRenderContext,
  {
    items = scene.items,
    badges = false,
    className,
    itemsClassName,
    before,
    after,
  }: {
    items?: readonly LessonSceneItem[];
    badges?: boolean;
    className?: string;
    itemsClassName?: string;
    before?: ReactNode;
    after?: ReactNode;
  } = {}
) => {
  const content = items.map((item, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; authored order is static
    <div key={`${index}-${item.label}`} className="concept">
      {badges ? (
        <span className="concept-badge">
          <Icon name={item.icon} />
        </span>
      ) : (
        <Icon name={item.icon} />
      )}
      <div>
        <strong>
          <SceneText>{item.label}</SceneText>
        </strong>
        {item.detail ? (
          <p>
            <SceneText>{item.detail}</SceneText>
          </p>
        ) : null}
      </div>
    </div>
  ));
  const entries = itemsClassName ? <div className={itemsClassName}>{content}</div> : content;
  return className ? (
    <div className={className}>
      {before}
      {entries}
      {after}
    </div>
  ) : (
    entries
  );
};

export const groups = (context: SceneRenderContext, kind = 'comparison'): ReactNode => {
  const { scene, prototype, labels, relationSymbols } = context;
  if (!scene.groups.length) return null;
  const related =
    ['comparison', 'signals'].includes(kind) &&
    scene.groups.length === 2 &&
    !scene.groups.some(group => group.verdict);
  const relation = scene.relation ?? { evidence: '', kind: 'versus', label: labels.comparison };
  return (
    <div
      className={`groups ${kind}${related ? ' related' : ''}`}
      data-relation={related ? relation.kind : undefined}
    >
      {scene.groups.map((group, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; authored order is static
        <Fragment key={`${index}-${group.label}`}>
          {index === 1 && related ? (
            <div aria-label={relation.label} className="relation" role="img">
              <span className="relation-symbol">
                {prototype ? (
                  <Icon
                    name={
                      {
                        greater: 'math-greater',
                        less: 'math-lower',
                        different: 'equal-not',
                        equal: 'equal',
                        versus: 'vs',
                        leads: 'arrow-right',
                      }[relation.kind]
                    }
                  />
                ) : (
                  relationSymbols[relation.kind]
                )}
              </span>
            </div>
          ) : null}
          <section className={group.verdict ? `verdict-${group.verdict}` : undefined}>
            <h3>
              {group.verdict ? (
                <Icon name={group.verdict === 'prefer' ? 'circle-check' : 'circle-x'} />
              ) : null}
              <span>
                <SceneText>{group.label}</SceneText>
              </span>
            </h3>
            <ul>
              {group.items.map((entry, entryIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; authored order is static
                <li key={`${entryIndex}-${entry}`}>
                  <Icon name={group.icons[entryIndex] ?? ''} />
                  <span>
                    <SceneText>{entry}</SceneText>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </Fragment>
      ))}
    </div>
  );
};

export const sequence = ({ scene }: SceneRenderContext, kind: string) => (
  <ol className={`sequence ${kind}`}>
    {scene.items.map((item, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; authored order is static
      <li key={`${index}-${item.label}`}>
        <span className="step-index">
          {kind === 'checklist' ? <Icon name={item.icon} /> : String(index + 1).padStart(2, '0')}
        </span>
        <div>
          <strong>
            <SceneText>{item.label}</SceneText>
          </strong>
          {item.detail ? (
            <p>
              <SceneText>{item.detail}</SceneText>
            </p>
          ) : null}
        </div>
      </li>
    ))}
  </ol>
);

export const matrix = ({ scene, labels, tableKeyboardAccess }: SceneRenderContext) => {
  const rowCount = Math.max(0, ...scene.groups.map(group => group.items.length));
  return (
    <section
      className="table-wrap"
      aria-label={scene.title || labels.comparison}
      tabIndex={tableKeyboardAccess ? 0 : undefined}
    >
      <table>
        <thead>
          <tr>
            {scene.criteria ? (
              <th scope="col" className="matrix-corner">
                {labels.criterion}
              </th>
            ) : null}
            {scene.groups.map((group, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; authored order is static
              <th key={`${index}-${group.label}`} scope="col">
                <SceneText>{group.label}</SceneText>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rowCount }, (_, row) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; authored order is static
            <tr key={`${row}-${scene.criteria?.[row] ?? ''}`}>
              {scene.criteria ? (
                <th scope="row">
                  <div className="matrix-row-label">
                    <SceneText>{scene.criteria[row]}</SceneText>
                  </div>
                </th>
              ) : null}
              {scene.groups.map((group, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; authored order is static
                <td key={`${index}-${group.label}`}>
                  <div className="matrix-copy">
                    <SceneText>{group.items[row] ?? '—'}</SceneText>
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};

export const nestedLayers = (items: readonly LessonSceneItem[]) =>
  items.reduceRight<ReactNode>(
    (inside, item) => (
      <section key={item.label}>
        <strong>{item.label}</strong>
        {item.detail ? <p>{item.detail}</p> : null}
        {inside}
      </section>
    ),
    null
  );

/** Fixed geometry from quick-templates.mjs; the model supplies content only. */
const QUICK_GEOMETRY = {
  svg: { width: 640, height: 360 },
  radial: {
    cx: 320,
    cy: 210,
    radius: 130,
    height: 420,
    labelGap: 24,
    upperValueOffset: 3,
    labelBottom: 16,
    labelOffset: 8,
    labelLineHeight: '1.5em',
    dot: 6,
  },
  scatter: {
    left: 75,
    right: 585,
    top: 50,
    bottom: 285,
    ticks: 4,
    tickY: 308,
    tickX: 62,
    tickOffset: 4,
    labelX: 330,
    labelY: 345,
    axisY: 23,
    dot: 7,
    labelGap: 12,
  },
  funnel: {
    center: 320,
    top: 12,
    bandHeight: 118,
    topWidth: 540,
    bottomWidth: 300,
    cells: 10,
    cellSize: 18,
    cellGap: 8,
    cornerRadius: 18,
    stripY: 85,
    numberY: 39,
    labelY: 66,
    cellRadius: 3,
    toneMin: 16,
    toneRange: 24,
  },
  cycle: { radius: 33, center: 50, gapMax: 0.49, gapFraction: 0.7, arrowHead: 2 },
  branches: { width: 100, height: 36, join: 18, center: 50 },
} as const;

export const quickBox = (label: string, detail = '', icon?: string) => (
  <div className="q-box">
    {icon ? <Icon name={icon} /> : null}
    <strong>{label}</strong>
    {detail ? <p>{detail}</p> : null}
  </div>
);

export const quickGroup = (group: LessonSceneGroup, index: number) => (
  <section className="q-box" key={`${index}-${group.label}`} data-playback-group={index}>
    <h3>
      {group.icon ? <Icon name={group.icon} /> : null}
      {group.label}
    </h3>
    {group.items.length === 1 ? (
      <p>{group.items[0]}</p>
    ) : (
      <ul className="q-entities">
        {group.items.map((entry, entryIndex) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: authored entities have stable order and may repeat labels
          <li key={`${entryIndex}-${entry}`}>
            <Icon name={group.icons[entryIndex]} />
            <span>{entry}</span>
          </li>
        ))}
      </ul>
    )}
  </section>
);

const chartKey = (labels: readonly string[]) => (
  <ol className="q-chart-key" hidden>
    {labels.map((label, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: authored measurements have stable order
      <li key={`${index}-${label}`} data-playback-item={index} hidden value={index + 1}>
        {label}
      </li>
    ))}
  </ol>
);

const updateChartKey = <Label extends Element>(
  svg: SVGSVGElement,
  labels: NodeListOf<Label>,
  placeLabel: (label: Label) => boolean
) => {
  const key = svg.parentElement?.querySelector<HTMLOListElement>(':scope > .q-chart-key');
  if (!key) return;
  let hasKeyEntries = false;
  for (const [index, label] of labels.entries()) {
    const showKey = placeLabel(label);
    key.children[index].toggleAttribute('hidden', !showKey);
    hasKeyEntries ||= showKey;
  }
  key.hidden = !hasKeyEntries;
};

const placeScatterLabel = (label: HTMLElement) => {
  const { labelGap, left, right } = QUICK_GEOMETRY.scatter;
  const { width } = QUICK_GEOMETRY.svg;
  const pointX = Number(label.dataset.pointX);
  const pointY = Number(label.dataset.pointY);
  const preferLeft = right - pointX < pointX - left;
  const name = label.children[0] as HTMLElement;
  const marker = label.children[1] as HTMLElement;
  name.hidden = false;
  marker.hidden = true;
  // A name with no room on either side would otherwise cover points or axis labels.
  const leftSpace = pointX - 2 * labelGap;
  const rightSpace = width - pointX - 2 * labelGap;
  const showKey = name.offsetWidth > Math.max(leftSpace, rightSpace);
  name.hidden = showKey;
  marker.hidden = !showKey;
  const { offsetWidth, offsetHeight } = label;
  const labelOnLeft = offsetWidth > rightSpace || (preferLeft && offsetWidth <= leftSpace);
  const beside = labelOnLeft ? pointX - labelGap - offsetWidth : pointX + labelGap;
  const above = pointY - labelGap - offsetHeight;
  label.style.left = `${Math.max(labelGap, Math.min(beside, width - labelGap - offsetWidth))}px`;
  label.style.top = `${above >= 0 ? above : pointY + labelGap}px`;
  return showKey;
};

function placeScatterAxes(svg: SVGSVGElement) {
  const key = svg.parentElement?.querySelector<HTMLElement>('.q-axis-key');
  if (!key) return;
  const bounds = svg.getBoundingClientRect();
  const axes = svg.querySelectorAll<SVGTextElement>('[data-axis]');
  for (const [index, axis] of axes.entries()) {
    const title = axis.children[0];
    title.removeAttribute('hidden');
    axis.removeAttribute('data-in-key');
    const extent = title.getBoundingClientRect();
    const outside = extent.left < bounds.left || extent.right > bounds.right;
    title.toggleAttribute('hidden', outside);
    axis.toggleAttribute('data-in-key', outside);
    key.children[index].toggleAttribute('hidden', !outside);
  }
  key.hidden = !key.querySelector(':scope > :not([hidden])');
}

const placeRadialLabel = (label: SVGTextElement) => {
  label.removeAttribute('data-in-key');
  const { x, width } = label.getBBox();
  const showKey = x < 0 || x + width > QUICK_GEOMETRY.svg.width;
  label.toggleAttribute('data-in-key', showKey);
  return showKey;
};

const sizeQuickChartLabels = (svg: SVGSVGElement | null) => {
  if (!svg?.parentElement || typeof ResizeObserver === 'undefined') return;
  const resize = () => {
    const { clientHeight, clientWidth, viewBox } = svg;
    if (!clientWidth || !clientHeight) return;
    // The viewBox uses the smaller axis scale, including when max-height limits the chart.
    const { width, height } = viewBox.baseVal;
    svg.style.setProperty(
      '--q-inverse-scale',
      String(Math.max(width / clientWidth, height / clientHeight))
    );
    if (svg.classList.contains('q-scatter')) {
      placeScatterAxes(svg);
      updateChartKey(
        svg,
        svg.querySelectorAll<HTMLElement>('.q-scatter-point-label'),
        placeScatterLabel
      );
    } else {
      updateChartKey(
        svg,
        svg.querySelectorAll<SVGTextElement>('.q-radial-label'),
        placeRadialLabel
      );
    }
  };
  const observer = new ResizeObserver(resize);
  observer.observe(svg.parentElement);
  const fonts = svg.ownerDocument.fonts;
  fonts.addEventListener('loadingdone', resize);
  resize();
  return () => {
    observer.disconnect();
    fonts.removeEventListener('loadingdone', resize);
  };
};

const quickSvg = (
  scene: LessonScene,
  content: ReactNode,
  height: number = QUICK_GEOMETRY.svg.height,
  description?: string
) => (
  <svg
    key={description}
    className={`q-svg${scene.type === 'scatter' ? ' q-scatter' : ''}`}
    viewBox={`0 0 ${QUICK_GEOMETRY.svg.width} ${height}`}
    role="img"
    aria-label={scene.title}
    ref={description ? sizeQuickChartLabels : undefined}
  >
    <title>{scene.title}</title>
    {description ? <desc>{description}</desc> : null}
    {content}
  </svg>
);

export const quickRadial = ({ scene }: SceneRenderContext) => {
  const {
    cx,
    cy,
    radius,
    height,
    labelGap,
    upperValueOffset,
    labelBottom,
    labelOffset,
    labelLineHeight,
    dot,
  } = QUICK_GEOMETRY.radial;
  const point = (index: number, distance: number) => [
    cx + Math.cos((index * 2 * Math.PI) / scene.items.length - Math.PI / 2) * distance,
    cy + Math.sin((index * 2 * Math.PI) / scene.items.length - Math.PI / 2) * distance,
  ];
  const labelPlacement = (x: number, y: number) => {
    const dx = x - cx;
    let anchor: 'middle' | 'start' | 'end' = 'end';
    if (Math.abs(dx) < 1) anchor = 'middle';
    else if (dx > 0) anchor = 'start';
    const abovePlot = y < cy - radius;
    let baseline = y - labelOffset;
    // Above the plot, anchor the value so wider line spacing grows away from the grid.
    if (abovePlot) baseline = y + upperValueOffset;
    else if (y > cy + radius) baseline = y + labelBottom;
    return { anchor, abovePlot, baseline };
  };
  const measurements = scene.items.map(
    item => `${item.label}: ${item.value} / ${scene.max} ${scene.unit}`
  );
  const chart = quickSvg(
    scene,
    <>
      {[0.25, 0.5, 0.75, 1].map(fraction => (
        <circle key={fraction} className="q-grid" cx={cx} cy={cy} r={radius * fraction} />
      ))}
      {scene.items.map((item, index) => {
        const [x, y] = point(index, radius);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: authored measures have stable order
          <line key={`${index}-${item.label}`} x1={cx} y1={cy} x2={x} y2={y} className="q-grid" />
        );
      })}
      {scene.type === 'radar' ? (
        <polygon
          className="q-radar"
          points={scene.items
            .map((item, index) =>
              point(index, (radius * (item.value as number)) / (scene.max as number)).join(',')
            )
            .join(' ')}
        />
      ) : (
        scene.items.map((item, index) => {
          const [x, y] = point(index, (radius * (item.value as number)) / (scene.max as number));
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: authored measures have stable order
            <g key={`${index}-${item.label}`} data-playback-item={index}>
              <line x1={cx} y1={cy} x2={x} y2={y} className="q-series" />
              <circle className="q-dot" cx={x} cy={y} r={dot} />
            </g>
          );
        })
      )}
      {scene.items.map((item, index) => {
        const [x, y] = point(index, radius + labelGap);
        const { anchor, abovePlot, baseline } = labelPlacement(x, y);
        const nameOffset = abovePlot ? `-${labelLineHeight}` : undefined;
        return (
          <text
            // biome-ignore lint/suspicious/noArrayIndexKey: authored measures have stable order
            key={`${index}-${item.label}`}
            className="q-radial-label"
            x={x}
            y={baseline}
            textAnchor={anchor}
            data-playback-item={index}
          >
            <tspan x={x} dy={nameOffset}>
              {item.label}
            </tspan>
            <tspan
              className="q-radial-value"
              x={x}
              y={abovePlot ? baseline : undefined}
              dy={abovePlot ? undefined : labelLineHeight}
            >
              {item.value} / {scene.max}
              <tspan className="q-radial-inline-unit"> {scene.unit}</tspan>
            </tspan>
            <tspan className="q-radial-marker" x={x} dy={nameOffset}>
              {index + 1}
            </tspan>
          </text>
        );
      })}
    </>,
    height,
    measurements.join('; ')
  );
  return (
    <>
      {chart}
      {scene.unit ? (
        <p className="q-radial-unit" aria-hidden="true">
          {scene.unit}
        </p>
      ) : null}
      {chartKey(measurements)}
    </>
  );
};

export const quickTree = ({ scene }: SceneRenderContext) => {
  const children = (parent: string) => scene.items.filter(item => item.parent === parent);
  const branch = (node: LessonSceneItem): ReactNode => (
    <li key={node.id} data-playback-item={scene.items.indexOf(node)}>
      {quickBox(node.label, node.detail, node.icon)}
      {children(node.id as string).length ? (
        <ul>{children(node.id as string).map(branch)}</ul>
      ) : null}
    </li>
  );
  const root = scene.items.find(item => !item.parent) as LessonSceneItem;
  return (
    <ul
      className="q-tree"
      style={{ '--root-columns': Math.max(1, children(root.id as string).length) } as CSSProperties}
    >
      {branch(root)}
    </ul>
  );
};

type QuickMatrixRows = NonNullable<LessonScene['rows']>;

function authoredHeatmapMaximum(max: number | undefined, rows: QuickMatrixRows) {
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return undefined;
  return rows.every(row =>
    row.values.every(value => typeof value === 'number' && value >= 0 && value <= max)
  )
    ? max
    : undefined;
}

export const quickMatrix = ({ scene, labels, tableKeyboardAccess }: SceneRenderContext) => {
  const columns = scene.columns as string[];
  const rows = scene.rows as QuickMatrixRows;
  const heatmap = scene.type === 'heatmap';
  const max = heatmap ? authoredHeatmapMaximum(scene.max, rows) : undefined;
  const unit = heatmap && typeof scene.unit === 'string' ? scene.unit.trim() : '';
  const range = max === undefined ? '' : `0–${max}`;
  const caption = `${range} ${unit}`.trim();
  return (
    <section
      className="q-table"
      aria-label={scene.title || labels.comparison}
      tabIndex={tableKeyboardAccess ? 0 : undefined}
    >
      <table
        style={
          max === undefined
            ? undefined
            : ({ '--heatmap-tracks': columns.length + 2 } as CSSProperties)
        }
      >
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            <td />
            {columns.map((column, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: authored columns have stable order
              <th key={`${index}-${column}`} scope="col">
                {heatmap ? column : <div className="security-cell-copy">{column}</div>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: authored rows have stable order
            <tr key={`${index}-${row.label}`}>
              <th scope="row">
                <div className="matrix-row-label">{row.label}</div>
              </th>
              {row.values.map((value, column) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: repeated values occupy distinct fixed columns
                  key={`${column}-${value}`}
                  style={
                    max === undefined
                      ? undefined
                      : ({
                          '--heatmap-value': `${((value as number) / max) * 100}%`,
                        } as CSSProperties)
                  }
                >
                  {heatmap ? value : <div className="security-cell-copy">{value}</div>}
                  {max === undefined ? null : (
                    <span className="heatmap-track" aria-hidden="true">
                      <span />
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};

export const quickTreemap = ({ scene }: SceneRenderContext) => {
  const layout = (
    items: readonly LessonSceneItem[],
    x: number,
    y: number,
    width: number,
    height: number
  ): ReactNode => {
    if (items.length === 1) {
      const item = items[0];
      return (
        <div
          className="q-tile"
          style={{ left: `${x}%`, top: `${y}%`, width: `${width}%`, height: `${height}%` }}
          data-playback-item={scene.items.indexOf(item)}
        >
          {item.icon ? <Icon name={item.icon} /> : null}
          <strong>{item.label}</strong>
          <span>
            {item.value} {scene.unit}
          </span>
        </div>
      );
    }
    const sum = items.reduce((total, item) => total + (item.value as number), 0),
      half = Math.ceil(items.length / 2);
    const a = items.slice(0, half),
      b = items.slice(half),
      fraction = a.reduce((total, item) => total + (item.value as number), 0) / sum;
    return width >= height ? (
      <>
        {layout(a, x, y, width * fraction, height)}
        {layout(b, x + width * fraction, y, width * (1 - fraction), height)}
      </>
    ) : (
      <>
        {layout(a, x, y, width, height * fraction)}
        {layout(b, x, y + height * fraction, width, height * (1 - fraction))}
      </>
    );
  };
  return <div className="q-treemap">{layout(scene.items, 0, 0, 100, 100)}</div>;
};

export const quickScatter = ({ scene }: SceneRenderContext) => {
  const geometry = QUICK_GEOMETRY.scatter;
  const domain = (key: 'x' | 'y') => {
    const min = Math.min(0, ...scene.items.map(item => item[key] as number)),
      max = Math.max(0, ...scene.items.map(item => item[key] as number));
    return [min, max === min ? min + 1 : max];
  };
  const [xmin, xmax] = domain('x'),
    [ymin, ymax] = domain('y');
  const x = (value: number) =>
    geometry.left + ((value - xmin) / (xmax - xmin)) * (geometry.right - geometry.left);
  const y = (value: number) =>
    geometry.bottom - ((value - ymin) / (ymax - ymin)) * (geometry.bottom - geometry.top);
  const chart = quickSvg(
    scene,
    <>
      {Array.from({ length: geometry.ticks + 1 }, (_, index) => {
        const xx = xmin + ((xmax - xmin) * index) / geometry.ticks,
          yy = ymin + ((ymax - ymin) * index) / geometry.ticks;
        return (
          <g key={xx}>
            <line x1={x(xx)} y1={geometry.top} x2={x(xx)} y2={geometry.bottom} className="q-grid" />
            <line x1={geometry.left} y1={y(yy)} x2={geometry.right} y2={y(yy)} className="q-grid" />
            <text x={x(xx)} y={geometry.tickY} textAnchor="middle">
              {+xx.toFixed(2)}
            </text>
            <text x={geometry.tickX} y={y(yy) + geometry.tickOffset} textAnchor="end">
              {+yy.toFixed(2)}
            </text>
          </g>
        );
      })}
      <line
        x1={geometry.left}
        y1={geometry.top}
        x2={geometry.left}
        y2={geometry.bottom}
        className="q-axes"
      />
      <line
        x1={geometry.left}
        y1={geometry.bottom}
        x2={geometry.right}
        y2={geometry.bottom}
        className="q-axes"
      />
      <text data-axis="X" x={geometry.labelX} y={geometry.labelY} textAnchor="middle">
        <tspan>{scene.xLabel}</tspan>
        <tspan className="q-axis-marker">X</tspan>
      </text>
      <text data-axis="Y" x={geometry.left} y={geometry.axisY} textAnchor="start">
        <tspan>{scene.yLabel}</tspan>
        <tspan className="q-axis-marker">Y</tspan>
      </text>
      {scene.items.map((item, index) => {
        const pointX = x(item.x as number);
        const pointY = y(item.y as number);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: authored points have stable order
          <g key={`${index}-${item.label}`} data-playback-item={index}>
            <circle className="q-dot" cx={pointX} cy={pointY} r={geometry.dot} />
            <foreignObject
              width={QUICK_GEOMETRY.svg.width}
              height={QUICK_GEOMETRY.svg.height}
              pointerEvents="none"
            >
              <span className="q-scatter-point-label" data-point-x={pointX} data-point-y={pointY}>
                <span>{item.label}</span>
                <span hidden>{index + 1}</span>
              </span>
            </foreignObject>
          </g>
        );
      })}
    </>,
    QUICK_GEOMETRY.svg.height,
    scene.items
      .map(item => `${item.label}: ${scene.xLabel} ${item.x}, ${scene.yLabel} ${item.y}`)
      .join('; ')
  );
  return (
    <>
      {chart}
      <dl className="q-axis-key" hidden>
        <div hidden>
          <dt>X</dt>
          <dd>{scene.xLabel}</dd>
        </div>
        <div hidden>
          <dt>Y</dt>
          <dd>{scene.yLabel}</dd>
        </div>
      </dl>
      {chartKey(scene.items.map(item => item.label))}
    </>
  );
};

export const quickFunnel = ({ scene }: SceneRenderContext) => {
  const {
    center,
    top,
    bandHeight,
    topWidth,
    bottomWidth,
    cells,
    cellSize,
    cellGap,
    cornerRadius,
    stripY,
    numberY,
    labelY,
    cellRadius,
    toneMin,
    toneRange,
  } = QUICK_GEOMETRY.funnel;
  const stripWidth = cells * cellSize + (cells - 1) * cellGap;
  const sideInset =
    (cornerRadius * (topWidth - bottomWidth)) / (2 * scene.items.length * bandHeight);
  const half = (stage: number) =>
    (topWidth - ((topWidth - bottomWidth) * stage) / scene.items.length) / 2;
  const bands = scene.items.map((item, index) => {
    const y = top + index * bandHeight,
      a = half(index),
      b = half(index + 1),
      end = y + bandHeight;
    const amount = ((item.value as number) / (scene.items[0].value as number)) * cells;
    const upper =
      index === 0
        ? `M ${center - a + cornerRadius} ${y} H ${center + a - cornerRadius} Q ${center + a} ${y} ${center + a - sideInset} ${y + cornerRadius}`
        : `M ${center - a} ${y} H ${center + a}`;
    const lower =
      index === scene.items.length - 1
        ? `L ${center + b + sideInset} ${end - cornerRadius} Q ${center + b} ${end} ${center + b - cornerRadius} ${end} H ${center - b + cornerRadius} Q ${center - b} ${end} ${center - b - sideInset} ${end - cornerRadius}`
        : `L ${center + b} ${end} H ${center - b}`;
    const close =
      index === 0
        ? `L ${center - a + sideInset} ${y + cornerRadius} Q ${center - a} ${y} ${center - a + cornerRadius} ${y} Z`
        : 'Z';
    return (
      <g
        // biome-ignore lint/suspicious/noArrayIndexKey: authored stages have stable order
        key={`${index}-${item.label}`}
        style={
          {
            '--band-tone': `${toneMin + (index / Math.max(1, scene.items.length - 1)) * toneRange}%`,
          } as CSSProperties
        }
        data-playback-item={index}
      >
        <path className="q-funnel-segment" d={`${upper} ${lower} ${close}`} />
        <text className="q-funnel-number" x={center} y={y + numberY} textAnchor="middle">
          {item.value}
        </text>
        <text className="q-funnel-label" x={center} y={y + labelY} textAnchor="middle">
          {item.label}
        </text>
        {Array.from({ length: cells }, (_, cell) => {
          const x = center - stripWidth / 2 + cell * (cellSize + cellGap),
            filled = Math.max(0, Math.min(1, amount - cell));
          return (
            <g key={x}>
              <rect
                className="q-funnel-cell"
                x={x}
                y={y + stripY}
                width={cellSize}
                height={cellSize}
                rx={cellRadius}
              />
              {filled ? (
                <rect
                  className="q-funnel-cell-fill"
                  x={x}
                  y={y + stripY}
                  width={cellSize * filled}
                  height={cellSize}
                  rx={filled === 1 ? cellRadius : 0}
                />
              ) : null}
            </g>
          );
        })}
      </g>
    );
  });
  const values = scene.items.map(item => `${item.value} ${scene.unit}, ${item.label}`).join('; ');
  return quickSvg(
    {
      ...scene,
      title: `${scene.title}: ${values}`,
    },
    bands,
    top * 2 + scene.items.length * bandHeight
  );
};

export const quickCycle = ({ scene }: SceneRenderContext) => {
  const { radius, center, gapMax, gapFraction, arrowHead } = QUICK_GEOMETRY.cycle;
  const stationGap = Math.min(gapMax, (Math.PI / scene.items.length) * gapFraction);
  const point = (angle: number) => [
    center + radius * Math.sin(angle),
    center - radius * Math.cos(angle),
  ];
  return (
    <div className="q-cycle">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        {scene.items.map((item, index) => {
          const start = (index * 2 * Math.PI) / scene.items.length + stationGap,
            end = ((index + 1) * 2 * Math.PI) / scene.items.length - stationGap;
          const [x, y] = point(start),
            [ex, ey] = point(end),
            dx = Math.cos(end),
            dy = Math.sin(end);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: authored stations have stable order
            <g key={`${index}-${item.label}`}>
              <path d={`M ${x} ${y} A ${radius} ${radius} 0 0 1 ${ex} ${ey}`} />
              <path
                d={`M ${ex - dx * arrowHead + dy * arrowHead} ${ey - dy * arrowHead - dx * arrowHead} L ${ex} ${ey} L ${ex - dx * arrowHead - dy * arrowHead} ${ey - dy * arrowHead + dx * arrowHead}`}
              />
            </g>
          );
        })}
      </svg>
      <div className="q-cycle-center">{scene.center}</div>
      {scene.items.map((item, index) => {
        const [x, y] = point((index * 2 * Math.PI) / scene.items.length);
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: authored stations have stable order
            key={`${index}-${item.label}`}
            className="q-cycle-node"
            style={{ left: `${x}%`, top: `${y}%` }}
            data-playback-item={index}
          >
            {item.icon ? <Icon name={item.icon} /> : null}
            <strong>{item.label}</strong>
          </div>
        );
      })}
    </div>
  );
};

export const quickIntegration = ({ scene }: SceneRenderContext) => {
  const bank = (group: LessonSceneGroup, groupIndex: number) => (
    <div
      className="q-bank"
      style={{ '--branches': group.items.length } as CSSProperties}
      data-playback-group={groupIndex}
    >
      {group.items.map((name, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: authored entities have stable order
        <Fragment key={`${index}-${name}`}>
          {quickBox(name, group.details?.[index] || '', group.icons[index])}
        </Fragment>
      ))}
    </div>
  );
  const branches = (group: LessonSceneGroup, outgoing = false) => {
    const geometry = QUICK_GEOMETRY.branches;
    const xs = group.items.map((_, index) => ((index + 0.5) * geometry.width) / group.items.length);
    const stems = xs.map(x => `M ${x} 0 V ${geometry.join}`).join(' ');
    const path = `${stems} M ${xs[0]} ${geometry.join} H ${xs.at(-1)} M ${geometry.center} ${geometry.join} V ${geometry.height}`;
    return (
      <svg
        className={`q-branches${outgoing ? ' q-branches-out' : ''}`}
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d={path} vectorEffect="non-scaling-stroke" />
      </svg>
    );
  };
  return (
    <div className="q-integration">
      {bank(scene.groups[0], 0)}
      {branches(scene.groups[0])}
      <div className="q-core">{quickBox(scene.center as string, '', scene.icon)}</div>
      {branches(scene.groups[1], true)}
      {bank(scene.groups[1], 1)}
    </div>
  );
};
