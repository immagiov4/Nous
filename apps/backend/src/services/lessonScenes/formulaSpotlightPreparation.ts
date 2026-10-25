import { INTERNAL_FAST_TASK_INSTRUCTION } from '@shared/aiPromptInstructions';
import {
  type FormulaSpotlightData,
  FormulaSpotlightDataSchema,
  formulaLatexSource,
  formulaSpotlightCovers,
  hasFormulaSpotlightReferences,
  renderSpotlightFormula,
  resolveFormulaOccurrence,
  resolveFormulaReferences,
} from '@shared/formulaSpotlight';
import type { PlaybackRange } from '@shared/lessonPlayback';
import { findLessonSceneProblems, type LessonScene } from '@shared/lessonScene';
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
const symbolShape = FormulaSpotlightDataSchema.shape.symbols.element.shape;
const voiceShape = {
  anchor: symbolShape.anchor,
  anchorOccurrence: symbolShape.anchorOccurrence,
  additionalAnchors: symbolShape.additionalAnchors.unwrap(),
};
const sourceSymbolSchema = z.object({
  id: symbolShape.id,
  latex: symbolShape.latex,
  sourceOccurrences: z
    .array(z.object({ occurrence: symbolShape.anchorOccurrence.unwrap(), needsGroup: z.boolean() }))
    .min(1),
  name: symbolShape.name,
  meaning: symbolShape.meaning,
  ...voiceShape,
});
const sourceDraftSchema = z.object({
  mentioned: z.boolean(),
  title: symbolShape.name,
  summary: symbolShape.meaning,
  symbols: z.array(sourceSymbolSchema),
});
type SourceFormulaDraft = z.infer<typeof sourceDraftSchema>;

const FORMULA_BINDING_INSTRUCTION = `Prepare data for the existing formula spotlight. The authored mathematics is immutable. Use only the supplied formula and narration. Return data, never styling or code.
Decide whether the narration names any part of this visible formula, including explanatory references and recalls, not just complete readings. Supplied dictatedRanges are explicit readings of this formula and require mentioned:true. If no part is named, choose mentioned:false.
Every voice anchor is an exact quotation from the complete canonical narration, limited to the words naming that part. anchorOccurrence selects its zero-based literal occurrence, including occurrences inside other words. Supply it whenever the quotation repeats. Put every later mention of the same part in additionalAnchors, each with its exact quotation and occurrence. Do not broaden quotations to avoid repetitions. Empty anchor and [] mean an unmentioned part. Never rewrite narration.
Use the lesson language for names, meanings, title and summary. Explain only what the provided material supports. ${INTERNAL_FAST_TASK_INSTRUCTION}`;

async function requestFormulaDraft<T extends z.ZodType>(
  schema: T,
  input: FormulaPreparationInput,
  instructions: string
) {
  const { $schema: _dialect, ...outputSchema } = z.toJSONSchema(schema);
  const { source, narration } = input;
  const response = await generateStructuredOutput<unknown>({
    config: input.config,
    slot: 'scene',
    signal: input.signal,
    sourceAware: false,
    output: { name: 'formula_spotlight_preparation', schema: outputSchema },
    system: `${FORMULA_BINDING_INSTRUCTION}\n${instructions}`,
    prompt: `AUTHORED TEX (copy fragments exactly, including braces and spaces):\n${formulaLatexSource(source.formula)}\n\nCANONICAL NARRATION:\n${narration}\n\n${JSON.stringify(
      {
        dictatedRanges: source.dictatedRanges,
        dictatedReadings: source.dictatedRanges?.map(range =>
          narration.slice(range.start, range.end)
        ),
        existingTemplate: source.template,
        requiredCorrection: input.retryFeedback,
      }
    )}`,
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
  source: FormulaPreparationSource,
  draft: SourceFormulaDraft
): LessonScene & FormulaSpotlightData {
  const latex = formulaLatexSource(source.formula);
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
  // KaTeX control words are indivisible: an "a" inside \mathbf is not a source-symbol occurrence.
  const tokens = Array.from(latex.matchAll(/\\(?:[a-zA-Z@]+|[\s\S])|[\s\S]/gu));
  const sourceBoundaries = new Set([0, ...tokens.map(token => token.index + token[0].length)]);
  const ranges = draft.symbols
    .flatMap(symbol =>
      symbol.sourceOccurrences.map(selection => ({
        id: symbol.id,
        needsGroup: selection.needsGroup,
        ...resolveFormulaOccurrence(
          latex,
          {
            anchor: symbol.latex,
            anchorOccurrence: selection.occurrence,
          },
          sourceBoundaries
        ),
      }))
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let cursor = 0;
  let formula = '';
  for (const range of ranges) {
    if (range.start < cursor)
      throw new Error('Source formula fragments must not overlap.', {
        cause: { range, previousEnd: cursor },
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
    symbols: draft.symbols.map(({ sourceOccurrences: _occurrences, ...symbol }) => symbol),
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

/** Bind exact source fragments to exact heard words without asking the model to re-author math. */
export async function generateSourceBoundFormula(
  input: FormulaPreparationInput
): Promise<LessonSceneOutcome> {
  const template = input.source.template;
  if (template) {
    const ids = template.symbols.map(symbol => symbol.id);
    const schema = z.object({
      mentioned: input.source.dictatedRanges?.length ? z.literal(true) : z.boolean(),
      links: z.array(z.object({ id: z.enum(ids), ...voiceShape })),
    });
    const { parsed, response } = await requestFormulaDraft(
      schema,
      input,
      'The existingTemplate formula and symbol definitions are fixed. Return links only by their existing IDs. Omit unmentioned IDs. Use additionalAnchors for repeated mentions; never duplicate a link ID. Choose mentioned:false and links:[] when no part is named.'
    );
    if (!parsed.success)
      return invalidFormulaDraft(['Follow the formula-link response schema.'], response);
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
        anchor: '',
        anchorOccurrence: undefined,
        additionalAnchors: [],
        ...links.get(symbol.id),
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
    'If mentioned:false, return symbols:[] with a short title and summary. Otherwise define every mathematical identifier, including unmentioned ones. latex is an EXACT, independently renderable substring of AUTHORED TEX, not reformatted TeX. sourceOccurrences lists {occurrence,needsGroup}: the zero-based exact fragment occurrence in AUTHORED TEX, counting only matches that do not split a TeX control word or escaped control symbol; letters inside command names are not occurrences and whether the inserted reference needs a brace group because it is an unbraced TeX argument (for example the 0 in _0 or an unbraced function argument). Set needsGroup:true exactly for those arguments; otherwise false. The application adds only that paired group around the reference. Source fragments must not overlap. Do not return a rewritten formula. Keep base and index separately targetable when narration distinguishes them. Different positions may use separate IDs and sourceOccurrences; Use multiple distinct sourceOccurrences only when the same part appears at several source positions. The application inserts the references and preserves all other source characters.'
  );
  if (!parsed.success)
    return invalidFormulaDraft(['Follow the source-fragment response schema.'], response);
  if (!parsed.data.mentioned && parsed.data.symbols.length)
    return invalidFormulaDraft(
      ['A static decision must return symbols:[] rather than discard supplied links.'],
      parsed.data
    );
  try {
    const scene = sourceFormulaScene(input.source, parsed.data);
    return validatePreparedFormula(input, scene, parsed.data.mentioned, parsed.data);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return invalidFormulaDraft(
      ['Select exact, nonoverlapping, complete source fragments.'],
      parsed.data,
      error
    );
  }
}
