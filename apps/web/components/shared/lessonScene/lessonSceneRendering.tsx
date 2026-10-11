import type { LessonScene, LessonSceneGroup, LessonSceneItem } from '@shared/lessonScene';
import type { ReadSceneAnimationFrame } from '@shared/lessonSceneAnimation';
import { type CSSProperties, Fragment, type ReactNode } from 'react';

import { SceneIcon as Icon } from './SceneIcon.tsx';

/** Shared content and playback context for the web scene renderers. */
export interface SceneRenderContext {
  scene: LessonScene;
  isDarkMode: boolean;
  prototype: boolean;
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
        <strong>{item.label}</strong>
        {item.detail ? <p>{item.detail}</p> : null}
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
              <span>{group.label}</span>
            </h3>
            <ul>
              {group.items.map((entry, entryIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; authored order is static
                <li key={`${entryIndex}-${entry}`}>
                  <Icon name={group.icons[entryIndex] ?? ''} />
                  <span>{entry}</span>
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
          <strong>{item.label}</strong>
          {item.detail ? <p>{item.detail}</p> : null}
        </div>
      </li>
    ))}
  </ol>
);

export const matrix = ({ scene, labels }: SceneRenderContext) => {
  const rowCount = Math.max(0, ...scene.groups.map(group => group.items.length));
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {scene.criteria ? <th scope="col">{labels.criterion}</th> : null}
            {scene.groups.map((group, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; authored order is static
              <th key={`${index}-${group.label}`} scope="col">
                {group.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rowCount }, (_, row) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; authored order is static
            <tr key={`${row}-${scene.criteria?.[row] ?? ''}`}>
              {scene.criteria ? <th scope="row">{scene.criteria[row]}</th> : null}
              {scene.groups.map((group, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; authored order is static
                <td key={`${index}-${group.label}`}>{group.items[row] ?? '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
    labelTop: 22,
    labelBottom: 16,
    labelOffset: 8,
    valueLine: 25,
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
  heatmapTone: 28,
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

const quickSvg = (
  scene: LessonScene,
  content: ReactNode,
  height: number = QUICK_GEOMETRY.svg.height
) => (
  <svg
    className={`q-svg${scene.type === 'scatter' ? ' q-scatter' : ''}`}
    viewBox={`0 0 ${QUICK_GEOMETRY.svg.width} ${height}`}
    role="img"
    aria-label={scene.title}
  >
    <title>{scene.title}</title>
    {content}
  </svg>
);

export const quickRadial = ({ scene }: SceneRenderContext) => {
  const { cx, cy, radius, height, labelGap, labelTop, labelBottom, labelOffset, valueLine, dot } =
    QUICK_GEOMETRY.radial;
  const point = (index: number, distance: number) => [
    cx + Math.cos((index * 2 * Math.PI) / scene.items.length - Math.PI / 2) * distance,
    cy + Math.sin((index * 2 * Math.PI) / scene.items.length - Math.PI / 2) * distance,
  ];
  return quickSvg(
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
        const [x, y] = point(index, radius + labelGap),
          dx = x - cx;
        const anchor = Math.abs(dx) < 1 ? 'middle' : dx > 0 ? 'start' : 'end';
        const top =
          y < cy - radius ? y - labelTop : y > cy + radius ? y + labelBottom : y - labelOffset;
        return (
          <text
            // biome-ignore lint/suspicious/noArrayIndexKey: authored measures have stable order
            key={`${index}-${item.label}`}
            className="q-radial-label"
            x={x}
            y={top}
            textAnchor={anchor}
            data-playback-item={index}
          >
            <tspan x={x}>{item.label}</tspan>
            <tspan className="q-radial-value" x={x} dy={valueLine}>
              {item.value} / {scene.max} {scene.unit}
            </tspan>
          </text>
        );
      })}
    </>,
    height
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

export const quickMatrix = ({ scene }: SceneRenderContext) => (
  <div className="q-table">
    <table>
      <thead>
        <tr>
          <th />
          {(scene.columns as string[]).map((column, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: authored columns have stable order
            <th key={`${index}-${column}`} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(scene.rows as NonNullable<LessonScene['rows']>).map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: authored rows have stable order
          <tr key={`${index}-${row.label}`}>
            <th scope="row">{row.label}</th>
            {row.values.map((value, column) => (
              <td
                // biome-ignore lint/suspicious/noArrayIndexKey: cells are identified by their fixed column
                key={column}
                style={
                  scene.type === 'heatmap'
                    ? {
                        background: `color-mix(in srgb,var(--blue) ${Math.round(((value as number) / (scene.max as number)) * QUICK_GEOMETRY.heatmapTone)}%,var(--surface))`,
                      }
                    : undefined
                }
              >
                {value}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

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
  return quickSvg(
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
      <text x={geometry.labelX} y={geometry.labelY} textAnchor="middle">
        {scene.xLabel}
      </text>
      <text x={geometry.left} y={geometry.axisY} textAnchor="start">
        {scene.yLabel}
      </text>
      {scene.items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: authored points have stable order
        <g key={`${index}-${item.label}`} data-playback-item={index}>
          <circle
            className="q-dot"
            cx={x(item.x as number)}
            cy={y(item.y as number)}
            r={geometry.dot}
          />
          <text
            x={x(item.x as number) + (item.x === xmax ? -geometry.labelGap : geometry.labelGap)}
            y={y(item.y as number) - geometry.labelGap}
            textAnchor={item.x === xmax ? 'end' : 'start'}
          >
            {item.label}
          </text>
        </g>
      ))}
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
  return quickSvg(
    {
      ...scene,
      title: `${scene.title}: ${scene.items.map(item => `${item.value} ${scene.unit}, ${item.label}`).join('; ')}`,
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
    const path = `${xs.map(x => `M ${x} 0 V ${geometry.join}`).join(' ')} M ${xs[0]} ${geometry.join} H ${xs.at(-1)} M ${geometry.center} ${geometry.join} V ${geometry.height}`;
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
