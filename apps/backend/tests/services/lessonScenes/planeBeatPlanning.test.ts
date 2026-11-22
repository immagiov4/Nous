import { checkAlgorithmGeometry } from '@shared/lessonStudios/algorithmLayout';
import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import { assert, expect, test } from 'vitest';
import { checkStudioOperands } from '../../../src/services/lessonScenes/lessonStudioSelection';
import { planStudioScene } from '../../../src/services/lessonScenes/studioBeatPlanning';

function planeDraft(spec: object, citations: [string, string][], example = false) {
  return {
    type: 'geometry',
    ...(example && { inputMode: 'example' }),
    geometryStudio: { id: 'plane', spec },
    operandSources: citations.map(([field, quote]) => ({
      field: `geometryStudio.spec.${field}`,
      quote,
    })),
  };
}

test('a grounded secant keeps the stated point and approaches the polynomial tangent', () => {
  const passage = 'Per y = x² esaminiamo la derivata nel punto x = 1. La secante diventa tangente.';
  const draft = planeDraft({ form: 'derivative', coefficients: [1, 0, 0], point: 1 }, [
    ['coefficients', 'y = x²'],
    ['point', 'x = 1'],
  ]);
  const scene = planStudioScene(draft);
  assert(scene?.type === 'geometry' && scene.geometryStudio.id === 'plane');
  expect(checkStudioOperands(scene, draft, [], passage, true).rejectedField).toBeUndefined();
  expect(scene.geometryStudio.spec.layers).toContainEqual({
    id: 'secant',
    type: 'tangent',
    of: 'curve',
    x: 1,
    h: 'h',
  });
  const increments = scene.geometryStudio.spec.beats.flatMap(beat => beat.set?.h ?? []);
  expect(increments.at(-1)).toBe(0);
  expect(increments).toEqual([...increments].sort((a, b) => b - a));
  expect(scene.studioCues.at(-1)?.anchor).toMatch(/pendenza 2\b/u);
  expect(
    checkAlgorithmGeometry(scene, readerStudioViewports.desktop, { requireBeatSync: true })
  ).toEqual([]);
});

test('two sourced linear equations are drawn together before the common point is shown', () => {
  const passage = 'Il sistema è y = 2x − 1 e y = −x + 5.';
  const spec = {
    form: 'linear-intersection',
    lines: [
      { m: 2, b: -1 },
      { m: -1, b: 5 },
    ],
  };
  const draft = planeDraft(spec, [
    ['lines.0', 'y = 2x − 1'],
    ['lines.1', 'y = −x + 5'],
  ]);
  const scene = planStudioScene(draft);
  assert(scene?.type === 'geometry' && scene.geometryStudio.id === 'plane');
  expect(checkStudioOperands(scene, draft, [], passage, true).rejectedField).toBeUndefined();
  expect(scene.geometryStudio.spec.beats.map(beat => beat.show)).toEqual([
    ['first'],
    ['first', 'second'],
    ['first', 'second', 'crossing'],
  ]);
  expect(scene.studioCues.at(-1)?.anchor).toMatch(/2.*3/u);
  expect(
    checkAlgorithmGeometry(scene, readerStudioViewports.desktop, { requireBeatSync: true })
  ).toEqual([]);
});

test('break-even uses each stated price to compute its own crossing', () => {
  const draft = planeDraft(
    { form: 'break-even', fixedCost: 20000, unitCost: 6, prices: [10, 12] },
    []
  );
  const scene = planStudioScene(draft);
  assert(scene?.type === 'geometry' && scene.geometryStudio.id === 'plane');
  expect(scene.geometryStudio.spec.beats.flatMap(beat => beat.set?.change ?? [])).toEqual([12]);
  const crossings = scene.studioCues.filter(cue => cue.targets?.includes('crossing'));
  expect(crossings).toHaveLength(2);
  expect(crossings[0].anchor.replaceAll(/\s|\./gu, '')).toContain('5000');
  expect(crossings[1].anchor.replaceAll(/\s|\./gu, '')).toContain('3333');
});

test('compound and simple interest use the same initial capital and yearly rate', () => {
  const draft = planeDraft(
    { form: 'compound-interest', principal: 1000, ratePercent: 5, years: 20 },
    []
  );
  const scene = planStudioScene(draft);
  assert(scene?.type === 'geometry' && scene.geometryStudio.id === 'plane');
  const { layers, beats } = scene.geometryStudio.spec;
  const finalPoints = layers.flatMap(layer =>
    layer.type === 'point' && beats.at(-1)?.focus.includes(layer.id) ? [layer.at] : []
  );
  expect(finalPoints).toEqual([
    [20, 2000],
    [20, expect.closeTo(2653.3, 2)],
  ]);
  expect(scene.studioCues.at(-1)?.anchor).toMatch(/2[.\s]?653,30? euro/u);
  expect(
    checkAlgorithmGeometry(scene, readerStudioViewports.desktop, { requireBeatSync: true })
  ).toEqual([]);
});

test('a qualitative market lesson can introduce an illustrative equilibrium and a second crossing', () => {
  const draft = planeDraft(
    { form: 'market-equilibrium' },
    [['form', 'prezzo di equilibrio']],
    true
  );
  const scene = planStudioScene(draft);
  assert(scene?.type === 'geometry' && scene.geometryStudio.id === 'plane');
  expect(scene.studioCues[0].anchor).toMatch(/^Per esempio/u);
  expect(scene.studioCues.filter(cue => cue.targets?.includes('crossing'))).toHaveLength(2);
});
