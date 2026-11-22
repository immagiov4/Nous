import { planeMechanismCopy as copy } from '@shared/lessonStudios/planeMechanism.copy.it';
import type { Layer, Spec } from '@shared/lessonStudios/planeSpec';
import * as z from 'zod';

const method = {
  derivative: z.literal('derivative'),
  intersection: z.literal('linear-intersection'),
  breakEven: z.literal('break-even'),
  market: z.literal('market-equilibrium'),
  growth: z.literal('compound-interest'),
};
const line = z.strictObject({ m: z.number(), b: z.number() });
const lines = z.tuple([line, line]);
const derivative = z.strictObject({
  form: method.derivative,
  coefficients: z.tuple([z.number(), z.number(), z.number()]),
  point: z.number(),
  steps: z.array(z.number()).min(1).optional(),
});
const intersection = z.strictObject({ form: method.intersection, lines });
const breakEven = z.strictObject({
  form: method.breakEven,
  fixedCost: z.number().positive(),
  unitCost: z.number().nonnegative(),
  prices: z.array(z.number().positive()).min(1),
});
const market = z.strictObject({
  form: method.market,
  lines,
  demandIncrease: z.number().positive().optional(),
});
const growth = z.strictObject({
  form: method.growth,
  principal: z.number().positive(),
  ratePercent: z.number().positive(),
  years: z.number().int().positive(),
});
export const PlaneMechanismSchema = z.discriminatedUnion('form', [
  derivative,
  intersection,
  breakEven,
  market,
  growth,
]);
export const PlaneMechanismExampleSchema = z.strictObject({ form: z.union(Object.values(method)) });
export type PlaneMechanism = z.infer<typeof PlaneMechanismSchema>;

export const planeMechanismRule = [
  'For these mechanisms use geometryStudio.id "plane" and spec.form equal to derivative, linear-intersection, break-even, market-equilibrium, or compound-interest. Never write beats or layer data.',
  'derivative: for a quadratic f(x), extract coefficients [a,b,c] from the stated formula, point from its stated x, and steps only if nonzero h values are supplied. Cite coefficients and point. Coefficients implicit in the written equation (such as 1 for x²) are exact. A conceptual explanation with no function, point or data is an example.',
  'linear-intersection: extract lines [{m,b},{m,b}] in lesson order. Cite the complete first and second equations as lines.0 and lines.1. Supply implicit coefficients from the equations.',
  'break-even: extract fixedCost, unitCost (cost per piece) and prices in lesson order. Cite each separately, using prices.0, prices.1, etc. Include later prices when the lesson compares them.',
  'market-equilibrium: lines are demand then supply, as price in terms of quantity. Cite complete equations as lines.0 and lines.1. If quantified, include and cite demandIncrease as the increase in demand intercept. For a qualitative lesson without data use example mode.',
  'compound-interest: extract and cite principal, ratePercent (5 for 5%), and years at the final comparison. This form is for annual compounding. Cite these data, rather than the derived balances.',
  'For cited plane data use fields like geometryStudio.spec.point (prefix geometryStudio.spec. for every field). With no supplied operands, use inputMode "example" and only {form}; cite the mechanism as geometryStudio.spec.form.',
].join('\n');

type Plan = { spec: Spec; beats: { sentence: string; targets: string[] }[] };
type DrawingBeat = Spec['beats'][number] & { sentence: string };
type PlanePlot = Omit<Spec, 'beats' | 'scale'>;

function plannedPlot(plot: PlanePlot, changes: DrawingBeat[]): Plan {
  return {
    spec: { ...plot, scale: 'independent', beats: changes.map(({ sentence: _, ...beat }) => beat) },
    beats: changes.map(({ sentence, focus }) => ({ sentence, targets: focus })),
  };
}

function step(id: string, show: string[], sentence: string, set?: Spec['parameters']): DrawingBeat {
  return { focus: [id], show, sentence, ...(set && { set }) };
}

function paddedBounds(values: number[]): [number, number] {
  const bottom = Math.min(...values);
  const top = Math.max(...values);
  const padding = (top - bottom || Math.max(1, Math.abs(top))) / 10;
  return [bottom - padding, top + padding];
}

