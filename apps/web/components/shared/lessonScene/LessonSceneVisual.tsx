import {
  hasConflictingLessonSceneClosingText,
  LESSON_SCENE_DIAGRAM_TYPES,
  LESSON_SCENE_NUMERIC_TYPES,
  LESSON_SCENE_RELATION_SYMBOLS,
  type LessonScene,
  type LessonSceneGroup,
  type LessonSceneItem,
} from '@shared/lessonScene';
import { Fragment, useContext } from 'react';

import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import { SceneChart } from './SceneChart.tsx';
import { SceneDiagram } from './SceneDiagram.tsx';
import { SceneIcon, SceneIconProvider, ScenePrototypeContext } from './SceneIcon.tsx';
import './lessonScene.css';

/**
 * Renders a validated lesson scene with the catalog layouts ported from the notes-live-lab
 * prototype. Geometry and style live here, so stored scenes follow future design changes.
 */

const Concepts = ({
  badges = false,
  items,
}: {
  badges?: boolean;
  items: readonly LessonSceneItem[];
}) =>
  items.map((item, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: items are model text and may repeat; the list is static
    <div key={`${index}-${item.label}`} className="concept">
      {badges ? (
        <span className="concept-badge">
          <SceneIcon name={item.icon} />
        </span>
      ) : (
        <SceneIcon name={item.icon} />
      )}
      <div>
        <strong>{item.label}</strong>
        {item.detail ? <p>{item.detail}</p> : null}
      </div>
    </div>
  ));

const GroupSection = ({ group }: { group: LessonSceneGroup }) => (
  <section className={group.verdict ? `verdict-${group.verdict}` : undefined}>
    <h3>
      {group.verdict ? (
        <SceneIcon name={group.verdict === 'prefer' ? 'circle-check' : 'circle-x'} />
      ) : null}
      <span>{group.label}</span>
    </h3>
    <ul>
      {group.items.map((entry, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: entries are model text and may repeat; the list is static
        <li key={`${index}-${entry}`}>
          <SceneIcon name={group.icons[index] ?? ''} />
          <span>{entry}</span>
        </li>
      ))}
    </ul>
  </section>
);

const Groups = ({ kind = 'comparison', scene }: { kind?: string; scene: LessonScene }) => {
  const masked = useContext(ScenePrototypeContext);
  if (!scene.groups.length) return null;
  const related =
    ['comparison', 'signals'].includes(kind) &&
    scene.groups.length === 2 &&
    !scene.groups.some(group => group.verdict);
  const relation = scene.relation ?? {
    evidence: '',
    kind: 'versus' as const,
    label: t('confronto'),
  };
  return (
    <div
      className={`groups ${kind}${related ? ' related' : ''}`}
      data-relation={related ? relation.kind : undefined}
    >
      {scene.groups.map((group, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; the list is static
        <Fragment key={`${index}-${group.label}`}>
          {index === 1 && related ? (
            <div aria-label={relation.label} className="relation" role="img">
              <span className="relation-symbol">
                {masked ? (
                  <SceneIcon
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
                  LESSON_SCENE_RELATION_SYMBOLS[relation.kind]
                )}
              </span>
            </div>
          ) : null}
          <GroupSection group={group} />
        </Fragment>
      ))}
    </div>
  );
};

const Sequence = ({ items, kind }: { items: readonly LessonSceneItem[]; kind: string }) => (
  <ol className={`sequence ${kind}`}>
    {items.map((item, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: model entries may repeat; the list is static
      <li key={`${index}-${item.label}`}>
        <span className="step-index">
          {kind === 'checklist' ? (
            <SceneIcon name={item.icon} />
          ) : (
            String(index + 1).padStart(2, '0')
          )}
        </span>
        <div>
          <strong>{item.label}</strong>
          {item.detail ? <p>{item.detail}</p> : null}
        </div>
      </li>
    ))}
  </ol>
);

