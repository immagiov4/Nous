import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { type Browser, chromium } from 'playwright';
import type { ObservedEvent, PlaytestAdapter, StopVerdict } from './adapter';
import { type DiagnosticRecord, recordDiagnostic, withDiagnostics } from './diagnostics';
import { type InspectorFinding, inspect, type StepProbeFinding } from './inspector/inspect';
import { createPiVisualJudge } from './inspector/judge';
import {
  type DecisionSource,
  type LearnerRunResult,
  type MissionOutcome,
  runLearner,
} from './learner/loop';
import { createModelResolver } from './learner/modelResolution';
import { createPiDecisionSource } from './learner/piDecisionSource';
import { createModelUsage, type ModelUsage, withModelUsage } from './modelUsage';
import {
  isGeometrySignal,
  type Observation,
  OperatorCloseError,
  type OperatorSession,
  openOperatorSession,
} from './operator/session';
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
  cleanupError?: string;
  evidenceError?: string;
  correlationId?: string;
  affect?: string;
  elapsedMs?: number;
  modelUsage?: ModelUsage;
  costEstimated?: true;
  diagnostics?: Record<string, string>;
  operationalFailure?: true;
  inspectionCoverage?: { eligibleObservations: number; totalObservations: number };
  findings: InspectorFinding[];
  friction: string[];
  reportPath: string;
  videoPath?: string;
};
export type RunSummary = {
  runDir: string;
  seed: string;
  records: StoryRunRecord[];
  outcomeCounts: Record<StoryOutcome, number>;
  costEstimated?: true;
  diagnostics?: Record<string, string>;
  operationalFailure?: true;
  /** Set when the shared application stack could not start; every story is then blocked. */
  stackFailure?: string;
};
type RunOptions = {
  adapter: PlaytestAdapter;
  stories: Story[];
  personas: Map<string, Persona>;
  concurrency: number;
  headed: boolean;
  video?: boolean;
  model: string;
  provider: string;
  runDir: string;
  seed?: string;
  sourceFactory?: () => DecisionSource;
};
export type StepProbeSignal = Pick<Observation, 'stepIndex' | 'screenshotPath'> & {
  signal: ProbeSignal;
};

/** Keyed selection is independent of worker order; rejection sampling preserves uniform choice. */
export function selectAffect(input: {
  seed: string;
  story: Story;
  viewport: Viewport;
  persona?: Persona;
}): string | undefined {
  const { seed, story, viewport, persona } = input;
  const pinned = story.requires.affect;
  if (pinned !== undefined) {
    if (typeof pinned !== 'string' || !persona?.affects?.includes(pinned))
      throw new Error('Pinned affect must be one of the story persona’s listed affects.');
    return pinned;
  }
  const affects = persona?.affects;
  if (!affects) return undefined;
  const uint32Range = 2 ** 32;
  const acceptanceRange = uint32Range - (uint32Range % affects.length);
  for (let attempt = 0; ; attempt++) {
    const sample = createHash('sha256')
      .update(JSON.stringify([seed, story.id, viewport, attempt]))
      .digest()
      .readUInt32BE(0);
    if (sample < acceptanceRange) return affects[sample % affects.length];
  }
}

/** Preserve partial evidence and record each closure failure once. */
function recordEvidenceFailure(record: StoryRunRecord, error: unknown): string | undefined {
  const failures =
    error instanceof OperatorCloseError ? error.failures : [{ stage: 'trace', cause: error }];
  if (error instanceof OperatorCloseError && error.videoPath) record.videoPath = error.videoPath;
  for (const failure of failures)
    recordDiagnostic(failure.stage, failure.cause, { operational: true });
  const artifacts = error instanceof OperatorCloseError ? error.artifacts : 'trace';
  record.outcome = 'operator-failure';
  record.evidenceError = `The harness could not save the browser ${artifacts}.`;
  record.reason = record.evidenceError;
  return error instanceof OperatorCloseError ? error.tracePath : undefined;
}

