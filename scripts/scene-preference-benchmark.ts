import { createHash, randomUUID } from 'node:crypto';
import { existsSync, watch, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as z from 'zod';
import { MAX_VISUAL_LESSON_CHARS } from '../packages/shared-types/lessonGenerationPolicy.js';
import { selectableLessonSceneTypes } from '../packages/shared-types/lessonScene.js';
import { readGitIdentity } from './git-identity.js';

/**
 * Run: bun --tsconfig-override apps/backend/tsconfig.json scripts/scene-preference-benchmark.ts
 * --dataset <private.jsonl> --output <new-private.json> --repetitions 3 --run
 * Omit --run for preflight; use --limit N or --cases id,id for a bounded smoke run.
 * Uncaptioned cases cannot label formula-spotlight. First interrupt checkpoints; repeat to force stop.
 * Accuracy = preferred / (preferred + rejected); neither, invalid, error and text are separate.
 * This measures uncaptioned generation with the local production defaults/environment, not
 * deployed settings. Labels never reach the model. No workflow, database, icons or renderer runs.
 */

const form = z.union([
  z.enum(selectableLessonSceneTypes({ captioned: false })),
  // Historical verdict labels stay readable when the live selector consolidates a form.
  z.literal('hierarchy'),
  z
    .string()
    .startsWith('uncovered:')
    .min('uncovered:'.length + 1),
]);
const CaseSchema = z
  .strictObject({
    id: z.string().min(1),
    passage: z.string().min(1),
    sectionTitle: z.string(),
    sectionDescription: z.string(),
    preferred: form,
    rejected: form,
    tie: z.boolean(),
  })
  .refine(c => c.preferred !== c.rejected);
type PreferenceCase = z.infer<typeof CaseSchema>;
export interface Trial {
  id: string;
  repetition: number;
  kind: 'scene' | 'text' | 'invalid' | 'error' | 'cancelled';
  chosen?: string;
  latencyMs: number;
  errorClass?: string;
  diagnostic?: import('../apps/backend/src/workflows/workflowErrorDiagnostics.js').WorkflowErrorDiagnostic;
  source?: { chars: number; excerptChars: number; truncated: boolean; excerptSha256: string };
}

/** Reject malformed input without embedding a private record in the diagnostic. */
export const parseCases = (text: string): PreferenceCase[] => {
  try {
    const cases = text
      .split(/\r?\n/u)
      .filter(line => line.trim())
      .map(line => CaseSchema.parse(JSON.parse(line)));
    if (!cases.length || new Set(cases.map(c => c.id)).size !== cases.length)
      throw new Error('Empty or duplicate cases');
    return cases;
  } catch {
    throw new Error('Invalid benchmark dataset');
  }
};

const uncovered = (type: string) => type.startsWith('uncovered:');
const ratio = (n: number, d: number) => (d ? n / d : null);
const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
const latencyStats = (trials: readonly Trial[]) => {
  const sorted = trials.map(t => t.latencyMs).sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
};

/** Pairwise accuracy conditions on choosing either member; neither and failed choices are separate. */
export const summarize = (
  cases: readonly PreferenceCase[],
  trials: readonly Trial[],
  repetitions: number
) => {
  const completed = trials.filter(t => t.kind !== 'cancelled');
  const decisive = cases.filter(c => !c.tie);
  const pairs = new Map(
    decisive.filter(c => !uncovered(c.preferred) && !uncovered(c.rejected)).map(c => [c.id, c])
  );
  const uncoveredPreferred: Record<string, number> = {};
  for (const c of decisive.filter(c => uncovered(c.preferred))) {
    const label = c.preferred.slice('uncovered:'.length);
    uncoveredPreferred[label] = (uncoveredPreferred[label] ?? 0) + 1;
  }
  const runs = Array.from({ length: repetitions }, (_, index) => {
    const own = completed.filter(t => t.repetition === index + 1);
    const paired = own.filter(t => pairs.has(t.id));
    const preferred = paired.filter(
      t => t.kind === 'scene' && t.chosen === pairs.get(t.id)?.preferred
    ).length;
    const rejected = paired.filter(
      t => t.kind === 'scene' && t.chosen === pairs.get(t.id)?.rejected
    ).length;
    const neither = paired.filter(
      t =>
        t.kind === 'scene' &&
        t.chosen !== pairs.get(t.id)?.preferred &&
        t.chosen !== pairs.get(t.id)?.rejected
    ).length;
    return {
      repetition: index + 1,
      completed: own.length,
      preferred,
      rejected,
      neither,
      accuracy: ratio(preferred, preferred + rejected),
      preferredShareOfCoveredPairs: ratio(preferred, pairs.size),
      latencyMs: latencyStats(own),
      failures: own.filter(t => t.kind === 'invalid' || t.kind === 'error').length,
      textFallbacks: own.filter(t => t.kind === 'text').length,
    };
  });
  const accuracies = runs.flatMap(r => (r.accuracy === null ? [] : [r.accuracy]));
  const failed = completed.filter(t => t.kind === 'error' || t.kind === 'invalid').length;
  return {
    dataset: {
      total: cases.length,
      decisive: decisive.length,
      ties: cases.length - decisive.length,
      coveredPairs: pairs.size,
      uncoveredPreferred,
      uncoveredPreferredShare: ratio(
        Object.values(uncoveredPreferred).reduce((a, b) => a + b, 0),
        decisive.length
      ),
    },
    repetitions: runs,
    accuracy: {
      mean: ratio(
        accuracies.reduce((a, b) => a + b, 0),
        accuracies.length
      ),
      min: accuracies.length ? Math.min(...accuracies) : null,
      max: accuracies.length ? Math.max(...accuracies) : null,
      spread: accuracies.length ? Math.max(...accuracies) - Math.min(...accuracies) : null,
      scoredRepetitions: accuracies.length,
    },
    latencyMs: latencyStats(completed),
    failureRate: ratio(failed, completed.length),
    textFallbackRate: ratio(completed.filter(t => t.kind === 'text').length, completed.length),
    completedTrials: completed.length,
    cancelledTrials: trials.length - completed.length,
    expectedTrials: decisive.length * repetitions,
  };
};

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const outsideRepository = async (path: string) => {
  const canonical = await realpath(path);
  const rel = relative(await realpath(repository), canonical);
  if (!rel || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)))
    throw new Error('Use private paths outside the repository.');
  return canonical;
};
const positiveInteger = (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Expected a positive integer.');
  return parsed;
};

