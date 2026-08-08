import { describe, expect, test } from 'vitest';

import {
  classifyWorkflowDefinitionDeployment,
  reconcileUnavailableWorkflowDefinitions,
  type WorkflowDefinitionBoundary,
  type WorkflowDefinitionDeployment,
  type WorkflowDefinitionDeploymentState,
  type WorkflowDefinitionReconciliationStore,
} from '../../src/workflows/workflowDefinitionReconciler.js';

const available: WorkflowDefinitionBoundary = {
  definitionHash: 'a'.repeat(64),
  definitionHashVersion: 1,
  workflowId: 'available',
};

const removed: WorkflowDefinitionBoundary = {
  definitionHash: 'b'.repeat(64),
  definitionHashVersion: 1,
  workflowId: 'available',
};

const deployment = (
  current: WorkflowDefinitionBoundary,
  supportedDefinitions: readonly WorkflowDefinitionBoundary[] = [current]
): WorkflowDefinitionDeployment => ({ current, supportedDefinitions });

const deploymentState = (
  current: WorkflowDefinitionDeployment,
  previous: WorkflowDefinitionDeployment | null = null
): WorkflowDefinitionDeploymentState => ({ current, previous });

describe('workflow definition deployment classification', () => {
  const versionOne = {
    definitionHash: '1'.repeat(64),
    definitionHashVersion: 1,
    workflowId: 'rolling',
  } satisfies WorkflowDefinitionBoundary;
  const versionTwo = {
    definitionHash: '2'.repeat(64),
    definitionHashVersion: 1,
    workflowId: 'rolling',
  } satisfies WorkflowDefinitionBoundary;
  const unrelated = {
    definitionHash: '3'.repeat(64),
    definitionHashVersion: 1,
    workflowId: 'rolling',
  } satisfies WorkflowDefinitionBoundary;

  test('initializes the first deployment and keeps an identical replica authoritative', () => {
    expect(classifyWorkflowDefinitionDeployment(null, deployment(versionOne))).toBe('initialize');
    expect(
      classifyWorkflowDefinitionDeployment(
        deploymentState(deployment(versionOne)),
        deployment(versionOne)
      )
    ).toBe('unchanged');
  });

  test('promotes a new current definition that can resume the deployed current', () => {
    expect(
      classifyWorkflowDefinitionDeployment(
        deploymentState(deployment(versionOne)),
        deployment(versionTwo, [versionTwo, versionOne])
      )
    ).toBe('promote');
  });

  test('promotes removal of a resumable definition without letting an old replica restore it', () => {
    const withPrevious = deployment(versionTwo, [versionTwo, versionOne]);
    const afterKillSwitch = deployment(versionTwo);

    expect(
      classifyWorkflowDefinitionDeployment(deploymentState(withPrevious), afterKillSwitch)
    ).toBe('promote');
    expect(
      classifyWorkflowDefinitionDeployment(
        deploymentState(afterKillSwitch, withPrevious),
        withPrevious
      )
    ).toBe('stale');
  });

  test('keeps an old replica stale after a rolling deployment and rejects unrelated lineage', () => {
    const current = deployment(versionTwo, [versionTwo, versionOne]);

    expect(
      classifyWorkflowDefinitionDeployment(
        deploymentState(current, deployment(versionOne)),
        deployment(versionOne)
      )
    ).toBe('stale');
    expect(
      classifyWorkflowDefinitionDeployment(
        deploymentState(current, deployment(versionOne)),
        deployment(unrelated)
      )
    ).toBe('conflict');
  });
});

describe('workflow definition reconciler', () => {
  test('fails every active run for a removed definition and leaves registered work alone', async () => {
    const failedByBoundary = new Map([[removed.definitionHash, ['run-1', 'run-2']]]);
    let candidateChangedBeforeLock = true;
    const store: WorkflowDefinitionReconciliationStore = {
      activateDeployments: async deployments => deployments,
      failNextRun: async boundary => {
        if (candidateChangedBeforeLock) {
          candidateChangedBeforeLock = false;
          return { status: 'retry' };
        }
        const runId = failedByBoundary.get(boundary.definitionHash)?.shift();
        return runId ? { runId, status: 'failed' } : { status: 'empty' };
      },
      listActiveBoundaries: async () => [available, removed],
    };
    const registry = {
      listDefinitionDeployments: () => [deployment(available)],
      resolve: (workflowId: string, definitionHash: string) =>
        workflowId === available.workflowId && definitionHash === available.definitionHash
          ? available
          : null,
    };

    await expect(reconcileUnavailableWorkflowDefinitions({ registry, store })).resolves.toEqual([
      'run-1',
      'run-2',
    ]);
    expect(failedByBoundary.get(removed.definitionHash)).toEqual([]);
  });

  test('treats a matching hash with an incompatible hash version as unavailable', async () => {
    const failedRuns = ['run-incompatible'];
    const store: WorkflowDefinitionReconciliationStore = {
      activateDeployments: async deployments => deployments,
      failNextRun: async () => {
        const runId = failedRuns.shift();
        return runId ? { runId, status: 'failed' } : { status: 'empty' };
      },
      listActiveBoundaries: async () => [removed],
    };
    const registry = {
      listDefinitionDeployments: () => [deployment(removed)],
      resolve: () => ({ ...removed, definitionHashVersion: 2 }),
    };

    await expect(reconcileUnavailableWorkflowDefinitions({ registry, store })).resolves.toEqual([
      'run-incompatible',
    ]);
  });
});
