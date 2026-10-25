import { INTERNAL_FAST_TASK_INSTRUCTION } from '@shared/aiPromptInstructions';
import {
  type FormulaSpotlightData,
  FormulaSpotlightDataSchema,
  findFormulaOccurrences,
  formulaLatexSource,
  formulaSpotlightCovers,
  hasFormulaSpotlightReferences,
  renderSpotlightFormula,
  resolveFormulaReferences,
} from '@shared/formulaSpotlight';
import type { PlaybackRange } from '@shared/lessonPlayback';
import { findLessonSceneProblems, type LessonScene } from '@shared/lessonScene';
import { narrationWords } from '@shared/playbackWordTiming';
import * as z from 'zod';
import type { GlobalModelConfig } from '../../config/modelConfig.js';
import { isInvalidLessonVisualStructuredOutput } from '../lessonGenerationVisuals.js';
import { generateStructuredOutput } from '../structuredGeneration.js';
import type { LessonSceneOutcome } from './lessonSceneGeneration.js';

export interface FormulaPreparationSource {
  readonly formula: string;
  readonly template?: LessonScene & FormulaSpotlightData;
  readonly dictatedRanges?: readonly PlaybackRange[];
}
interface FormulaPreparationInput {
  readonly config: GlobalModelConfig;
  readonly source: FormulaPreparationSource;
  readonly narration: string;
  readonly retryFeedback?: string;
  readonly signal: AbortSignal;
}
class FormulaSelectionError extends Error {}

interface SelectionToken extends PlaybackRange {
  readonly id: string;
  readonly text: string;
}
const symbolShape = FormulaSpotlightDataSchema.shape.symbols.element.shape;
const wordSelectionSchema = z.object({
  first: z.string().regex(/^w\d+$/u),
  last: z.string().regex(/^w\d+$/u),
});
const voiceShape = { mentions: z.array(wordSelectionSchema) };
const sourceDraftSchema = z.object({
  mentioned: z.boolean(),
  title: symbolShape.name,
  summary: symbolShape.meaning,
  symbols: z.array(
    z.object({
      id: symbolShape.id,
      ranges: z
        .array(
          z.object({
            first: z.string().regex(/^t\d+$/u),
            last: z.string().regex(/^t\d+$/u),
            needsGroup: z.boolean(),
          })
        )
        .min(1),
      name: symbolShape.name,
      meaning: symbolShape.meaning,
      ...voiceShape,
    })
  ),
});
type SourceFormulaDraft = z.infer<typeof sourceDraftSchema>;
type TokenSelection = { readonly first: string; readonly last: string };

const FORMULA_BINDING_INSTRUCTION = `Prepare data for the existing formula spotlight. The authored mathematics is immutable. Use only the supplied formula and narration. Return data, never styling, rewritten math or rewritten speech.
Decide whether the narration names any part of this visible formula, including explanatory references and recalls, not just complete readings. Supplied dictatedRanges are explicit readings of this formula and require mentioned:true. If no part is named, choose mentioned:false.
Use the supplied narrationWords IDs to select each exact spoken mention: first and last are inclusive word IDs, equal for a single word. Copy IDs from the list; never count substring occurrences or invent quotations. Select only the words naming that part. mentions:[] means an unmentioned part. Include every later reference, too. Several parts may select the same words when one mention names a compound or a family; each of those explicit parts will light up together.
Distinguish a symbol's name from an identical ordinary word used as an article or preposition. When those words are adjacent, select the naming token rather than its grammatical neighbor. For example, in the Italian phrase 'si somma a a b', the first isolated 'a' names the quantity and the second 'a' introduces its recipient b. Exclude articles and connective words from a named operand; a spoken operator belongs to its own displayed target, not the adjacent operand.
Mathematical identity includes concrete indices and primes: two quantities with different indices or primes are not interchangeable just because their base glyph matches. A generic family reference may explicitly target its displayed members. Separate base/index targets still belong to their complete indexed quantity. Use dictatedWords for this formula's own reading; add references elsewhere only to the same quantity. Include named operators, delimiters and indices, not just letters. A named pair of brackets can link both delimiters to the same words. Select minimal naming words rather than unrelated introductory clauses.
Use the lesson language for names, meanings, title and summary. Explain only what the provided material supports. ${INTERNAL_FAST_TASK_INSTRUCTION}`;

const speechTokens = (narration: string): SelectionToken[] =>
  narrationWords(narration).map((word, index) => ({ ...word, id: `w${index}` }));
const sourceTokens = (latex: string): SelectionToken[] =>
  Array.from(latex.matchAll(/\\(?:[a-zA-Z@]+|[\s\S])|[\s\S]/gu), (token, index) => ({
    id: `t${index}`,
    text: token[0],
    start: token.index,
    end: token.index + token[0].length,
  }));

