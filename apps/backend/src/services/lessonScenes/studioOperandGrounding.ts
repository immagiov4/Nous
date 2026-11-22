import { copy as musicCopy } from '@shared/lessonStudios/music.copy.it';
import { hitTracks, type MusicSpec, musicPitches } from '@shared/lessonStudios/musicSpec';
import { tokenizePlaneExpression } from '@shared/lessonStudios/planeMath';
import type { Layer } from '@shared/lessonStudios/planeSpec';
import { namesLabel } from '@shared/lessonStudios/studioBeatSync';
import { getMarkdownMathDelimitersAt, getMarkdownMathRangeAt } from '@shared/markdownMathSyntax';
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

const writtenOperandSequence = new RegExp(String.raw`${writtenNumber}\s+${writtenNumber}`, 'u');
const positionalArrayValue = new RegExp(
  String.raw`\b(?:prim|second|terz|quart|quint|sest|settim|ottav|non|decim)[oa](?:\s+(?:voce|elemento|valore))?\s+(?:è|vale)\s+${entry}`,
  'giu'
);
const singletonArray = new RegExp(
  String.raw`\b(?:array|lista)\s+(?:con\s+(?:il\s+)?(?:solo\s+)?valore|compost[oa]\s+dal(?:\s+solo)?\s+valore)\s+${entry}`,
  'iu'
);
const countedSteps = new RegExp(
  String.raw`^\s*(?:(?:o|oppure)\s+${entry}\s+)?(?:passaggi|passi|confronti|scambi|elementi|parti|metà)(?!${boundary})`,
  'iu'
);
const containsValues = (values: number[]) => values.length > 0 && values.every(Number.isFinite);

export function hasStatedArrayInput(passage: string) {
  return (
    statedStudioOperandLists(passage).some(
      ({ values, index, end }) =>
        containsValues(values) && (passage[index] === '[' || !countedSteps.test(passage.slice(end)))
    ) ||
    [...passage.matchAll(markdownTableRows)].some(([, row]) =>
      containsValues(statedTableOperands(row))
    ) ||
    writtenOperandSequence.test(passage) ||
    singletonArray.test(passage) ||
    [...passage.matchAll(positionalArrayValue)].length >= 2
  );
}

const statedEdgeWeight = new RegExp(
  String.raw`\b(?:peso|pesa|costo|costa|lunghezza)\s*(?:[:=]|(?:di|è)\s+)?\s*(?:\[\s*)?(${entry})`,
  'iu'
);

export function hasStatedGraphOperands(passage: string) {
  return /→|↔|->/u.test(passage) || statedEdgeWeight.test(passage);
}

function hasStatedStudioNumber(passage: string) {
  return (
    /\d/u.test(passage) ||
    [...passage.matchAll(operandToken)].some(([value]) => Number.isFinite(readOperand(value)))
  );
}

export function hasStatedScaleOperands(passage: string) {
  if (statedScaleValues(passage).length > 0) return true;
  const valueClause =
    /\b(?:coefficiente|parametro)\s+\$?a\$?\s+(?:assume|prende|varia|passa)\b[^.!?\r\n]*/giu;
  if ([...passage.matchAll(valueClause)].some(([clause]) => hasStatedStudioNumber(clause)))
    return true;
  const equation = new RegExp(
    String.raw`(?:y|f\(x\))\s*=\s*[-−+]?\s*(?:${writtenNumber}\s*)?(?:[·×*]\s*)?x(?:²|\^\{?2\}?)`,
    'giu'
  );
  return equation.test(passage);
}

const perspectiveMeasure = new RegExp(
  String.raw`${entry}\s*(?:(?:×|x|per)\s*${entry}|(?:segment[oi]|fil[ae]|righ[ae]|colonn[ae]|piastrell[ae]|quadrat[oi]|unità|mm|cm|m|metr[oi])(?!${boundary}))|\b(?:lato|larghezza|altezza|profondità|lunghezza)\s*(?:di\s+|è\s+|[:=]\s*)?${entry}`,
  'iu'
);
const writtenPerspectiveMeasure = new RegExp(
  String.raw`(?<!${boundary})${writtenNumber}(?:\s*(?:[×x]|\\times)\s*${writtenNumber}(?:\s*(?:cm|mm|m))?|cm|mm|m)(?!${boundary})`,
  'iu'
);

