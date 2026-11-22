import { tokenizePlaneExpression } from '@shared/lessonStudios/planeMath';
import type { Layer } from '@shared/lessonStudios/planeSpec';
import { italianStudioNumber, readItalianStudioNumber } from './italianStudioNumbers.js';

const writtenNumber = String.raw`[-−+]?(?:\d+(?:[.,]\d+)?|\.\d+)(?:[eE][+−-]?\d+)?`;
const unsignedGroupedNumber = String.raw`[1-9]\d{0,2}(?:\.\d{3})+(?:,\d+)?`;
const italianGroupedNumber = `[-−+]?${unsignedGroupedNumber}`;
const operand = `(?:${italianGroupedNumber}|${writtenNumber}|${italianStudioNumber})`;
const boundary = String.raw`[\p{L}\p{N}]`;
const spokenMinusPrefix = String.raw`meno\s+`;
const spokenMinus = new RegExp(`^${spokenMinusPrefix}`, 'iu');
const entry = `(?<!${boundary})(?:${spokenMinusPrefix})?${operand}(?!${boundary})`;
const listSeparator = String.raw`(?:[,;]\s+(?:(?:e|and)\s+)?|\s+(?:e|and)\s+)`;
const operandList = new RegExp(`${entry}(?:${listSeparator}${entry})+`, 'giu');
const operandToken = new RegExp(entry, 'giu');
const bracketedList = /(?<!\\)\[[^\]\r\n]*(?:\]|$)/gu;
const displayMath = /\\\[([\s\S]*?)\\\]/gu;
const writtenToken = new RegExp(`^(?:${italianGroupedNumber}|${writtenNumber})$`, 'u');
const groupedToken = new RegExp(`^${italianGroupedNumber}$`, 'u');
const sentenceEnd = /(?<!\d)\.|\.(?!\d)|[!?\r\n]/u;
const expressionContinuation = /^[*/⁄^×÷=+−-]/u;
const unsupportedNumberSuffix =
  /^(?:mila|milion[ei]|miliard[oi]|bilion[ei]|biliard[oi]|trilion[ei]|mezz[oi]|terz[oi]|quart[oi]|quint[oi]|sest[oi]|settim[oi]|ottav[oi]|non[oi]|decim[oi])\b/iu;
const bareListPrefix = /(?:[,;*/⁄^×÷+−-]|\b(?:e|and))\s*$/iu;
const bareListSuffix = /^(?:[,;]|\b(?:e|and)\b)/iu;
const resultMarker =
  /\b(?:risultat[oi]|risultant[ei]|otteniamo|alla\s+fine|ordinat[aeio]|sorted|results?|output|finale?)\b/iu;
