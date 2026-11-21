import { describe, expect, test } from 'vitest';

import {
  heapOperationFromNarration,
  matchesStatedStudioOperands,
} from '../../../src/services/lessonScenes/studioOperandGrounding.js';

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
    expect(matchesStatedStudioOperands(fixture.input, fixture.passage)).toBe(true);
    if ('heapOperation' in fixture) {
      expect(heapOperationFromNarration(fixture.passage)).toBe(fixture.heapOperation);
    }
  });

  test('permits example values when narration gives no list', () => {
    const narration = 'Ordiniamo un array di cinque numeri con bubble sort.';
    expect(matchesStatedStudioOperands([5, 3, 8], narration)).toBe(true);
  });

  test('keeps the first list when an instruction immediately follows it', () => {
    const narration = 'Prendiamo l’array 5, 3, 8 e ordiniamolo.';
    expect(matchesStatedStudioOperands([5, 3, 8], narration)).toBe(true);
    expect(matchesStatedStudioOperands([5, 3], narration)).toBe(false);
  });

  test('keeps the sign of a spoken operand', () => {
    const narration = 'Partiamo da meno tre e quattro.';
    expect(matchesStatedStudioOperands([-3, 4], narration)).toBe(true);
    expect(matchesStatedStudioOperands([3, 4], narration)).toBe(false);
  });

  test('rejects a first list whose sentence identifies it as the result', () => {
    const narration = '[3.5, 4] è il risultato. Partiamo da [4, 3.5].';
    expect(matchesStatedStudioOperands([3.5, 4], narration)).toBe(false);
    expect(matchesStatedStudioOperands([4, 3.5], narration)).toBe(false);
  });

  test('recognizes an affirmative description of heapsort without an imperative', () => {
    const narration = 'Heap sort ordina la lista estraendo ogni volta il massimo.';
    expect(heapOperationFromNarration(narration)).toBe('sort');
  });
});