/** Context closure precedes adapter cleanup on every prepared story path. */
async function closePreparedStory(input: {
  session?: OperatorSession;
  prepared: Awaited<ReturnType<PlaytestAdapter['prepare']>>;
  record: StoryRunRecord;
}): Promise<string | undefined> {
  let tracePath: string | undefined;
  const { session, prepared, record } = input;
  if (session) {
    try {
      const evidence = await session.close();
      tracePath = evidence.tracePath;
      if (evidence.videoPath) record.videoPath = evidence.videoPath;
    } catch (error) {
      tracePath = recordEvidenceFailure(record, error);
    }
  }
  try {
    await prepared.cleanup?.();
  } catch (error) {
    recordDiagnostic('cleanup', error, { operational: true });
    record.outcome = 'operator-failure';
    record.cleanupError = 'The adapter could not clean up the synthetic story account.';
    record.reason = record.cleanupError;
  }
  return tracePath;
}

/** Drain at each operator boundary, before the learner can request another action. */
function withProbeEvidence(
  session: OperatorSession,
  options: RunOptions,
  signals: StepProbeSignal[],
  findings: StepProbeFinding[]
): OperatorSession {
  let lastObservation: Observation | undefined;
  const attach = (observation: Observation, drained: ProbeSignal[]) => {
    const evidence = {
      stepIndex: observation.stepIndex,
      screenshotPath: observation.screenshotPath,
    };
    signals.push(...drained.map(signal => ({ signal, ...evidence })));
    findings.push(
      ...toFindings(drained, options.adapter.thresholds(), {
        probeClass: kind => options.adapter.probeClass(kind),
        taxonomyClasses: () => options.adapter.taxonomyClasses(),
      }).map(finding => ({
        ...finding,
        ...evidence,
      }))
    );
  };
  const collect = async (observation: Observation) => {
    lastObservation = observation;
    attach(observation, await session.signals());
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
    async close() {
      try {
        // Queued events emitted while the learner decided its final step belong to the last view;
        // fresh geometry does not, because that screenshot predates any later DOM change.
        if (lastObservation) {
          const events = (await session.signals()).filter(signal => !isGeometrySignal(signal));
          attach(lastObservation, events);
        }
      } catch (error) {
        // A failed drain (e.g. the page closed) must not leave the context open or lose its trace.
        recordDiagnostic('final-probe-drain', error, { operational: true });
      }
      return session.close();
    },
  };
}

async function runStory(input: {
  options: RunOptions;
  story: Story;
  viewport: Viewport;
  jobIndex: number;
  getBrowser: () => Promise<Browser>;
  stackFailure?: string;
  resolveModel: ReturnType<typeof createModelResolver>;
}): Promise<StoryRunRecord> {
  const modelUsage = createModelUsage();
  return withModelUsage(modelUsage, 'learner', () => runStoryWithUsage(input, modelUsage));
}