/** Uses the lesson's point and explicit secants, then draws the analytical quadratic limit. */
function planDerivative({ coefficients: [a, b, c], point, steps }: z.infer<typeof derivative>) {
  if (a === 0) throw new Error('A quadratic secant needs a nonzero leading coefficient');
  const increments = steps ?? [1, 0.5, 0.25];
  if (increments.some((h, i) => h === 0 || (i > 0 && Math.abs(h) >= Math.abs(increments[i - 1]))))
    throw new Error('Secant increments must approach zero');
  const x = paddedBounds([point, ...increments.map(h => point + h)]);
  const f = (t: number) => (a * t + b) * t + c;
  const vertex = -b / (2 * a);
  const y = paddedBounds([...x.map(f), ...(x[0] < vertex && vertex < x[1] ? [f(vertex)] : [])]);
  const layers: Layer[] = [
    { id: 'curve', type: 'curve', expr: `(${a})*x^2+(${b})*x+(${c})` },
    { id: 'secant', type: 'tangent', of: 'curve', x: point, h: 'h' },
  ];
  const slope = (h: number) => a * (2 * point + h) + b;
  return plannedPlot(
    { title: copy.derivative.title, x, y, layers, parameters: { h: increments[0] } },
    [
      step('curve', ['curve'], copy.derivative.curve(point)),
      ...increments.map(h =>
        step('secant', ['curve', 'secant'], copy.derivative.secant(h, slope(h)), { h })
      ),
      step('secant', ['curve', 'secant'], copy.derivative.tangent(slope(0)), { h: 0 }),
    ]
  );
}

type Line = z.infer<typeof line>;
const first = 'first';
const second = 'second';
const crossing = 'crossing';

function intersectLines([a, b]: [Line, Line]) {
  if (a.m === b.m) throw new Error('The lines must have one intersection');
  const x = (b.b - a.b) / (a.m - b.m);
  return { x, y: a.m * x + a.b };
}

function plotCrossings(input: {
  title: string;
  axes?: readonly [string, string];
  names?: [string, string];
  initial: [Line, Line];
  alternative: Line[];
  vary: 'm' | 'b';
  sentences: [string, string];
  revised: (value: number) => string;
  solution: (x: number, y: number) => string;
}) {
  const [a, b] = input.initial;
  const all = [b, ...input.alternative];
  const points = all.map(line => intersectLines([a, line]));
  const x: [number, number] = paddedBounds([0, ...points.map(point => point.x)]);
  if (input.axes && points.every(point => point.x > 0)) x[0] = 0;
  const y = paddedBounds([a, ...all].flatMap(({ m, b }) => x.map(t => m * t + b)));
  const secondForm = { ...b, [input.vary]: 'change' };
  const layers: Layer[] = [
    { id: first, type: 'line', form: a, name: input.names?.[0] },
    { id: second, type: 'line', form: secondForm, name: input.names?.[1] },
    { id: crossing, type: 'intersection', of: [first, second] },
  ];
  const shown = [first, second];
  const solution = ({ x, y }: { x: number; y: number }) =>
    step(crossing, [...shown, crossing], input.solution(x, y));
  const changes = [
    step(first, [first], input.sentences[0]),
    step(second, shown, input.sentences[1]),
    solution(points[0]),
    ...input.alternative.flatMap((line, index) => [
      step(second, shown, input.revised(line[input.vary]), { change: line[input.vary] }),
      solution(points[index + 1]),
    ]),
  ];
  const axes: Spec['axes'] = input.axes && [...input.axes];
  return plannedPlot(
    { title: input.title, axes, x, y, layers, parameters: { change: b[input.vary] } },
    changes
  );
}

function planIntersection({ lines: [a, b] }: z.infer<typeof intersection>) {
  const text = copy.intersection;
  return plotCrossings({
    title: text.title,
    initial: [a, b],
    alternative: [],
    vary: 'm',
    sentences: [text.line(text.first, a.m, a.b), text.line(text.second, b.m, b.b)],
    revised: () => '',
    solution: text.at,
  });
}

