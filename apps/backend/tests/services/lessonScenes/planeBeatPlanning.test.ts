import { checkAlgorithmGeometry } from '@shared/lessonStudios/algorithmLayout';
import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import { assert, expect, test } from 'vitest';
import { checkStudioOperands } from '../../../src/services/lessonScenes/lessonStudioSelection';
import { planStudioScene } from '../../../src/services/lessonScenes/studioBeatPlanning';
import { matchesStatedPlaneOperand } from '../../../src/services/lessonScenes/studioOperandGrounding';

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
  const decoy = planeDraft({ form: 'derivative', coefficients: [1, 0, 0], point: 1 }, [
    ['coefficients', '[1, 0, 0]'],
    ['point', 'x = 1'],
  ]);
  expect(
    checkStudioOperands(scene, decoy, [], `${passage} Il codice è [1, 0, 0].`, true).rejectedField
  ).toBe('geometryStudio.spec.coefficients');
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

test('a secant uses an explicit h list and preserves a small nonzero limit in speech', () => {
  const passage =
    'Usiamo y = 0,001x² nel punto x = 1. Gli scarti sono h = [4, 3]. Le pagine sono 4 e 3.';
  const spec = { form: 'derivative', coefficients: [0.001, 0, 0], point: 1, steps: [4, 3] };
  const cited = [
    ['coefficients', 'y = 0,001x²'],
    ['point', 'x = 1'],
  ] satisfies [string, string][];
  const draft = planeDraft(spec, [...cited, ['steps', 'h = [4, 3]']]);
  const scene = planStudioScene(draft);
  assert(scene);
  expect(checkStudioOperands(scene, draft, [], passage, true).rejectedField).toBeUndefined();
  expect(
    checkStudioOperands(scene, planeDraft(spec, [...cited, ['steps', '4 e 3']]), [], passage, true)
      .rejectedField
  ).toBe('geometryStudio.spec.steps');
  expect(scene.studioCues.at(-1)?.anchor).toMatch(/pendenza 0,002\./u);
  expect(
    checkStudioOperands(
      scene,
      planeDraft(spec, [...cited, ['steps', 'h = 2; le pagine sono [4, 3]']]),
      [],
      'Usiamo y = 0,001x² nel punto x = 1. Più avanti h = 2; le pagine sono [4, 3].',
      true
    ).rejectedField
  ).toBe('geometryStudio.spec.steps');
});

test('a derivative cannot use default secants when the passage supplies h values', () => {
  const passage = 'Usiamo y = x² nel punto x = 1. Gli scarti sono h = [4, 3].';
  const spec = { form: 'derivative', coefficients: [1, 0, 0], point: 1 };
  const quotes: [string, string][] = [
    ['coefficients', 'y = x²'],
    ['point', 'x = 1'],
  ];
  const missing = planeDraft(spec, quotes);
  const complete = planeDraft({ ...spec, steps: [4, 3] }, [...quotes, ['steps', 'h = [4, 3]']]);
  const missingScene = planStudioScene(missing);
  const completeScene = planStudioScene(complete);
  assert(
    missingScene &&
      completeScene?.type === 'geometry' &&
      completeScene.geometryStudio.id === 'plane'
  );
  expect(checkStudioOperands(missingScene, missing, [], passage, true).rejectedField).toBe(
    'geometryStudio.spec.steps'
  );
  expect(
    checkStudioOperands(completeScene, complete, [], passage, true).rejectedField
  ).toBeUndefined();
  expect(completeScene.geometryStudio.spec.beats.flatMap(beat => beat.set?.h ?? [])).toEqual([
    4, 3, 0,
  ]);
  expect(
    checkStudioOperands(completeScene, complete, [], `${passage} Poi usiamo h = 2.`, true)
      .rejectedField
  ).toBe('geometryStudio.spec.steps');
});

test('a secant quotient with h in the denominator does not assign an h step', () => {
  const passage = 'Per y = x² nel punto x = 1, la pendenza è ((1 + h)² − 1)/h = 2 + h.';
  const draft = planeDraft({ form: 'derivative', coefficients: [1, 0, 0], point: 1 }, [
    ['coefficients', 'y = x²'],
    ['point', 'x = 1'],
  ]);
  const scene = planStudioScene(draft);
  assert(scene);
  expect(checkStudioOperands(scene, draft, [], passage, true).rejectedField).toBeUndefined();
});

