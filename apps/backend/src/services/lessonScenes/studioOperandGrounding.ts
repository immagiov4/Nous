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
const bracketedList = /\[[^\]\r\n]*\]/gu;
const bracketNumber = /^[−+-]?\d+(?:\.\d+)?$/u;
const inputPrefix =
  /^(?:(?:partiamo|iniziamo) (?:da|con|dalla lista)|(?:start|begin) with|(?:input|array iniziale|initial array)\s*[:=]?)\s*$/iu;
const singleListPrefix =
  /^(?:(?:confrontiamo|consideriamo|ordiniamo|compare|consider|sort)(?: (?:i valori|la lista|the values|the list))?|(?:i (?:valori|numeri) sono|the (?:values|numbers) are)|costruiamo (?:un )?(?:max[- ]?)?heap con|build (?:a )?(?:max[- ]?)?heap with)\s*:?$/iu;
const resultPrefix =
  /^(?:(?:(?:il|the) )?(?:risultato|result|output|ordine finale|final (?:array|answer))\b|alla fine\b|(?:otteniamo|we get)\b)/iu;

const readOperand = (token: string) =>
  cardinalValues.get(token.toLowerCase()) ?? Number(token.replace('−', '-').replace(',', '.'));

/** Treat competing numeric lists as ambiguous unless their roles are explicitly stated. */
export function matchesStatedStudioOperands(input: readonly number[], narration: string): boolean {
  const bracketed = [...narration.matchAll(bracketedList)];
  const spelledOut = [...narration.matchAll(operandList)].filter(
    match =>
      !bracketed.some(
        list => match.index >= list.index && match.index < list.index + list[0].length
      )
  );
  const lists = [
    ...bracketed.map(match => {
      const tokens = match[0]
        .slice(1, -1)
        .split(',')
        .map(token => token.trim());
      return {
        index: match.index,
        values: tokens.every(token => bracketNumber.test(token)) ? tokens.map(readOperand) : [],
      };
    }),
    ...spelledOut.map(match => {
      const before = narration.slice(0, match.index);
      const after = narration.slice(match.index + match[0].length);
      const partial =
        /(?:\b(?:meno|minus|e|and)\s+|,\s*)$/iu.test(before) ||
        /^(?:\s+(?:e|and)\b|,)/iu.test(after);
      return {
        index: match.index,
        values: partial
          ? []
          : [...match[0].matchAll(operandToken)].map(([token]) => readOperand(token)),
      };
    }),
  ].sort((left, right) => left.index - right.index);
  const [first, ...later] = lists;
  if (!first || lists.some(list => !list.values.length)) return false;

  const prefixAt = (index: number) =>
    narration
      .slice(0, index)
      .split(/[.!?;]/u)
      .at(-1)
      ?.trim() ?? '';
  const prefix = prefixAt(first.index);
  if (later.length) {
    if (!inputPrefix.test(prefix) || !later.every(list => resultPrefix.test(prefixAt(list.index))))
      return false;
  } else if (prefix && !inputPrefix.test(prefix) && !singleListPrefix.test(prefix)) {
    return false;
  }
  return (
    first.values.length === input.length && first.values.every((value, i) => value === input[i])
  );
}

const heapAction =
  /^(?:(?:poi|ora|quindi|then|now|next)\s+)?(?:(?:estraiamo|estrai|ordiniamo|ordina)\s+(?:il|la|i|gli|le|tutti)\s+|(?:extract|sort)\s+(?:the|all)\s+)\S/iu;
const negation = /\b(?:non|mai|senza|not|never|without|don['’]t)\b/iu;
const extractionOrOrdering =
  /\b(?:estraiamo|estrai|estrarre|ordiniamo|ordina|ordinare|extract(?:ing)?|sort(?:ing)?)\b/iu;

/** Full sorting needs an affirmative instruction. Conflicting instructions need a catalog scene. */
export function heapOperationFromNarration(narration: string): 'build' | 'sort' | undefined {
  const clauses = narration.split(/[.!?;:\n]+/u).map(clause => clause.trim());
  const requestsSort = clauses.some(clause => heapAction.test(clause) && !negation.test(clause));
  if (!requestsSort) return 'build';
  const contradictsSort = clauses.some(
    clause => negation.test(clause) && extractionOrOrdering.test(clause)
  );
  return contradictsSort ? undefined : 'sort';
}
