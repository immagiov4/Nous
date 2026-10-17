import katex from 'katex';
import * as z from 'zod';
import { cueTimes } from './lessonSceneAnimation';

const symbolId = z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/u);
const text = z.string().min(1).regex(/\S/u);
export const FormulaSpotlightDataSchema = z.object({
  formula: text,
  symbols: z
    .array(z.object({ id: symbolId, latex: text, name: text, meaning: text, anchor: text }))
    .min(1),
});
export type FormulaSpotlightData = Readonly<z.infer<typeof FormulaSpotlightDataSchema>>;

/** Explicit symbol references keep binding independent of glyph/substring guessing. */
function compileFormula(scene: FormulaSpotlightData, highlighted: boolean): string {
  const used = new Set<string>();
  const symbols = new Map(scene.symbols.map(symbol => [symbol.id, symbol]));
  if (symbols.size !== scene.symbols.length) throw new Error('Formula symbol ids must be unique.');
  const latex = scene.formula.replaceAll(
    /\\nousSymbol\{([A-Za-z][A-Za-z0-9]*)\}/gu,
    (_, id: string) => {
      const symbol = symbols.get(id);
      if (!symbol) throw new Error('A formula reference names an unknown symbol.');
      used.add(id);
      return highlighted
        ? String.raw`\htmlClass{nous-formula-symbol-${id}}{${symbol.latex}}`
        : `{${symbol.latex}}`;
    }
  );
  if (used.size !== symbols.size)
    throw new Error('Every defined symbol must occur in the formula.');
  return latex;
}

/** Validate plain math before adding renderer-owned classes; model HTML/URLs stay untrusted. */
export function renderSpotlightFormula(scene: FormulaSpotlightData): string {
  let requestedTrust = false;
  katex.renderToString(compileFormula(scene, false), {
    throwOnError: true,
    trust: () => {
      requestedTrust = true;
      return false;
    },
  });
  if (requestedTrust) throw new Error('Formula content must contain math only.');
  const classes = new Set(scene.symbols.map(symbol => `nous-formula-symbol-${symbol.id}`));
  const html = katex.renderToString(compileFormula(scene, true), {
    displayMode: true,
    throwOnError: true,
    strict: false,
    // KaTeX's htmlClass is the only trust context carrying a class property.
    trust: context => 'class' in context && classes.has(context.class),
  });
  if (
    [...classes].some(
      name => !new RegExp(String.raw`class="[^"\n]*\b${name}(?: |")`, 'u').test(html)
    )
  ) {
    throw new Error('Every symbol must render a highlight target.');
  }
  return html;
}

/** A legend symbol must render independently from definitions in the complete formula. */
export const renderSpotlightSymbol = (latex: string): string =>
  katex.renderToString(latex, { throwOnError: true, trust: false });

export function findFormulaSpotlightProblems(value: unknown, source?: string): string[] {
  const parsed = FormulaSpotlightDataSchema.safeParse(value);
  if (!parsed.success)
    return ['A formula spotlight needs a formula and named, explained, anchored symbols.'];
  const problems: string[] = [];
  try {
    renderSpotlightFormula(parsed.data);
    for (const symbol of parsed.data.symbols) renderSpotlightSymbol(symbol.latex);
  } catch {
    problems.push('The formula must be valid math with unique, complete symbol references.');
  }
  if (
    new Set(parsed.data.symbols.map(symbol => symbol.anchor)).size !== parsed.data.symbols.length
  ) {
    problems.push('Every formula symbol needs its own distinct narration anchor.');
  }
  if (source !== undefined) {
    try {
      cueTimes(source, parsed.data.symbols);
    } catch {
      problems.push('Formula symbol anchors must be exact, unique and ordered in the narration.');
    }
  }
  return problems;
}