export function hasStatedPerspectiveDimensions(passage: string) {
  return (
    perspectiveMeasure.test(passage) ||
    writtenPerspectiveMeasure.test(passage) ||
    statedStudioOperandLists(passage).some(({ values }) => containsValues(values))
  );
}

function unwrapStudioMath(quote: string) {
  const text = quote.trim();
  const delimiters = getMarkdownMathDelimitersAt(text, 0);
  const range = delimiters && getMarkdownMathRangeAt(text, 0);
  return range?.end === text.length && delimiters
    ? text.slice(delimiters.open.length, -delimiters.close.length).trim()
    : text;
}

export function matchesQuadraticScaleFormula(quote: string) {
  const formula = unwrapStudioMath(quote.trimEnd().replace(/,$/u, ''))
    .replaceAll(/\\(?:cdot|times)|[\s·*]/gu, '')
    .replace(/\^\{2\}/u, '^2');
  return /^(?:y|f\(x\))=ax(?:²|\^2)$/u.test(formula);
}

const scaleAssignment = String.raw`(?<![\p{L}\p{N}_])(?:\$a\$|a)\s*(?:=|vale\s+|è\s+)\s*(${entry})`;

export function matchesStatedScaleValue(quote: string, value: number) {
  const assignment = new RegExp(`^${scaleAssignment}$`, 'iu').exec(unwrapStudioMath(quote));
  return !!assignment && readOperand(assignment[1]) === value;
}

export function statedScaleValues(passage: string) {
  const values = new Set<number>();
  for (const match of passage.matchAll(new RegExp(scaleAssignment, 'giu'))) {
    const start = match.index;
    const end = start + match[0].length;
    if (
      isCompleteOperandSpan(passage, start, end) &&
      isAffirmativeStudioCitation(passage, { start, end })
    )
      values.add(readOperand(match[1]));
  }
  return [...values];
}

function graphLabelPattern(label: string) {
  const text = label.trim().replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  return `(?:\x60${text}\x60|\\*\\*${text}\\*\\*|«${text}»|"${text}"|${text})`;
}

const edgeWeightPrefix =
  /^(?:ha\s+)?(?:peso|pesa|costo|costa|lunghezza)\s*(?:[:=]|(?:di|è)\s+)?\s*/iu;
const edgeWeightScalar = new RegExp(
  String.raw`^(?:\[\s*(${entry})\s*\]|\(\s*(${entry})\s*\)|(${entry}))[.!?]?$`,
  'iu'
);

function graphLinkWeight(after: string) {
  const bare = after.trim().replace(/^[,;:]\s*/u, '');
  const expression = bare.replace(edgeWeightPrefix, '');
  const scalar = edgeWeightScalar.exec(expression);
  if (scalar) return readOperand(scalar[1] ?? scalar[2] ?? scalar[3]);
  return expression === bare ? undefined : NaN;
}

function matchesDirectedGraphLink(
  left: string,
  right: string,
  from: string,
  to: string,
  weight?: number
) {
  const origin = new RegExp(
    String.raw`(?<!${boundary}|\d[.,])${graphLabelPattern(from)}\s*$`,
    'iu'
  );
  const destination = new RegExp(
    String.raw`^\s*${graphLabelPattern(to)}(?!${boundary}|[.,]\d)`,
    'iu'
  );
  const label = destination.exec(right);
  if (!label || !origin.test(left)) return false;
  return graphLinkWeight(right.slice(label[0].length)) === weight;
}

export function matchesStatedGraphLink(
  quote: string,
  { from, to, directed, weight }: { from: string; to: string; directed: boolean; weight?: number }
) {
  if (negation.test(quote)) return false;
  const parts = quote.split(directed ? /→|->/u : /↔/u);
  if (parts.length !== 2) return false;
  const [left, right] = parts;
  return (
    matchesDirectedGraphLink(left, right, from, to, weight) ||
    (!directed && matchesDirectedGraphLink(left, right, to, from, weight))
  );
}

