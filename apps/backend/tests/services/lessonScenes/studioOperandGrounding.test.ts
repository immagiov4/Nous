import { describe, expect, test } from 'vitest';

import {
  heapOperationFromNarration,
  isAffirmativeStudioCitation,
  matchesSectionStudioOperands,
  matchesStatedGraphEndpoint,
  matchesStatedGraphLink,
  matchesStatedStudioOperands,
  matchesStatedStudioSearchTarget,
  planeLayerOperands,
  sectionOperandSpan,
} from '../../../src/services/lessonScenes/studioOperandGrounding.js';

test('a graph citation must state the directed link in the extracted order', () => {
  const edge = { from: 'A', to: 'B', directed: true };
  expect(matchesStatedGraphLink('A → B', edge)).toBe(true);
  expect(matchesStatedGraphLink('B → A', edge)).toBe(false);
  expect(matchesStatedGraphLink('Non A → B', edge)).toBe(false);
  expect(matchesStatedGraphLink('A e B appartengono al grafo', edge)).toBe(false);
});

test.each([
  ['`1` → **2**, peso 3', true],
  ['«1» → «2», peso [3]', true],
  ['1 → 2. Un altro arco pesa 3', false],
  ['1 → 2, peso [3, 8]', false],
  ['1 → 2,5, peso 3', false],
])('keeps a weight local to the complete edge %s', (quote, grounded) => {
  expect(matchesStatedGraphLink(quote, { from: '1', to: '2', directed: true, weight: 3 })).toBe(
    grounded
  );
});

test('an exact quote cannot hide an alternative graph target', () => {
  const quote = 'La destinazione è il nodo 2';
  const source = `${quote} oppure 3.`;
  expect(matchesStatedGraphEndpoint(source, { start: 0, end: quote.length }, 'target', '2')).toBe(
    false
  );
});

test('a cropped graph citation retains the polarity of its owning sentence', () => {
  for (const [source, affirmative] of [
    ['Non usiamo A → B. Usiamo B → A.', false],
    ['Prima usiamo A → B. Poi non torniamo ad A.', true],
  ] as const) {
    const span = sectionOperandSpan(source, 'A → B');
    if (!span) throw new Error('Expected an exact link citation');
    expect(isAffirmativeStudioCitation(source, span)).toBe(affirmative);
  }
});

// Verbatim lab corpus passages that passed the studio gate in round 20.
const labPassages = [
  {
    id: 'stem-01-bubble-sort',
    input: [5, 1, 4, 2, 8],
    passage:
      'Bubble sort scorre la lista da sinistra a destra e confronta ogni coppia di elementi vicini. Se il primo è più grande del secondo, li scambia. Alla fine del primo passaggio, l’elemento più grande è “risalito” in fondo, come una bolla, e non va più toccato. Si ripete sulla parte ancora disordinata. Con la lista [5, 1, 4, 2, 8] il primo passaggio fa tre scambi e porta l’8 in fondo. Se in un passaggio non avviene nessuno scambio, la lista è ordinata e l’algoritmo può fermarsi: per questo su una lista quasi ordinata bubble sort è veloce, mentre nel caso peggiore servono circa n²/2 confronti.',
  },
  {
    id: 'ed-01-heap-sort',
    input: [4, 10, 3, 5, 1],
    passage:
      'Heap sort ordina una lista usando un max-heap: un albero binario quasi completo in cui ogni genitore è maggiore o uguale ai figli. L’albero vive dentro lo stesso array: i figli dell’elemento in posizione i stanno in 2i+1 e 2i+2. Prima si costruisce l’heap partendo dall’ultimo genitore e facendo “scendere” ogni valore finché è più grande dei figli. A quel punto il massimo è in cima, nella posizione 0. Lo si scambia con l’ultimo elemento, si considera l’ultimo posto come definitivo e si ripristina l’heap sulla parte restante. Con [4, 10, 3, 5, 1] l’heap costruito è [10, 5, 3, 4, 1]. Ripetendo, la lista si ordina in O(n log n) senza memoria aggiuntiva.',
    heapOperation: 'sort',
  },
  {
    id: 'ed-03-bubble-quasi-ordinata',
    input: [1, 2, 4, 3, 5, 6],
    passage:
      'Domanda dello studente: cosa cambia se la lista è quasi ordinata? Prendiamo [1, 2, 4, 3, 5, 6]. Nel primo passaggio bubble sort confronta le coppie vicine e trova un solo caso fuori posto, 4 e 3, che scambia. Nel secondo passaggio confronta di nuovo tutte le coppie ma non fa nessuno scambio: questo prova che la lista è ordinata e l’algoritmo si ferma. Servono due passaggi invece di sei: su liste quasi ordinate bubble sort con il controllo “nessuno scambio” lavora in tempo quasi lineare.',
  },
] as const;

