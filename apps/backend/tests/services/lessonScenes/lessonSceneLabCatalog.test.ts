import {
  findLessonSceneProblems,
  HistoricalLessonSceneSchemas,
  LessonSceneSchema,
} from '@shared/lessonScene';
import { describe, expect, test } from 'vitest';

import {
  LAB_COMPOSITION_SCENE,
  LAB_COMPOSITION_SOURCE,
  LAB_QUICK_SCENES,
} from '../../helpers/lessonSceneLabExamples';

const example = (type: string) => {
  const scene = LAB_QUICK_SCENES.find(scene => scene.type === type);
  if (!scene) throw new Error(`Missing lab example: ${type}`);
  return scene;
};

describe('settled lab scene catalog', () => {
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
