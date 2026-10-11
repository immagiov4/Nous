import type { LessonScene, LessonSceneItem } from '@shared/lessonScene';
import type { ReadSceneAnimationFrame } from '@shared/lessonSceneAnimation';
import { Fragment, type ReactNode } from 'react';

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
                  <Icon name={group.icons[entryIndex]} />
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
