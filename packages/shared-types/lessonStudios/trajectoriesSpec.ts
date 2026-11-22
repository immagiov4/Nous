import * as z from 'zod';
import { geometryBeatFields } from './geometryStudioSpec';
import type { Point } from './vectorScene';

export const trajectoriesModelGuide = `trajectories spec {title,xLabel,yLabel,series:[{name,points:[[x,y],...]}],phases?:[{label,start,end}],beats:[{at,action,target}]}. 1–6 uniquely named series; 3–8 normalized points (0–1), strictly ascending x. Phases have unique labels and 0≤start<end≤1. Actions: reveal (target series name), phase (target phase label), compare (target array of two distinct series names). Qualitative curves are illustrative, not measured data. Use meaningful axis names, e.g. {at:"b1",action:"compare",target:["A","B"]}.`;
const label = z.string().min(1).regex(/\S/u);
const unit = z.number().min(0).max(1);
const points = z
  .array(z.tuple([unit, unit]))
  .min(3)
  .max(8);
const phases = z.array(z.object({ label, start: unit, end: unit }));
export const TrajectoriesSpecSchema = z.object({
  title: label,
  xLabel: label,
  yLabel: label,
  series: z
    .array(z.object({ name: label, points }))
    .min(1)
    .max(6),
  phases: phases.optional(),
  beats: z.array(
    z.discriminatedUnion('action', [
      z.object({ ...geometryBeatFields, action: z.literal('reveal'), target: label }),
      z.object({ ...geometryBeatFields, action: z.literal('phase'), target: label }),
      z.object({
        ...geometryBeatFields,
        action: z.literal('compare'),
        target: z.tuple([label, label]),
      }),
    ])
  ),
});
export type TrajectoriesSpec = z.infer<typeof TrajectoriesSpecSchema>;
type Phase = NonNullable<TrajectoriesSpec['phases']>[number];
const INVALID_TRAJECTORY_TARGET = 'Invalid series or phase selection';

export function comparisonInterval(a: Point[], b: Point[], phase?: Phase) {
  return {
    left: Math.max(a[0][0], b[0][0], phase?.start ?? 0),
    right: Math.min(a[a.length - 1][0], b[b.length - 1][0], phase?.end ?? 1),
  };
}

export function checkTrajectoriesSpec(spec: TrajectoriesSpec) {
  const series = new Map(spec.series.map(({ name, points }) => [name, points]));
  const phases = new Map(spec.phases?.map(phase => [phase.label, phase]));
  if (series.size !== spec.series.length) throw new Error('Series names must be unique');
  if (phases.size !== (spec.phases?.length ?? 0)) throw new Error('Phase labels must be unique');
  if (spec.phases?.some(phase => phase.start >= phase.end))
    throw new Error('Phase start must precede end');
  if (
    spec.series.some(({ points }) =>
      points.some(([x], index) => index > 0 && x <= points[index - 1][0])
    )
  ) {
    throw new Error('Points must have strictly ascending x');
  }
  checkTrajectoryBeats(spec.beats, series, phases);
}

function checkTrajectoryBeats(
  beats: TrajectoriesSpec['beats'],
  series: Map<string, Point[]>,
  phases: Map<string, Phase>
) {
  let activePhase: Phase | undefined;
  for (const beat of beats) {
    switch (beat.action) {
      case 'phase':
        activePhase = phases.get(beat.target);
        if (!activePhase) throw new Error(INVALID_TRAJECTORY_TARGET);
        break;
      case 'reveal':
        if (!series.has(beat.target)) throw new Error(INVALID_TRAJECTORY_TARGET);
        break;
      case 'compare':
        checkComparison(beat.target, series, activePhase);
        break;
    }
  }
}

function checkComparison(
  [first, second]: [string, string],
  series: Map<string, Point[]>,
  phase?: Phase
) {
  const a = series.get(first);
  const b = series.get(second);
  if (!a || !b || first === second) throw new Error(INVALID_TRAJECTORY_TARGET);
  const { left, right } = comparisonInterval(a, b, phase);
  if (right <= left) throw new Error('Compared series must overlap in the active phase or plot');
}
