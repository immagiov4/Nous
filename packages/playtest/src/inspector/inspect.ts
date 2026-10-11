import * as z from 'zod';
import type { LearnerRunResult } from '../learner/loop';
import type { Observation } from '../operator/session';
import type { ProbeFinding } from '../probes/thresholds';
import type { VisualJudge } from './judge';

export type InspectorFinding = {
  source: 'probe' | 'judge';
  taxonomyClass: string;
  title: string;
  trigger: string;
  expected: string;
  actual: string;
  stepIndex: number;
  screenshotPath: string;
};

const judgeFindingSchema = z.object({
  source: z.literal('judge'),
  taxonomyClass: z.string().min(1),
  title: z.string().min(1),
  trigger: z.string().min(1),
  expected: z.string().min(1),
  actual: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  screenshotPath: z.string().min(1),
});

function probeFinding(probe: ProbeFinding): InspectorFinding {
  return {
    ...probe,
    source: 'probe',
    title: probe.signal.kind,
    trigger: 'Probe collection; exact triggering step is not recorded.',
    expected: `Maintainer threshold: ${probe.threshold}`,
    actual: JSON.stringify(probe.signal),
    // ProbeFinding has no observation provenance; assigning a screen would invent evidence.
    stepIndex: -1,
    screenshotPath: '',
  };
}

/** Judge indices address the supplied screenshot list; returned indices address observations. */
export async function inspect(input: {
  probeFindings: ProbeFinding[];
  learner: LearnerRunResult;
  observations: Observation[];
  judge?: VisualJudge;
  styleReference: string[];
  taxonomy: string;
}): Promise<InspectorFinding[]> {
  const findings = input.probeFindings.map(probeFinding);
  if (input.judge) {
    const candidates = await input.judge.judge({
      screenshots: input.observations.map(observation => observation.screenshotPath),
      styleReference: input.styleReference,
      taxonomy: input.taxonomy,
    });
    let dropped = 0;
    for (const candidate of candidates) {
      const parsed = judgeFindingSchema.safeParse(candidate);
      const observation = parsed.success ? input.observations[parsed.data.stepIndex] : undefined;
      if (!parsed.success || observation?.screenshotPath !== parsed.data.screenshotPath) {
        dropped++;
        continue;
      }
      findings.push({ ...parsed.data, stepIndex: observation.stepIndex });
    }
    if (dropped) {
      console.warn(
        `Inspector dropped ${dropped} judge findings with invalid screenshot evidence or fields.`
      );
    }
  }
  return findings.sort((a, b) => {
    if (a.stepIndex !== b.stepIndex) return a.stepIndex - b.stepIndex;
    if (a.taxonomyClass === b.taxonomyClass) return 0;
    return a.taxonomyClass < b.taxonomyClass ? -1 : 1;
  });
}
