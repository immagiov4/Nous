import type {
  GuidedPathLessonScene,
  LessonSceneType,
  ProportionalLessonScene,
} from '@shared/lessonScene';
import { Fragment, type ReactNode } from 'react';

import { AnimatedScene } from './AnimatedScene.tsx';
import {
  concepts,
  groups,
  matrix,
  nestedLayers,
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
  causal: c => (
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
      {c.scene.items[0].value}
      <span>{c.scene.items[0].label}</span>
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
} satisfies Record<LessonSceneType, SceneRenderer>;
