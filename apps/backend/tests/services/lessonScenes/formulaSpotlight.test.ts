import { findLessonSceneProblems } from '@shared/lessonScene';
import { JSDOM } from 'jsdom';
import { expect, test } from 'vitest';
import { FORMULA_SPOTLIGHT_SPEECH, formulaSpotlight } from '../../helpers/formulaSpotlight';

test('accepts a complete formula with named symbols and exact spoken anchors', () => {
  expect(findLessonSceneProblems(formulaSpotlight, FORMULA_SPOTLIGHT_SPEECH)).toEqual([]);
});

import {
  renderSpotlightFormula,
  renderSpotlightSymbol,
  resolveFormulaReferences,
} from '@shared/formulaSpotlight';

test('binds repeated spoken names to explicit ordered occurrences without guessing', () => {
  const scene = {
    ...formulaSpotlight,
    formula: String.raw`\nousSymbol{first}+\nousSymbol{second}`,
    symbols: [0, 1].map((anchorOccurrence, index) => ({
      id: index ? 'second' : 'first',
      latex: 'x',
      name: 'Ics',
      meaning: 'Valore',
      anchor: 'ics',
      anchorOccurrence,
    })),
  };
  expect(findLessonSceneProblems(scene, 'ics più ics')).toEqual([]);
  expect(resolveFormulaReferences(scene, 'ics più ics')).toEqual([
    { index: 0, anchor: 'ics', start: 0, end: 3 },
    { index: 1, anchor: 'ics', start: 8, end: 11 },
  ]);
  expect(() =>
    resolveFormulaReferences(
      {
        ...scene,
        symbols: scene.symbols.map(symbol => ({ ...symbol, anchorOccurrence: undefined })),
      },
      'ics più ics'
    )
  ).toThrow();
  expect(
    resolveFormulaReferences({ ...scene, symbols: [...scene.symbols].reverse() }, 'ics più ics')
  ).toEqual([
    { index: 1, anchor: 'ics', start: 0, end: 3 },
    { index: 0, anchor: 'ics', start: 8, end: 11 },
  ]);
  expect(() =>
    resolveFormulaReferences(
      { ...scene, symbols: [{ ...scene.symbols[0], anchorOccurrence: 2 }] },
      'ics più ics'
    )
  ).toThrow();
});

test.each([
  { formula: '\\nousSymbol{missing}' },
  { formula: '\\frac{' },
  { formula: '\\href{https://example.com}{\\nousSymbol{probability}}' },
  { formula: `\\def\\discard#1{}\\discard{${formulaSpotlight.formula}}` },
  { symbols: [...formulaSpotlight.symbols, formulaSpotlight.symbols[0]] },
  {
    symbols: formulaSpotlight.symbols.map((symbol, index) =>
      index ? symbol : { ...symbol, meaning: '' }
    ),
  },
  {
    symbols: formulaSpotlight.symbols.map((symbol, index) =>
      index ? symbol : { ...symbol, anchor: 'invented words' }
    ),
  },
  { symbols: [...formulaSpotlight.symbols].reverse() },
  { items: [{ label: 'Extra content', detail: '', icon: '' }] },
])('rejects invalid or ungrounded spotlight content: %o', patch => {
  expect(
    findLessonSceneProblems({ ...formulaSpotlight, ...patch }, FORMULA_SPOTLIGHT_SPEECH).length
  ).toBeGreaterThan(0);
});

test('repeated formula references keep explicit targets in fractions, scripts and matrices', () => {
  const scene = {
    ...formulaSpotlight,
    symbols: [
      { ...formulaSpotlight.symbols[0], anchor: 'La probabilità p' },
      { id: 'i', latex: 'i', name: 'Indice', meaning: 'Indice di riga', anchor: 'L’indice i' },
    ],
    formula:
      '\\frac{\\nousSymbol{probability}^{2}}{1+\\nousSymbol{probability}}+\\begin{pmatrix}\\nousSymbol{probability}_{\\nousSymbol{i}}&0\\end{pmatrix}',
  };
  expect(findLessonSceneProblems(scene, 'La probabilità p. L’indice i.')).toEqual([]);
  expect(
    renderSpotlightFormula(scene).match(/class="enclosing nous-formula-symbol-probability"/g)
  ).toHaveLength(3);
});

