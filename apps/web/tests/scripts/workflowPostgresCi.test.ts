import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

type WorkflowStep = {
  if?: string;
  name?: string;
  run?: string;
};

type WorkflowConfig = {
  jobs: Record<string, { steps: WorkflowStep[] }>;
};

const workflow = parse(readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')) as WorkflowConfig;
const supabaseSteps = workflow.jobs['supabase-contract'].steps;

function requireStep(name: string): WorkflowStep {
  const step = supabaseSteps.find(candidate => candidate.name === name);
  expect(step, `Missing CI step: ${name}`).toBeDefined();
  return step as WorkflowStep;
}

describe('workflow PostgreSQL CI contract', () => {
  test('runs the load-bearing workflow stores and crash recovery on pull requests', () => {
    const step = requireStep('Run Critical Workflow PostgreSQL Contract');

    expect(step.if).toBe("github.event_name == 'pull_request'");
    expect(step.run).toContain('bunx supabase status -o env');
    expect(step.run).toContain('WORKFLOW_INTEGRATION_DATABASE_URL="$DB_URL"');
    expect(step.run).toContain('RUN_WORKFLOW_INTEGRATION_TESTS=1');
    expect(step.run).toContain('postgresWorkflowRunStore.integration.test.ts');
    expect(step.run).toContain('postgresWorkflowExecutionStore.integration.test.ts');
    expect(step.run).toContain('postgresWorkflowSignalStore.integration.test.ts');
    expect(step.run).toContain('workflowProcessCrash.integration.test.ts');
  });

  test('runs the complete deterministic PostgreSQL contract on main', () => {
    const step = requireStep('Run Full Workflow PostgreSQL Contract');

    expect(step.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(step.run).toContain('bunx supabase status -o env');
    expect(step.run).toContain('WORKFLOW_INTEGRATION_DATABASE_URL="$DB_URL"');
    expect(step.run).toContain('bun run test:workflow-postgres');
  });

  test('keeps real-provider workflow tests outside CI', () => {
    const workflowCommands = Object.values(workflow.jobs)
      .flatMap(job => job.steps)
      .flatMap(step => (step.run ? [step.run] : []));

    expect(workflowCommands.join('\n')).not.toContain('test:workflow-codex');
  });
});
