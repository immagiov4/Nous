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
    expect(
      findLessonSceneProblems(
        scene({ items: [{ detail: '', icon: '', label: ' ', value: 12 }], type: 'number' })
      )
    ).toEqual(['Every item needs a label, a detail, and an icon identifier.']);
    expect(findLessonSceneProblems(scene({ items: [], type: 'comparison' }))).toEqual([
      'The comparison form requires exactly two non-empty groups.',
    ]);
    expect(findLessonSceneProblems(scene({ items: scene({}).items.slice(0, 1) }))).toEqual([
      'The checklist form requires at least two items.',
    ]);
    expect(
      findLessonSceneProblems(
        scene({ groups: [{ ...group('Gruppo', ['Uno', 'Due']), icons: ['point'] }] })
      )
    ).toEqual(['Every group needs a label, its entries, and exactly one icon slot per entry.']);
    expect(
      findLessonSceneProblems(
        scene({ groups: [group('Sì', ['Procedi']), group('No', [])], items: [], type: 'decision' })
      )
    ).toEqual(['The decision form requires exactly two non-empty groups.']);
    const matrix = (criteria?: string[]) =>
      scene({
        ...(criteria ? { criteria } : {}),
        groups: [group('Fonte A', ['Sì', 'No']), group('Fonte B', ['No', 'Sì'])],
        items: [],
        type: 'matrix',
      });
    expect(findLessonSceneProblems(matrix(['Pertinenza', 'Riscontri']))).toEqual([]);
    expect(findLessonSceneProblems(matrix())).toEqual([
      'The matrix form requires at least two criteria.',
    ]);
    expect(findLessonSceneProblems(matrix(['Pertinenza']))).toEqual([
      'Matrix criteria must label every row of both groups.',
    ]);
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
    const dose = scene({
      items: [{ detail: '', icon: '', label: 'dose', value: 25 }],
      type: 'number',
    });
    expect(findLessonSceneProblems(dose, 'La dose è 2,5 mg.')).toEqual([
      'Quantitative values must appear in the lesson: dose.',
    ]);
    expect(findLessonSceneProblems(dose, 'Gli iscritti sono 1.025, non 25.')).toEqual([]);
    const weight = (value: number) =>
      scene({ items: [{ detail: '', icon: '', label: 'peso', value }], type: 'number' });
    expect(findLessonSceneProblems(weight(1234.567), 'Il peso è 1.234,567 grammi.')).toEqual([]);
    expect(findLessonSceneProblems(weight(1234567), 'Il peso è 1.234,567 grammi.')).toEqual([
      'Quantitative values must appear in the lesson: peso.',
    ]);
    expect(findLessonSceneProblems(weight(1234567), 'Il peso è 1.234.567 grammi.')).toEqual([]);
    expect(findLessonSceneProblems(weight(1234.567), 'Il peso è 1.234.567 grammi.')).toEqual([
      'Quantitative values must appear in the lesson: peso.',
    ]);
    expect(
      findLessonSceneProblems(
        { ...dose, items: [{ ...dose.items[0], value: 1025 }] },
        'Gli iscritti sono 1.025.'
      )
    ).toEqual([]);
    expect(findLessonSceneProblems(weight(0.0255), 'La quota è 0,0255.')).toEqual([]);
    expect(findLessonSceneProblems(weight(0.025), 'La quota è 0,0255.')).toEqual([
      'Quantitative values must appear in the lesson: peso.',
    ]);
    expect(findLessonSceneProblems(weight(1234567), 'Il peso è 1 234 567 grammi.')).toEqual([]);
    expect(findLessonSceneProblems(weight(2), 'Le classi 1,2,3 sono attive.')).toEqual([]);
    expect(findLessonSceneProblems(weight(12), 'La minima è −12 °C.')).toEqual([
      'Quantitative values must appear in the lesson: peso.',
    ]);
    expect(findLessonSceneProblems(weight(12), 'Le pagine 10-12 lo spiegano.')).toEqual([]);
    expect(findLessonSceneProblems(weight(120), 'Nel 2024 120 studenti.')).toEqual([]);
    expect(findLessonSceneProblems(weight(1500000), 'Circa 1.5e6 cellule.')).toEqual([]);
    expect(findLessonSceneProblems(weight(10200), 'Righe:\n10\n200')).toEqual([
      'Quantitative values must appear in the lesson: peso.',
    ]);
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
    const quotedFlow = {
      ...ungrounded,
      diagram: {
        ...ungrounded.diagram,
        edges: [{ ...ungrounded.diagram.edges[0], evidence: 'la competenza è pertinente' }],
      },
      quote: 'Una frase inventata.',
    };
    expect(findLessonSceneProblems(quotedFlow, LESSON)).toEqual([
      'The quote must be copied exactly from the lesson.',
    ]);
    const grounded = 'la competenza è pertinente';
    const disconnected = scene({
      diagram: {
        edges: [
          { evidence: grounded, from: 'a', kind: 'call', label: 'poi', to: 'b' },
          { evidence: grounded, from: 'c', kind: 'call', label: 'poi', to: 'd' },
        ],
        nodes: ['a', 'b', 'c', 'd'].map(id => ({ id, kind: 'step' as const, label: id })),
      },
      items: [],
      type: 'flowchart',
    });
    expect(findLessonSceneProblems(disconnected, LESSON)).toEqual([
      'Every diagram node must be connected.',
    ]);
    const connected = {
      ...disconnected,
      diagram: {
        ...disconnected.diagram,
        edges: [
          ...(disconnected.diagram?.edges ?? []),
          { evidence: grounded, from: 'b', kind: 'call' as const, label: 'poi', to: 'c' },
        ],
        nodes: disconnected.diagram?.nodes ?? [],
      },
    };
    expect(findLessonSceneProblems(connected, LESSON)).toEqual([]);
    expect(findLessonSceneProblems({ ...connected, items: scene({}).items })).toEqual([
      'A diagram form keeps its content in diagram: items and groups must be empty.',
    ]);
    // Stored scenes are checked without the lesson text but still need their quotations.
    const unquoted = {
      ...connected,
      diagram: {
        ...connected.diagram,
        edges: connected.diagram.edges.map(edge => ({ ...edge, evidence: '' })),
      },
    };
    expect(isLessonScene(unquoted)).toBe(false);
  });

  test('requires the quote form to show a quotation', () => {
    const quote = scene({ body: 'Testo libero.', items: [], type: 'quote' });
    expect(findLessonSceneProblems(quote, LESSON)).toEqual([
      'The quote form requires a quotation from the lesson.',
    ]);
    expect(
      findLessonSceneProblems({ ...quote, body: '', quote: 'la competenza è pertinente' }, LESSON)
    ).toEqual([]);
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
