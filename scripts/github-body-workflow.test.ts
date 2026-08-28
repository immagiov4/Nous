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
  concurrency: {
    'cancel-in-progress': boolean;
    group: string;
  };
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
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(workflow.concurrency).toEqual({
      group: `\${{ github.workflow }}-\${{ github.event.pull_request.number }}`,
      'cancel-in-progress': true,
    });
  });

  test('executes the trusted base revision without persisted credentials', () => {
    const checkout = workflow.jobs.validate.steps.find(
      step => step.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
    );

    expect(checkout?.with).toEqual({
      ref: `\${{ github.event.pull_request.base.sha }}`,
      'persist-credentials': false,
    });
    expect(workflow.jobs.validate.steps[1]).toEqual({
      name: 'Set up Bun',
      uses: 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
      with: { 'bun-version': '1.4.0' },
    });
    expect(workflow.jobs.validate.steps[2]).toEqual({
      name: 'Install trusted dependencies',
      run: 'bun install --frozen-lockfile --ignore-scripts --production',
    });
  });

  test('reads untrusted body text from the event file instead of shell interpolation', () => {
    expect(workflow.jobs.validate.steps).toHaveLength(5);
    expect(workflow.jobs.validate.steps[3]).toEqual({
      name: 'Read body from pull request event',
      env: { BODY_FILE: `\${{ runner.temp }}/pull-request-body.md` },
      run: `node -e "const fs = require('node:fs'); const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); fs.writeFileSync(process.env.BODY_FILE, event.pull_request.body ?? '', 'utf8');"`,
    });
    expect(workflow.jobs.validate.steps[4]).toEqual({
      name: 'Verify remote pull request body',
      env: {
        BODY_FILE: `\${{ runner.temp }}/pull-request-body.md`,
        GH_TOKEN: `\${{ github.token }}`,
        PR_NUMBER: `\${{ github.event.pull_request.number }}`,
        REPOSITORY: `\${{ github.repository }}`,
      },
      run: 'bun scripts/github-body.mjs verify --kind pr --repo "$REPOSITORY" --number "$PR_NUMBER" --body-file "$BODY_FILE"',
    });
  });
});