test('the derivative uses the equation and point stated without ASCII digits', () => {
  const passage = 'Studiamo la derivata di y = x² nel punto x = due.';
  const illustrative = planeDraft({ form: 'derivative' }, [['form', 'derivata']], true);
  const grounded = planeDraft({ form: 'derivative', coefficients: [1, 0, 0], point: 2 }, [
    ['coefficients', 'y = x²'],
    ['point', 'x = due'],
  ]);
  const exampleScene = planStudioScene(illustrative);
  const groundedScene = planStudioScene(grounded);
  assert(exampleScene && groundedScene);
  expect(
    checkStudioOperands(exampleScene, illustrative, [], 'Studiamo la derivata.', true).rejectedField
  ).toBeUndefined();
  expect(checkStudioOperands(exampleScene, illustrative, [], passage, true).rejectedField).toBe(
    'geometryStudio.spec.form'
  );
  expect(
    checkStudioOperands(groundedScene, grounded, [], passage, true).rejectedField
  ).toBeUndefined();
  expect(groundedScene.studioCues.at(-1)?.anchor).toContain('pendenza 4.');
});

test.each([
  'Un sistema lineare con y = x e y = -x.',
  'Un sistema lineare con y = αx e y = −αx.',
  String.raw`Un sistema lineare con \(y=x\) e \(y=-x\).`,
])('an example cannot replace implicit line coefficients in %s', passage => {
  const draft = planeDraft({ form: 'linear-intersection' }, [['form', 'sistema lineare']], true);
  const scene = planStudioScene(draft);
  assert(scene);
  expect(checkStudioOperands(scene, draft, [], passage, true).rejectedField).toBe(
    'geometryStudio.spec.form'
  );
});

test.each([
  [0.1, 1.5, '0,3'],
  [0.00000001, 1, '0,00000002'],
])('the tangent at %s × x² and x = %s uses a readable decimal', (coefficient, point, slope) => {
  const scene = planStudioScene(
    planeDraft({ form: 'derivative', coefficients: [coefficient, 0, 0], point }, [])
  );
  assert(scene);
  expect(scene.studioCues.at(-1)?.anchor).toContain(`pendenza ${slope}.`);
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
  const decoy = planeDraft(spec, [
    ['lines.0', '[2, −1]'],
    ['lines.1', 'y = −x + 5'],
  ]);
  expect(
    checkStudioOperands(scene, decoy, [], `${passage} Coordinate di un altro punto: [2, −1].`, true)
      .rejectedField
  ).toBe('geometryStudio.spec.lines.0');
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
  const passage =
    'I costi fissi sono stimati. Costi fissi di 20.000 euro. Costi variabili di 6 euro a pezzo. Vende ogni pezzo a 10 euro. Il prezzo sale a 12 euro.';
  const draft = planeDraft(
    { form: 'break-even', fixedCost: 20000, unitCost: 6, prices: [10, 12] },
    [
      ['fixedCost', 'Costi fissi di 20.000 euro'],
      ['unitCost', 'Costi variabili di 6 euro a pezzo'],
      ['prices.0', 'Vende ogni pezzo a 10 euro'],
      ['prices.1', 'Il prezzo sale a 12 euro'],
    ]
  );
  const scene = planStudioScene(draft);
  assert(scene?.type === 'geometry' && scene.geometryStudio.id === 'plane');
  expect(checkStudioOperands(scene, draft, [], passage, true).rejectedField).toBeUndefined();
  expect(
    checkStudioOperands(scene, draft, [], passage.replace('20.000', '30.000'), true).rejectedField
  ).toBe('geometryStudio.spec.fixedCost');
  expect(scene.geometryStudio.spec.beats.flatMap(beat => beat.set?.change ?? [])).toEqual([12]);
  const crossings = scene.studioCues.filter(cue => cue.targets?.includes('crossing'));
  expect(crossings).toHaveLength(2);
  expect(crossings[0].anchor.replaceAll(/\s|\./gu, '')).toContain('5000');
  expect(crossings[1].anchor.replaceAll(/\s|\./gu, '')).toContain('3333');
  const base = { form: 'break-even', fixedCost: 20000, unitCost: 6 };
  const quotes = [
    ['fixedCost', 'Costi fissi di 20.000 euro'],
    ['unitCost', 'Costi variabili di 6 euro a pezzo'],
  ] satisfies [string, string][];
  for (const prices of [[10], [12, 10]]) {
    const changed = planeDraft({ ...base, prices }, [
      ...quotes,
      ...prices.map((price, index): [string, string] => [
        `prices.${index}`,
        price === 10 ? 'Vende ogni pezzo a 10 euro' : 'Il prezzo sale a 12 euro',
      ]),
    ]);
    const candidate = planStudioScene(changed);
    assert(candidate);
    expect(checkStudioOperands(candidate, changed, [], passage, true).rejectedField).toBe(
      'geometryStudio.spec.prices'
    );
  }
});

