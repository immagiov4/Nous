import {
  findLessonSceneProblems,
  HistoricalLessonSceneSchemas,
  type LessonScene,
  LessonSceneSchema,
} from '@shared/lessonScene';
import { describe, expect, test } from 'vitest';

import {
  LAB_COMPOSITION_SCENE,
  LAB_COMPOSITION_SOURCE,
  LAB_QUICK_SCENES,
} from '../../helpers/lessonSceneLabExamples';

const example = (type: string): LessonScene => {
  const scene = LAB_QUICK_SCENES.find(scene => scene.type === type);
  if (!scene) throw new Error(`Missing lab example: ${type}`);
  return scene;
};

describe('settled lab scene catalog', () => {
  test.each([
    ['radar', 'value', 2],
    ['radar', 'max', 6],
    ['polar', 'value', 21],
    ['polar', 'max', 101],
    ['funnel', 'value', 101],
    ['treemap', 'value', 513],
    ['gantt', 'start', -1],
    ['gantt', 'end', 2],
    ['scatter', 'x', 11],
    ['scatter', 'y', 41],
    ['heatmap', 'values', 5],
    ['heatmap', 'max', 11],
    ['proportional-static', 'quantity', 3],
    ['proportional-static', 'amountPerUnit', 129],
  ])('grounds the authored %s %s in the supplied source', (type, field, number) => {
    const original = example(type as string);
    const source = JSON.stringify(original, null, 2);
    let changes: Partial<LessonScene>;
    if (field === 'values') {
      changes = {
        rows: (original.rows as NonNullable<LessonScene['rows']>).map((row, index) =>
          index === 0
            ? {
                ...row,
                values: row.values.map((value, column) =>
                  column === 0 ? (number as number) : value
                ),
              }
            : row
        ),
      };
    } else if (['value', 'start', 'end', 'x', 'y'].includes(field as string)) {
      changes = {
        items: original.items.map((item, index) =>
          index === 0 ? { ...item, [field as string]: number } : item
        ),
      };
    } else {
      changes = { [field as string]: number };
    }
    const scene = { ...original, ...changes };
    expect(findLessonSceneProblems(original, source)).toEqual([]);
    expect(findLessonSceneProblems(scene)).toEqual([]);
    expect(findLessonSceneProblems(scene, source)).toEqual([
      'Quantitative values must appear in the lesson.',
    ]);
  });

  test('grounds proportional inputs rather than the derived total', () => {
    const scene = { ...example('proportional-static'), quantity: 3, amountPerUnit: 0.1 };
    expect(findLessonSceneProblems(scene, '3 repliche, 0,1 MB per replica.')).toEqual([]);
  });

  test.each(LAB_QUICK_SCENES)('accepts and preserves the lab $type example', scene => {
    expect(findLessonSceneProblems(scene)).toEqual([]);
    expect(LessonSceneSchema.parse(scene)).toEqual(scene);
    expect(HistoricalLessonSceneSchemas.at(-1)?.parse(scene)).toEqual(scene);
    expect(HistoricalLessonSceneSchemas[0].safeParse(scene).success).toBe(false);
  });

  test.each([
    ['quadrant', { groups: example('quadrant').groups.slice(0, 3) }],
    ['radar', { max: 0 }],
    ['polar', { max: 10 }],
    ['flywheel', { items: example('flywheel').items.slice(0, 2) }],
    [
      'tree',
      {
        items: [
          { id: 'root', label: 'Root', detail: '', icon: '' },
          { id: 'a', label: 'A', detail: '', icon: '', parent: 'b' },
          { id: 'b', label: 'B', detail: '', icon: '', parent: 'a' },
        ],
      },
    ],
    ['stack', { items: example('stack').items.slice(0, 1) }],
    [
      'venn',
      {
        groups: [
          { label: 'a'.repeat(25), items: [], icons: [] },
          ...example('venn').groups.slice(1),
        ],
      },
    ],
    [
      'funnel',
      {
        items: [
          { label: 'A', detail: '', icon: '', value: 1 },
          { label: 'B', detail: '', icon: '', value: 2 },
        ],
      },
    ],
    ['treemap', { items: [{ label: 'A', detail: '', icon: '', value: 0 }] }],
    ['heatmap', { rows: [{ label: 'A', values: [1] }] }],
    ['gantt', { items: [{ label: 'A', detail: '', icon: '', start: 2, end: 1 }] }],
    ['scatter', { items: [{ label: 'A', detail: '', icon: '', x: Number.NaN, y: 1 }] }],
    ['process', { items: example('process').items.slice(0, 1) }],
    [
      'integration',
      {
        groups: [
          { label: 'Sources', items: ['A', 'B', 'C'], icons: ['point', 'point', 'point'] },
          example('integration').groups[1],
        ],
      },
    ],
    ['security', { rows: [{ label: 'A', values: ['Read', '', 'Read'] }] }],
    [
      'deployment',
      {
        groups: [
          { label: 'Host', items: ['API', 'Worker'], icons: [] },
          { label: 'Other', items: ['DB'], icons: ['database'] },
        ],
      },
    ],
    ['proportional-static', { quantity: 13 }],
  ])('rejects the lab-invalid %s example', (type, changes) => {
    expect(
      findLessonSceneProblems({ ...example(type as string), ...(changes as object) })
    ).not.toEqual([]);
  });

  test.each([
    { title: 'x'.repeat(161) },
    { body: 'x'.repeat(601) },
    { note: 'x'.repeat(601) },
    {
      items: [
        { label: 'A', detail: 'x'.repeat(241), icon: '' },
        { label: 'B', detail: '', icon: '' },
      ],
    },
    {
      items: [
        { label: 'A', detail: '', icon: 'invalid<script>' },
        { label: 'B', detail: '', icon: '' },
      ],
    },
    { items: Array.from({ length: 13 }, () => ({ label: 'A', detail: '', icon: '' })) },
  ])('enforces shared static content bounds', changes => {
    expect(findLessonSceneProblems({ ...example('process'), ...changes })).not.toEqual([]);
  });

  test.each(
    [
      [
        { id: 'root', label: 'Root' },
        { id: 'b', label: 'B', parent: 'missing' },
      ],
      [
        { id: 'root', label: 'Root' },
        { id: 'root', label: 'Duplicate' },
      ],
      [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B', parent: 'a' },
        { id: 'c', label: 'C', parent: 'b' },
        { id: 'd', label: 'D', parent: 'c' },
      ],
    ].map(items => ({ items }))
  )('rejects invalid tree topology %#', ({ items }) => {
    expect(
      findLessonSceneProblems({
        ...example('tree'),
        items: items.map(item => ({ detail: '', icon: '', ...item })),
      })
    ).not.toEqual([]);
  });

  test('accepts twelve nodes and preserves their parent relationships', () => {
    const scene = {
      ...example('tree'),
      items: Array.from({ length: 12 }, (_, index) => ({
        id: String(index),
        label: `Node ${index}`,
        detail: '',
        icon: '',
        ...(index ? { parent: '0' } : {}),
      })),
    };
    expect(findLessonSceneProblems(scene)).toEqual([]);
    expect(LessonSceneSchema.parse(scene).items).toEqual(scene.items);
  });

  test('validates ordered composition evidence and preserves panel fields', () => {
    expect(findLessonSceneProblems(LAB_COMPOSITION_SCENE, LAB_COMPOSITION_SOURCE)).toEqual([]);
    expect(LessonSceneSchema.parse(LAB_COMPOSITION_SCENE)).toEqual(LAB_COMPOSITION_SCENE);
    expect(findLessonSceneProblems(LAB_COMPOSITION_SCENE)).toEqual([]);
    expect(findLessonSceneProblems(LAB_COMPOSITION_SCENE, 'Un altro testo')).not.toEqual([]);
  });

  test.each([
    { items: [{ label: 'Extra', detail: '', icon: '' }] },
    { groups: [{ label: 'Extra', items: ['Entry'], icons: [''] }] },
    {
      panels: LAB_COMPOSITION_SCENE.panels.map(panel => ({
        ...panel,
        items: panel.items.map(item => ({ ...item, label: '' })),
      })),
    },
    {
      panels: LAB_COMPOSITION_SCENE.panels.map(panel => ({
        ...panel,
        items: panel.items.map(item => ({ ...item, label: '   ' })),
      })),
    },
  ])('rejects extra composition content and blank panel labels %#', changes => {
    expect(
      findLessonSceneProblems({ ...LAB_COMPOSITION_SCENE, ...changes }, LAB_COMPOSITION_SOURCE)
    ).not.toEqual([]);
  });

  test.each(
    [
      [LAB_COMPOSITION_SCENE.panels[0]],
      [LAB_COMPOSITION_SCENE.panels[0], LAB_COMPOSITION_SCENE.panels[0]],
      [LAB_COMPOSITION_SCENE.panels[0], { ...LAB_COMPOSITION_SCENE.panels[1], panels: [] }],
      [
        LAB_COMPOSITION_SCENE.panels[0],
        {
          ...LAB_COMPOSITION_SCENE.panels[1],
          items: LAB_COMPOSITION_SCENE.panels[1].items.slice(0, 1),
        },
      ],
      [LAB_COMPOSITION_SCENE.panels[0], { ...LAB_COMPOSITION_SCENE.panels[1], evidence: '' }],
    ].map(panels => ({ panels }))
  )('rejects invalid composition panels %#', ({ panels }) => {
    expect(
      findLessonSceneProblems({ ...LAB_COMPOSITION_SCENE, panels }, LAB_COMPOSITION_SOURCE)
    ).not.toEqual([]);
  });
});
