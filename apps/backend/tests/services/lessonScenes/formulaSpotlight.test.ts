import { findLessonSceneProblems } from '@shared/lessonScene';
import { expect, test } from 'vitest';
import { FORMULA_SPOTLIGHT_SPEECH, formulaSpotlight } from '../../helpers/formulaSpotlight';

test('accepts a complete formula with named symbols and exact spoken anchors', () => {
  expect(findLessonSceneProblems(formulaSpotlight, FORMULA_SPOTLIGHT_SPEECH)).toEqual([]);
});

import { renderSpotlightFormula } from '@shared/formulaSpotlight';

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
    symbols: [formulaSpotlight.symbols[0]],
    formula:
      '\\frac{\\nousSymbol{probability}^{2}}{1+\\nousSymbol{probability}}+\\begin{pmatrix}\\nousSymbol{probability}_i&0\\end{pmatrix}',
  };
  expect(findLessonSceneProblems(scene, FORMULA_SPOTLIGHT_SPEECH)).toEqual([]);
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