async function runStoryWithUsage(
  input: Parameters<typeof runStory>[0],
  modelUsage: ModelUsage
): Promise<StoryRunRecord> {
  const startedAt = performance.now();
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
    modelUsage,
  };
  return withDiagnostics(record, async () => {
    let prepared: Awaited<ReturnType<PlaytestAdapter['prepare']>>;
    const persona = story.persona ? options.personas.get(story.persona) : undefined;
    try {
      if (input.stackFailure !== undefined) throw new Error(input.stackFailure);
      record.affect = selectAffect({
        seed: options.seed ?? basename(resolve(options.runDir)),
        story,
        viewport,
        persona,
      });
      prepared = await options.adapter.prepare(story, viewport);
    } catch (error) {
      recordDiagnostic('preparation', error, { operational: true });
      // Adapter precondition failures are explicitly user-readable by contract.
      record.reason = error instanceof Error ? error.message : 'Story preparation failed.';
      record.elapsedMs = performance.now() - startedAt;
      await saveStory({ record });
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
      } catch (error) {
        classificationFailed = true;
        recordDiagnostic('classification', error, {
          record,
          label: '[playtest] Event classification failed:',
          operational: true,
        });
      }
    };
    try {
      // Wrap once so the learner and the final close share it: close drains late probe signals.
      session = withProbeEvidence(
        await openOperatorSession({
          browser: await input.getBrowser(),
          baseUrl: options.adapter.baseUrl(),
          viewport,
          locale: options.adapter.locale(),
          credentials: prepared.credentials,
          inspectionSelector: prepared.inspectionSelector,
          runDir: storyDir,
          video: options.video,
          onEvent,
        }),
        options,
        probeSignals,
        probeFindings
      );
      learner = await runLearner({
        story,
        persona:
          persona && record.affect
            ? {
                ...persona,
                body: `${persona.body}\n\n${options.adapter.describeAffect?.(record.affect) ?? record.affect}`,
              }
            : persona,
        appDescription: options.adapter.appDescription(),
        operator: session,
        source:
          options.sourceFactory?.() ??
          createPiDecisionSource({
            model: options.model,
            provider: options.provider,
            resolveModel: input.resolveModel,
          }),
        shouldStop: () =>
          stopped?.reason ?? (classificationFailed ? 'Event classification failed.' : undefined),
      });
      record.outcome = learner.outcome;
      record.friction = learner.friction;
      record.reason = learner.reason;
      const stopDecision = learner.turns.at(-1)?.decision;
      if (stopDecision?.type === 'stop') record.reason = stopDecision.summary;
    } catch (error) {
      recordDiagnostic('operator', error, { operational: true });
      record.outcome = 'operator-failure';
      record.reason = 'The harness could not execute the story.';
    } finally {
      tracePath = await closePreparedStory({ session, prepared, record });
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
      const scope = scopeInspection(
        learner,
        { probeSignals, tracePath, stopEvent },
        Boolean(prepared.inspectionSelector)
      );
      const observations = scope.observations;
      record.inspectionCoverage = scope.coverage;
      const eligibleScreenshots = new Set(
        observations.map(observation => observation.screenshotPath)
      );
      const inspection = {
        probeFindings: probeFindings.filter(finding =>
          eligibleScreenshots.has(finding.screenshotPath)
        ),
        learner,
        observations,
        trace: scope.trace,
      };
      try {
        record.findings = await withModelUsage(modelUsage, 'judge', () =>
          inspect({
            ...inspection,
            styleReference: options.adapter.styleReference(),
            taxonomy: options.adapter.taxonomy(),
            taxonomyClasses: options.adapter.taxonomyClasses(),
            judge: createPiVisualJudge({
              model: options.model,
              provider: options.provider,
              resolveModel: input.resolveModel,
            }),
          })
        );
      } catch (error) {
        recordDiagnostic('inspection', error, {
          label: '[playtest] Visual inspection failed:',
          operational: true,
        });
        inspectionError = 'Visual inspection failed; probe evidence is retained.';
        record.findings = await inspect({
          ...inspection,
          styleReference: [],
          taxonomy: '',
          taxonomyClasses: [],
        });
      }
    }
    if (modelUsage.costEstimated) record.costEstimated = true;
    record.elapsedMs = performance.now() - startedAt;
    await saveStory({ record, learner, probeSignals, tracePath, stopEvent, inspectionError });
    return record;
  });
}

/** Judge context follows the same capture boundary as screenshots; story evidence remains complete. */
function scopeInspection(
  learner: LearnerRunResult,
  trace: { probeSignals: StepProbeSignal[]; tracePath?: string; stopEvent?: ObservedEvent },
  scoped: boolean
) {
  const observations = learner.observations.filter(
    observation => observation.inspectionEligible !== false
  );
  const coverage = scoped
    ? { eligibleObservations: observations.length, totalObservations: learner.observations.length }
    : undefined;
  if (!scoped) return { observations, coverage, trace: { learner, ...trace } };
  const eligible = new Set(observations.map(observation => observation.screenshotPath));
  let current = learner.observations[0];
  const turns = learner.turns.filter(turn => {
    const contextEligible = current && eligible.has(current.screenshotPath);
    const result = turn.result?.observation;
    current = result ?? current;
    // Stop summaries describe the whole mission rather than a single captured view.
    return (
      contextEligible &&
      turn.decision.type !== 'stop' &&
      (!result || eligible.has(result.screenshotPath))
    );
  });
  return {
    observations,
    coverage,
    trace: {
      learner: {
        observations,
        turns,
        diary: turns.flatMap(turn => (turn.decision.type === 'diary' ? [turn.decision.entry] : [])),
        friction: turns.flatMap(turn =>
          turn.decision.type === 'report-friction' ? [turn.decision.text] : []
        ),
      },
      probeSignals: trace.probeSignals.filter(signal => eligible.has(signal.screenshotPath)),
    },
  };
}

