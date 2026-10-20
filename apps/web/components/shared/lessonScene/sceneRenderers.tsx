import type {
  GuidedPathLessonScene,
  LessonScenePanel,
  LessonSceneType,
  ProportionalLessonScene,
} from '@shared/lessonScene';
import { proportionalTotal } from '@shared/lessonSceneAnimation';
import { Fragment, type ReactNode } from 'react';

import { getAppLocale } from '../../../i18n/uiMessages.ts';

import { AnimatedScene } from './AnimatedScene.tsx';
import { CausalGrid } from './CausalGrid.tsx';
import {
  concepts,
  groups,
  matrix,
  nestedLayers,
  quickBox,
  quickCycle,
  quickFunnel,
  quickGroup,
  quickIntegration,
  quickMatrix,
  quickRadial,
  quickScatter,
  quickTree,
  quickTreemap,
  type SceneRenderContext,
  sequence,
} from './lessonSceneRendering.tsx';
import { SceneChart } from './SceneChart.tsx';
import { SceneDiagram } from './SceneDiagram.tsx';
import { SceneIcon } from './SceneIcon.tsx';

export type SceneRenderer = (context: SceneRenderContext) => ReactNode;

const chart: SceneRenderer = ({ scene, isDarkMode, prototype }) => (
  <SceneChart scene={scene} isDarkMode={isDarkMode} prototype={prototype} />
);

const diagram: SceneRenderer = ({ scene, isDarkMode }) => (
  <SceneDiagram scene={scene} isDarkMode={isDarkMode} />
);