/** Resolve only provider-selected IDs; source control words and acoustic words are indivisible. */
function selectedRange(
  tokens: readonly SelectionToken[],
  selection: TokenSelection
): PlaybackRange {
  const first = tokens.find(token => token.id === selection.first);
  const last = tokens.find(token => token.id === selection.last);
  if (!first || !last || first.start > last.start)
    throw new FormulaSelectionError('Select existing token IDs in source order.', {
      cause: { selection, available: tokens.map(({ id, text }) => ({ id, text })) },
    });
  return { start: first.start, end: last.end };
}

function heardLinks(mentions: readonly TokenSelection[], narration: string) {
  const words = speechTokens(narration);
  const references = mentions.map(selection => {
    const range = selectedRange(words, selection);
    const anchor = narration.slice(range.start, range.end);
    const anchorOccurrence = findFormulaOccurrences(narration, anchor).indexOf(range.start);
    if (anchorOccurrence < 0)
      throw new Error('Selected words must retain their canonical position.');
    return { anchor, anchorOccurrence };
  });
  return {
    anchor: references[0]?.anchor ?? '',
    anchorOccurrence: references[0]?.anchorOccurrence,
    additionalAnchors: references.slice(1),
  };
}

async function requestFormulaDraft<T extends z.ZodType>(
  schema: T,
  input: FormulaPreparationInput,
  instructions: string
) {
  const { $schema: _dialect, ...outputSchema } = z.toJSONSchema(schema);
  const { source, narration } = input;
  const words = speechTokens(narration);
  const response = await generateStructuredOutput<unknown>({
    config: input.config,
    slot: 'scene',
    signal: input.signal,
    sourceAware: false,
    output: { name: 'formula_spotlight_preparation', schema: outputSchema },
    system: `${FORMULA_BINDING_INSTRUCTION}\n${instructions}`,
    prompt: JSON.stringify({
      authoredTex: formulaLatexSource(source.formula),
      sourceTokens: source.template ? undefined : sourceTokens(formulaLatexSource(source.formula)),
      canonicalNarration: narration,
      narrationWords: words,
      dictatedRanges: source.dictatedRanges,
      dictatedWords: source.dictatedRanges?.map(range =>
        words.filter(word => word.start < range.end && word.end > range.start)
      ),
      existingTemplate: source.template,
      requiredCorrection: input.retryFeedback,
    }),
  }).catch(error => {
    input.signal.throwIfAborted();
    if (!isInvalidLessonVisualStructuredOutput(error)) throw error;
    return null;
  });
  input.signal.throwIfAborted();
  return { parsed: schema.safeParse(response), response };
}

function invalidFormulaDraft(
  problems: readonly string[],
  draft: unknown,
  error?: Error
): LessonSceneOutcome {
  return {
    kind: 'invalid',
    problems,
    formulaCorrection: {
      draft,
      problem: error?.message,
      selection: error?.cause,
    },
  };
}

function sourceFormulaScene(
  input: FormulaPreparationInput,
  draft: SourceFormulaDraft
): LessonScene & FormulaSpotlightData {
  const latex = formulaLatexSource(input.source.formula);
  if (!draft.mentioned)
    return {
      type: 'formula-spotlight',
      title: draft.title,
      body: '',
      quote: '',
      note: '',
      items: [],
      groups: [],
      autoplay: true,
      formula: String.raw`\nousSymbol{formula}`,
      symbols: [
        {
          id: 'formula',
          latex,
          name: draft.title,
          meaning: draft.summary,
          anchor: '',
          additionalAnchors: [],
        },
      ],
    };
  const tokens = sourceTokens(latex);
  const parts = draft.symbols.map(symbol => {
    const ranges = symbol.ranges.map(selection => ({
      ...selectedRange(tokens, selection),
      id: symbol.id,
      needsGroup: selection.needsGroup,
    }));
    const fragment = latex.slice(ranges[0].start, ranges[0].end);
    if (ranges.some(range => latex.slice(range.start, range.end) !== fragment))
      throw new FormulaSelectionError(
        'Different source fragments need separate symbol IDs, even when they share a spoken mention.',
        { cause: { symbol: symbol.id, ranges } }
      );
    return {
      ranges,
      symbol: {
        id: symbol.id,
        latex: fragment,
        name: symbol.name,
        meaning: symbol.meaning,
        ...heardLinks(symbol.mentions, input.narration),
      },
    };
  });
  const ranges = parts
    .flatMap(part => part.ranges)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let cursor = 0;
  let formula = '';
  for (const range of ranges) {
    if (range.start < cursor)
      throw new FormulaSelectionError('Source formula fragments must not overlap.', {
        cause: { range, previousEnd: cursor, selections: ranges },
      });
    const reference = String.raw`\nousSymbol{${range.id}}`;
    formula += latex.slice(cursor, range.start) + (range.needsGroup ? `{${reference}}` : reference);
    cursor = range.end;
  }
  formula += latex.slice(cursor);
  return {
    type: 'formula-spotlight',
    title: draft.title,
    body: '',
    quote: '',
    note: '',
    items: [],
    groups: [],
    autoplay: true,
    formula,
    symbols: parts.map(part => part.symbol),
  };
}