/** JSON remains available when a companion report fails; the summary retains unwritable stories. */
async function saveStory(input: Parameters<typeof writeStoryReports>[0]): Promise<void> {
  try {
    await writeStoryReports(input);
  } catch (error) {
    recordDiagnostic('report', error, { operational: true });
    if (input.record.outcome !== 'app-error') {
      input.record.outcome = 'operator-failure';
      input.record.reason = 'The harness could not write the story report.';
    }
    try {
      const existing = await readFile(input.record.reportPath, 'utf8')
        .then(JSON.parse)
        .catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === 'ENOENT') return {};
          throw cause;
        });
      await writeFile(
        input.record.reportPath,
        JSON.stringify({ ...existing, ...input.record }, null, 2)
      );
    } catch (cause) {
      recordDiagnostic('report-persistence', cause);
    }
  }
}

/** One browser per worker, one context per story×viewport; results retain deterministic order. */
export async function runPlaytest(options: RunOptions): Promise<RunSummary> {
  const run: DiagnosticRecord = {};
  const seeded = { ...options, seed: options.seed ?? basename(resolve(options.runDir)) };
  return withDiagnostics(run, () => executePlaytest(seeded, run));
}

function storyJobs(options: RunOptions) {
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
  return jobs;
}

async function executePlaytest(options: RunOptions, run: DiagnosticRecord): Promise<RunSummary> {
  const jobs = storyJobs(options);
  let stackFailure: string | undefined;
  try {
    await options.adapter.ensureStack();
  } catch (error) {
    recordDiagnostic('stack', error, { operational: true });
    stackFailure = error instanceof Error ? error.message : 'Application stack is unavailable.';
  }
  const records: StoryRunRecord[] = new Array(jobs.length);
  const resolveModel = createModelResolver({ model: options.model, provider: options.provider });
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
          resolveModel,
        });
      }
    } catch (error) {
      recordDiagnostic('worker-execution', error);
      throw error;
    } finally {
      await browser?.close().catch(error => {
        recordDiagnostic('browser-close', error);
        throw error;
      });
    }
  };
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(options.concurrency, jobs.length) }, worker)
  );
  for (const worker of workers)
    if (worker.status === 'rejected') {
      recordDiagnostic('worker', worker.reason);
      try {
        await mkdir(options.runDir, { recursive: true });
        await writeFile(
          join(options.runDir, 'summary.json'),
          JSON.stringify(
            {
              ...run,
              seed: options.seed,
              records: records.filter(Boolean),
              reason: 'The harness could not complete its workers.',
            },
            null,
            2
          )
        );
      } catch (cause) {
        recordDiagnostic('worker-report', cause);
      }
      throw new Error('The harness could not complete its workers.', { cause: worker.reason });
    }
  const outcomeCounts: RunSummary['outcomeCounts'] = {
    completed: 0,
    abandoned: 0,
    'harness-limit': 0,
    'operator-failure': 0,
    'app-error': 0,
    'blocked-precondition': 0,
  };
  for (const record of records) outcomeCounts[record.outcome]++;
  const summary: RunSummary = {
    runDir: options.runDir,
    seed: options.seed as string,
    records,
    outcomeCounts,
    ...run,
    ...(records.some(record => record.costEstimated) ? { costEstimated: true } : {}),
    ...(stackFailure === undefined ? {} : { stackFailure }),
  };
  try {
    await writeSummaryReports(summary);
  } catch (error) {
    recordDiagnostic('summary-report', error);
    summary.diagnostics = run.diagnostics;
    try {
      await writeFile(join(options.runDir, 'summary.json'), JSON.stringify(summary, null, 2));
    } catch (cause) {
      recordDiagnostic('summary-persistence', cause);
    }
    throw new Error('The harness could not write the run summary.', { cause: error });
  }
  return summary;
}