test.each([
  {
    ...formulaSpotlight,
    symbols: formulaSpotlight.symbols.map((symbol, index) =>
      index === 1 ? { ...symbol, anchor: formulaSpotlight.symbols[0].anchor } : symbol
    ),
  },
  {
    ...formulaSpotlight,
    formula: '\\def\\localSymbol{p}\\nousSymbol{probability}',
    symbols: [{ ...formulaSpotlight.symbols[0], latex: '\\localSymbol' }],
  },
])('rejects scenes whose symbol cannot be narrated or rendered independently', scene => {
  expect(findLessonSceneProblems(scene, FORMULA_SPOTLIGHT_SPEECH).length).toBeGreaterThan(0);
});

const boundVariable = {
  ...formulaSpotlight,
  formula: String.raw`\nousSymbol{x}`,
  symbols: [
    {
      id: 'x',
      latex: 'x',
      name: 'Variabile',
      meaning: 'Valore della variabile',
      anchor: 'Il simbolo x',
    },
  ],
};

test.each([
  String.raw`\nousSymbol{x}+x`,
  String.raw`\nousSymbol{x}+y`,
  String.raw`\nousSymbol{x}+\beta`,
  String.raw`\nousSymbol{x}+\mathrm{x}`,
  String.raw`\def\raw{x}\nousSymbol{x}+\raw`,
])('rejects an unwrapped mathematical identifier in the rendered formula: %s', formula => {
  expect(findLessonSceneProblems({ ...boundVariable, formula }, 'Il simbolo x.')).not.toEqual([]);
});

test.each([
  String.raw`\nousSymbol{x}\tag{1}`,
  String.raw`\begin{equation}\nousSymbol{x}\end{equation}`,
])('accepts display-only notation in the same mode as the displayed formula: %s', formula => {
  expect(findLessonSceneProblems({ ...boundVariable, formula }, 'Il simbolo x.')).toEqual([]);
  expect(renderSpotlightFormula({ ...boundVariable, formula })).toContain('katex-display');
});

test('rejects a repeated unwrapped operator that has its own symbol definition', () => {
  const scene = {
    ...boundVariable,
    formula: String.raw`\nousSymbol{x}\nousSymbol{bar}\nousSymbol{x}\mid\nousSymbol{x}`,
    symbols: [
      ...boundVariable.symbols,
      {
        id: 'bar',
        latex: String.raw`\mid`,
        name: 'Condizione',
        meaning: 'Dato',
        anchor: 'La barra',
      },
    ],
  };
  expect(findLessonSceneProblems(scene, 'Il simbolo x. La barra.')).not.toEqual([]);
});

test('clamps extreme explicit dimensions consistently in the formula and its legend', () => {
  const rule = (size: number) => String.raw`\rule{${size}em}{${size}em}`;
  const renderedDimensions = (html: string) => {
    const dom = new JSDOM(html);
    try {
      const formula = dom.window.document.querySelector('.katex-html');
      if (!formula) throw new Error('KaTeX must produce visible formula markup.');
      // The hidden source annotation intentionally retains the authored, unclamped TeX.
      return formula.outerHTML;
    } finally {
      dom.window.close();
    }
  };
  const formula = (size: number) =>
    renderedDimensions(
      renderSpotlightFormula({
        ...boundVariable,
        formula: String.raw`\nousSymbol{x}` + rule(size),
      })
    );
  const legend = (size: number) => renderedDimensions(renderSpotlightSymbol(rule(size)));
  expect(formula(1_000_000)).toBe(formula(1_000_000_000));
  expect(legend(1_000_000)).toBe(legend(1_000_000_000));
  expect(legend(1)).not.toBe(legend(1_000_000));
});