const route = String.raw`(?:cammino|percorso|distanza)(?:\s+(?:minim[oa]|più\s+breve))?`;
const graphEndpointRole = {
  node: String.raw`nodo(?:\s+isolato)?`,
  start: String.raw`(?:(?:partiamo|partire|si\s+parte|iniziamo|${route})\s+da(?:l|lla)?|(?:sorgente|origine|nodo\s+di\s+partenza)(?:\s+è)?)`,
  target: String.raw`(?:(?:arriviamo|arrivare|si\s+arriva|terminiamo)\s+a(?:l|lla)?|${route}\s+da(?:l|lla)?\s+[^.!?→↔]+?\s+a(?:l|lla)?|(?:destinazione|traguardo|nodo\s+di\s+arrivo)(?:\s+è)?)`,
};

export function matchesStatedGraphEndpoint(
  source: string,
  span: { start: number; end: number },
  role: keyof typeof graphEndpointRole,
  label: string
) {
  const mention = new RegExp(
    String.raw`\b${graphEndpointRole[role]}[\s:]+(?:(?:il|la)\s+)?(?:nodo\s+)?${graphLabelPattern(label)}(?!${boundary}|[.,]\d)`,
    'iu'
  );
  const match = mention.exec(source.slice(span.start, span.end));
  if (!match) return false;
  const end = span.start + match.index + match[0].length;
  return !/^\s*(?:o|oppure)\b/iu.test(source.slice(end));
}

export function matchesStatedGraphAlgorithm(
  source: string,
  span: { start: number; end: number },
  labels: readonly string[],
  otherLabels: readonly string[]
) {
  const { before, after } = operandSentenceContext(source, span.start, span.end);
  const quote = source.slice(span.start, span.end);
  return (
    labels.some(label => namesLabel(quote, label)) &&
    !otherLabels.some(label => namesLabel(`${before}${quote}${after}`, label))
  );
}

function operandSentenceContext(source: string, start: number, end: number) {
  const before = source.slice(0, start).split(sentenceEnd).at(-1) ?? '';
  const after = source.slice(end).split(sentenceEnd, 1)[0];
  return { before, after };
}