type Generate =
  typeof import('../apps/backend/src/services/lessonScenes/lessonSceneGeneration.js').generateLessonScene;
type VisualConfig =
  import('../apps/backend/src/services/lessonVisualModelConfig.js').LessonVisualModelConfig;

/** Stop at the existing validated-scene callback, before any icon embeddings or icon model calls. */
export const measureCase = async (input: {
  c: PreferenceCase;
  repetition: number;
  config: VisualConfig;
  signal: AbortSignal;
  generate: Generate;
}): Promise<Trial> => {
  const started = performance.now();
  const validated = new Error('Selection observed');
  let chosen: string | undefined;
  let kind: Trial['kind'];
  let errorClass: string | undefined;
  let diagnostic: Trial['diagnostic'];
  try {
    const result = await input.generate({
      allowTextFallback: true,
      config: input.config,
      lessonMarkdown: input.c.passage,
      sectionTitle: input.c.sectionTitle,
      sectionDescription: input.c.sectionDescription,
      signal: input.signal,
      onValidatedScene: scene => {
        chosen = scene.type;
        throw validated;
      },
    });
    kind = result.kind;
    if (result.kind === 'invalid') {
      const { WorkflowObservedTechnicalDiagnosticSchema } = await import(
        '../apps/backend/src/workflows/workflowErrorDiagnostics.js'
      );
      diagnostic = WorkflowObservedTechnicalDiagnosticSchema.parse(
        result.diagnostic ?? { type: 'InvalidScene', errorStage: 'validation' }
      );
    }
  } catch (error) {
    if (error === validated) kind = 'scene';
    else if (input.signal.aborted) kind = 'cancelled';
    else {
      kind = 'error';
      // Keep only a bounded technical classification, never a provider message or request body.
      errorClass = error instanceof TypeError ? 'TypeError' : 'ProviderOrGenerationError';
      const { toWorkflowErrorDiagnostic } = await import(
        '../apps/backend/src/workflows/workflowErrorDiagnostics.js'
      );
      diagnostic = toWorkflowErrorDiagnostic(error, { includeContent: false });
    }
  }
  return {
    id: input.c.id,
    repetition: input.repetition,
    kind,
    ...(chosen ? { chosen } : {}),
    ...(errorClass ? { errorClass } : {}),
    ...(diagnostic ? { diagnostic } : {}),
    source: {
      chars: input.c.passage.length,
      excerptChars: Math.min(input.c.passage.length, MAX_VISUAL_LESSON_CHARS),
      truncated: input.c.passage.length > MAX_VISUAL_LESSON_CHARS,
      excerptSha256: createHash('sha256')
        .update(input.c.passage.slice(0, MAX_VISUAL_LESSON_CHARS))
        .digest('hex'),
    },
    latencyMs: performance.now() - started,
  };
};

