import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as z from 'zod';
import type { PlaytestAdapter } from './adapter';
import { type DiagnosticRecord, recordDiagnostic, withDiagnostics } from './diagnostics';
import { runPlaytest } from './runner';
import { filterStories, loadPersonas, loadStories } from './stories';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_ADAPTER = 'e2e/nous/adapter.ts';
const adapterSchema = z.object({
  appDescription: z.function(),
  baseUrl: z.function(),
  locale: z.function(),
  ensureStack: z.function(),
  prepare: z.function(),
  classify: z.function(),
  styleReference: z.function(),
  taxonomy: z.function(),
  taxonomyClasses: z.function(),
  probeClass: z.function(),
  thresholds: z.function(),
});

/** Adapter stories/personas live beside its module; model and provider are explicit choices. */
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    options: {
      id: { type: 'string', multiple: true },
      tag: { type: 'string', multiple: true },
      kind: { type: 'string', multiple: true },
      concurrency: { type: 'string' },
      headed: { type: 'boolean', default: false },
      model: { type: 'string' },
      provider: { type: 'string' },
      seed: { type: 'string' },
      adapter: { type: 'string', default: DEFAULT_ADAPTER },
      'run-dir': { type: 'string' },
    },
  });
  const dataRoot = process.env.NOUS_E2E_DATA;
  if (!dataRoot && !values['run-dir'])
    throw new Error('NOUS_E2E_DATA is unset. Set it to the local playtest data directory.');
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const runDir = values['run-dir']
    ? resolve(values['run-dir'])
    : join(dataRoot as string, 'runs', timestamp);
  const diagnosticRun: DiagnosticRecord = {};
  return withDiagnostics(diagnosticRun, async () => {
    try {
      const adapterPath = resolve(values.adapter);
      const adapterFile = await stat(adapterPath).catch(error => {
        if (error.code === 'ENOENT') {
          recordDiagnostic('adapter-loading', error);
          throw new Error(
            `Adapter module is missing: ${adapterPath}. Provide --adapter with an existing module.`,
            { cause: error }
          );
        }
        throw error;
      });
      if (!adapterFile.isFile()) throw new Error(`Adapter module is not a file: ${adapterPath}.`);
      const concurrency =
        values.concurrency === undefined ? DEFAULT_CONCURRENCY : Number(values.concurrency);
      if (!Number.isSafeInteger(concurrency) || concurrency <= 0)
        throw new Error('--concurrency must be a positive integer.');
      if (!values.model?.trim() || !values.provider?.trim())
        throw new Error('Provide both --model and --provider.');
      const kinds =
        values.kind === undefined
          ? undefined
          : z.array(z.enum(['check', 'mission'])).parse(values.kind);
      const module = await import(pathToFileURL(adapterPath).href);
      const exportedAdapter: unknown = module.default ?? module.adapter;
      if (!adapterSchema.safeParse(exportedAdapter).success) {
        throw new Error(
          'Adapter module must export a PlaytestAdapter as default or named adapter.'
        );
      }
      const adapter = exportedAdapter as PlaytestAdapter;
      const adapterDir = dirname(adapterPath);
      const stories = filterStories(await loadStories(join(adapterDir, 'stories')), {
        ids: values.id,
        tags: values.tag,
        kinds,
      });
      if (stories.length === 0) throw new Error('No stories match the selected filters.');
      const personas = stories.some(story => story.persona)
        ? await loadPersonas(join(adapterDir, 'personas'))
        : new Map();
      // Colons are invalid in Windows filenames; retain the ISO timestamp with filesystem-safe separators.
      const summary = await runPlaytest({
        adapter,
        stories,
        personas,
        concurrency,
        headed: values.headed,
        model: values.model,
        provider: values.provider,
        runDir,
        seed: values.seed,
      });
      console.log(`Playtest reports: ${join(summary.runDir, 'summary.html')}`);
      console.log(JSON.stringify(summary.outcomeCounts));
    } catch (error) {
      recordDiagnostic('cli', error);
      try {
        await mkdir(runDir, { recursive: true });
        const summaryPath = join(runDir, 'summary.json');
        const existing = await readFile(summaryPath, 'utf8')
          .then(JSON.parse)
          .catch((cause: NodeJS.ErrnoException) => {
            if (cause.code === 'ENOENT') return {};
            throw cause;
          });
        await writeFile(
          summaryPath,
          JSON.stringify(
            {
              ...existing,
              diagnostics: {
                ...existing.diagnostics,
                ...diagnosticRun.diagnostics,
              },
            },
            null,
            2
          )
        );
      } catch (cause) {
        recordDiagnostic('cli-persistence', cause);
      }
      throw error;
    }
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    recordDiagnostic('cli-exit', error);
    console.error(error instanceof Error ? error.message : 'Playtest failed.');
    process.exitCode = 1;
  }
}