export function isAffirmativeStudioCitation(
  source: string,
  { start, end }: { start: number; end: number }
) {
  const { before, after } = operandSentenceContext(source, start, end);
  const sentence = `${before} ${source.slice(start, end)} ${after}`;
  // A nonnegative weight constrains the input; it does not negate the procedure.
  return !negation.test(sentence.replaceAll(/\bnon(?:\s+|-)negativ[oaie]\b/giu, ''));
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

function normalizeOperandNotation(quote: string) {
  return unwrapStudioMath(quote)
    .replaceAll(/^\$+|\$+$/gu, '')
    .replaceAll('−', '-')
    .replaceAll(/\\(?:cdot|times)/gu, '*')
    .replaceAll(
      /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu,
      exponent => `^${[...exponent].map(digit => superscripts.indexOf(digit)).join('')}`
    );
}

function normalizeOperandEquation(quote: string) {
  return normalizeOperandNotation(quote)
    .replaceAll(/\s+/gu, '')
    .replaceAll(/\^\{(\d+)\}/gu, '^$1')
    .replaceAll(/(?<=\d)[×·*](?=[a-z])/giu, '');
}

const statedPlaneEquation = /[\p{L}₀-₉)$]\s*=\s*[+-]?\s*[\p{L}\\($]/u;

export function hasStatedPlaneInputs(passage: string) {
  const text = normalizeOperandNotation(passage);
  return hasStatedStudioNumber(text) || statedPlaneEquation.test(text);
}

/** Parse written x terms, including coefficients and zero terms implied by the syntax. */
export function polynomialCoefficients(
  quote: string,
  axis = 'x'
): [number, number, number] | undefined {
  if (/\d\s+\d/u.test(quote)) return undefined;
  const equation = normalizeOperandEquation(quote).replace(/^f\(x\)=/iu, 'y=');
  const rhs = formula.exec(equation)?.[1];
  if (!rhs) return undefined;
  const parts = rhs.matchAll(
    new RegExp(String.raw`([+-]?)(${unsignedLiteral})?(?:([a-z])(?:\^(\d+))?)?`, 'giu')
  );
  const coefficients: [number, number, number] = [0, 0, 0];
  for (const match of parts) {
    if (!match[0]) continue;
    const term = polynomialTerm(match, axis);
    if (!term) return undefined;
    coefficients[2 - term.degree] += term.value;
  }
  return coefficients.every(Number.isFinite) ? coefficients : undefined;
}

function polynomialTerm([, sign, literal, variable, exponent]: RegExpMatchArray, axis: string) {
  if (variable && variable.toLowerCase() !== axis) return undefined;
  const degree = variable ? Number(exponent ?? 1) : 0;
  if (degree > 2) return undefined;
  const value = literal === undefined ? 1 : readOperand(literal);
  return { degree, value: sign === '-' ? -value : value };
}

const priceRole = String.raw`(?:prezz[oi](?:\s+(?:di\s+vendita|unitari[oi]|per\s+pezzo))?\b(?:\s+(?:(?:sal(?:e|isse)|scend(?:e|esse)|pass(?:a|asse))\s+a|è(?:\s+di)?|di|a|vale))?\s*[:=]?\s+|vend[eo](?:\s+(?:ogni|ciascun)\s+pezzo)?\s+a\s+)`;
const perUnit = String.raw`(?:€\s*/\s*(?:unità|pezzo)|(?:euro\s+|€\s*)?(?:per\s+(?:(?:ogni|ciascun[oa]?)\s+)?(?:unità|pezzo)|a\s+pezzo|ciascun[oa]))(?!${boundary})`;
const yearAmount = String.raw`(${entry})\s+ann[oi]\b`;
const planeOperand = {
  point: String.raw`(?<!${boundary})x\s*=\s*(${entry})`,
  fixedCost: String.raw`\bcost[oi]\s+fiss[oi]\s+(?:di\s+|pari\s+a\s+)?(${entry})`,
  unitCost: String.raw`\bcost[oi]\s+variabil[ei]\s+(?:di\s+|pari\s+a\s+)?(${entry})\s*${perUnit}`,
  price: String.raw`\b${priceRole}(${entry})\s*euro\b`,
  principal: String.raw`(${entry})\s*euro\s+(?:al\s+${entry}\s*(?:%|per\s+cento\b)|iniziali\b)|\b(?:capitale\s+iniziale\s+(?:di\s+)?|su\s+)(${entry})\s*euro\b`,
  ratePercent: String.raw`(${entry})\s*(?:%|per\s+cento\b)`,
  years: yearAmount,
};

/** Match an explicit operand and its mathematical coordinate or commercial unit. */
export function matchesStatedPlaneOperand(
  quote: string,
  field: keyof typeof planeOperand,
  value: number
) {
  const values = statedPlaneOperands(quote, field);
  return values.length === 1 && values[0] === value;
}

export function statedPlaneOperands(quote: string, field: keyof typeof planeOperand) {
  const text = unwrapStudioMath(quote);
  return [...text.matchAll(new RegExp(planeOperand[field], 'giu'))]
    .filter(match => {
      const start = match.index;
      const end = start + match[0].length;
      return (
        !continuesOperand(text.slice(end)) &&
        (field !== 'price' || isAffirmativeStudioCitation(text, { start, end }))
      );
    })
    .map(([, first, second]) => readOperand(first ?? second));
}

const demandInterceptIncrease = new RegExp(
  String.raw`^(?:l['’]|il\s+)?(?:intercetta|prezzo)\s+della\s+(?:curva\s+di\s+)?domanda\s+(?:aumenta|cresce|sale)\s+di\s+(${entry})(?:\s*(?:euro|€))?[.!?]?$`,
  'iu'
);
const quantifiedDemandShift = new RegExp(
  String.raw`\bdomanda(?:\s+(?:aumenta|cresce|sale|diminuisce|scende)\s+di\s+|\s*:\s*[+−-]\s*)${entry}`,
  'iu'
);
const nonAdditiveDemandUnit =
  /^\s*(?:%|per\s+cento\b|unità(?![\p{L}\p{N}])|pezz[oi]\b|o(?:ppure)?\b)/iu;

export function hasQuantifiedDemandShift(section: string) {
  return quantifiedDemandShift.test(section);
}

export function matchesStatedDemandIncrease(section: string, quote: string, value: number) {
  const amount = demandInterceptIncrease.exec(unwrapStudioMath(quote))?.[1];
  if (!amount || readOperand(amount) !== value) return false;
  const span = sectionOperandSpan(section, quote);
  return !!span && !nonAdditiveDemandUnit.test(section.slice(span.end));
}

export function statedMarketCoefficients(quote: string, expectedRole: 'domanda' | 'offerta') {
  const market =
    /^(?:la\s+|l['’])?(?:curva\s+di\s+)?(domanda|offerta)(?:\s*:\s*|\s+è\s+)(.+)$/iu.exec(
      quote.trim()
    );
  if (!market || market[1].toLowerCase() !== expectedRole) return undefined;
  const equation = market[2].replace(/[.!?]$/u, '');
  if (!/^p=/iu.test(normalizeOperandEquation(equation))) return undefined;
  return polynomialCoefficients(equation, 'q');
}

const subannualCompounding = new RegExp(
  String.raw`\b(?:mensil[ei]|mensilmente|trimestral[ei]|trimestralmente|giornalier[oaie]|giornalmente|quotidian[oaie]|quotidianamente|semestral[ei]|semestralmente|monthly|quarterly|daily|ogni\s+(?:${entry}\s+)?(?:mes[ei]|trimestr[ei]|giorn[oi]|semestr[ei])|al\s+(?:mese|trimestre|giorno|semestre)|volte\s+(?:all|l)['’]anno)\b`,
  'iu'
);

export function hasNonannualCompounding(section: string) {
  return subannualCompounding.test(section);
}

const laterDuration = /\b(?:poi|quindi|infine|successivamente|alla\s+fine)\b/iu;
const alternativeDuration = /\b(?:o|oppure)\b/iu;
const sharedYearUnit = new RegExp(
  String.raw`(?:${entry}\s+(?:o|oppure)\s+|\b(?:tra|fra)\s+${entry}\s+e\s+)${yearAmount}`,
  'iu'
);

export function finalStatedCompoundYears(section: string) {
  if (sharedYearUnit.test(section)) return undefined;
  const durations = [...section.matchAll(new RegExp(yearAmount, 'giu'))].flatMap(match => {
    const start = match.index;
    const end = start + match[0].length;
    return isAffirmativeStudioCitation(section, { start, end })
      ? [{ value: readOperand(match[1]), start, end }]
      : [];
  });
  for (const [index, duration] of durations.slice(1).entries()) {
    const previous = durations[index];
    if (duration.value === previous.value) continue;
    const transition = section.slice(previous.end, duration.start);
    if (!laterDuration.test(transition) || alternativeDuration.test(transition)) return undefined;
  }
  return durations.at(-1)?.value;
}

const secantAssignment = String.raw`(?<!${boundary})h\s*(?:=|assume\s+i\s+valori\b)\s*(\[[^\]\r\n]*\]|${entry}(?:${listSeparator}${entry})*)`;
const beforeSecantTerm = /[\p{L}\p{N})\]}][ \t]*[*/⁄×÷^+−-][ \t]*$/u;