test('break-even requires an affirmative price stated as “il prezzo è di”', () => {
  const costs = 'Costi fissi di 20.000 euro. Costi variabili di 6 euro a pezzo.';
  const sale = 'Vende ogni pezzo a 10 euro';
  const price = 'Il prezzo è di 12 euro';
  const base = { form: 'break-even', fixedCost: 20000, unitCost: 6 };
  const citations: [string, string][] = [
    ['fixedCost', 'Costi fissi di 20.000 euro'],
    ['unitCost', 'Costi variabili di 6 euro a pezzo'],
    ['prices.0', sale],
  ];
  const draft = planeDraft({ ...base, prices: [10] }, citations);
  const twoPrices = planeDraft({ ...base, prices: [10, 12] }, [...citations, ['prices.1', price]]);
  const scene = planStudioScene(draft);
  const twoPriceScene = planStudioScene(twoPrices);
  assert(scene && twoPriceScene);
  const passage = `${costs} ${sale}. ${price}.`;
  expect(
    checkStudioOperands(twoPriceScene, twoPrices, [], passage, true).rejectedField
  ).toBeUndefined();
  expect(checkStudioOperands(scene, draft, [], passage, true).rejectedField).toBe(
    'geometryStudio.spec.prices'
  );
  expect(
    checkStudioOperands(
      scene,
      draft,
      [],
      `${costs} Non usiamo il prezzo di 12 euro. ${sale}.`,
      true
    ).rejectedField
  ).toBeUndefined();
});

test('an illustrative break-even scene cannot replace a stated price in words', () => {
  const draft = planeDraft({ form: 'break-even' }, [['form', 'punto di pareggio']], true);
  const scene = planStudioScene(draft);
  assert(scene);
  expect(
    checkStudioOperands(scene, draft, [], 'Spieghiamo il punto di pareggio.', true).rejectedField
  ).toBeUndefined();
  expect(
    checkStudioOperands(
      scene,
      draft,
      [],
      'Spieghiamo il punto di pareggio. Il prezzo è di dieci euro.',
      true
    ).rejectedField
  ).toBe('geometryStudio.spec.form');
});

