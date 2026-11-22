import type { Sql, TransactionSql } from 'postgres';
import { describe, expect, test, vi } from 'vitest';

import {
  classifyWorkflowDefinitionDeployment,
  PostgresWorkflowDefinitionReconciliationStore,
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

function deployedRegistry(active: WorkflowDefinitionDeployment, registry = [active]) {
  const state: { version: string; registry: unknown; definition: unknown } = {
    version: '1',
    registry,
    definition: active,
  };
  const begin = async <T>(run: (transaction: TransactionSql) => Promise<T>): Promise<T> => {
    const draft = { ...state };
    const query = async (parts: TemplateStringsArray, ...parameters: unknown[]) => {
      const statement = parts.join('?').trim();
      if (statement.startsWith('insert into')) return [];
      if (statement.startsWith('select') && statement.includes('current_manifest')) {
        return [
          {
            current_manifest: draft.registry,
            current_workflow_set_version: draft.version,
            previous_manifest: null,
            previous_workflow_set_version: null,
            removed_workflow_ids: [],
          },
        ];
      }
      if (statement.startsWith('select current_deployment')) {
        return [{ current_deployment: draft.definition, previous_deployment: null }];
      }
      if (statement.startsWith('update public.workflow_definition_registry_deployments')) {
        draft.version = String(parameters[0]);
        draft.registry = parameters[1];
        return [];
      }
      if (statement.startsWith('update public.workflow_definition_deployments')) {
        draft.definition = parameters[0];
        return [];
      }
      throw new Error(`Unexpected test query: ${statement}`);
    };
    const transaction = Object.assign(query, { json: (value: unknown) => value });
    const result = await run(transaction as unknown as TransactionSql);
    Object.assign(state, draft);
    return result;
  };
  const log = vi.fn();
  return { sql: { begin } as unknown as Sql, log, state };
}

describe('workflow definition release check', () => {
  test('checks a promotion twice without publishing its authority, then commits a real activation', async () => {
    const live = deployment(available);
    const candidate = deployment(removed, [available, removed]);
    const { sql, state, log } = deployedRegistry(live);
    const store = new PostgresWorkflowDefinitionReconciliationStore(sql, { log }, 'nous-reader', 2);

    await expect(store.activateDeployments([candidate], 'check')).resolves.toEqual([]);
    await expect(store.activateDeployments([candidate], 'check')).resolves.toEqual([]);
    expect(state).toEqual({ version: '1', registry: [live], definition: live });
    expect(log).not.toHaveBeenCalled();

    await expect(store.activateDeployments([candidate])).resolves.toEqual([candidate]);
    expect(state).toEqual({ version: '2', registry: [candidate], definition: candidate });

    const oldReplica = new PostgresWorkflowDefinitionReconciliationStore(sql, { log });
    await expect(oldReplica.activateDeployments([live], 'check')).rejects.toMatchObject({
      name: 'WorkflowReplicaOutdatedError',
    });
    await expect(oldReplica.activateDeployments([live])).resolves.toEqual([]);
  });

  test('a definition conflict reports the workflow ID and candidate hash without changing authority', async () => {
    const live = deployment(available);
    const candidate = deployment(removed);
    const { sql, state, log } = deployedRegistry(live);
    const store = new PostgresWorkflowDefinitionReconciliationStore(sql, { log }, 'nous-reader', 2);
    await expect(store.activateDeployments([candidate], 'check')).rejects.toMatchObject({
      name: 'WorkflowDefinitionDeploymentConflictError',
      workflowId: candidate.current.workflowId,
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'conflict',
        ...candidate.current,
        supportedDefinitionCount: 1,
      })
    );
    expect(state).toEqual({ version: '1', registry: [live], definition: live });
  });

  test('a same-version roster conflict reports only the added and removed definitions', async () => {
    const live = deployment(available);
    const candidate = deployment({ ...removed, workflowId: 'candidate-only' });
    const shared = deployment({ ...available, workflowId: 'shared' });
    const { sql, state, log } = deployedRegistry(live, [live, shared]);
    const store = new PostgresWorkflowDefinitionReconciliationStore(sql, { log });
    await expect(store.activateDeployments([candidate, shared], 'check')).rejects.toMatchObject({
      name: 'WorkflowDefinitionRegistryDeploymentConflictError',
    });
    expect(log).toHaveBeenCalledTimes(2);
    for (const definition of [live, candidate]) {
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'conflict',
          ...definition.current,
          supportedDefinitionCount: 1,
        })
      );
    }
    expect(state).toEqual({ version: '1', registry: [live, shared], definition: live });
  });
});

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