const negation =
  /\b(?:non|mai|senza|no|not|never|without|(?:do|does|did|is|are|was|were)n['’]t)\b/iu;
const rejectedInitialList =
  /\b(?:non|never|not)\s+(?:(?:dobbiamo|dovremmo|possiamo|si\s+(?:deve|può)|è\s+(?:necessario|consentito))\s+)?(?:partiamo|partire|usiamo|usare|prendiamo|prendere|scegliamo|scegliere|consideriamo|considerare|sono|use|start|choose|pick)\b/iu;

function continuesOperand(after: string) {
  const [line] = after.split('\n', 1);
  const continuation = line.trimStart();
  return expressionContinuation.test(continuation) || unsupportedNumberSuffix.test(continuation);
}

function readOperand(token: string): number {
  const magnitude = token.replace(spokenMinus, '');
  if (!writtenToken.test(magnitude)) {
    const value = readItalianStudioNumber(magnitude);
    return spokenMinus.test(token) ? -value : value;
  }
  const digits = groupedToken.test(magnitude) ? magnitude.replaceAll('.', '') : magnitude;
  const value = Number(digits.replaceAll('−', '-').replace(',', '.'));
  return spokenMinus.test(token) ? -value : value;
}

function bracketOperands(list: string) {
  if (!list.endsWith(']')) return [];
  const contents = list.slice(1, -1).trim();
  const scalar = readOperand(contents);
  if (Number.isFinite(scalar)) return [scalar];
  // Spaced commas and semicolons separate entries without consuming decimal commas.
  const commaSeparator = /,\s/u.test(list) ? /,\s+/u : ',';
  const separator = list.includes(';') ? ';' : commaSeparator;
  return contents.split(separator).map(token => readOperand(token.trim()));
}

export function statedStudioOperandLists(narration: string) {
  const bracketed = [...narration.matchAll(bracketedList)];
  const bareLists = [...narration.matchAll(operandList)].filter(
    match =>
      !bracketed.some(
        list => match.index >= list.index && match.index < list.index + list[0].length
      )
  );
  const lists = [
    ...bracketed.map(match => {
      const end = match.index + match[0].length;
      return {
        index: match.index,
        end,
        values: continuesOperand(narration.slice(end)) ? [] : bracketOperands(match[0]),
      };
    }),
    ...bareLists.map(match => {
      const end = match.index + match[0].length;
      const before = narration.slice(0, match.index);
      const after = narration.slice(end).trimStart();
      const fragment =
        bareListPrefix.test(before) || bareListSuffix.test(after) || continuesOperand(after);
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
  initial = false,
  source = { text: phrase, start: 0 }
): boolean {
  const lists = statedStudioOperandLists(phrase);
  const matches = ({ values }: (typeof lists)[number]) =>
    values.length === input.length && values.every((value, i) => value === input[i]);
  if (!lists.length && input.length === 1)
    return readOperand(phrase.trim().replace(/[.!?]$/u, '')) === input[0];
  if (!initial) return lists.some(matches);
  const [list] = lists;
  if (!list || !matches(list)) return false;
  return !isUnusableInitialList(source.text, source.start + list.index, source.start + list.end);
}

function operandSentenceContext(source: string, start: number, end: number) {
  const before = source.slice(0, start).split(sentenceEnd).at(-1) ?? '';
  const after = source.slice(end).split(sentenceEnd, 1)[0];
  return { before, after };
}

function isUnusableInitialList(source: string, start: number, end: number) {
  const { before, after } = operandSentenceContext(source, start, end);
  return (
    resultMarker.test(`${before} ${after}`) ||
    rejectedInitialList.test(before.split(/[,;:]/u).at(-1) ?? '')
  );
}

const unsignedLiteral = String.raw`(?:${unsignedGroupedNumber}|(?:\d+(?:[.,]\d+)?|\.\d+)(?:[eE][+-]?\d+)?)`;
const power = String.raw`(?:\^\d+)?`;
const term = `(?:(?:${unsignedLiteral})?[a-z]${power}|${unsignedLiteral})`;
const formula = new RegExp(`^[a-z](?:[₀-₉]+)?=([+-]?${term}(?:[+-]${term})*)$`, 'iu');
const superscripts = '⁰¹²³⁴⁵⁶⁷⁸⁹';

function statedFormulaOperands(quote: string, coefficients: boolean) {
  if (/\d\s+\d/u.test(quote)) return [];
  const display = [...quote.matchAll(displayMath)][0];
  const equation = (display?.[0] === quote ? display[1] : quote)
    .replaceAll(/^\$+|\$+$/gu, '')
    .replaceAll(/\s+/gu, '')
    .replaceAll('−', '-')
    .replaceAll(/(?<=\d)[×·*](?=[a-z])/giu, '')
    .replaceAll(
      /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu,
      exponent => `^${[...exponent].map(digit => superscripts.indexOf(digit)).join('')}`
    );
  const rhs = formula.exec(equation)?.[1];
  if (!rhs) return [];
  const terms = rhs.matchAll(
    new RegExp(String.raw`([+-]?)(${unsignedLiteral})?(?:[a-z](?:\^(\d+))?)?`, 'giu')
  );
  return [...terms].flatMap(([, sign, literal, exponent]) => [
    ...(literal === undefined ? [] : [readOperand(sign + literal)]),
    ...(!coefficients && exponent !== undefined ? [Number(exponent)] : []),
  ]);
}

const markdownTableRow = String.raw`\|[^\r\n]+\|`;
const markdownTableSpan = new RegExp(
  String.raw`^${markdownTableRow}(?:\r?\n${markdownTableRow})*$`,
  'u'
);
const markdownTableRows = new RegExp(String.raw`^[ \t]*(${markdownTableRow})[ \t]*\r?$`, 'gmu');

function statedTableOperands(quote: string) {
  return quote.split(/\r?\n/u).flatMap(row =>
    row
      .slice(1, -1)
      .split('|')
      .flatMap(cell => {
        const value = readOperand(cell.trim());
        if (Number.isFinite(value)) return [value];
        return /\d/u.test(cell) || cell.match(operandToken) ? [NaN] : [];
      })
  );
}

/** Resolve a unique quotation and reject a slice of a larger operand expression. */
export function sectionOperandSpan(section: string, quote: string) {
  const start = section.indexOf(quote);
  if (start < 0 || section.indexOf(quote, start + 1) !== -1) return undefined;
  const end = start + quote.length;
  return isCompleteOperandSpan(section, start, end) ? { start, end } : undefined;
}

function cutsOperandStructure(source: string, start: number, end: number) {
  const partial = (from: number, to: number) =>
    from < end && to > start && (from < start || to > end);
  if (statedStudioOperandLists(source).some(span => partial(span.index, span.end))) return true;
  if (
    [...source.matchAll(operandToken)].some(match =>
      partial(match.index, match.index + match[0].length)
    )
  )
    return true;
  if (
    [...source.matchAll(markdownTableRows)].some(row => {
      const rowStart = row.index + row[0].indexOf(row[1]);
      return partial(rowStart, rowStart + row[1].length);
    })
  )
    return true;
  return [...source.matchAll(displayMath)].some(match => {
    if (!partial(match.index, match.index + match[0].length)) return false;
    const body = match[1].trim();
    const bodyStart = match.index + match[0].indexOf(body, String.raw`\[`.length);
    return start !== bodyStart || end !== bodyStart + body.length;
  });
}

export function isCompleteOperandSpan(source: string, start: number, end: number) {
  if (start < 0) return false;
  const before = source.slice(0, start);
  const after = source.slice(end);
  const quote = source.slice(start, end);
  const wordJoin = /^[\p{L}\p{N}\p{M}]/u;
  if (wordJoin.test(before.at(-1) ?? '') && wordJoin.test(quote)) return false;
  if (wordJoin.test(after) && wordJoin.test(quote.at(-1) ?? '')) return false;
  if (continuesOperand(after)) return false;
  if (cutsOperandStructure(source, start, end)) return false;
  if (
    markdownTableSpan.test(quote) &&
    (!/^\s*$/u.test(before.split('\n').at(-1) ?? '') || !/^\s*$/u.test(after.split('\n', 1)[0]))
  )
    return false;
  if (
    Number.isFinite(readOperand(quote)) &&
    (bareListPrefix.test(before) || bareListSuffix.test(after.trimStart()))
  )
    return false;
  return true;
}

export function matchesSectionStudioOperands(
  values: readonly number[],
  section: string,
  quote: string,
  span: { start: number; end: number },
  options: { initial?: boolean; formula?: 'coefficients' | 'literals' }
) {
  if (options.initial && isUnusableInitialList(section, span.start, span.end)) return false;
  const table = markdownTableSpan.test(quote);
  const source = { text: section, start: span.start };
  if (!table && matchesStatedStudioOperands(values, quote, options.initial, source)) return true;
  if (!table && !options.formula) return false;
  const stated = table
    ? statedTableOperands(quote)
    : statedFormulaOperands(quote, options.formula === 'coefficients');
  return values.length === stated.length && stated.every((value, index) => value === values[index]);
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
      return [tokens[index - 1] === '-' ? -value : value];
    });
  switch (layer.type) {
    case 'line':
      return numericLeaves(layer.form);
    case 'point':
      return numericLeaves(layer.at);
    case 'circle':
      return numericLeaves([layer.center, layer.radius]);
    case 'unit-circle-wave':
      return numericLeaves(layer.angle);
    case 'segment':
    case 'vector':
      return numericLeaves(layer.through);
    case 'grid-transform':
      return numericLeaves(layer.matrix);
    case 'construction':
      return numericLeaves([layer.through, layer.horizon]);
    case 'floor':
      return numericLeaves([layer.vanishing, layer.near]);
    case 'tangent':
      return numericLeaves([layer.x, layer.h]);
    case 'snell':
      return numericLeaves([layer.n1, layer.n2, layer.angle]);
    case 'region':
    case 'intersection':
    case 'roots':
      return [];
  }
}

const heapSort = /\b(?:heapsort|ordin[ai]|estra|sort|extract)/iu;
const extraction = /\b(?:estra|extract)/iu;

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
      if (alternativeTarget.test(after) || continuesOperand(after)) return false;
      targets.add(readOperand(match[1]));
    }
  }
  return targets.size === 1 && targets.has(target);
}

export function matchesSectionStudioSearchTarget(
  target: number,
  section: string,
  span: { start: number; end: number }
) {
  const { before, after } = operandSentenceContext(section, span.start, span.end);
  const quote = section.slice(span.start, span.end);
  return (
    matchesStatedStudioSearchTarget(target, quote) &&
    matchesStatedStudioSearchTarget(target, `${before}${quote}${after}`)
  );
}

/** A negated extraction conflicts with an affirmative sorting or extraction clause. */
export function heapOperationFromNarration(narration: string): 'build' | 'sort' | undefined {
  const clauses = narration.split(/[,;.!?:\r\n]+/u);
  const requestsSort = clauses.some(clause => heapSort.test(clause) && !negation.test(clause));
  if (!requestsSort) return 'build';
  const contradictsSort = clauses.some(clause => negation.test(clause) && extraction.test(clause));
  return contradictsSort ? undefined : 'sort';
}
