import { join } from 'node:path';
import { type Browser, chromium } from 'playwright';
import type { ObservedEvent, PlaytestAdapter, StopVerdict } from './adapter';
import { type InspectorFinding, inspect, type StepProbeFinding } from './inspector/inspect';
import { createPiVisualJudge } from './inspector/judge';
import {
  type DecisionSource,
  type LearnerRunResult,
  type MissionOutcome,
  runLearner,
} from './learner/loop';
import { createPiDecisionSource } from './learner/piDecisionSource';
import { type Observation, type OperatorSession, openOperatorSession } from './operator/session';
import type { ProbeSignal } from './probes/pageProbes';
import { toFindings } from './probes/thresholds';
import { writeStoryReports, writeSummaryReports } from './report/writeReports';
import type { Persona, Story, Viewport } from './types';

export type StoryOutcome = MissionOutcome | 'app-error' | 'blocked-precondition';
export type StoryRunRecord = {
  storyId: string;
  viewport: Viewport;
  outcome: StoryOutcome;
  reason?: string;
  correlationId?: string;
  findings: InspectorFinding[];
  friction: string[];
  reportPath: string;
};
export type RunSummary = {
  runDir: string;
  records: StoryRunRecord[];
  outcomeCounts: Record<StoryOutcome, number>;
};
type RunOptions = {
  adapter: PlaytestAdapter;
  stories: Story[];
  personas: Map<string, Persona>;
  concurrency: number;
  headed: boolean;
  model: string;
  provider: string;
  runDir: string;
  sourceFactory?: () => DecisionSource;
};
export type StepProbeSignal = Pick<Observation, 'stepIndex' | 'screenshotPath'> & {
  signal: ProbeSignal;
};

/** Drain at each operator boundary, before the learner can request another action. */
function withProbeEvidence(
  session: OperatorSession,
  options: RunOptions,
  signals: StepProbeSignal[],
  findings: StepProbeFinding[]
): OperatorSession {
  const collect = async (observation: Observation) => {
    const drained = await session.signals();
    const evidence = {
      stepIndex: observation.stepIndex,
      screenshotPath: observation.screenshotPath,
    };
    signals.push(...drained.map(signal => ({ signal, ...evidence })));
    findings.push(
      ...toFindings(drained, options.adapter.thresholds()).map(finding => ({
        ...finding,
        ...evidence,
      }))
    );
  };
  return {
    async observe() {
      const observation = await session.observe();
      await collect(observation);
      return observation;
    },
    async act(action) {
      const result = await session.act(action);
      await collect(result.observation);
      return result;
    },
    signals: () => session.signals(),
    close: () => session.close(),
  };
}

