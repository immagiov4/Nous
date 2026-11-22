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
  concurrency?: {
    'cancel-in-progress': boolean;
    group: string;
  };
  env?: Record<string, string>;
  if?: string;
  needs?: string[];
  steps: WorkflowStep[];
};

type WorkflowConfig = {
  concurrency: {
    'cancel-in-progress': string;
    group: string;
  };
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
    expect(workflow.concurrency).toEqual({
      'cancel-in-progress': `\${{ github.event_name == 'pull_request' }}`,
      group: `\${{ github.workflow }}-\${{ github.event.pull_request.number || github.run_id }}`,
    });
    for (const aggregate of ['test', 'browser-proofs', 'quality-coverage']) {
      expect(workflow.jobs[aggregate].concurrency).toBeUndefined();
    }
    expect(workflow.jobs['supabase-contract'].concurrency).toEqual({
      'cancel-in-progress': true,
      group: `\${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}-supabase`,
    });
  });

  test('merges coverage after independent producers and keeps all browser proofs', async () => {
    const quality = workflow.jobs['quality-coverage'];
    const playback = workflow.jobs['playback-proofs'];
    const sourcePreparation = workflow.jobs['source-preparation-proofs'];
    const shards = workflow.jobs['vitest-coverage-shard'];
    const staticChecks = workflow.jobs['static-checks'];
    const python = workflow.jobs['python-coverage'];
    expect(quality.needs).toEqual(['static-checks', 'vitest-coverage-shard', 'python-coverage']);
    expect(workflow.jobs['browser-proofs'].needs).toEqual([
      'playback-proofs',
      'source-preparation-proofs',
    ]);
    for (const worker of [shards, staticChecks, python, playback, sourcePreparation]) {
      expect(worker.needs).toBeUndefined();
      expect(worker.if).toBeUndefined();
      expect(worker.steps[0].with?.ref).toBe(
        `\${{ github.event.pull_request.head.sha || github.sha }}`
      );
    }
    expect(shards.steps.some(step => step.run?.includes('--reporter=blob'))).toBe(true);
    expect(staticChecks.steps.some(step => step.run === 'bun run gate:checks')).toBe(true);
    const pythonCommand = python.steps.find(step =>
      step.run?.includes('scripts/source-shelf/tests/coverage_blender.py')
    );
    expect(pythonCommand?.run).toContain('python3 scripts/source-shelf/tests/coverage_encoder.py');
    const mergeIndex = quality.steps.findIndex(step => step.id === 'merge');
    expect(quality.steps[mergeIndex]?.run).toContain('--merge-reports vitest-reports');
    expect(quality.if).toBe(`\${{ !cancelled() }}`);
    expect(quality.steps[0].if).toBe("needs.vitest-coverage-shard.result != 'success'");
    const sonarPrerequisitesIndex = quality.steps.findIndex(
      step => step.name === 'Require static checks and Python coverage'
    );
    const sonarPrerequisites = quality.steps[sonarPrerequisitesIndex];
    expect(sonarPrerequisites?.env).toEqual({
      STATIC_RESULT: `\${{ needs.static-checks.result }}`,
      PYTHON_RESULT: `\${{ needs.python-coverage.result }}`,
    });
    expect(mergeIndex).toBeLessThan(sonarPrerequisitesIndex);
    expect(sonarPrerequisitesIndex).toBeLessThan(
      quality.steps.findIndex(step => step.name === 'SonarQube Cloud scan and quality gate')
    );
    const browser = workflow.jobs['browser-proofs'];
    expect(browser.if).toBe('always()');
    expect(browser.steps[0].env).toEqual({
      PLAYBACK_RESULT: `\${{ needs.playback-proofs.result }}`,
      SOURCE_PREPARATION_RESULT: `\${{ needs.source-preparation-proofs.result }}`,
    });
    for (const [step, environment] of [
      [sonarPrerequisites, { STATIC_RESULT: 'success', PYTHON_RESULT: 'success' }],
      [browser.steps[0], { PLAYBACK_RESULT: 'success', SOURCE_PREPARATION_RESULT: 'success' }],
    ] as const) {
      expect(step?.shell).toBe('node {0}');
      const run = (results: Record<string, string>) =>
        spawnSync('node', ['-e', step?.run ?? ''], {
          env: { ...process.env, ...results },
          windowsHide: true,
        }).status;
      expect(run(environment)).toBe(0);
      for (const producer of Object.keys(environment)) {
        for (const result of ['failure', 'cancelled', 'skipped']) {
          expect(run({ ...environment, [producer]: result })).toBe(1);
        }
      }
    }
    const commands = playback.steps.flatMap(step => (step.run ? [step.run] : []));
    expect(playback.steps.filter(step => step.run).every(step => step.if === undefined)).toBe(true);

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
      'bun --tsconfig-override e2e/nous/tsconfig.json apps/web/tests/components/shared/GuidedStepAlignment.browser.tsx',
      'bun scripts/heavy-run.mjs --label playback-bar -- node apps/web/tests/components/workspace/PlaybackBarLayout.browser.ts',
      'node apps/web/tests/components/workspace/PlaybackFocus.browser.ts',
      'bun run test:interview-recovery',
    ]);
    expect(sourcePreparation.steps.flatMap(step => (step.run ? [step.run] : []))).toEqual([
      'bun install --frozen-lockfile',
      'bunx playwright install --with-deps chromium firefox',
      'bun run test:source-preparation-shelf',
      'bun run test:source-preparation-shelf',
    ]);
    expect(
      playback.steps.find(
        step => step.name === 'Verify interview draft recovery through the library'
      )?.env
    ).toEqual({
      NOUS_E2E_DATA: `\${{ runner.temp }}/nous-recovery`,
    });
    expect(
      playback.steps.findIndex(step => step.name === 'Upload interview recovery evidence')
    ).toBeGreaterThan(
      playback.steps.findIndex(
        step => step.name === 'Verify interview draft recovery through the library'
      )
    );
    expect(playback.steps.find(step => step.name === 'Upload interview recovery evidence')).toEqual(
      {
        name: 'Upload interview recovery evidence',
        if: 'always()',
        uses: 'actions/upload-artifact@v4',
        with: {
          name: 'interview-recovery',
          overwrite: true,
          path: `\${{ runner.temp }}/nous-recovery/interview-recovery`,
          'if-no-files-found': 'ignore',
        },
      }
    );
    expect(
      sourcePreparation.steps.find(
        step => step.name === 'Verify source-preparation motion and lifecycle'
      )
    ).toEqual({
      name: 'Verify source-preparation motion and lifecycle',
      env: { NOUS_E2E_DATA: `\${{ runner.temp }}/nous-source-preparation` },
      run: 'bun run test:source-preparation-shelf',
    });
    expect(
      sourcePreparation.steps.find(
        step => step.name === 'Verify source-preparation playback in Firefox'
      )
    ).toEqual({
      name: 'Verify source-preparation playback in Firefox',
      env: {
        NOUS_E2E_DATA: `\${{ runner.temp }}/nous-source-preparation-firefox`,
        SHELF_BROWSER: 'firefox',
        SHELF_SCENE: 'desktop-light',
      },
      run: 'bun run test:source-preparation-shelf',
    });
    expect(sourcePreparation.steps.at(-1)).toEqual({
      name: 'Upload source-preparation evidence',
      if: 'always()',
      uses: 'actions/upload-artifact@v4',
      with: {
        name: 'source-preparation',
        overwrite: true,
        path: [
          `\${{ runner.temp }}/nous-source-preparation/source-preparation-shelf`,
          `\${{ runner.temp }}/nous-source-preparation-firefox/source-preparation-shelf`,
          '',
        ].join('\n'),
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
        if: "always() && steps.merge.outcome == 'success'",
        uses: 'actions/upload-artifact@v4',
        with: {
          name: `coverage-\${{ github.event.pull_request.head.sha || github.sha }}`,
          path: 'coverage/lcov.info',
          overwrite: true,
          'if-no-files-found': 'error',
        },
      },
    ]);
    const allCommands = Object.values(workflow.jobs)
      .flatMap(job => job.steps)
      .map(step => step.run);
    expect(allCommands.filter(command => command === 'bun run gate:checks')).toHaveLength(1);
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
