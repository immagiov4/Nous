import katex from 'katex';
import rehypeRaw from 'rehype-raw';
import { unified } from 'unified';
import * as z from 'zod';
import { cueTimes } from './lessonSceneAnimation';

// Two em preserves every term in the five-symbol card at the 390 px mobile viewport.
const SPOTLIGHT_MATH_OPTIONS = { maxSize: 2, throwOnError: true } as const;

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

// Reuse the app's HTML parser and KaTeX's TeX atom classes, including macro-expanded output.
const mathMarkup = unified().use(rehypeRaw);
type MathNode = ReturnType<typeof mathMarkup.runSync>['children'][number];
type MathElement = Extract<MathNode, { type: 'element' }>;
const MATH_ATOM_CLASSES = new Set([
  'mord',
  'mop',
  'mbin',
  'mrel',
  'mopen',
  'mclose',
  'mpunct',
  'minner',
]);

function findRenderedMath(nodes: readonly MathNode[]): MathElement | undefined {
  for (const node of nodes) {
    if (node.type !== 'element') continue;
    if (
      Array.isArray(node.properties.className) &&
      node.properties.className.includes('katex-html')
    )
      return node;
    const found = findRenderedMath(node.children);
    if (found) return found;
  }
  return undefined;
}

function renderedMath(html: string): MathElement {
  // rehype-raw accepts raw input nodes; its Root signature omits that input extension.
  const tree = mathMarkup.runSync({
    type: 'root',
    children: [{ type: 'raw', value: html }],
  } as unknown as Parameters<typeof mathMarkup.runSync>[0]);
  const math = findRenderedMath(tree.children);
  if (!math) throw new Error('KaTeX must produce a rendered math tree.');
  return math;
}

function mathText(node: MathNode): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(mathText).join('');
  return '';
}

function validateRenderedSymbols(
  scene: FormulaSpotlightData,
  html: string,
  targets: ReadonlySet<string>
): void {
  const symbols = new Set(
    scene.symbols.map(symbol => mathText(renderedMath(renderSpotlightSymbol(symbol.latex))))
  );
  const visit = (node: MathNode, wrapped = false, textMode = false, term = false): void => {
    if (node.type === 'text') {
      const value = node.value.trim();
      // Numeric literals and structural punctuation remain ordinary formula syntax.
      if (
        !wrapped &&
        !textMode &&
        value &&
        (symbols.has(value) || (term && !/^[\p{N}\p{P}\s]+$/u.test(value)))
      ) {
        throw new Error('Every mathematical symbol occurrence must use its explicit reference.');
      }
      return;
    }
    if (node.type !== 'element') return;
    const classes = Array.isArray(node.properties.className) ? node.properties.className : [];
    // KaTeX's vertical-list spacer contains a zero-width layout character, not a math atom.
    if (classes.includes('vlist-s')) return;
    const atom = classes.find(name => MATH_ATOM_CLASSES.has(String(name)));
    for (const child of node.children)
      visit(
        child,
        wrapped || classes.some(name => targets.has(String(name))),
        textMode || classes.includes('text'),
        atom ? atom === 'mord' || atom === 'mop' : term
      );
  };
  visit(renderedMath(html));
}

/** Validate plain math before adding renderer-owned classes; model HTML/URLs stay untrusted. */
export function renderSpotlightFormula(scene: FormulaSpotlightData): string {
  let requestedTrust = false;
  katex.renderToString(compileFormula(scene, false), {
    ...SPOTLIGHT_MATH_OPTIONS,
    displayMode: true,
    trust: () => {
      requestedTrust = true;
      return false;
    },
  });
  if (requestedTrust) throw new Error('Formula content must contain math only.');
  const classes = new Set(scene.symbols.map(symbol => `nous-formula-symbol-${symbol.id}`));
  const html = katex.renderToString(compileFormula(scene, true), {
    ...SPOTLIGHT_MATH_OPTIONS,
    displayMode: true,
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
  validateRenderedSymbols(scene, html, classes);
  return html;
}

/** A legend symbol must render independently from definitions in the complete formula. */
export const renderSpotlightSymbol = (latex: string): string =>
  katex.renderToString(latex, { ...SPOTLIGHT_MATH_OPTIONS, trust: false });

export function findFormulaSpotlightProblems(value: unknown, source?: string): string[] {
  const parsed = FormulaSpotlightDataSchema.safeParse(value);
  if (!parsed.success)
    return ['A formula spotlight needs a formula and named, explained, anchored symbols.'];
  const problems: string[] = [];
  try {
    renderSpotlightFormula(parsed.data);
  } catch {
    problems.push(
      'The formula must be valid display math with unique, complete symbol references and no unwrapped symbol occurrences.'
    );
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