export const readOptions = (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: {
      dataset: { type: 'string' },
      output: { type: 'string' },
      repetitions: { type: 'string', default: '3' },
      limit: { type: 'string' },
      cases: { type: 'string' },
      run: { type: 'boolean' },
      'cancel-file': { type: 'string' },
    },
  });
  if (!values.dataset || !values.output)
    throw new Error(
      'Usage: bun --tsconfig-override apps/backend/tsconfig.json scripts/scene-preference-benchmark.ts --dataset <private.jsonl> --output <private.json> [--repetitions 3] [--limit N | --cases id,id] [--run]'
    );
  const repetitions = positiveInteger(values.repetitions);
  if (values.limit !== undefined) positiveInteger(values.limit);
  if (values.cases?.split(',').some(id => !id.trim()))
    throw new Error('Case selection must not be empty.');
  if (values.limit !== undefined && values.cases !== undefined)
    throw new Error('Choose --limit or --cases.');
  return { ...values, dataset: values.dataset, output: values.output, repetitions };
};

const loadCases = async (values: ReturnType<typeof readOptions>) => {
  const dataset = await outsideRepository(values.dataset);
  await outsideRepository(dirname(resolve(values.output)));
  try {
    await outsideRepository(values.output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // The local CLI explicitly selects this canonical external dataset; it is not a server path.
  const datasetText = await readFile(dataset, 'utf8'); // NOSONAR
  let cases = parseCases(datasetText);
  if (values.cases) {
    const requested = new Set(values.cases.split(','));
    cases = cases.filter(c => requested.has(c.id));
    if (cases.length !== requested.size) throw new Error('Unknown case selection.');
  }
  if (values.limit) cases = cases.filter(c => !c.tie).slice(0, positiveInteger(values.limit));
  return { cases, datasetText };
};

const watchCancellation = (cancelFile: string | undefined, cancel: () => void) => {
  if (!cancelFile) return undefined;
  const checkCancellation = () => {
    if (existsSync(cancelFile)) cancel();
  };
  const watcher = watch(dirname(cancelFile), { persistent: false }, checkCancellation); // NOSONAR: Operator CLI control path; watches metadata only, never reads file contents.
  checkCancellation();
  writeFileSync(`${cancelFile}.ready`, '', { flag: 'wx' }); // NOSONAR: Operator CLI path; exclusively creates an empty marker and rejects existing files/symlinks.
  return watcher;
};

export async function runBenchmark(args: string[]) {
  const values = readOptions(args);
  const { repetitions } = values;
  const { cases, datasetText } = await loadCases(values);
  await import('../apps/backend/src/config/env.js');
  // Match backend initialization order, then disable persisted settings before any resolution.
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  const { getResolvedGlobalModelConfig, resolveTextModelConfig } = await import(
    '../apps/backend/src/config/modelConfig.js'
  );
  const { generateLessonScene } = await import(
    '../apps/backend/src/services/lessonScenes/lessonSceneGeneration.js'
  );
  const { resolveLessonVisualModelConfig } = await import(
    '../apps/backend/src/services/lessonVisualModelConfig.js'
  );
  const config = await getResolvedGlobalModelConfig();
  const visualConfig = resolveLessonVisualModelConfig(config);
  if (visualConfig.artifact.provider !== 'openrouter')
    throw new Error('This offline benchmark requires the configured OpenRouter scene provider.');
  const sceneConfig = {
    ...config,
    aiProvider: visualConfig.artifact.provider,
    aiProviderOverrides: {},
  };
  const model = resolveTextModelConfig(sceneConfig, 'scene');
  const { commitSha, dirty } = readGitIdentity(repository);
  const diff = Bun.spawnSync(['git', 'diff', '--binary', 'HEAD', '--'], {
    cwd: repository,
    windowsHide: true,
  }); // NOSONAR: fixed Git arguments through the developer's Git installation, no shell.
  if (!diff.success) throw new Error('Cannot identify benchmark worktree diff.');
  const metadata = {
    commit: commitSha,
    dirty,
    diffSha256: createHash('sha256').update(diff.stdout).digest('hex'),
    datasetSha256: createHash('sha256').update(datasetText).digest('hex'),
    selectionSha256: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
    provider: 'openrouter',
    ...model,
    serviceTier: 'normal',
    latencyBoundary: 'generation plus schema/domain validation, before icon selection',
    startedAt: new Date().toISOString(),
  };
  console.log(
    JSON.stringify({ model, cases: cases.length, ...summarize(cases, [], repetitions).dataset })
  );
  if (!values.run) return;
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required.');
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const processEvents: NodeJS.EventEmitter = process;
  processEvents.once('SIGINT', cancel);
  processEvents.once('SIGTERM', cancel);
  const cancelWatch = watchCancellation(values['cancel-file'], cancel);
  const trials: Trial[] = [];
  const save = () =>
    writeCheckpoint(values.output, {
      metadata,
      cancelled: abort.signal.aborted,
      summary: summarize(cases, trials, repetitions),
      trials,
    });
  // Exclusive creation protects a previous run; checkpoints replace only this run's file.
  await writeFile(values.output, '{}', { flag: 'wx' }); // NOSONAR: validated external CLI output; exclusive creation prevents overwrites.
  try {
    await save();
    const decisive = cases.filter(c => !c.tie);
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const c of decisive) {
        if (abort.signal.aborted) break;
        const input = {
          c,
          repetition,
          config: visualConfig,
          signal: abort.signal,
          generate: generateLessonScene,
        };
        const trial = await measureCase(input); // NOSONAR: serial calls isolate latency from self-induced contention.
        trials.push(trial);
        await save(); // NOSONAR: persist each observation before starting the next paid call.
        console.log(`Recorded ${trials.length}/${cases.filter(c => !c.tie).length * repetitions}`);
      }
      if (abort.signal.aborted) break;
    }
  } finally {
    await save();
    processEvents.removeListener('SIGINT', cancel);
    processEvents.removeListener('SIGTERM', cancel);
    cancelWatch?.close();
  }
  console.table(summarize(cases, trials, repetitions).repetitions);
  console.log(JSON.stringify(summarize(cases, trials, repetitions)));
  if (abort.signal.aborted) process.exitCode = 130;
}