function secantValues(operands: string) {
  const values = operands.startsWith('[')
    ? bracketOperands(operands)
    : [...operands.matchAll(operandToken)].map(([token]) => readOperand(token));
  return values.filter(value => value !== 0);
}

export function statedSecantSteps(section: string) {
  return [...section.matchAll(new RegExp(secantAssignment, 'giu'))].flatMap(match => {
    const start = match.index;
    const end = start + match[0].length;
    if (beforeSecantTerm.test(section.slice(0, start))) return [];
    if (!isAffirmativeStudioCitation(section, { start, end })) return [];
    // An unsupported expression is still supplied data and must not trigger defaults.
    return isCompleteOperandSpan(section, start, end) ? secantValues(match[1]) : [NaN];
  });
}

export function matchesStatedSecantSteps(quote: string, values: readonly number[]) {
  const assignment = new RegExp(`^${secantAssignment}$`, 'iu').exec(unwrapStudioMath(quote));
  if (!assignment) return false;
  const stated = secantValues(assignment[1]);
  return stated.length === values.length && stated.every((value, index) => value === values[index]);
}

function statedFormulaOperands(quote: string, coefficients: boolean) {
  if (/\d\s+\d/u.test(quote)) return [];
  const equation = normalizeOperandEquation(quote);
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
  if (!quote) return undefined;
  let complete: { start: number; end: number } | undefined;
  for (let start = section.indexOf(quote); start >= 0; start = section.indexOf(quote, start + 1)) {
    const end = start + quote.length;
    if (!isCompleteOperandSpan(section, start, end)) continue;
    if (complete) return undefined;
    complete = { start, end };
  }
  return complete;
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
  const implied =
    !table && options.formula === 'coefficients' ? polynomialCoefficients(quote) : undefined;
  if (implied && values.length === 3)
    return implied.every((value, index) => value === values[index]);
  if (implied && values.length === 2 && implied[0] === 0)
    return implied[1] === values[0] && implied[2] === values[1];
  const stated = table
    ? statedTableOperands(quote)
    : statedFormulaOperands(quote, options.formula === 'coefficients');
  return values.length === stated.length && stated.every((value, index) => value === values[index]);
}

