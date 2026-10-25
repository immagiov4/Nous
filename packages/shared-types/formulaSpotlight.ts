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
    .array(
      z.object({
        id: symbolId,
        latex: text,
        name: text,
        meaning: text,
        anchor: z.string(),
        anchorOccurrence: z.number().int().nonnegative().optional(),
        additionalAnchors: z
          .array(
            z.object({ anchor: text, anchorOccurrence: z.number().int().nonnegative().optional() })
          )
          .optional(),
      })
    )
    .min(1),
});
export type FormulaSpotlightData = Readonly<z.infer<typeof FormulaSpotlightDataSchema>>;

/** A saved formula is animated whenever any part has an explicit narration link. */
export const hasFormulaSpotlightReferences = (scene: FormulaSpotlightData): boolean =>
  scene.symbols.some(symbol => Boolean(symbol.anchor || symbol.additionalAnchors?.length));

/** Explicit symbol references keep binding independent of glyph/substring guessing. */
function compileFormula(
  scene: FormulaSpotlightData,
  renderSymbol: (symbol: FormulaSpotlightData['symbols'][number]) => string
): string {
  const used = new Set<string>();
  const symbols = new Map(scene.symbols.map(symbol => [symbol.id, symbol]));
  if (symbols.size !== scene.symbols.length) throw new Error('Formula symbol ids must be unique.');
  const latex = scene.formula.replaceAll(
    /\\nousSymbol\{([A-Za-z][A-Za-z0-9]*)\}/gu,
    (_, id: string) => {
      const symbol = symbols.get(id);
      if (!symbol) throw new Error('A formula reference names an unknown symbol.');
      used.add(id);
      return renderSymbol(symbol);
    }
  );
  if (used.size !== symbols.size)
    throw new Error('Every defined symbol must occur in the formula.');
  return latex;
}

