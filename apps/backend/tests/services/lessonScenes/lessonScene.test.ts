import {
  buildLessonSceneDiagramSource,
  findLessonSceneProblems,
  isLessonScene,
  type LessonScene,
} from '@shared/lessonScene';
import { describe, expect, test } from 'vitest';

const LESSON =
  'Una fonte è credibile quando la competenza è pertinente. Nel 2024 i casi furono 12.';

const scene = (overrides: Partial<LessonScene>): LessonScene => ({
  body: '',
  groups: [],
  items: [
    { detail: '', icon: 'school', label: 'Pertinenza' },
    { detail: '', icon: 'search', label: 'Riscontri' },
  ],
  note: '',
  quote: '',
  title: 'Valutare una fonte',
  type: 'checklist',
  ...overrides,
});

const group = (label: string, items: string[]) => ({
  icons: items.map(() => 'point'),
  items,
  label,
});

describe('lesson scene contract', () => {
  test('accepts a well-formed scene grounded in the lesson', () => {
    expect(findLessonSceneProblems(scene({}), LESSON)).toEqual([]);
    expect(isLessonScene(scene({}))).toBe(true);
  });

  test('requires quotations and relation evidence copied exactly from the lesson', () => {
    expect(findLessonSceneProblems(scene({ quote: 'Una frase inventata.' }), LESSON)).toEqual([
      'The quote must be copied exactly from the lesson.',
    ]);
    const comparison = scene({
      groups: [group('Competenza', ['Pertinente']), group('Apparenza', ['Titolo'])],
      items: [],
      relation: { evidence: 'non presente', kind: 'greater', label: 'più peso' },
      type: 'comparison',
    });
    expect(findLessonSceneProblems(comparison, LESSON)).toEqual([
      'A relation other than versus needs an exact quotation from the lesson.',
    ]);
    // Persisted scenes are checked without the lesson text.
    expect(findLessonSceneProblems(comparison)).toEqual([]);
  });

  test('enforces the shape each form needs', () => {
    expect(findLessonSceneProblems(scene({ items: [], type: 'comparison' }))).toEqual([
      'The comparison form requires exactly two groups.',
    ]);
    expect(findLessonSceneProblems(scene({ items: scene({}).items.slice(0, 1) }))).toEqual([
      'The checklist form requires at least two items.',
    ]);
    expect(
      findLessonSceneProblems(
        scene({ groups: [{ ...group('Gruppo', ['Uno', 'Due']), icons: ['point'] }] })
      )
    ).toEqual(['Every group needs a label, its entries, and exactly one icon slot per entry.']);
  });

  test('accepts only quantities stated in the lesson for quantitative forms', () => {
    const number = scene({
      items: [{ detail: '', icon: '', label: 'casi nel 2024', value: 12 }],
      type: 'number',
    });
    expect(findLessonSceneProblems(number, LESSON)).toEqual([]);
    expect(
      findLessonSceneProblems({ ...number, items: [{ ...number.items[0], value: 999 }] }, LESSON)
    ).toEqual(['Quantitative values must appear in the lesson: casi nel 2024.']);
    expect(findLessonSceneProblems(number, 'Testo senza quantità.')).toEqual([
      'Quantitative values must appear in the lesson: casi nel 2024.',
    ]);
    const decimal = scene({
      items: [{ detail: '', icon: '', label: 'quota', value: 1234.5 }],
      type: 'number',
    });
    expect(findLessonSceneProblems(decimal, 'La quota è 1.234,5 euro.')).toEqual([]);
    const interval = scene({
      items: [
        { detail: '', icon: '', label: 'minimo', value: 5 },
        { detail: '', icon: '', label: 'stima', value: 3 },
        { detail: '', icon: '', label: 'massimo', value: 9 },
      ],
      type: 'interval',
    });
    expect(findLessonSceneProblems(interval)).toEqual([
      'An interval needs exactly a minimum, an estimate, and a maximum, in order.',
    ]);
  });

  test('requires grounded, connected diagrams and ordered journeys', () => {
    const journey = scene({
      diagram: {
        edges: [
          { evidence: 'la competenza è pertinente', from: 'a', kind: 'call', label: '', to: 'c' },
          { evidence: 'la competenza è pertinente', from: 'c', kind: 'call', label: '', to: 'b' },
        ],
        nodes: [
          { id: 'a', kind: 'start', label: 'Richiesta' },
          { id: 'b', kind: 'step', label: 'Verifica' },
          { id: 'c', kind: 'end', label: 'Fiducia' },
        ],
      },
      items: [],
      type: 'journey',
    });
    expect(findLessonSceneProblems(journey, LESSON)).toEqual([
      'A journey must follow its nodes in order, without jumps or branches.',
    ]);
    const ungrounded = {
      ...journey,
      diagram: {
        edges: [{ evidence: 'inventata', from: 'a', kind: 'call' as const, label: 'poi', to: 'b' }],
        nodes: journey.diagram?.nodes.slice(0, 2) ?? [],
      },
    };
    expect(findLessonSceneProblems(ungrounded, LESSON)).toEqual([
      'The connection "poi" needs an exact quotation from the lesson.',
    ]);
  });

  test('builds Mermaid source whose labels cannot inject diagram syntax', () => {
    const source = buildLessonSceneDiagramSource(
      scene({
        diagram: {
          edges: [{ evidence: '', from: 'start', kind: 'call', label: 'se "sì" ]', to: 'end' }],
          nodes: [
            { id: 'start', kind: 'decision', label: 'Domanda {x}' },
            { id: 'end', kind: 'end', label: 'Fine; click' },
          ],
        },
        items: [],
        type: 'flowchart',
      }),
      'TD'
    );
    expect(source).toBe(
      [
        'flowchart TD',
        'n0{"Domanda #123;x#125;"}',
        'n1(["Fine#59; click"])',
        'n0 -->|"se #34;sì#34; #93;"| n1',
      ].join('\n')
    );
  });
});