const MatrixTable = ({ scene }: { scene: LessonScene }) => {
  const rowCount = Math.max(0, ...scene.groups.map(group => group.items.length));
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {scene.criteria ? <th scope="col">{t('Criterio')}</th> : null}
            {scene.groups.map((group, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; the list is static
              <th key={`${index}-${group.label}`} scope="col">
                {group.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rowCount }, (_, row) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: model criteria may repeat; the rows are static
            <tr key={`${row}-${scene.criteria?.[row] ?? ''}`}>
              {scene.criteria ? <th scope="row">{scene.criteria[row]}</th> : null}
              {scene.groups.map((group, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; the list is static
                <td key={`${index}-${group.label}`}>{group.items[row] ?? '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const NestedLayers = ({ items }: { items: readonly LessonSceneItem[] }) =>
  items.reduceRight<React.ReactNode>(
    (inside, item) => (
      <section key={item.label}>
        <strong>{item.label}</strong>
        {item.detail ? <p>{item.detail}</p> : null}
        {inside}
      </section>
    ),
    null
  );

const SceneContent = ({ isDarkMode, scene }: { isDarkMode: boolean; scene: LessonScene }) => {
  const prototype = useContext(ScenePrototypeContext);
  const { items } = scene;
  if (LESSON_SCENE_DIAGRAM_TYPES.has(scene.type))
    return <SceneDiagram isDarkMode={isDarkMode} scene={scene} />;
  if (scene.type === 'number') {
    return (
      <div className="big-number">
        {items[0]?.value}
        <span>{items[0]?.label}</span>
      </div>
    );
  }
  if (LESSON_SCENE_NUMERIC_TYPES.has(scene.type))
    return <SceneChart isDarkMode={isDarkMode} scene={scene} prototype={prototype} />;
  switch (scene.type) {
    case 'definition':
      return (
        <div className="definition">
          <Concepts badges items={items} />
        </div>
      );
    case 'parts':
      return (
        <div className="parts">
          <Concepts items={items} />
        </div>
      );
    case 'signals':
      return <Groups kind="signals" scene={scene} />;
    case 'comparison':
      return <Groups scene={scene} />;
    case 'matrix':
      return <MatrixTable scene={scene} />;
    case 'checklist':
    case 'hypothesis':
      return <Sequence items={items} kind="checklist" />;
    case 'steps':
    case 'timeline':
      return <Sequence items={items} kind={scene.type} />;
    case 'causal':
      return (
        <div className="causal">
          {items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; the list is static
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
      );
    case 'hierarchy':
      return (
        <div className="hierarchy">
          <div className="root-node">{scene.title}</div>
          <div className="branches">
            <Concepts items={items} />
          </div>
        </div>
      );
    case 'network':
      return (
        <div className="network">
          <div className="hub">{scene.title}</div>
          <div className="satellites">
            <Concepts items={items} />
          </div>
        </div>
      );
    case 'cycle':
      return (
        <div className="cycle">
          <span className="cycle-arrow">
            <SceneIcon name="refresh" />
          </span>
          <Concepts items={items} />
        </div>
      );
    case 'decision': {
      const question = prototype ? (scene.quote || scene.body).trim() : scene.quote || scene.body;
      return (
        <div className="decision">
          {question || !prototype ? <div className="decision-question">{question}</div> : null}
          <Groups kind={question || !prototype ? 'branches' : 'decision-options'} scene={scene} />
        </div>
      );
    }
    case 'continuum':
      return (
        <div className="continuum">
          <div className="continuum-line" />
          <div className="endpoints">
            <Concepts items={items} />
          </div>
        </div>
      );
    case 'balance':
      return (
        <div className="balance">
          <Groups kind="balance-pans" scene={scene} />
          <div className="beam" />
          <div className="fulcrum" />
        </div>
      );
    case 'concepts':
      return (
        <div className="concept-map">
          <Concepts items={items} />
        </div>
      );
    case 'claim':
      return (
        <div className="claim">
          <div className="claim-rule" />
          <Concepts items={items} />
        </div>
      );
    case 'source':
      return (
        <div className="source">
          <div className="source-profile">
            <Concepts items={items.slice(0, 1)} />
          </div>
          <dl>
            {items.slice(1).map((item, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; the list is static
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
      );
    case 'counterexample':
      return (
        <div className="counterexample">
          <Concepts items={items} />
        </div>
      );
    case 'limits':
      return (
        <>
          <div className="limits-items">
            <Concepts items={items} />
          </div>
          <Groups kind="limits" scene={scene} />
        </>
      );
    case 'quote':
      return (
        <blockquote>
          <span aria-hidden="true">“</span>
          {scene.quote}
        </blockquote>
      );
    case 'roles':
      return (
        <div className="roles">
          {items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: model labels may repeat; the list is static
            <section key={`${index}-${item.label}`}>
              <div aria-hidden="true" className="avatar">
                <SceneIcon name={item.icon || 'user'} />
              </div>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </section>
          ))}
        </div>
      );
    case 'beforeafter':
      return scene.groups.some(group => group.verdict) ? (
        <Groups kind="assessment" scene={scene} />
      ) : (
        <Groups
          scene={{ ...scene, relation: { evidence: '', kind: 'leads', label: t('diventa') } }}
        />
      );
    case 'layers':
      return (
        <div className="nested-layers">
          <NestedLayers items={items} />
        </div>
      );
    case 'boundary':
      return (
        <div className="boundary">
          <Concepts items={items} />
          <Groups kind="boundary-groups" scene={scene} />
        </div>
      );
    default:
      return null;
  }
};

export const LessonSceneVisual = ({
  className = '',
  isDarkMode = false,
  scene,
  variant = 'card',
}: {
  readonly className?: string;
  readonly isDarkMode?: boolean;
  readonly scene: LessonScene;
  readonly variant?: 'card' | 'bare';
}) => (
  <figure
    className={`lesson-scene ${variant === 'bare' ? 'lesson-scene-bare' : ''} ${className}`}
    data-nous-speech="ignore"
  >
    <SceneIconProvider prototype={variant === 'bare'}>
      <article className={`scene type-${scene.type}`}>
        <header>
          <h2>{scene.title}</h2>
          {scene.body && scene.type !== 'quote' ? (
            <p className="scene-intro">{scene.body}</p>
          ) : null}
        </header>
        <div className="visual-content">
          <SceneContent isDarkMode={isDarkMode} scene={scene} />
        </div>
        {/* The reader omits conflicting closing text; the player follows the laboratory scene. */}
        {scene.quote.trim() &&
        scene.type !== 'quote' &&
        scene.type !== 'decision' &&
        (variant === 'bare' || !hasConflictingLessonSceneClosingText(scene)) ? (
          <aside aria-label={t('Domanda')} className="scene-note scenario-question">
            <SceneIcon name="help-circle" />
            <p>{scene.quote}</p>
          </aside>
        ) : null}
        {scene.note.trim() &&
        (variant === 'bare' || !hasConflictingLessonSceneClosingText(scene)) ? (
          <aside aria-label={t('Nota')} className="scene-note">
            <SceneIcon name="info-circle" />
            <p>{scene.note}</p>
          </aside>
        ) : null}
      </article>
    </SceneIconProvider>
  </figure>
);