export const SCENE_RENDERERS = {
  definition: c => concepts(c, { className: 'definition', badges: true }),
  parts: c => concepts(c, { className: 'parts' }),
  signals: c => groups(c, 'signals'),
  comparison: groups,
  matrix,
  checklist: c => sequence(c, 'checklist'),
  causal: c =>
    c.playback ? (
      <CausalGrid items={c.scene.items} />
    ) : (
      <div className="causal">
        {c.scene.items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; authored order is static
          <Fragment key={`${index}-${item.label}`}>
            {index > 0 ? (
              <span className="arrow">
                <SceneIcon name="arrow-right" />
              </span>
            ) : null}
            <div className="cause">
              <SceneIcon name={item.icon} />
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </div>
          </Fragment>
        ))}
      </div>
    ),
  steps: c => sequence(c, c.scene.type),
  timeline: c => sequence(c, c.scene.type),
  hierarchy: c =>
    concepts(c, {
      className: 'hierarchy',
      before: <div className="root-node">{c.scene.title}</div>,
      itemsClassName: 'branches',
    }),
  network: c =>
    concepts(c, {
      className: 'network',
      before: <div className="hub">{c.scene.title}</div>,
      itemsClassName: 'satellites',
    }),
  cycle: c =>
    concepts(c, {
      className: 'cycle',
      before: (
        <span className="cycle-arrow">
          <SceneIcon name="refresh" />
        </span>
      ),
    }),
  decision: c => {
    const question = c.prototype
      ? (c.scene.quote || c.scene.body).trim()
      : c.scene.quote || c.scene.body;
    return (
      <div className="decision">
        {question || !c.prototype ? <div className="decision-question">{question}</div> : null}
        {groups(c, question || !c.prototype ? 'branches' : 'decision-options')}
      </div>
    );
  },
  continuum: c =>
    concepts(c, {
      className: 'continuum',
      before: <div className="continuum-line" />,
      itemsClassName: 'endpoints',
    }),
  balance: c => (
    <div className="balance">
      {groups(c, 'balance-pans')}
      <div className="beam" />
      <div className="fulcrum" />
    </div>
  ),
  concepts: c => concepts(c, { className: 'concept-map' }),
  claim: c => (
    <div className="claim">
      <div className="claim-rule" />
      {concepts(c)}
    </div>
  ),
  hypothesis: c => sequence(c, 'checklist'),
  source: c => (
    <div className="source">
      <div className="source-profile">{concepts(c, { items: c.scene.items.slice(0, 1) })}</div>
      <dl>
        {c.scene.items.slice(1).map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; authored order is static
          <div key={`${index}-${item.label}`}>
            <dt>
              <SceneIcon name={item.icon} />
              {item.label}
            </dt>
            <dd>{item.detail}</dd>
          </div>
        ))}
      </dl>
    </div>
  ),
  counterexample: c => concepts(c, { className: 'counterexample' }),
  limits: c => (
    <Fragment>
      {concepts(c, { className: 'limits-items' })}
      {groups(c, 'limits')}
    </Fragment>
  ),
  quote: c => (
    <blockquote>
      <span aria-hidden="true">{'“'}</span>
      {c.scene.quote}
    </blockquote>
  ),
  roles: c => (
    <div className="roles">
      {c.scene.items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; authored order is static
        <section key={`${index}-${item.label}`}>
          <div aria-hidden="true" className="avatar">
            <SceneIcon name={item.icon || 'user'} />
          </div>
          <strong>{item.label}</strong>
          <p>{item.detail}</p>
        </section>
      ))}
    </div>
  ),
  beforeafter: c =>
    c.scene.groups.some(group => group.verdict)
      ? groups(c, 'assessment')
      : groups({
          ...c,
          scene: {
            ...c.scene,
            relation: { evidence: '', kind: 'leads', label: c.labels.becomes },
          },
        }),
  layers: c => <div className="nested-layers">{nestedLayers(c.scene.items)}</div>,
  boundary: c => concepts(c, { className: 'boundary', after: groups(c, 'boundary-groups') }),
  number: c => (
    <div className="big-number">
      {c.scene.items[0]?.value}
      <span>{c.scene.items[0]?.label}</span>
    </div>
  ),
  bars: chart,
  line: chart,
  donut: chart,
  distribution: chart,
  interval: chart,
  flowchart: diagram,
  sequence: diagram,
  journey: diagram,
  proportional: c => (
    <AnimatedScene scene={c.scene as ProportionalLessonScene} readFrame={c.readFrame} />
  ),
  'guided-path': c => (
    <AnimatedScene scene={c.scene as GuidedPathLessonScene} readFrame={c.readFrame} />
  ),
  composition: c => (
    <div className="composed-panels">
      {(c.scene.panels as readonly LessonScenePanel[]).map((panel, index) => {
        const context = { ...c, scene: { ...c.scene, items: panel.items } };
        return (
          <section key={panel.kind} data-playback-panel={index}>
            <h3>{panel.title}</h3>
            {panel.kind === 'steps'
              ? sequence(context, 'steps')
              : concepts(context, { className: 'parts' })}
          </section>
        );
      })}
    </div>
  ),
  quadrant: c => (
    <>
      <div className="q-axis">{c.scene.yLabel}</div>
      <div className="q-quadrant">
        {c.scene.groups.map((group, index) => quickGroup(group, index))}
      </div>
      <div className="q-axis q-axis-x">{c.scene.xLabel}</div>
    </>
  ),
  radar: quickRadial,
  polar: quickRadial,
  flywheel: quickCycle,
  tree: quickTree,
  stack: c => (
    <div className="q-stack">
      {c.scene.items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: authored layers have stable order
        <div className="q-layer" key={`${index}-${item.label}`} data-playback-item={index}>
          <b>{index + 1}</b>
          {quickBox(item.label, item.detail, item.icon)}
        </div>
      ))}
    </div>
  ),
  venn: c => (
    <div className="q-venn-diagram">
      <div className="q-venn-circles" aria-hidden="true">
        <i />
        <i />
      </div>
      {c.scene.groups.map((group, index) => (
        <section
          className="q-venn-region"
          // biome-ignore lint/suspicious/noArrayIndexKey: authored regions have fixed order
          key={`${index}-${group.label}`}
          data-playback-group={index}
        >
          <strong>{group.label}</strong>
          {group.items.map((item, itemIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: authored region entries have stable order
            <p key={`${itemIndex}-${item}`}>{item}</p>
          ))}
        </section>
      ))}
    </div>
  ),
  funnel: quickFunnel,
  treemap: quickTreemap,
  heatmap: quickMatrix,
  gantt: c => {
    const items = c.scene.items;
    const min = Math.min(...items.map(item => item.start as number)),
      max = Math.max(...items.map(item => item.end as number));
    return (
      <div className="q-gantt">
        {items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: authored intervals have stable order
          <div key={`${index}-${item.label}`} data-playback-item={index}>
            <strong>{item.label}</strong>
            <div className="q-gantt-track">
              <span
                style={{
                  left: `${(((item.start as number) - min) / (max - min)) * 100}%`,
                  width: `${(((item.end as number) - (item.start as number)) / (max - min)) * 100}%`,
                }}
              />
            </div>
            <small>
              {item.start}–{item.end} {c.scene.unit}
            </small>
          </div>
        ))}
      </div>
    );
  },
  scatter: quickScatter,
  process: c => (
    <ol className="q-process">
      {c.scene.items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: authored stages have stable order
        <li key={`${index}-${item.label}`} data-playback-item={index}>
          {index ? (
            <span className="q-step-arrow">
              <SceneIcon name="arrow-right" />
              <SceneIcon name="arrow-down" />
            </span>
          ) : null}
          <div className="q-step-marker">
            <b className="q-index">{index + 1}</b>
          </div>
          {quickBox(item.label, item.detail, item.icon)}
        </li>
      ))}
    </ol>
  ),
  integration: quickIntegration,
  security: quickMatrix,
  deployment: c => (
    <div className="q-columns">
      {c.scene.groups.map((group, index) => quickGroup(group, index))}
    </div>
  ),
  'proportional-static': c => {
    const numbers = new Intl.NumberFormat(getAppLocale(), { maximumSignificantDigits: 21 });
    const total = proportionalTotal(c.scene.amountPerUnit as number, c.scene.quantity as number);
    return (
      <>
        <div className="q-units">
          {Array.from({ length: c.scene.quantity as number }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: each unit occupies a fixed numbered position
            <Fragment key={index + 1}>
              {quickBox(String(index + 1), `${c.scene.amountPerUnit} ${c.scene.unit}`)}
            </Fragment>
          ))}
        </div>
        <div className="q-result">
          <strong>
            {numbers.format(total)} {c.scene.unit}
          </strong>
          <p>
            {c.scene.quantity} × {c.scene.amountPerUnit} {c.scene.unit}
          </p>
        </div>
      </>
    );
  },
} satisfies Record<LessonSceneType, SceneRenderer>;
