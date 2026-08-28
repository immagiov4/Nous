import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs: {
    validate: {
      name: string;
      steps: WorkflowStep[];
    };
  };
  on: {
    pull_request_target: {
      types: string[];
    };
  };
  permissions: Record<string, string>;
};

const workflow = parse(
  readFileSync(resolve('.github/workflows/pull-request-body.yml'), 'utf8')
) as Workflow;

describe('pull request body workflow security contract', () => {
  test('runs only for remote pull request body lifecycle events with read-only permissions', () => {
    expect(workflow.on).toEqual({
      pull_request_target: { types: ['opened', 'edited', 'reopened'] },
    });
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  test('executes the trusted base revision without persisted credentials', () => {
    const checkout = workflow.jobs.validate.steps.find(
      step => step.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
    );

    expect(checkout?.with).toEqual({
      ref: `\${{ github.event.pull_request.base.sha }}`,
      'persist-credentials': false,
    });
  });

  test('reads untrusted body text from the event file instead of shell interpolation', () => {
    const commands = workflow.jobs.validate.steps
      .flatMap(step => (step.run ? [step.run] : []))
      .join('\n');

    expect(commands).toContain('process.env.GITHUB_EVENT_PATH');
    expect(commands).toContain('node scripts/github-body.mjs validate --body-file');
    expect(commands).not.toContain('github.event.pull_request.body');
  });
});
