const cardinalWords = [
  'zero uno due tre quattro cinque sei sette otto nove dieci undici dodici tredici quattordici quindici sedici diciassette diciotto diciannove',
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen',
];
const cardinalValues = new Map(
  cardinalWords.flatMap(words => words.split(' ').map((word, index) => [word, index] as const))
);
const writtenNumber = String.raw`[-−+]?\d+(?:[.,]\d+)?`;
const operand = `(?:${writtenNumber}|${[...cardinalValues.keys()].join('|')})`;
const boundary = String.raw`[\p{L}\p{N}]`;
const entry = `(?<!${boundary})${operand}(?!${boundary})`;
const listSeparator = String.raw`(?:,\s+|\s+(?:e|and)\s+)`;
const operandList = new RegExp(`${entry}(?:${listSeparator}${entry})+`, 'giu');
const operandToken = new RegExp(entry, 'giu');
const bracketedList = /\[\s*[-−+]?\d+(?:\.\d+)?(?:\s*,\s*[-−+]?\d+(?:\.\d+)?)+\s*\]/gu;

const readOperand = (token: string) =>
  cardinalValues.get(token.toLowerCase()) ?? Number(token.replace('−', '-').replace(',', '.'));

/** The first explicit input list fixes both the operands and their order. */
export function matchesStatedStudioOperands(input: readonly number[], narration: string): boolean {
  const bracketed = [...narration.matchAll(bracketedList)];
  const spelledOut = [...narration.matchAll(operandList)].filter(
    match =>
      !bracketed.some(
        list => match.index >= list.index && match.index < list.index + list[0].length
      )
  );
  const enumerations = [
    ...spelledOut.map(match => ({
      index: match.index,
      values: [...match[0].matchAll(operandToken)].map(([token]) => readOperand(token)),
    })),
    ...bracketed.map(match => ({
      index: match.index,
      values: match[0].slice(1, -1).split(',').map(readOperand),
    })),
  ].sort((left, right) => left.index - right.index);
  const initial = enumerations[0]?.values;
  return (
    !initial || (initial.length === input.length && initial.every((value, i) => value === input[i]))
  );
}

/** Explicit construction language can describe the first half of a full heapsort as well. */
export function describesOnlyHeapConstruction(narration: string): boolean {
  const construction = /\b(?:costruiamo|costruire|costruzione|build|building|construction)\b/iu;
  const heap = /\bheap\b/iu;
  const extraction =
    /\b(?:heap[- ]?sort|estraiamo|estrarre|estrazione|extract|extracting|extraction|ordinamento|sorting|ordinata|ordinato|sorted)\b|\b(?:massimo|maximum)\b[^.!?]*\b(?:fondo|fine|end|tail)\b/iu;
  return construction.test(narration) && heap.test(narration) && !extraction.test(narration);
}