async function runStory(input: {
  options: RunOptions;
  story: Story;
  viewport: Viewport;
  jobIndex: number;
  getBrowser: () => Promise<Browser>;
  stackFailure?: string;
}): Promise<StoryRunRecord> {
  const { options, story, viewport } = input;
  // The index also distinguishes IDs differing only by case on Windows filesystems.
  const storyDir = join(
    options.runDir,
    `story-${input.jobIndex}-${encodeURIComponent(story.id)}`,
    viewport
  );
  const record: StoryRunRecord = {
    storyId: story.id,
    viewport,
    outcome: 'blocked-precondition',
    findings: [],
    friction: [],
    reportPath: join(storyDir, 'story.json'),
  };
  let prepared: Awaited<ReturnType<PlaytestAdapter['prepare']>>;
  try {
    if (input.stackFailure !== undefined) throw new Error(input.stackFailure);
    prepared = await options.adapter.prepare(story, viewport);
  } catch (error) {
    // Adapter precondition failures are explicitly user-readable by contract.
    record.reason = error instanceof Error ? error.message : 'Story preparation failed.';
    await writeStoryReports({ record });
    return record;
  }

  const probeSignals: StepProbeSignal[] = [];
  const probeFindings: StepProbeFinding[] = [];
  let stopped: Extract<StopVerdict, { stop: true }> | undefined;
  let stopEvent: ObservedEvent | undefined;
  let classificationFailed = false;
  let session: OperatorSession | undefined;
  let learner: LearnerRunResult | undefined;
  let tracePath: string | undefined;
  let inspectionError: string | undefined;
  const onEvent = (event: ObservedEvent) => {
    if (stopped || classificationFailed) return;
    try {
      const verdict = options.adapter.classify(event);
      if (verdict.stop) {
        stopped = verdict;
        stopEvent = event;
      }
    } catch {
      classificationFailed = true;
    }
  };
  try {
    session = await openOperatorSession({
      browser: await input.getBrowser(),
      baseUrl: options.adapter.baseUrl(),
      viewport,
      credentials: prepared.credentials,
      runDir: storyDir,
      onEvent,
    });
    learner = await runLearner({
      story,
      persona: story.persona ? options.personas.get(story.persona) : undefined,
      appDescription: options.adapter.appDescription(),
      operator: withProbeEvidence(session, options, probeSignals, probeFindings),
      source:
        options.sourceFactory?.() ??
        createPiDecisionSource({ model: options.model, provider: options.provider }),
      shouldStop: () =>
        stopped?.reason ?? (classificationFailed ? 'Event classification failed.' : undefined),
    });
    record.outcome = learner.outcome;
    record.friction = learner.friction;
    const stopDecision = learner.turns.at(-1)?.decision;
    if (stopDecision?.type === 'stop') record.reason = stopDecision.summary;
  } catch {
    record.outcome = 'operator-failure';
    record.reason = 'The harness could not execute the story.';
  } finally {
    if (session) {
      try {
        ({ tracePath } = await session.close());
      } catch {
        record.outcome = 'operator-failure';
        record.reason = 'The harness could not save the browser trace.';
      }
    }
  }
  if (stopped) {
    record.outcome = 'app-error';
    record.reason = stopped.reason;
    record.correlationId = stopped.correlationId;
  } else if (classificationFailed) {
    record.outcome = 'operator-failure';
    record.reason = 'The adapter could not classify an observed event.';
  }
  if (learner) {
    const inspection = {
      probeFindings,
      learner,
      observations: learner.observations,
    };
    try {
      record.findings = await inspect({
        ...inspection,
        styleReference: options.adapter.styleReference(),
        taxonomy: options.adapter.taxonomy(),
        judge: createPiVisualJudge({ model: options.model, provider: options.provider }),
      });
    } catch {
      inspectionError = 'Visual inspection failed; probe evidence is retained.';
      record.findings = await inspect({ ...inspection, styleReference: [], taxonomy: '' });
    }
  }
  await writeStoryReports({ record, learner, probeSignals, tracePath, stopEvent, inspectionError });
  return record;
}

/** One browser per worker, one context per story×viewport; results retain deterministic order. */
export async function runPlaytest(options: RunOptions): Promise<RunSummary> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0) {
    throw new Error('Concurrency must be a positive integer.');
  }
  const jobs = options.stories
    .flatMap(story => story.viewports.map(viewport => ({ story, viewport })))
    .sort((a, b) => {
      if (a.story.id !== b.story.id) return a.story.id < b.story.id ? -1 : 1;
      if (a.viewport !== b.viewport) return a.viewport < b.viewport ? -1 : 1;
      return 0;
    });
  const keys = new Set<string>();
  for (const { story, viewport } of jobs) {
    const key = JSON.stringify([story.id, viewport]);
    if (keys.has(key)) throw new Error(`Duplicate story×viewport: ${story.id} (${viewport}).`);
    keys.add(key);
    if (story.persona && !options.personas.has(story.persona)) {
      throw new Error(`Unknown persona: ${story.persona}.`);
    }
  }
  let stackFailure: string | undefined;
  try {
    await options.adapter.ensureStack();
  } catch (error) {
    stackFailure = error instanceof Error ? error.message : 'Application stack is unavailable.';
  }
  const records: StoryRunRecord[] = new Array(jobs.length);
  let nextJob = 0;
  const worker = async () => {
    let browser: Browser | undefined;
    const getBrowser = async () => {
      browser ??= await chromium.launch({ headless: !options.headed });
      return browser;
    };
    try {
      while (nextJob < jobs.length) {
        const index = nextJob++;
        records[index] = await runStory({
          options,
          ...jobs[index],
          jobIndex: index,
          getBrowser,
          stackFailure,
        });
      }
    } finally {
      await browser?.close();
    }
  };
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(options.concurrency, jobs.length) }, worker)
  );
  for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;
  const outcomeCounts: RunSummary['outcomeCounts'] = {
    completed: 0,
    abandoned: 0,
    'harness-limit': 0,
    'operator-failure': 0,
    'app-error': 0,
    'blocked-precondition': 0,
  };
  for (const record of records) outcomeCounts[record.outcome]++;
  const summary = { runDir: options.runDir, records, outcomeCounts };
  await writeSummaryReports(summary);
  return summary;
}
