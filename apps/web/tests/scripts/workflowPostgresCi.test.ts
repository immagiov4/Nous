import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  concurrency: {
    'cancel-in-progress': boolean;
    group: string;
  };
  env?: Record<string, string>;
  if?: string;
  steps: WorkflowStep[];
};

type WorkflowConfig = {
  jobs: Record<string, WorkflowJob>;
  on: {
    pull_request: unknown;
    push: { branches: string[] };
  };
  permissions: { contents: string };
};

const workflow = parse(readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')) as WorkflowConfig;
const packageScripts = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).scripts as Record<
  string,
  string
>;
const testSteps = workflow.jobs.test.steps;
const supabaseSteps = workflow.jobs['supabase-contract'].steps;

function requireStep(name: string): WorkflowStep {
  const step = supabaseSteps.find(candidate => candidate.name === name);
  expect(step, `Missing CI step: ${name}`).toBeDefined();
  return step as WorkflowStep;
}

describe('workflow PostgreSQL CI contract', () => {
  test('runs pull request branches once and cancels superseded runs', () => {
    expect(workflow.on.push.branches).toEqual(['main']);
    expect(workflow.on.pull_request).toBeNull();
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.test.concurrency).toEqual({
      'cancel-in-progress': true,
      group: `\${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}-test`,
    });
    expect(workflow.jobs['supabase-contract'].concurrency).toEqual({
      'cancel-in-progress': true,
      group: `\${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}-supabase`,
    });
  });

  test('runs only the CI quality, Fallow, and complete Bun suite commands', () => {
    const commands = testSteps.flatMap(step => (step.run ? [step.run] : []));

    expect(commands).toEqual([
      'bun install --frozen-lockfile',
      'bun run quality:ci',
      'bun run check:fallow:ci',
      'bun run test',
    ]);
  });

  test('keeps staging credentials on trusted main pushes', () => {
    const managedStagingJob = workflow.jobs['managed-staging-contract'];
    const checkout = managedStagingJob.steps.find(step => step.name === 'Checkout');
    const credentialsCondition =
      "env.DATABASE_URL != '' && env.SUPABASE_JWT_SECRET != '' && env.SUPABASE_URL != ''";

    expect(managedStagingJob.if).toBe(
      "github.event_name == 'push' && github.ref == 'refs/heads/main'"
    );
    expect(managedStagingJob.env).toEqual({
      DATABASE_URL: `\${{ secrets.SUPABASE_STAGING_DATABASE_URL }}`,
      SUPABASE_JWT_SECRET: `\${{ secrets.SUPABASE_STAGING_JWT_SECRET }}`,
      SUPABASE_URL: `\${{ secrets.SUPABASE_STAGING_URL }}`,
    });
    expect(managedStagingJob.concurrency).toEqual({
      'cancel-in-progress': false,
      group: `\${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}-managed-staging`,
    });
    expect(managedStagingJob.steps).not.toHaveLength(0);
    expect(managedStagingJob.steps.every(step => step.if === credentialsCondition)).toBe(true);
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });

  test('uses the canonical Supabase contract without the retired source migrator', () => {
    const canonicalContract = requireStep('Run Canonical Auth/RLS Contract');
    const workflowCommands = Object.values(workflow.jobs)
      .flatMap(job => job.steps)
      .flatMap(step => (step.run ? [step.run] : []));

    expect(canonicalContract.run).toBe('bun run test:supabase-contract');
    expect(workflowCommands.join('\n')).not.toContain('migrate-project-sources-to-storage');
  });

  test('selects relevant pull request changes from the complete base-to-head diff', () => {
    const checkout = requireStep('Checkout');
    const selector = requireStep('Select Workflow PostgreSQL Contract');

    expect(checkout.with?.['fetch-depth']).toBe(0);
    expect(selector.id).toBe('workflow-postgres');
    expect(selector.if).toBe("github.event_name == 'pull_request'");
    expect(selector.env).toEqual({
      BASE_SHA: `\${{ github.event.pull_request.base.sha }}`,
      HEAD_SHA: `\${{ github.event.pull_request.head.sha }}`,
    });
    expect(selector.run).toBe(
      [
        'set -o pipefail',
        'git diff --name-only --no-renames -z "$BASE_SHA" "$HEAD_SHA" | \\',
        '  bun run scripts/select-workflow-postgres-contract.ts',
        '',
      ].join('\n')
    );
  });

  test('runs the load-bearing workflow stores and crash recovery for selected pull requests', () => {
    const step = requireStep('Run Critical Workflow PostgreSQL Contract');

    expect(step.if).toBe(
      "github.event_name == 'pull_request' && steps.workflow-postgres.outputs.changed == 'true'"
    );
    expect(step.run).toContain('bunx supabase status -o env');
    expect(step.run).toContain('WORKFLOW_INTEGRATION_DATABASE_URL="$DB_URL"');
    expect(step.run).toContain('bun run test:workflow-postgres:critical');
    expect(packageScripts['test:workflow-postgres:critical']).toBe(
      'bun run scripts/run-workflow-postgres-contract.ts critical'
    );
  });

  test('runs the complete deterministic PostgreSQL contract on main', () => {
    const step = requireStep('Run Full Workflow PostgreSQL Contract');

    expect(step.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(step.run).toContain('bunx supabase status -o env');
    expect(step.run).toContain('WORKFLOW_INTEGRATION_DATABASE_URL="$DB_URL"');
    expect(step.run).toContain('bun run test:workflow-postgres');
    expect(packageScripts['test:workflow-postgres']).toBe(
      'bun run scripts/run-workflow-postgres-contract.ts full'
    );
  });

  test('keeps real-provider workflow tests outside CI', () => {
    const workflowCommands = Object.values(workflow.jobs)
      .flatMap(job => job.steps)
      .flatMap(step => (step.run ? [step.run] : []));

    expect(workflowCommands.join('\n')).not.toContain('test:workflow-codex');
  });
});
