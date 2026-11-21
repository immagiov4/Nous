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
const spokenMinusPrefix = String.raw`(?:meno|minus)\s+`;
const spokenMinus = new RegExp(`^${spokenMinusPrefix}`, 'iu');
const entry = `(?<!${boundary})(?:${spokenMinusPrefix})?${operand}(?!${boundary})`;
const listSeparator = String.raw`(?:,\s+|\s+(?:e|and)\s+)`;
const operandList = new RegExp(`${entry}(?:${listSeparator}${entry})+`, 'giu');
const operandToken = new RegExp(entry, 'giu');
const bracketedList = /\[[^\]\r\n]*\]/gu;
const bracketNumber = /^[−+-]?\d+(?:\.\d+)?$/u;
const sentenceEnd = /(?<!\d)\.|\.(?!\d)|[!?\r\n]/u;
const resultMarker =
  /\b(?:risultat[oi]|risultant[ei]|otteniamo|alla\s+fine|ordinat[aeio]|sorted|results?|output|finale?)\b/iu;

function readOperand(token: string): number {
  const magnitude = token.replace(spokenMinus, '').toLowerCase();
  const value =
    cardinalValues.get(magnitude) ?? Number(magnitude.replace('−', '-').replace(',', '.'));
  return spokenMinus.test(token) ? -value : value;
}

/** Example operands are allowed only when the passage gives no numeric list. */
export function matchesStatedStudioOperands(input: readonly number[], narration: string): boolean {
  const bracketed = [...narration.matchAll(bracketedList)];
  const spelledOut = [...narration.matchAll(operandList)].filter(
    match =>
      !bracketed.some(
        list => match.index >= list.index && match.index < list.index + list[0].length
      )
  );
  const lists = [
    ...bracketed.flatMap(match => {
      const tokens = match[0]
        .slice(1, -1)
        .split(',')
        .map(token => token.trim());
      return tokens.every(token => bracketNumber.test(token))
        ? [
            {
              index: match.index,
              end: match.index + match[0].length,
              values: tokens.map(readOperand),
            },
          ]
        : [];
    }),
    ...spelledOut.map(match => ({
      index: match.index,
      end: match.index + match[0].length,
      values: [...match[0].matchAll(operandToken)].map(([token]) => readOperand(token)),
    })),
  ].sort((left, right) => left.index - right.index);
  const [first] = lists;
  if (!first) return true;

  const before = narration.slice(0, first.index).split(sentenceEnd).at(-1);
  const after = narration.slice(first.end).split(sentenceEnd, 1)[0];
  if (resultMarker.test(`${before} ${after}`)) return false;
  return (
    first.values.length === input.length && first.values.every((value, i) => value === input[i])
  );
}

const heapSort = /\b(?:heapsort|ordin[ai]|estra|sort|extract)/iu;
const extraction = /\b(?:estra|extract)/iu;
const negation =
  /\b(?:non|mai|senza|no|not|never|without|(?:do|does|did|is|are|was|were)n['’]t)\b/iu;

/** A negated extraction conflicts with an affirmative sorting or extraction clause. */
export function heapOperationFromNarration(narration: string): 'build' | 'sort' | undefined {
  const clauses = narration.split(/[,;.!?:\r\n]+/u);
  const requestsSort = clauses.some(clause => heapSort.test(clause) && !negation.test(clause));
  if (!requestsSort) return 'build';
  const contradictsSort = clauses.some(clause => negation.test(clause) && extraction.test(clause));
  return contradictsSort ? undefined : 'sort';
}
