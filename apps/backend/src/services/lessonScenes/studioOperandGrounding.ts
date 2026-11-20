const cardinalWords = [
  'zero uno due tre quattro cinque sei sette otto nove dieci',
  'zero one two three four five six seven eight nine ten',
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

/** Ground the full input order when the passage explicitly enumerates an array of that size. */
export function matchesStatedStudioOperands(input: readonly number[], narration: string): boolean {
  const lists = [
    ...[...narration.matchAll(operandList)].map(([list]) =>
      [...list.matchAll(operandToken)].map(([token]) => readOperand(token))
    ),
    ...[...narration.matchAll(bracketedList)].map(([list]) =>
      list.slice(1, -1).split(',').map(readOperand)
    ),
  ].filter(values => values.length === input.length);
  return lists.length === 0 || lists.some(values => values.every((value, i) => value === input[i]));
}