/** Resolve renderer references to mathematical notation for visual-only preparation. */
export function getFormulaSpotlightLatex(scene: FormulaSpotlightData): string {
  const exported = new Map<string, string>();
  return compileFormula(scene, symbol => {
    const saved = exported.get(symbol.latex);
    if (saved !== undefined) return saved;
    const atoms: string[] = [];
    const visit = (node: MathNode): void => {
      if (node.type !== 'element') return;
      const classes = Array.isArray(node.properties.className) ? node.properties.className : [];
      const atom = classes.find(name => MATH_ATOM_CLASSES.has(String(name)));
      if (atom) atoms.push(String(atom));
      else for (const child of node.children) visit(child);
    };
    visit(renderedMath(renderSpotlightSymbol(symbol.latex)));
    // Ordinary braces change a punctuation atom into an ordinary atom and can merge it into a number.
    const latex =
      atoms.length === 1 && atoms[0] === 'mpunct'
        ? String.raw`\mathpunct{${symbol.latex}}`
        : `{${symbol.latex}}`;
    exported.set(symbol.latex, latex);
    return latex;
  });
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
        throw new Error('Every mathematical symbol occurrence must use its explicit reference.', {
          cause: { unwrappedMath: value },
        });
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

function highlightedFormula(scene: FormulaSpotlightData, output: 'mathml' | 'htmlAndMathml') {
  const classes = new Set(scene.symbols.map(symbol => `nous-formula-symbol-${symbol.id}`));
  const html = katex.renderToString(
    compileFormula(
      scene,
      symbol => String.raw`\htmlClass{nous-formula-symbol-${symbol.id}}{${symbol.latex}}`
    ),
    {
      ...SPOTLIGHT_MATH_OPTIONS,
      displayMode: true,
      strict: false,
      output,
      // KaTeX's htmlClass is the only trust context carrying a class property.
      trust: context => 'class' in context && classes.has(context.class),
    }
  );
  return { html, classes };
}

/** Validate plain math before adding renderer-owned classes; model HTML/URLs stay untrusted. */
export function renderSpotlightFormula(scene: FormulaSpotlightData): string {
  let requestedTrust = false;
  katex.renderToString(
    compileFormula(scene, symbol => `{${symbol.latex}}`),
    {
      ...SPOTLIGHT_MATH_OPTIONS,
      displayMode: true,
      trust: () => {
        requestedTrust = true;
        return false;
      },
    }
  );
  if (requestedTrust) throw new Error('Formula content must contain math only.');
  const { html, classes } = highlightedFormula(scene, 'htmlAndMathml');
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
  const anchored = parsed.data.symbols.filter(symbol => symbol.anchor);
  if (
    new Set(anchored.map(symbol => JSON.stringify([symbol.anchor, symbol.anchorOccurrence])))
      .size !== anchored.length
  ) {
    problems.push('Every formula symbol needs its own distinct narration anchor.');
  }
  if (source !== undefined) {
    try {
      resolveFormulaReferences(parsed.data, source);
    } catch {
      problems.push('Formula symbol anchors must be exact, unique and ordered in the narration.');
    }
  }
  return problems;
}

/** Select a literal occurrence explicitly supplied by formula preparation. */
export function resolveFormulaOccurrence(
  text: string,
  selection: { anchor: string; anchorOccurrence?: number },
  allowedBoundaries?: ReadonlySet<number>
) {
  const matchingOffsets: number[] = [];
  if (selection.anchor) {
    for (
      let start = text.indexOf(selection.anchor);
      start >= 0;
      start = text.indexOf(selection.anchor, start + 1)
    )
      if (
        !allowedBoundaries ||
        (allowedBoundaries.has(start) && allowedBoundaries.has(start + selection.anchor.length))
      )
        matchingOffsets.push(start);
  }
  const start = matchingOffsets[selection.anchorOccurrence ?? 0];
  if (
    start === undefined ||
    (selection.anchorOccurrence === undefined && matchingOffsets.length !== 1)
  )
    throw new Error('Formula anchors must identify exact literal occurrences.', {
      cause: {
        anchor: selection.anchor,
        anchorOccurrence: selection.anchorOccurrence ?? null,
        matchingOffsets,
      },
    });
  return { start, end: start + selection.anchor.length };
}

/** Exact canonical-speech links; an unmentioned element stays visible without emphasis. */
export function resolveFormulaReferences(scene: FormulaSpotlightData, speech: string) {
  const linked = scene.symbols.flatMap((symbol, index) =>
    symbol.anchor ? [{ ...symbol, index }] : []
  );
  const explicitReferences = scene.symbols.some(
    symbol => symbol.anchorOccurrence !== undefined || symbol.additionalAnchors !== undefined
  );
  if (linked.length && !explicitReferences) cueTimes(speech, linked);
  const locate = (symbol: { anchor: string; anchorOccurrence?: number; index: number }) => ({
    index: symbol.index,
    anchor: symbol.anchor,
    ...resolveFormulaOccurrence(speech, symbol),
  });
  const first = linked.map(locate);
  const additional = scene.symbols.flatMap((symbol, index) =>
    (symbol.additionalAnchors ?? []).map(anchor => locate({ ...anchor, index }))
  );
  return [...first, ...additional].sort(
    (left, right) => left.start - right.start || left.index - right.index
  );
}

/** Compare mathematical structure, including scripts, rather than visible glyph strings. */
export function formulaSpotlightCovers(scene: FormulaSpotlightData, formulas: readonly string[]) {
  const structure = (node: MathNode): unknown => {
    if (node.type === 'text') return node.value.trim() || undefined;
    if (node.type !== 'element' || node.tagName === 'annotation') return undefined;
    const children = node.children.map(structure).filter(child => child !== undefined);
    const attributes = Object.fromEntries(
      Object.entries(node.properties)
        .filter(
          ([name]) => !['className', 'style', 'xmlns', 'display', 'lspace', 'rspace'].includes(name)
        )
        .sort(([left], [right]) => left.localeCompare(right))
    );
    if (
      ['span', 'math', 'semantics', 'mrow'].includes(node.tagName) &&
      children.length === 1 &&
      !Object.keys(attributes).length
    )
      return children[0];
    return { tag: node.tagName, attributes, children };
  };
  const parse = (html: string) => {
    const tree = mathMarkup.runSync({
      type: 'root',
      children: [{ type: 'raw', value: html }],
    } as unknown as Parameters<typeof mathMarkup.runSync>[0]);
    return structure(tree.children[0]);
  };
  const contains = (tree: unknown, expected: unknown): boolean => {
    if (JSON.stringify(tree) === JSON.stringify(expected)) return true;
    return (
      typeof tree === 'object' &&
      tree !== null &&
      'children' in tree &&
      Array.isArray(tree.children) &&
      tree.children.some(child => contains(child, expected))
    );
  };
  try {
    const rendered = parse(highlightedFormula(scene, 'mathml').html);
    return formulas.every(formula => {
      const html = katex.renderToString(formulaLatexSource(formula), {
        ...SPOTLIGHT_MATH_OPTIONS,
        displayMode: true,
        output: 'mathml',
        trust: false,
      });
      return contains(rendered, parse(html));
    });
  } catch {
    return false;
  }
}

/** Extract the exact TeX from a delimited source formula, retaining its authored whitespace. */
export function formulaLatexSource(formula: string): string {
  const delimiter =
    formula.startsWith('$$') ||
    formula.startsWith(String.raw`\[`) ||
    formula.startsWith(String.raw`\(`)
      ? 2
      : 1;
  return formula.slice(delimiter, -delimiter);
}
