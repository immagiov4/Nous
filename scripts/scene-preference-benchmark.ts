import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as z from 'zod';
import { GENERATABLE_LESSON_SCENE_TYPES } from '../packages/shared-types/lessonScene.js';

/**
 * Run: bun --tsconfig-override apps/backend/tsconfig.json scripts/scene-preference-benchmark.ts
 * --dataset <private.jsonl> --output <new-private.json> --repetitions 3 --run
 * Omit --run for preflight; use --limit N or --cases id,id for a bounded smoke run.
 * Accuracy = preferred / (preferred + rejected); neither, invalid, error and text are separate.
 * This measures uncaptioned generation with the local production defaults/environment, not
 * deployed settings. Labels never reach the model. No workflow, database, icons or renderer runs.
 */

const form = z.union([
  z.enum(GENERATABLE_LESSON_SCENE_TYPES),
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
}

/** Reject malformed input without embedding a private record in the diagnostic. */
export const parseCases = (text: string): PreferenceCase[] => {
  try {
    const cases = text
      .split(/\r?\n/u)
      .filter(line => line.trim())
      .map(line => CaseSchema.parse(JSON.parse(line)));
    if (!cases.length || new Set(cases.map(c => c.id)).size !== cases.length) throw new Error();
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
    const own = trials.filter(t => t.repetition === index + 1);
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
  const failed = trials.filter(t => t.kind === 'error' || t.kind === 'invalid').length;
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
    latencyMs: latencyStats(trials),
    failureRate: ratio(failed, trials.length),
    textFallbackRate: ratio(trials.filter(t => t.kind === 'text').length, trials.length),
    completedTrials: trials.length,
    expectedTrials: decisive.length * repetitions,
  };
};

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outsideRepository = async (path: string) => {
  const canonical = await realpath(path);
  const rel = relative(await realpath(repository), canonical);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel)))
    throw new Error('Use private paths outside the repository.');
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
  } catch (error) {
    if (error === validated) kind = 'scene';
    else if (input.signal.aborted) kind = 'cancelled';
    else {
      kind = 'error';
      // Keep only a bounded technical classification, never a provider message or request body.
      errorClass = error instanceof TypeError ? 'TypeError' : 'ProviderOrGenerationError';
    }
  }
  return {
    id: input.c.id,
    repetition: input.repetition,
    kind,
    ...(chosen ? { chosen } : {}),
    ...(errorClass ? { errorClass } : {}),
    latencyMs: performance.now() - started,
  };
};

const readOptions = () => {
  const { values } = parseArgs({
    options: {
      dataset: { type: 'string' },
      output: { type: 'string' },
      repetitions: { type: 'string', default: '3' },
      limit: { type: 'string' },
      cases: { type: 'string' },
      run: { type: 'boolean' },
    },
  });
  if (!values.dataset || !values.output)
    throw new Error(
      'Usage: bun --tsconfig-override apps/backend/tsconfig.json scripts/scene-preference-benchmark.ts --dataset <private.jsonl> --output <private.json> [--repetitions 3] [--limit N | --cases id,id] [--run]'
    );
  const repetitions = positiveInteger(values.repetitions);
  if (values.limit && values.cases) throw new Error('Choose --limit or --cases.');
  return { ...values, dataset: values.dataset, output: values.output, repetitions };
};

const loadCases = async (values: ReturnType<typeof readOptions>) => {
  await outsideRepository(values.dataset);
  await outsideRepository(dirname(resolve(values.output)));
  try {
    await outsideRepository(values.output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const datasetText = await readFile(values.dataset, 'utf8');
  let cases = parseCases(datasetText);
  if (values.cases) {
    const requested = new Set(values.cases.split(','));
    cases = cases.filter(c => requested.has(c.id));
    if (cases.length !== requested.size) throw new Error('Unknown case selection.');
  }
  if (values.limit) cases = cases.filter(c => !c.tie).slice(0, positiveInteger(values.limit));
  return { cases, datasetText };
};

async function main() {
  const values = readOptions();
  const { repetitions } = values;
  const { cases, datasetText } = await loadCases(values);
  // Environment loading happens in backend imports; clear remote persistence before resolving config.
  const { getResolvedGlobalModelConfig, resolveTextModelConfig } = await import(
    '../apps/backend/src/config/modelConfig.js'
  );
  const { generateLessonScene } = await import(
    '../apps/backend/src/services/lessonScenes/lessonSceneGeneration.js'
  );
  const { resolveLessonVisualModelConfig } = await import(
    '../apps/backend/src/services/lessonVisualModelConfig.js'
  );
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
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
  const metadata = {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
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
  const trials: Trial[] = [];
  const save = async () => {
    const temp = `${values.output}.partial`;
    await writeFile(
      temp,
      JSON.stringify(
        {
          metadata,
          cancelled: abort.signal.aborted,
          summary: summarize(cases, trials, repetitions),
          trials,
        },
        null,
        2
      )
    );
    await rename(temp, values.output as string);
  };
  // Exclusive creation protects a previous run; checkpoints replace only this run's file.
  await writeFile(values.output, '{}', { flag: 'wx' });
  try {
    await save();
    const decisive = cases.filter(c => !c.tie);
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const c of decisive) {
        if (abort.signal.aborted) break;
        trials.push(
          await measureCase({
            c,
            repetition,
            config: visualConfig,
            signal: abort.signal,
            generate: generateLessonScene,
          })
        );
        await save();
        console.log(`Completed ${trials.length}/${cases.filter(c => !c.tie).length * repetitions}`);
      }
      if (abort.signal.aborted) break;
    }
  } finally {
    await save();
    processEvents.removeListener('SIGINT', cancel);
    processEvents.removeListener('SIGTERM', cancel);
  }
  console.table(summarize(cases, trials, repetitions).repetitions);
  console.log(JSON.stringify(summarize(cases, trials, repetitions)));
  if (abort.signal.aborted) process.exitCode = 130;
}

if (import.meta.main)
  await main().catch(() => {
    console.error('Benchmark failed; inspect configuration and private paths.');
    process.exitCode = 1;
  });
