import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { probePackageScripts } from '../../../../scripts/package-script-probe';

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string;
  id?: string;
  name?: string;
  run?: string;
  shell?: string;
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
  needs?: string[];
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
    for (const job of ['test', 'quality-coverage', 'browser-proofs']) {
      expect(workflow.jobs[job]?.concurrency).toEqual({
        'cancel-in-progress': true,
        group: `\${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}-${job}`,
      });
    }
    expect(workflow.jobs['supabase-contract'].concurrency).toEqual({
      'cancel-in-progress': true,
      group: `\${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}-supabase`,
    });
  });

  test('runs browser proofs independently of the single coverage and Sonar worker', async () => {
    const quality = workflow.jobs['quality-coverage'];
    const browser = workflow.jobs['browser-proofs'];
    expect(quality).toBeDefined();
    expect(browser).toBeDefined();
    for (const worker of [quality, browser]) {
      expect(worker.needs).toBeUndefined();
      expect(worker.if).toBeUndefined();
      expect(worker.steps.slice(0, 4)).toEqual([
        {
          name: 'Checkout',
          uses: 'actions/checkout@v4',
          with: {
            ref: `\${{ github.event.pull_request.head.sha || github.sha }}`,
            ...(worker === quality ? { 'fetch-depth': 0 } : {}),
            'persist-credentials': false,
          },
        },
        {
          name: 'Setup Node',
          uses: 'actions/setup-node@v4',
          with: { 'node-version-file': '.node-version' },
        },
        { name: 'Setup Bun', uses: 'oven-sh/setup-bun@v2' },
        { name: 'Install Dependencies', run: 'bun install --frozen-lockfile' },
      ]);
    }
    expect(quality.steps.flatMap(step => (step.run ? [step.run] : []))).toEqual([
      'bun install --frozen-lockfile',
      'bunx playwright install --with-deps chromium',
      'bun run gate:ci',
    ]);
    const commands = browser.steps.flatMap(step => (step.run ? [step.run] : []));

    expect(commands).toEqual([
      'bun install --frozen-lockfile',
      'bunx playwright install --with-deps chromium firefox',
      [
        'sudo apt-get install --yes pulseaudio',
        'pulseaudio --start',
        "trap 'pulseaudio --kill || true' EXIT",
        'pactl load-module module-null-sink sink_name=nous_playback',
        'pactl set-default-sink nous_playback',
        'bun run test:audio-production',
        '',
      ].join('\n'),
      'bun run test:caption-rows',
      'bun apps/web/tests/components/workspace/PlaybackFocus.browser.ts',
      'bun run test:interview-recovery',
    ]);
    expect(
      browser.steps.find(
        step => step.name === 'Verify interview draft recovery through the library'
      )?.env
    ).toEqual({
      NOUS_E2E_DATA: `\${{ runner.temp }}/nous-recovery`,
    });
    expect(browser.steps.at(-1)).toEqual({
      name: 'Upload interview recovery evidence',
      if: 'always()',
      uses: 'actions/upload-artifact@v4',
      with: {
        name: 'interview-recovery',
        path: `\${{ runner.temp }}/nous-recovery/interview-recovery`,
        'if-no-files-found': 'ignore',
      },
    });
    expect(quality.steps.slice(-2)).toEqual([
      {
        name: 'SonarQube Cloud scan and quality gate',
        if: "github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository",
        uses: 'SonarSource/sonarqube-scan-action@d209202bc7d53ff1cc128f7f907dac145c9d6ae9',
        env: {
          SONAR_TOKEN: `\${{ secrets.SONAR_TOKEN }}`,
          SONAR_HOST_URL: 'https://sonarcloud.io',
        },
        with: {
          projectBaseDir: '',
          args: `-Dproject.settings=config/sonar-project.properties -Dsonar.organization=\${{ vars.SONAR_ORGANIZATION }} -Dsonar.projectKey=\${{ vars.SONAR_PROJECT_KEY }} -Dsonar.scm.revision=\${{ github.event.pull_request.head.sha || github.sha }} -Dsonar.eslint.reportPaths=.temp/sonar/eslint-report.json`,
        },
      },
      {
        name: 'Upload coverage for parity comparison',
        if: 'always()',
        uses: 'actions/upload-artifact@v4',
        with: {
          name: `coverage-\${{ github.event.pull_request.head.sha || github.sha }}`,
          path: 'coverage/lcov.info',
          'if-no-files-found': 'error',
        },
      },
    ]);
    const allCommands = Object.values(workflow.jobs)
      .flatMap(job => job.steps)
      .map(step => step.run);
    expect(allCommands.filter(command => command === 'bun run gate:ci')).toHaveLength(1);
    expect(await probePackageScripts(['gate:ci'])).toEqual([
      'quality:ci',
      'check:fallow:ci',
      'test:coverage',
    ]);
  });

  test('always evaluates the existing test check after both workers', () => {
    expect(workflow.jobs.test.if).toBe('always()');
    expect(workflow.jobs.test.needs).toEqual(['quality-coverage', 'browser-proofs']);
    expect(workflow.jobs.test.steps).toHaveLength(1);
    expect(workflow.jobs.test.steps[0].shell).toBe('node {0}');
    expect(workflow.jobs.test.steps[0].env).toEqual({
      QUALITY_RESULT: `\${{ needs.quality-coverage.result }}`,
      BROWSER_RESULT: `\${{ needs.browser-proofs.result }}`,
    });
  });

  const workerResults = ['success', 'failure', 'cancelled', 'skipped'];
  test.each(
    workerResults.flatMap(quality => workerResults.map(browser => [quality, browser]))
  )('aggregates quality=%s and browser=%s with real failure propagation', (quality, browser) => {
    const command = workflow.jobs.test.steps[0].run;
    expect(command).toBeDefined();
    const result = spawnSync('node', ['-e', command as string], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, QUALITY_RESULT: quality, BROWSER_RESULT: browser },
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`quality-coverage: ${quality}`);
    expect(result.stdout).toContain(`browser-proofs: ${browser}`);
    expect(result.status).toBe(quality === 'success' && browser === 'success' ? 0 : 1);
  });

  test('validates dependencies through the backend build without a redundant export', () => {
    expect(
      workflow.jobs['docker-dependencies'].steps.map(step => step.run).filter(Boolean)
    ).toEqual(['docker build --target backend .']);
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

  test('runs the load-bearing workflow stores and crash recovery for selected pull requests', async () => {
    const step = requireStep('Run Critical Workflow PostgreSQL Contract');

    expect(step.if).toBe(
      "github.event_name == 'pull_request' && steps.workflow-postgres.outputs.changed == 'true'"
    );
    expect(step.run).toContain('bunx supabase status -o env');
    expect(step.run).toContain('WORKFLOW_INTEGRATION_DATABASE_URL="$DB_URL"');
    expect(step.run).toContain('bun run test:workflow-postgres:critical');
    expect(await probePackageScripts(['test:workflow-postgres:critical'])).toEqual(['critical']);
  });

  test('runs the complete deterministic PostgreSQL contract on main', async () => {
    const step = requireStep('Run Full Workflow PostgreSQL Contract');

    expect(step.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(step.run).toContain('bunx supabase status -o env');
    expect(step.run).toContain('WORKFLOW_INTEGRATION_DATABASE_URL="$DB_URL"');
    expect(step.run).toContain('bun run test:workflow-postgres');
    expect(await probePackageScripts(['test:workflow-postgres'])).toEqual(['full']);
  });

  test('keeps real-provider workflow tests outside CI', () => {
    const workflowCommands = Object.values(workflow.jobs)
      .flatMap(job => job.steps)
      .flatMap(step => (step.run ? [step.run] : []));

    expect(workflowCommands.join('\n')).not.toContain('test:workflow-providers');
  });
});