describe('studio selection from the lab corpus', () => {
  test.each(labPassages)('$id keeps the lab input and heap operation', fixture => {
    expect(matchesStatedStudioOperands(fixture.input, fixture.passage, true)).toBe(true);
    if ('heapOperation' in fixture) {
      expect(heapOperationFromNarration(fixture.passage)).toBe(fixture.heapOperation);
    }
  });

  test('rejects example values when narration gives no list', () => {
    const narration = 'Ordiniamo un array di cinque numeri con bubble sort.';
    expect(matchesStatedStudioOperands([5, 3, 8], narration)).toBe(false);
  });

  test('keeps the first list when an instruction immediately follows it', () => {
    const narration = 'Prendiamo l’array [5, 3, 8] e ordiniamolo.';
    expect(matchesStatedStudioOperands([5, 3, 8], narration)).toBe(true);
    expect(matchesStatedStudioOperands([5, 3], narration)).toBe(false);
  });

  test('reads an explicit sign without reversing it', () => {
    const narration = 'Partiamo da meno tre e quattro.';
    expect(matchesStatedStudioOperands([-3, 4], narration)).toBe(true);
    expect(matchesStatedStudioOperands([3, 4], narration)).toBe(false);
    expect(matchesStatedStudioOperands([-3, 4], 'Partiamo da meno 3 e 4.')).toBe(true);
    expect(matchesStatedStudioOperands([-3, 4], 'Partiamo da −3 e 4.')).toBe(true);
  });

  test.each([
    { phrase: 'tre, uno, quattro', values: [3, 1, 4] },
    { phrase: 'due virgola cinque', values: [2.5] },
    { phrase: 'due virgola zero cinque', values: [2.05] },
    { phrase: 'meno due', values: [-2] },
    { phrase: 'un mezzo', values: [0.5] },
    { phrase: 'duecento e ventuno', values: [200, 21] },
  ])('reads the full Italian expression $phrase', ({ phrase, values }) => {
    expect(matchesStatedStudioOperands(values, phrase)).toBe(true);
  });

  test.each([
    'Usiamo i valori [3,5; 4,25].',
    'Usiamo i valori [3,5, 4,25].',
    'Usiamo i valori 3,5 e 4,25.',
  ])('reads Italian decimal commas in %s', phrase => {
    expect(matchesStatedStudioOperands([3.5, 4.25], phrase)).toBe(true);
    expect(matchesStatedStudioOperands([3.5, 4], phrase)).toBe(false);
  });

  test.each([
    'Partiamo dai valori 3, 4 e venti.',
    'Partiamo dai valori 3, 4 e duecento.',
    'Partiamo dai valori 3, 4, e 5.',
    'Partiamo dai valori [3, 4,',
    'Partiamo dai valori 3, 4,',
  ])('rejects a prefix of the stated list in %s', phrase => {
    expect(matchesStatedStudioOperands([3, 4], phrase)).toBe(false);
  });

  test('does not use the numerator of a written fraction as an operand', () => {
    expect(matchesStatedStudioOperands([3, 4, 1], 'Partiamo dai valori 3, 4 e 1/2.')).toBe(false);
    expect(matchesStatedStudioOperands([3, 4], 'Partiamo da [3, 4] / 2.')).toBe(false);
  });

  test('does not drop the order of magnitude of a spoken operand', () => {
    expect(matchesStatedStudioOperands([3, 4, 2], 'Partiamo da 3, 4 e due milioni.')).toBe(false);
    expect(matchesStatedStudioSearchTarget(2, 'Cerchiamo due milioni.')).toBe(false);
  });

  test.each([
    {
      section: 'La retta ha equazione y = 2x + 1.',
      quote: 'y = 2x + 1',
      values: [2, 1],
      accepted: true,
    },
    {
      section: 'La retta ha equazione y = 2x + 1 + 3.',
      quote: 'y = 2x + 1',
      values: [2, 1],
      accepted: false,
    },
    {
      section: 'La retta ha equazione y = 2*3x + 1.',
      quote: 'y = 2*3x + 1',
      values: [23, 1],
      accepted: false,
    },
    { section: 'La retta è y = x + 1.', quote: 'y = x + 1', values: [1, 1], accepted: false },
    { section: 'La retta è y = 2x − 1.', quote: 'y = 2x − 1', values: [2, -1], accepted: true },
    {
      section: 'Equazione:\n\\[y = 2x + 1\\]',
      quote: 'y = 2x + 1',
      values: [2, 1],
      accepted: true,
    },
    {
      section: 'Equazione:\n\\[y = 2x + 1\\]',
      quote: '\\[y = 2x + 1\\]',
      values: [2, 1],
      accepted: true,
    },
    {
      section: 'Equazione:\n\\[y = 2x\n+ 1\\]',
      quote: 'y = 2x',
      values: [2],
      accepted: false,
    },
    {
      section: 'La retta è y = 1.234x + 1\n- L’intercetta è positiva.',
      quote: 'y = 1.234x + 1',
      values: [1234, 1],
      accepted: true,
    },
    {
      section: 'Pesi noti:\n| A → B | meno due | due virgola cinque |',
      quote: '| A → B | meno due | due virgola cinque |',
      values: [-2, 2.5],
      accepted: true,
    },
    {
      section: 'Pesi noti:\n| A → B | 1 | 2 | 3 |',
      quote: '| 1 | 2 |',
      values: [1, 2],
      accepted: false,
    },
    {
      section: 'Pesi noti:\n| A → B | 3 | 4 |',
      quote: '3',
      values: [3],
      accepted: false,
    },
    {
      section: 'Pesi noti:\n| tre, quattro | 1 | 2 |',
      quote: '| tre, quattro | 1 | 2 |',
      values: [3, 4],
      accepted: false,
    },
    {
      section: 'Pesi noti:\n| tre o quattro | 1 | 2 |',
      quote: '| tre o quattro | 1 | 2 |',
      values: [1, 2],
      accepted: false,
    },
    { section: 'Il valore è due virgola cinque.', quote: 'cinque', values: [5], accepted: false },
    { section: 'Il valore è due milioni.', quote: 'due', values: [2], accepted: false },
  ])('requires exact and complete section evidence: $section', ({
    section,
    quote,
    values,
    accepted,
  }) => {
    const span = sectionOperandSpan(section, quote);
    expect(
      span !== undefined &&
        matchesSectionStudioOperands(values, section, quote, span, {
          formula: 'coefficients',
        })
    ).toBe(accepted);
  });

  test('requires a list even for a single operand', () => {
    expect(matchesStatedStudioOperands([2], 'Nel passaggio 2 aumentiamo l’angolo.')).toBe(false);
    expect(matchesStatedStudioOperands([2], 'Il nuovo angolo è [2] gradi.')).toBe(true);
  });

  test('distinguishes a decimal comma from a spaced separator', () => {
    expect(matchesStatedStudioOperands([1.5], 'Usiamo il valore [1,5].')).toBe(true);
    expect(matchesStatedStudioOperands([1, 5], 'Usiamo il valore [1,5].')).toBe(false);
    expect(matchesStatedStudioOperands([1, 5], 'Usiamo i valori [1, 5].')).toBe(true);
  });

  test('reads numeric operands from the same expression syntax as the plane', () => {
    expect(planeLayerOperands({ type: 'curve', id: 'trace', expr: 'x - -2 + 0.5' })).toEqual([
      -2, 0.5,
    ]);
  });

  test('grounds an explicit exponent without inventing a coefficient', () => {
    const section = 'La parabola ha equazione y = x².';
    const quote = 'y = x²';
    const span = { start: section.indexOf(quote), end: section.indexOf(quote) + quote.length };
    expect(sectionOperandSpan(section, quote)).toEqual(span);
    expect(matchesSectionStudioOperands([2], section, quote, span, { formula: 'literals' })).toBe(
      true
    );
    expect(
      matchesSectionStudioOperands([1], section, quote, span, { formula: 'coefficients' })
    ).toBe(false);
  });

  test('grounds a curve that subtracts the same constant as the cited equation', () => {
    const quote = 'y = x - 2';
    const values = planeLayerOperands({ type: 'curve', id: 'trace', expr: 'x - 2' });
    const span = { start: 0, end: quote.length };
    expect(matchesSectionStudioOperands(values, quote, quote, span, { formula: 'literals' })).toBe(
      true
    );
  });

  test('grounds physical values and floor geometry without including render metadata', () => {
    expect(
      planeLayerOperands({
        id: 'ray',
        type: 'snell',
        n1: 1,
        n2: 1.5,
        angle: 30,
        media: [
          { index: 1, name: 'Aria' },
          { index: 1.5, name: 'Vetro' },
        ],
      })
    ).toEqual([1, 1.5, 30]);
    expect(
      planeLayerOperands({
        id: 'floor',
        type: 'floor',
        vanishing: [0, 3],
        near: [
          [-3, 0],
          [3, 0],
        ],
        tiles: 6,
        rows: 9,
      })
    ).toEqual([0, 3, -3, 0, 3, 0]);
  });

  test('rejects a first list whose sentence identifies it as the result', () => {
    const narration = '[3.5, 4] è il risultato. Partiamo da [4, 3.5].';
    expect(matchesStatedStudioOperands([3.5, 4], narration, true)).toBe(false);
    expect(matchesStatedStudioOperands([4, 3.5], narration, true)).toBe(false);
  });

  test('recognizes an affirmative description of heapsort without an imperative', () => {
    const narration = 'Heap sort ordina la lista estraendo ogni volta il massimo.';
    expect(heapOperationFromNarration(narration)).toBe('sort');
  });
});