const unalteredSignature = /\bsenza\s+alterazioni\s+in\s+chiave\b/giu;

export function matchesCitedStudioText(
  matches: (text: string) => boolean,
  source: string,
  { start, end }: { start: number; end: number }
) {
  const quote = source.slice(start, end);
  const { before, after } = operandSentenceContext(source, start, end);
  const sentences = quote.split(sentenceEnd);
  const prefix = sentences[0].trim() ? before : '';
  const suffix = sentences.at(-1)?.trim() ? after : '';
  const context = prefix + quote + suffix;
  return (
    !negation.test(context.replaceAll(unalteredSignature, '')) && matches(quote) && matches(context)
  );
}

const musicKeyDeclaration =
  /\b(?:tonalità|scala(?:\s+naturale)?|accordi)\s*(?:di\s+|in\s+|è\s+(?:in\s+)?|:\s*)(?:(do|re|mi|fa|sol|la|si)\s*(diesis|bemolle|[#b])?\s+(maggiore|minore)|([a-g][#b]?m?)(?:\s+(major|minor|maggiore|minore))?)(?![\p{L}\p{N}#])/giu;
const unsupportedKeyContinuation =
  /^\s*[,/]?\s*\b(?:o|oppure|anziché|armonica|melodica|pentatonica|blues)\b/iu;
const musicAccidentals: Readonly<Record<string, string>> = {
  diesis: '♯',
  '#': '♯',
  bemolle: '♭',
  b: '♭',
};
const bpmUnit = String.raw`(?:BPM|battiti\s+al\s+minuto)(?!${boundary})`;
const bpmDeclaration = new RegExp(String.raw`(${entry})\s+${bpmUnit}`, 'giu');
const bpmRange = new RegExp(
  String.raw`(?:${entry}\s*(?:[-–—…/]|\ba\b)\s*${entry}|\b(?:tra|fra)\s+${entry}\s+e\s+${entry})\s+${bpmUnit}`,
  'iu'
);

function normalizedNotation(text: string) {
  return text.toLowerCase().replaceAll('♯', '#').replaceAll('♭', 'b');
}

function matchesMusicKey(key: string, text: string) {
  const tonic = musicPitches(key)[0][0].name.toLowerCase();
  const mode = key.endsWith('m') ? 'minore' : 'maggiore';
  if (text.search(unalteredSignature) >= 0 && key !== 'C' && key !== 'Am') return false;
  const declarations = [...normalizedNotation(text).matchAll(musicKeyDeclaration)];
  return (
    declarations.length > 0 &&
    declarations.every(match => {
      const [, note, accidental = '', quality, symbol, symbolMode] = match;
      if (unsupportedKeyContinuation.test(text.slice(match.index + match[0].length))) return false;
      if (!symbol)
        return note + (musicAccidentals[accidental] ?? accidental) === tonic && quality === mode;
      if (!symbolMode) return symbol === key.toLowerCase();
      return (
        symbol.replace(/m$/u, '') === key.toLowerCase().replace(/m$/u, '') &&
        symbolMode.startsWith('min') === key.endsWith('m') &&
        (!symbol.endsWith('m') || key.endsWith('m'))
      );
    })
  );
}

function matchesMusicList(values: readonly number[], label: string, text: string) {
  const statement = new RegExp(
    String.raw`\b${label}(?:\s*:\s*|\s+(?:sono\s+|(?:ai|sui)\s+passi\s+)?)(\[[^\]\r\n]*\]|${entry}(?:${listSeparator}${entry})*)`,
    'giu'
  );
  const declarations = [...text.matchAll(statement)];
  return (
    declarations.length > 0 &&
    declarations.every(match => {
      const [, list] = match;
      const end = match.index + match[0].length;
      return (
        isCompleteOperandSpan(text, end - list.length, end) &&
        (values.length ? matchesStatedStudioOperands(values, list) : /^\[\s*\]$/u.test(list))
      );
    })
  );
}

const musicField = 'geometryStudio.spec';

const scaleNoteList =
  /\b(?:note(?:\s+della\s+scala)?\s*:|scala\s+(?:contiene|comprende|è\s+composta\s+da)\s+)\s*([^.!?;\r\n]+)/giu;
const scaleNote = /^(do|re|mi|fa|sol|la|si)\s*(diesis|bemolle|[#b])?$/iu;

function matchesScaleNotes(list: string, scale: readonly string[]) {
  const notes = list
    .trim()
    .replaceAll(/^\[|\]$/gu, '')
    .split(/\s*,\s*|\s+e\s+/iu);
  return (
    (notes.length === scale.length || notes.length === scale.length - 1) &&
    notes.every((note, index) => {
      const match = scaleNote.exec(note.trim());
      if (!match) return false;
      const [, name, accidental = ''] = match;
      return name + (musicAccidentals[accidental] ?? accidental) === scale[index];
    })
  );
}

export function musicEvidenceConflict(
  spec: MusicSpec,
  source: string,
  citations: readonly { start: number; end: number }[]
) {
  const normalized = normalizedNotation(source);
  const first = citations.length ? Math.min(...citations.map(citation => citation.start)) : 0;
  const end = citations.length
    ? Math.max(...citations.map(citation => citation.end))
    : source.length;
  const nearestKey = [...normalized.slice(0, first).matchAll(musicKeyDeclaration)].at(-1);
  const opensWithKey = citations.some(
    citation =>
      citation.start === first &&
      normalized.slice(first, citation.end).search(musicKeyDeclaration) >= 0
  );
  const start = opensWithKey ? first : (nearestKey?.index ?? first);
  const citedContext = source.slice(start, end);
  const declarations = [...normalized.slice(start, end).matchAll(musicKeyDeclaration)];
  if (!citations.length && (declarations.length !== 1 || !matchesMusicKey(spec.key, citedContext)))
    return undefined;
  if (declarations.length > 1 || (declarations.length && !matchesMusicKey(spec.key, citedContext)))
    return `${musicField}.key`;
  if (spec.degrees) return undefined;
  const nextKey = normalized.slice(end).search(musicKeyDeclaration);
  const scaleContext = normalized.slice(start, nextKey < 0 ? undefined : end + nextKey);
  const scale = musicPitches(spec.key).map(([pitch]) => pitch.name.toLowerCase());
  return [...scaleContext.matchAll(scaleNoteList)].some(
    ([, list]) => !matchesScaleNotes(list, scale)
  )
    ? `${musicField}.key`
    : undefined;
}

export function musicOperandChecks(spec: MusicSpec) {
  const checks = [
    {
      field: `${musicField}.key`,
      matchesText: (text: string) => matchesMusicKey(spec.key, text),
    },
  ];
  const { degrees, drums } = spec;
  if (degrees) {
    checks.push({
      field: `${musicField}.degrees`,
      matchesText: text => matchesMusicList(degrees, 'gradi', text),
    });
  }
  if (drums) {
    checks.push({
      field: `${musicField}.drums.bpm`,
      matchesText: text => {
        if (bpmRange.test(text)) return false;
        const statements = [...text.matchAll(bpmDeclaration)];
        return (
          statements.length > 0 && statements.every(([, value]) => readOperand(value) === drums.bpm)
        );
      },
    });
    hitTracks.forEach((track, index) => {
      checks.push({
        field: `${musicField}.drums.${track}`,
        matchesText: text => matchesMusicList(drums[track], musicCopy.percussion[index], text),
      });
    });
  }
  return checks;
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
const actionSearchKey = String.raw`(?:cerchiamo|cerca|cercare|troviamo|trova|individuiamo|individua)\s+${targetLabel}`;
const statedSearchKey = String.raw`(?:(?:valore|elemento|numero)\s+(?:da\s+cercare|cercat[oa]|ricercat[oa])|chiave\s+di\s+ricerca)\s*(?:è|vale|[:=])\s*`;
const searchTarget = new RegExp(
  String.raw`\b(?:${actionSearchKey}|${statedSearchKey})(${entry})`,
  'giu'
);

export function hasStatedStudioSearchTarget(passage: string) {
  return Boolean(passage.match(searchTarget));
}
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