/** Exclusive same-directory temporary creation avoids following a stale .partial symlink. */
export const writeCheckpoint = async (output: string, report: unknown) => {
  const temp = `${output}.${randomUUID()}.partial`;
  await writeFile(temp, JSON.stringify(report, null, 2), { flag: 'wx' }); // NOSONAR: exclusive private sibling of the validated output; never follows existing paths.
  try {
    await rename(temp, output);
  } finally {
    await rm(temp, { force: true });
  }
};

export const runCli = async (args: string[]) => {
  if (args.includes('--run') && process.env.HEAVY_RUN_HELD !== '1' && process.env.CI !== 'true') {
    const { main: heavyRun } = await import('./heavy-run.mjs');
    const control = await mkdtemp(resolve(tmpdir(), 'scene-cancel-'));
    const cancelFile = resolve(control, 'cancel');
    let requested = false;
    try {
      process.exitCode = await heavyRun(
        [
          '--label',
          'scene-preferences',
          '--',
          process.execPath,
          ...process.execArgv,
          fileURLToPath(import.meta.url),
          ...args,
          '--cancel-file',
          cancelFile,
        ],
        {
          onInterrupt: () => {
            // No admitted benchmark can own a checkpoint yet; a second interrupt uses forced cleanup.
            if (requested || !existsSync(`${cancelFile}.ready`)) return false;
            requested = true;
            try {
              writeFileSync(cancelFile, '', { flag: 'wx' });
              return true;
            } catch {
              console.error('Graceful cancellation unavailable; stopping the benchmark.');
              return false;
            }
          },
        }
      );
    } finally {
      await rm(control, { recursive: true, force: true });
    }
    return;
  }
  await runBenchmark(args);
};

if (import.meta.main)
  await runCli(process.argv.slice(2)).catch(async error => {
    const { toWorkflowErrorDiagnostic } = await import(
      '../apps/backend/src/workflows/workflowErrorDiagnostics.js'
    );
    console.error('Benchmark failed; inspect configuration and private paths.');
    console.error(JSON.stringify(toWorkflowErrorDiagnostic(error, { includeContent: false })));
    process.exitCode = 1;
  });
