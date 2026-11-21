import { tokenizePlaneExpression } from '@shared/lessonStudios/planeMath';
import type { Layer } from '@shared/lessonStudios/planeSpec';

const cardinalWords = [
  'zero uno due tre quattro cinque sei sette otto nove dieci undici dodici tredici quattordici quindici sedici diciassette diciotto diciannove',
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen',
];
const writtenNumber = String.raw`[-−+]?(?:\d+(?:[.,]\d+)?|\.\d+)(?:[eE][+−-]?\d+)?`;
const operand = `(?:${writtenNumber}|${cardinalWords.join(' ').replaceAll(' ', '|')})`;
const boundary = String.raw`[\p{L}\p{N}]`;
const spokenMinusPrefix = String.raw`(?:meno|minus)\s+`;
const entry = `(?<!${boundary})(?:${spokenMinusPrefix})?${operand}(?!${boundary})`;
const listSeparator = String.raw`(?:[,;]\s+(?:(?:e|and)\s+)?|\s+(?:e|and)\s+)`;
const operandList = new RegExp(`${entry}(?:${listSeparator}${entry})+`, 'giu');
const operandToken = new RegExp(entry, 'giu');
const bracketedList = /\[[^\]\r\n]*(?:\]|$)/gu;
const writtenToken = new RegExp(`^${writtenNumber}$`, 'u');
const sentenceEnd = /(?<!\d)\.|\.(?!\d)|[!?\r\n]/u;
const expressionContinuation = /^[*/⁄^×÷=+−-]/u;
const bareListPrefix = /(?:[,;*/⁄^×÷+−-]|\b(?:e|and))\s*$/iu;
const bareListSuffix = /^(?:[,;]|\b(?:e|and)\b)/iu;
const resultMarker =
  /\b(?:risultat[oi]|risultant[ei]|otteniamo|alla\s+fine|ordinat[aeio]|sorted|results?|output|finale?)\b/iu;

function readOperand(token: string): number {
  return writtenToken.test(token) ? Number(token.replaceAll('−', '-').replace(',', '.')) : NaN;
}

function bracketOperands(list: string) {
  if (!list.endsWith(']')) return [];
  const contents = list.slice(1, -1).trim();
  if (writtenToken.test(contents)) return [readOperand(contents)];
  // Spaced commas and semicolons separate entries without consuming decimal commas.
  const commaSeparator = /,\s/u.test(list) ? /,\s+/u : ',';
  const separator = list.includes(';') ? ';' : commaSeparator;
  return contents.split(separator).map(token => readOperand(token.trim()));
}

function statedOperandLists(narration: string) {
  const bracketed = [...narration.matchAll(bracketedList)];
  const bareLists = [...narration.matchAll(operandList)].filter(
    match =>
      !bracketed.some(
        list => match.index >= list.index && match.index < list.index + list[0].length
      )
  );
  const lists = [
    ...bracketed.map(match => ({
      index: match.index,
      end: match.index + match[0].length,
      values: bracketOperands(match[0]),
    })),
    ...bareLists.map(match => {
      const end = match.index + match[0].length;
      const before = narration.slice(0, match.index);
      const after = narration.slice(end).trimStart();
      const fragment =
        bareListPrefix.test(before) ||
        bareListSuffix.test(after) ||
        expressionContinuation.test(after);
      return {
        index: match.index,
        end,
        values: fragment
          ? []
          : [...match[0].matchAll(operandToken)].map(([token]) => readOperand(token)),
      };
    }),
  ].sort((left, right) => left.index - right.index);
  return lists;
}

export function matchesStatedStudioOperands(
  input: readonly number[],
  phrase: string,
  initial = false
): boolean {
  const lists = statedOperandLists(phrase);
  const matches = ({ values }: (typeof lists)[number]) =>
    values.length === input.length && values.every((value, i) => value === input[i]);
  if (!initial) return lists.some(matches);
  const [list] = lists;
  if (!list || !matches(list)) return false;
  const before = phrase.slice(0, list.index).split(sentenceEnd).at(-1);
  const after = phrase.slice(list.end).split(sentenceEnd, 1)[0];
  return !resultMarker.test(`${before} ${after}`);
}

function numericLeaves(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(numericLeaves);
  return [];
}

export function planeLayerOperands(layer: Layer): number[] {
  if (layer.type === 'curve')
    return tokenizePlaneExpression(layer.expr).flatMap((token, index, tokens) => {
      const value = Number(token);
      if (!Number.isFinite(value)) return [];
      const beforeSign = tokens[index - 2];
      const negative = tokens[index - 1] === '-' && (!beforeSign || /^[(+*/^-]$/u.test(beforeSign));
      return [negative ? -value : value];
    });
  // waveStart only offsets the drawing of the wave along the horizontal axis.
  if (layer.type === 'unit-circle-wave') return numericLeaves(layer.angle);
  return numericLeaves(layer);
}

const heapSort = /\b(?:heapsort|ordin[ai]|estra|sort|extract)/iu;
const extraction = /\b(?:estra|extract)/iu;
const negation =
  /\b(?:non|mai|senza|no|not|never|without|(?:do|does|did|is|are|was|were)n['’]t)\b/iu;

const targetLabel = String.raw`(?:(?:il\s+(?:numero|valore|target)|l['’]elemento)\s+)?`;
const searchTarget = new RegExp(
  String.raw`\b(?:cerchiamo|cerca|cercare|troviamo|trova|individuiamo|individua)\s+${targetLabel}(${entry})`,
  'giu'
);
const alternativeTarget = new RegExp(
  String.raw`^\s*(?:(?:o|oppure|e)\s+|,\s*)${targetLabel}${entry}`,
  'iu'
);

/** The key must be named independently of the values in the input list. */
export function matchesStatedStudioSearchTarget(
  target: number | undefined,
  narration: string
): boolean {
  if (target === undefined) return false;
  const targets = new Set<number>();
  for (const sentence of narration.split(sentenceEnd)) {
    const matches = [...sentence.matchAll(searchTarget)];
    if (matches.length && negation.test(sentence)) return false;
    for (const match of matches) {
      const after = sentence.slice(match.index + match[0].length).trimStart();
      if (alternativeTarget.test(after) || expressionContinuation.test(after)) return false;
      targets.add(readOperand(match[1]));
    }
  }
  return targets.size === 1 && targets.has(target);
}

/** A negated extraction conflicts with an affirmative sorting or extraction clause. */
export function heapOperationFromNarration(narration: string): 'build' | 'sort' | undefined {
  const clauses = narration.split(/[,;.!?:\r\n]+/u);
  const requestsSort = clauses.some(clause => heapSort.test(clause) && !negation.test(clause));
  if (!requestsSort) return 'build';
  const contradictsSort = clauses.some(clause => negation.test(clause) && extraction.test(clause));
  return contradictsSort ? undefined : 'sort';
}