function planBreakEven({ fixedCost, unitCost, prices }: z.infer<typeof breakEven>) {
  if (prices.some(price => price <= unitCost))
    throw new Error('Break-even needs a positive margin');
  const text = copy.breakEven;
  const [price, ...revised] = prices;
  return plotCrossings({
    title: text.title,
    axes: text.axes,
    names: [text.costs, text.revenues],
    initial: [
      { m: unitCost, b: fixedCost },
      { m: price, b: 0 },
    ],
    alternative: revised.map(m => ({ m, b: 0 })),
    vary: 'm',
    sentences: [text.costLine(fixedCost, unitCost), text.revenueLine(price)],
    revised: text.revenueLine,
    solution: text.at,
  });
}

function planMarket({ lines: [demand, supply], demandIncrease }: z.infer<typeof market>) {
  if (demand.m >= 0 || supply.m <= 0 || demand.b <= supply.b)
    throw new Error(
      'Market equilibrium needs a falling demand and rising supply with positive quantity'
    );
  const text = copy.market;
  // The shared comparison moves the second line, so supply is revealed first.
  return plotCrossings({
    title: text.title,
    axes: text.axes,
    names: [text.supply, text.demand],
    initial: [supply, demand],
    alternative: demandIncrease ? [{ ...demand, b: demand.b + demandIncrease }] : [],
    vary: 'b',
    sentences: [text.supplyLine, text.demandLine],
    revised: () => text.shift,
    solution: text.at,
  });
}

function planGrowth({ principal, ratePercent, years }: z.infer<typeof growth>) {
  const text = copy.growth;
  const rate = ratePercent / 100;
  const simple = (year: number) => principal * (1 + year * rate);
  const compound = (year: number) => principal * (1 + rate) ** year;
  const selectedYears = [...new Set([1, Math.min(2, years), years])];
  const milestones = selectedYears.map(year => {
    const points: Layer[] = [
      { id: `simple-${year}`, type: 'point', at: [year, simple(year)] },
      { id: `compound-${year}`, type: 'point', at: [year, compound(year)] },
    ];
    return { year, points };
  });
  const curves = ['simple-curve', 'compound-curve'];
  const layers: Layer[] = [
    {
      id: 'simple-curve',
      type: 'line',
      form: { m: principal * rate, b: principal },
      name: text.simple,
    },
    {
      id: 'compound-curve',
      type: 'curve',
      expr: `${principal}*exp(${Math.log1p(rate)}*x)`,
      name: text.compound,
    },
    ...milestones.flatMap(({ points }) => points),
  ];
  const axes: Spec['axes'] = [...text.axes];
  return plannedPlot(
    {
      title: text.title,
      axes,
      x: [0, years],
      y: paddedBounds([principal, simple(years), compound(years)]),
      layers,
    },
    [
      step('simple-curve', ['simple-curve'], text.simpleLine(principal, ratePercent)),
      step('compound-curve', curves, text.compoundLine),
      ...milestones.map(({ year, points }) => ({
        focus: points.map(point => point.id),
        show: [...curves, ...points.map(point => point.id)],
        sentence: text.at(year, simple(year), compound(year)),
      })),
    ]
  );
}

export function planPlaneMechanism(input: PlaneMechanism) {
  switch (input.form) {
    case 'derivative':
      return planDerivative(input);
    case 'linear-intersection':
      return planIntersection(input);
    case 'break-even':
      return planBreakEven(input);
    case 'market-equilibrium':
      return planMarket(input);
    case 'compound-interest':
      return planGrowth(input);
  }
}

export const planeExamples = {
  derivative: { form: 'derivative', coefficients: [1, 0, 0], point: 1 },
  'linear-intersection': {
    form: 'linear-intersection',
    lines: [
      { m: 2, b: -1 },
      { m: -1, b: 5 },
    ],
  },
  'break-even': { form: 'break-even', fixedCost: 20, unitCost: 2, prices: [6] },
  'market-equilibrium': {
    form: 'market-equilibrium',
    lines: [
      { m: -1, b: 10 },
      { m: 1, b: 2 },
    ],
    demandIncrease: 2,
  },
  'compound-interest': { form: 'compound-interest', principal: 100, ratePercent: 10, years: 5 },
} satisfies { [Form in PlaneMechanism['form']]: Extract<PlaneMechanism, { form: Form }> };
