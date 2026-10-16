import * as z from 'zod';
import type { LearnerRunResult } from '../learner/loop';
import { isGeometrySignal, type Observation } from '../operator/session';
import type { ProbeFinding } from '../probes/thresholds';
import { type FindingEvidence, findingEvidenceSchema, groundingFailure } from './grounding';
import type { VisualJudge } from './judge';

export type InspectorFinding = {
  evidence?: FindingEvidence;
  source: 'probe' | 'judge';
  taxonomyClass: string;
  title: string;
  trigger: string;
  expected: string;
  actual: string;
  stepIndex: number;
  screenshotPath: string;
};

export type DiscardedFinding = { finding: unknown; reason: string };

const judgeFindingSchema = z.object({
  source: z.literal('judge'),
  evidence: findingEvidenceSchema,
  taxonomyClass: z.string().min(1),
  title: z.string().min(1),
  trigger: z.string().min(1),
  expected: z.string().min(1),
  actual: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  screenshotPath: z.string().min(1),
});

export type StepProbeFinding = ProbeFinding & Pick<Observation, 'stepIndex' | 'screenshotPath'>;

function probeFinding(probe: StepProbeFinding): InspectorFinding {
  return {
    ...probe,
    source: 'probe',
    title: probe.signal.kind,
    trigger: `Probe collection after step ${probe.stepIndex}.`,
    expected: `Maintainer threshold: ${probe.threshold}`,
    actual: JSON.stringify(probe.signal),
  };
}

function verifyEvidence(evidence: FindingEvidence, observation: Observation): string | undefined {
  if (observation.diagnostics?.capture.unstable)
    return 'The DOM and screenshot capture was unstable.';
  if (!observation.dom) return 'No DOM evidence was captured for this screenshot.';
  return groundingFailure(evidence, observation.dom);
}

type InspectionInput = {
  discarded?: DiscardedFinding[];
  probeFindings: StepProbeFinding[];
  learner: LearnerRunResult;
  observations: Observation[];
  judge?: VisualJudge;
  styleReference: string[];
  taxonomy: string;
  taxonomyClasses: string[];
  trace?: NonNullable<Parameters<VisualJudge['judge']>[0]['trace']>;
};

function groundedProbes(input: InspectionInput): InspectorFinding[] {
  const findings: InspectorFinding[] = [];
  for (const probe of input.probeFindings) {
    const finding = probeFinding(probe);
    const observation = input.observations.find(
      observation =>
        observation.stepIndex === probe.stepIndex &&
        observation.screenshotPath === probe.screenshotPath
    );
    if (isGeometrySignal(probe.signal) && observation?.diagnostics?.capture.unstable) {
      input.discarded?.push({ finding, reason: 'The DOM and screenshot capture was unstable.' });
      continue;
    }
    if (probe.signal.kind === 'overlap') {
      const evidence: FindingEvidence = {
        kind: 'overlap',
        selectors: [probe.signal.a, probe.signal.b],
      };
      const reason = observation
        ? verifyEvidence(evidence, observation)
        : 'The probe has no matching observation.';
      if (reason) {
        input.discarded?.push({ finding, reason });
        continue;
      }
      finding.evidence = evidence;
    }
    findings.push(finding);
  }
  return findings;
}

/** Judge indices address the supplied screenshot list; returned indices address observations. */
export async function inspect(input: InspectionInput): Promise<InspectorFinding[]> {
  const candidates =
    (await input.judge?.judge({
      screenshots: input.observations.map(observation => ({
        screenshotPath: observation.screenshotPath,
        dom: observation.dom,
        visibleText: [
          ...new Set(observation.nodes.map(node => node.name).filter(name => name.trim())),
        ],
      })),
      styleReference: input.styleReference,
      taxonomy: input.taxonomy,
      trace: input.trace,
    })) ?? [];
  const findings = groundedProbes(input);
  const allowedClasses = new Set(input.taxonomyClasses);
  let dropped = 0;
  for (const candidate of candidates) {
    const parsed = judgeFindingSchema.safeParse(candidate);
    const observation = parsed.success ? input.observations[parsed.data.stepIndex] : undefined;
    if (
      !parsed.success ||
      !allowedClasses.has(parsed.data.taxonomyClass) ||
      observation?.screenshotPath !== parsed.data.screenshotPath
    ) {
      input.discarded?.push({
        finding: candidate,
        reason: 'Invalid screenshot evidence, taxonomy or finding fields.',
      });
      dropped++;
      continue;
    }
    const reason = verifyEvidence(parsed.data.evidence, observation);
    if (reason) {
      input.discarded?.push({ finding: candidate, reason });
      continue;
    }
    const finding = { ...parsed.data, stepIndex: observation.stepIndex };
    if (finding.evidence.kind === 'text') {
      finding.actual = finding.evidence.quote;
      finding.expected = finding.evidence.replacement;
    }
    findings.push(finding);
  }
  if (dropped) {
    console.warn(
      `Inspector dropped ${dropped} judge findings with invalid screenshot evidence or fields.`
    );
  }
  return findings.sort((a, b) => {
    if (a.stepIndex !== b.stepIndex) return a.stepIndex - b.stepIndex;
    if (a.taxonomyClass === b.taxonomyClass) return 0;
    return a.taxonomyClass < b.taxonomyClass ? -1 : 1;
  });
}
