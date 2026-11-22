import { execFileSync } from 'node:child_process';
import { lstatSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import postgres from 'postgres';
import {
  createProductionRegistry,
  WORKFLOW_SET_VERSION,
} from '../apps/backend/src/workflows/runtime/workflowRuntimeComposition.js';
import type { WorkflowDefinitionDeployment } from '../apps/backend/src/workflows/types.js';

const workflowRegistryScope = 'nous-reader';
const repositoryRoot = resolve(import.meta.dirname, '..');
const fixturesDirectory = resolve(repositoryRoot, 'apps/backend/tests/workflows/fixtures');

function resolveFixtureName(name: string, extension: '.json' | '.txt'): string {
  const filename = basename(name);
  const destination = resolve(fixturesDirectory, filename);
  if (
    filename !== name ||
    extname(filename) !== extension ||
    !/^[\w-]+\.(?:json|txt)$/u.test(filename) ||
    !destination.startsWith(`${fixturesDirectory}${sep}`)
  ) {
    throw new Error(`Use a plain ${extension} filename in the workflow fixtures directory.`);
  }
  const existing = lstatSync(destination, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.nlink !== 1)) {
    throw new Error('The fixture destination must be a regular, unlinked file.');
  }
  return destination;
}

function readCheckout(gitPath: string | null, revision = 'HEAD') {
  if (!gitPath || !isAbsolute(gitPath))
    throw new Error('Could not resolve an absolute Git executable.');

  const git = (...args: string[]) =>
    execFileSync(gitPath, args, { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });
  const migrationDirectory = 'supabase/migrations/';
  git('diff', 'HEAD', '--quiet');
  const commit = git('rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`).trim();
  const migrations = git('ls-tree', '-r', '--name-only', commit, migrationDirectory)
    .split(/\r?\n/u)
    .filter(path => path.endsWith('.sql'))
    .map(path => path.slice(migrationDirectory.length));
  return { commit, migrations };
}

function serializeDeploymentFixture(
  { commit, migrations }: ReturnType<typeof readCheckout>,
  workflowSetVersion: number,
  deployments: readonly WorkflowDefinitionDeployment[]
): string {
  return `${JSON.stringify({ commit, workflowSetVersion, migrations, deployments }, null, 2)}\n`;
}

interface DeploymentRow {
  current_version: string;
  current_manifest: unknown;
  previous_version: string | null;
  previous_manifest: unknown;
}

async function readPersistedDeployment(databaseUrl: string) {
  try {
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      return await sql.begin('isolation level repeatable read read only', async transaction => {
        const [registry] = await transaction<DeploymentRow[]>`
          select current_workflow_set_version::text as current_version, current_manifest,
                 previous_workflow_set_version::text as previous_version, previous_manifest
          from public.workflow_definition_registry_deployments
          where registry_scope = ${workflowRegistryScope}
        `;
        const applied = await transaction<Array<{ version: string }>>`
          select version from supabase_migrations.schema_migrations order by version
        `;
        return { registry, applied };
      });
    } finally {
      await sql.end();
    }
  } catch {
    // PostgreSQL connection errors can contain the complete URL and credentials.
    throw new Error(
      'Could not export deployment history. Check DATABASE_URL and read permissions.'
    );
  }
}

type CaptureRequest =
  | { mode: 'local'; manifestPath: string }
  | { mode: 'persisted'; manifestPath: string; versionsPath: string; releasedCommit?: string };

function parseCaptureArguments(args: readonly string[]): CaptureRequest {
  const [manifestPath, versionsPath, selector, releasedCommit] = args;
  if (manifestPath === '--local' && versionsPath && args.length === 2) {
    return { mode: 'local', manifestPath: resolveFixtureName(versionsPath, '.json') };
  }
  const previous = selector === '--previous' && Boolean(releasedCommit) && args.length === 4;
  if (
    !manifestPath ||
    manifestPath === '--local' ||
    !versionsPath ||
    (args.length !== 2 && !previous)
  ) {
    throw new Error(
      'Expected <manifest.json> <applied-versions.txt> [--previous <released-commit>], or --local <manifest.json>.'
    );
  }
  return {
    mode: 'persisted',
    manifestPath: resolveFixtureName(manifestPath, '.json'),
    versionsPath: resolveFixtureName(versionsPath, '.txt'),
    releasedCommit,
  };
}

export async function captureWorkflowDeployment(
  args: readonly string[],
  gitPath: string | null,
  databaseUrl: string | undefined
): Promise<void> {
  const request = parseCaptureArguments(args);
  if (request.mode === 'local') {
    const checkout = readCheckout(gitPath);
    const deployments = createProductionRegistry().listDefinitionDeployments();
    writeFileSync(
      request.manifestPath,
      serializeDeploymentFixture(checkout, WORKFLOW_SET_VERSION, deployments)
    );
    return;
  }
  const { manifestPath, versionsPath, releasedCommit } = request;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for a persisted deployment export.');

  const checkout = readCheckout(gitPath, releasedCommit);
  const { registry, applied } = await readPersistedDeployment(databaseUrl);
  const version = releasedCommit ? registry?.previous_version : registry?.current_version;
  const manifest = releasedCommit ? registry?.previous_manifest : registry?.current_manifest;
  if (!version) throw new Error('The requested deployment is absent from the registry.');
  const workflowSetVersion = Number(version);
  if (!Number.isSafeInteger(workflowSetVersion) || workflowSetVersion < 1) {
    throw new Error('The deployed workflow-set version is invalid.');
  }
  if (!releasedCommit && workflowSetVersion !== WORKFLOW_SET_VERSION) {
    throw new Error('Check out the deployed commit for the selected workflow-set version.');
  }
  const { parseDefinitionManifest } = await import(
    '../apps/backend/src/workflows/workflowDefinitionReconciler.js'
  );
  const deployments = parseDefinitionManifest(manifest);
  writeFileSync(
    manifestPath,
    serializeDeploymentFixture(checkout, workflowSetVersion, deployments)
  );
  writeFileSync(versionsPath, `${applied.map(({ version }) => version).join('\n')}\n`);
}

if (import.meta.main) {
  await captureWorkflowDeployment(
    process.argv.slice(2),
    Bun.which('git'),
    process.env.DATABASE_URL
  );
}