function validatePreparedFormula(
  input: FormulaPreparationInput,
  scene: LessonScene & FormulaSpotlightData,
  mentioned: boolean,
  draft: unknown
): LessonSceneOutcome {
  const problems = findLessonSceneProblems(
    scene,
    `${input.source.formula}\n${input.narration}`,
    input.narration
  );
  if (mentioned !== hasFormulaSpotlightReferences(scene))
    problems.push('The named-parts decision must agree with the supplied narration links.');
  if (!formulaSpotlightCovers(scene, [input.source.formula]))
    problems.push('The target fragments must retain the complete authored mathematics.');
  if (problems.length) {
    try {
      renderSpotlightFormula(scene);
      resolveFormulaReferences(scene, input.narration);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return invalidFormulaDraft(
        problems,
        { sourceDraft: draft, formula: scene.formula, symbols: scene.symbols },
        error
      );
    }
    return invalidFormulaDraft(problems, {
      sourceDraft: draft,
      formula: scene.formula,
      symbols: scene.symbols,
    });
  }
  return { kind: 'scene', scene };
}

/** Bind listed source tokens to listed heard words; the provider never re-authors math or counts occurrences. */
export async function generateSourceBoundFormula(
  input: FormulaPreparationInput
): Promise<LessonSceneOutcome> {
  const template = input.source.template;
  let selectedDraft: unknown;
  try {
    if (template) {
      const ids = template.symbols.map(symbol => symbol.id);
      const schema = z.object({
        mentioned: input.source.dictatedRanges?.length ? z.literal(true) : z.boolean(),
        links: z.array(z.object({ id: z.enum(ids), ...voiceShape })),
      });
      const { parsed, response } = await requestFormulaDraft(
        schema,
        input,
        'The existingTemplate formula and symbol definitions are fixed. Return only links by their existing IDs, with exact narration word selections. A compound mention may link several IDs. Omit unmentioned IDs; never duplicate a link ID. Choose mentioned:false and links:[] when no part is named.'
      );
      if (!parsed.success)
        return invalidFormulaDraft(['Follow the formula-link response schema.'], response);
      selectedDraft = parsed.data;
      const links = new Map(parsed.data.links.map(link => [link.id, link]));
      if (links.size !== parsed.data.links.length)
        return invalidFormulaDraft(
          ['Every existing symbol ID may have only one link record.'],
          parsed.data
        );
      const scene = {
        ...template,
        symbols: template.symbols.map(symbol => ({
          ...symbol,
          ...heardLinks(links.get(symbol.id)?.mentions ?? [], input.narration),
        })),
      };
      return validatePreparedFormula(input, scene, parsed.data.mentioned, parsed.data);
    }
    const schema = input.source.dictatedRanges?.length
      ? sourceDraftSchema.extend({ mentioned: z.literal(true) })
      : sourceDraftSchema;
    const { parsed, response } = await requestFormulaDraft(
      schema,
      input,
      String.raw`If mentioned:false, return symbols:[] with a short title and summary. Otherwise define every mathematical identifier, including unmentioned ones. Each range selects inclusive first/last IDs from sourceTokens; single tokens use equal IDs. Select a complete independently renderable fragment. Control words such as \mathbf are indivisible. Source ranges must not overlap. Repeated occurrences use their own token IDs, even when one is a prefix of a longer fragment (for example q inside q-prime). Each symbol may have several ranges only for IDENTICAL source text; use separate symbols for distinct family members and link them to the same narration words. Never return rewritten TeX. Script operators _ and ^ are TeX syntax, not independently renderable fragments: never select one alone. Keep them outside a reference when selecting only their argument: select the digit, not _digit. needsGroup:true adds a paired brace group whenever the replacement occupies an unbraced TeX argument, including LETTERS as well as digits. For source q^K, selecting K requires needsGroup:true and produces q^{\nousSymbol{exponent}}, never q^\nousSymbol{exponent}. Use false when the argument already has braces or the fragment is not an argument. A whole base-with-script fragment can instead be selected as one part without an added group. The application preserves every source character outside the selected fragments.`
    );
    if (!parsed.success)
      return invalidFormulaDraft(['Follow the source-token response schema.'], response);
    if (!parsed.data.mentioned && parsed.data.symbols.length)
      return invalidFormulaDraft(
        ['A static decision must return symbols:[] rather than discard supplied links.'],
        parsed.data
      );
    selectedDraft = parsed.data;
    const scene = sourceFormulaScene(input, parsed.data);
    return validatePreparedFormula(input, scene, parsed.data.mentioned, parsed.data);
  } catch (error) {
    input.signal.throwIfAborted();
    if (!(error instanceof FormulaSelectionError)) throw error;
    return invalidFormulaDraft(
      ['Select exact, ordered, nonoverlapping source and narration token IDs.'],
      selectedDraft,
      error
    );
  }
}