test('keeps an unmentioned formula subscript visible without inventing a spoken reference', () => {
  const scene = {
    ...formulaSpotlight,
    symbols: formulaSpotlight.symbols.map(symbol =>
      symbol.id === 'theta' ? { ...symbol, anchor: '' } : symbol
    ),
  };
  expect(findLessonSceneProblems(scene, FORMULA_SPOTLIGHT_SPEECH)).toEqual([]);
  expect(renderSpotlightFormula(scene)).toContain('nous-formula-symbol-theta');
});

import { formulaSpotlightCovers } from '@shared/formulaSpotlight';

test('checks complete formula structure including base, subscript, exponent and operators', () => {
  const scene = {
    ...boundVariable,
    formula: String.raw`\nousSymbol{x}_{\nousSymbol{i}}`,
    symbols: [
      boundVariable.symbols[0],
      { id: 'i', latex: 'i', name: 'Indice', meaning: 'Indice', anchor: '' },
    ],
  };
  expect(formulaSpotlightCovers(scene, ['$x_i$'])).toBe(true);
  expect(formulaSpotlightCovers(scene, ['$x^i$'])).toBe(false);
  expect(formulaSpotlightCovers(scene, ['$x_i+y$'])).toBe(false);
  expect(formulaSpotlightCovers(scene, ['$x_i$', '$y$'])).toBe(false);
});

test('rejects changes to vector notation and fraction-bar attributes', () => {
  expect(formulaSpotlightCovers(boundVariable, [String.raw`$\mathbf{x}$`])).toBe(false);
  const fraction = {
    ...boundVariable,
    formula: String.raw`\genfrac{}{}{0pt}{}{\nousSymbol{x}}{2}`,
  };
  expect(formulaSpotlightCovers(fraction, [String.raw`$\frac{x}{2}$`])).toBe(false);
});

test('resolves repeated references to the same rendered symbol without duplicating its glyph', () => {
  const scene = {
    ...formulaSpotlight,
    formula: String.raw`\nousSymbol{x}`,
    symbols: [
      {
        id: 'x',
        latex: 'x',
        name: 'Ics',
        meaning: 'Valore',
        anchor: 'ics',
        anchorOccurrence: 0,
        additionalAnchors: [{ anchor: 'ics', anchorOccurrence: 1 }],
      },
    ],
  };
  expect(resolveFormulaReferences(scene, 'ics poi ics')).toEqual([
    { index: 0, anchor: 'ics', start: 0, end: 3 },
    { index: 0, anchor: 'ics', start: 8, end: 11 },
  ]);
});

test('uses exact speech positions independently of symbol definition order', () => {
  const scene = {
    ...formulaSpotlight,
    formula: String.raw`\nousSymbol{x}+\nousSymbol{y}`,
    symbols: [
      {
        id: 'x',
        latex: 'x',
        name: 'Ics',
        meaning: 'Primo valore',
        anchor: 'ics',
        anchorOccurrence: 0,
      },
      {
        id: 'y',
        latex: 'y',
        name: 'Ipsilon',
        meaning: 'Secondo valore',
        anchor: 'ipsilon',
        anchorOccurrence: 0,
      },
    ],
  };
  const speech = 'ipsilon prima di ics';
  expect(findLessonSceneProblems(scene, speech)).toEqual([]);
  expect(resolveFormulaReferences(scene, speech)).toEqual([
    { index: 1, anchor: 'ipsilon', start: 0, end: 7 },
    { index: 0, anchor: 'ics', start: 17, end: 20 },
  ]);
  expect(() =>
    resolveFormulaReferences(
      { ...scene, symbols: scene.symbols.map(({ anchorOccurrence: _, ...symbol }) => symbol) },
      speech
    )
  ).toThrow();
});