test('break-even rejects a batch cost unless the citation identifies a rate per unit', () => {
  const fixed = 'Costi fissi di 20.000 euro';
  const sale = 'Vende ogni pezzo a 800 euro';
  const spec = { form: 'break-even', fixedCost: 20000, unitCost: 600, prices: [800] };
  for (const [cost, accepted] of [
    ['Costi variabili di 600 euro per il lotto', false],
    ['Costi variabili di 600 euro per unità', true],
    ['Costi variabili di 600 euro per ogni pezzo', true],
    ['Costi variabili di 600 euro a pezzo', true],
    ['Costi variabili di 600 €/unità', true],
    ['Costi variabili di 600 euro ciascuno', true],
  ] as const) {
    const draft = planeDraft(spec, [
      ['fixedCost', fixed],
      ['unitCost', cost],
      ['prices.0', sale],
    ]);
    const scene = planStudioScene(draft);
    assert(scene);
    expect(
      checkStudioOperands(scene, draft, [], `${fixed}. ${cost}. ${sale}.`, true).rejectedField,
      cost
    ).toBe(accepted ? undefined : 'geometryStudio.spec.unitCost');
  }
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

const capital = 'Capitale iniziale di 1000 euro, con tasso annuo del 12%';

test.each([
  ['point', 12, 'x = 12', 'y = 12'],
  ['fixedCost', 600, 'Costi fissi di 600 euro', 'Costi di spedizione di 600 euro'],
  [
    'unitCost',
    600,
    'Costi variabili di 600 euro a pezzo',
    'Costi variabili di 600 euro per il lotto',
  ],
  ['price', 800, 'Il prezzo è di 800 euro', 'Il guadagno è di 800 euro'],
  ['principal', 1000, 'Capitale iniziale di 1000 euro', 'La commissione è di 1000 euro al 12%'],
  ['ratePercent', 12, 'Tasso annuo del 12%', 'Commissione del 12%'],
  ['years', 10, 'Dopo 10 anni', 'Una persona di 10 anni'],
  [
    'demandIncrease',
    20,
    'L’intercetta della domanda aumenta di 20 euro',
    'L’offerta aumenta di 20 euro',
  ],
] as const)('a %s citation names its role even when a decoy has the same number', (role, value, stated, decoy) => {
  expect(matchesStatedPlaneOperand(decoy, role, value)).toBe(false);
  expect(matchesStatedPlaneOperand(stated, role, value)).toBe(true);
});

function compoundDraft(
  years: number,
  duration = years === 1 ? 'dopo 1 anno' : `dopo ${years} anni`
) {
  return planeDraft({ form: 'compound-interest', principal: 1000, ratePercent: 12, years }, [
    ['principal', 'Capitale iniziale di 1000 euro'],
    ['ratePercent', 'tasso annuo del 12%'],
    ['years', duration],
  ]);
}

test('annual interest rejects explicitly subannual compounding', () => {
  const draft = compoundDraft(1);
  const scene = planStudioScene(draft);
  assert(scene);
  for (const frequency of ['mensile', 'trimestrale', 'giornaliera', 'due volte l’anno']) {
    const passage = `${capital} con capitalizzazione ${frequency}. Confrontiamo dopo 1 anno.`;
    expect(checkStudioOperands(scene, draft, [], passage, true).rejectedField, frequency).toBe(
      'geometryStudio.spec.compoundingFrequency'
    );
  }
  expect(
    checkStudioOperands(
      scene,
      draft,
      [],
      `${capital} con capitalizzazione annuale. Confrontiamo dopo 1 anno.`,
      true
    ).rejectedField
  ).toBeUndefined();
});

test('compound interest uses the final duration only when the source orders the comparisons', () => {
  const ordered = `${capital}. Confrontiamo dopo 5 anni e poi dopo 10 anni.`;
  const ambiguous = `${capital}. Confrontiamo dopo 5 anni oppure dopo 10 anni.`;
  const earlier = compoundDraft(5);
  const final = compoundDraft(10);
  const finalWithSharedPreposition = compoundDraft(10, 'poi 10 anni');
  const earlierScene = planStudioScene(earlier);
  const finalScene = planStudioScene(final);
  assert(earlierScene && finalScene);
  expect(checkStudioOperands(earlierScene, earlier, [], ordered, true).rejectedField).toBe(
    'geometryStudio.spec.years'
  );
  expect(checkStudioOperands(finalScene, final, [], ordered, true).rejectedField).toBeUndefined();
  expect(checkStudioOperands(finalScene, final, [], ambiguous, true).rejectedField).toBe(
    'geometryStudio.spec.years'
  );
  expect(
    checkStudioOperands(
      finalScene,
      finalWithSharedPreposition,
      [],
      `${capital}. Confrontiamo dopo 5 anni e poi 10 anni.`,
      true
    ).rejectedField
  ).toBeUndefined();
  expect(
    checkStudioOperands(
      finalScene,
      compoundDraft(10, '10 anni'),
      [],
      `${capital}. Confrontiamo dopo 5 o 10 anni.`,
      true
    ).rejectedField
  ).toBe('geometryStudio.spec.years');
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

test('an example never replaces capital, rate or duration written in words', () => {
  const draft = planeDraft({ form: 'compound-interest' }, [['form', 'interesse composto']], true);
  const scene = planStudioScene(draft);
  assert(scene);
  expect(
    checkStudioOperands(scene, draft, [], 'Spieghiamo come funziona l’interesse composto.', true)
      .rejectedField
  ).toBeUndefined();
  expect(
    checkStudioOperands(
      scene,
      draft,
      [],
      'Calcoliamo l’interesse composto su mille euro, al cinque per cento, per dieci anni.',
      true
    ).rejectedField
  ).toBe('geometryStudio.spec.form');
});

test('a market example uses the supplied quantity and price equations when they are stated', () => {
  const draft = planeDraft(
    {
      form: 'market-equilibrium',
      lines: [
        { m: -1, b: 10 },
        { m: 1, b: 2 },
      ],
    },
    [
      ['lines.0', 'La domanda è P = 10 − Q'],
      ['lines.1', 'L’offerta è P = Q + 2'],
    ]
  );
  const scene = planStudioScene(draft);
  assert(scene);
  const passage = 'La domanda è P = 10 − Q. L’offerta è P = Q + 2.';
  expect(checkStudioOperands(scene, draft, [], passage, true).rejectedField).toBeUndefined();
  expect(scene.studioCues.at(-1)?.anchor).toMatch(/quantità 4 e al prezzo 6/u);
});

test('a small nonzero intersection is spoken as a nonzero value', () => {
  const draft = planeDraft(
    {
      form: 'linear-intersection',
      lines: [
        { m: 1, b: 0 },
        { m: 0, b: 0.001 },
      ],
    },
    []
  );
  const scene = planStudioScene(draft);
  assert(scene);
  expect(scene.studioCues.at(-1)?.anchor).toContain('ascissa 0,001 e ordinata 0,001');
});

test('market equilibrium requires each cited equation to name its own market role', () => {
  const spec = {
    form: 'market-equilibrium',
    lines: [
      { m: -1, b: 10 },
      { m: 1, b: 2 },
    ],
  };
  const swapped = 'L’offerta è P = 10 − Q. La domanda è P = Q + 2.';
  const bare = planeDraft(spec, [
    ['lines.0', 'P = 10 − Q'],
    ['lines.1', 'P = Q + 2'],
  ]);
  const misleading = planeDraft(spec, [
    ['lines.0', 'L’offerta è P = 10 − Q'],
    ['lines.1', 'La domanda è P = Q + 2'],
  ]);
  const scene = planStudioScene(bare);
  assert(scene);
  for (const draft of [bare, misleading]) {
    expect(checkStudioOperands(scene, draft, [], swapped, true).rejectedField).toBe(
      'geometryStudio.spec.lines.0'
    );
  }
});

test.each([
  [
    'La capacità di produzione è 20 pezzi. L’intercetta della domanda aumenta di 20 euro.',
    'L’intercetta della domanda aumenta di 20 euro',
    true,
  ],
  ['La capacità di produzione è 20 pezzi. La domanda aumenta di 20.', '20 pezzi', false],
  ['L’offerta cresce di 20 unità.', '20', false],
  ['Non è vero che la domanda aumenta di 20.', 'la domanda aumenta di 20', false],
  ['La domanda aumenta di 20 unità.', 'La domanda aumenta di 20 unità', false],
  ['La domanda aumenta di 20 unità.', undefined, false],
  ['Domanda: +20 unità.', '+20 unità', false],
  ['Offerta: +20 unità.', '+20 unità', false],
] as const)('a market shift must cite the increase in “%s”', (claim, quote, accepted) => {
  const lines = 'La domanda è P = 100 − Q. L’offerta è P = Q + 5.';
  const spec = {
    form: 'market-equilibrium',
    lines: [
      { m: -1, b: 100 },
      { m: 1, b: 5 },
    ],
    ...(quote && { demandIncrease: 20 }),
  };
  const draft = planeDraft(spec, [
    ['lines.0', 'La domanda è P = 100 − Q'],
    ['lines.1', 'L’offerta è P = Q + 5'],
    ...(quote ? [['demandIncrease', quote] as [string, string]] : []),
  ]);
  const scene = planStudioScene(draft);
  assert(scene);
  expect(checkStudioOperands(scene, draft, [], `${lines} ${claim}`, true).rejectedField).toBe(
    accepted ? undefined : 'geometryStudio.spec.demandIncrease'
  );
});
