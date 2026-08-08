import type { Sql, TransactionSql } from 'postgres';

import { isRecord } from '../utils/validation.js';
import {
  asPostgresJson,
  toPostgresDefinitionBoundaryArrays,
} from './postgresWorkflowPersistence.js';
import type {
  StepFailure,
  WorkflowDefinitionBoundary,
  WorkflowDefinitionDeployment,
  WorkflowDefinitionDeploymentAuthority,
  WorkflowDefinitionDeploymentDecision,
  WorkflowDefinitionDeploymentState,
  WorkflowDefinitionDeploymentTombstone,
  WorkflowRun,
} from './types.js';
import {
  WorkflowDefinitionDeploymentConflictError,
  WorkflowDefinitionRegistryDeploymentConflictError,
} from './workflowErrors.js';
import {
  consoleWorkflowLogger,
  emitWorkflowLog,
  type WorkflowLogger,
} from './workflowObservability.js';

export type {
  WorkflowDefinitionBoundary,
  WorkflowDefinitionDeployment,
  WorkflowDefinitionDeploymentAuthority,
  WorkflowDefinitionDeploymentDecision,
  WorkflowDefinitionDeploymentState,
  WorkflowDefinitionDeploymentTombstone,
} from './types.js';

export type WorkflowDefinitionRunFailureResult =
  | { readonly status: 'empty' }
  | { readonly status: 'stale' }
  | { readonly status: 'retry' }
  | { readonly runId: string; readonly status: 'failed' };

const boundaryKey = (boundary: WorkflowDefinitionBoundary): string =>
  `${boundary.workflowId}\0${boundary.definitionHash}\0${boundary.definitionHashVersion}`;

const hasBoundary = (
  deployment: WorkflowDefinitionDeployment,
  boundary: WorkflowDefinitionBoundary
): boolean =>
  deployment.supportedDefinitions.some(
    candidate => boundaryKey(candidate) === boundaryKey(boundary)
  );

const hasSameCurrent = (
  left: WorkflowDefinitionDeployment,
  right: WorkflowDefinitionDeployment
): boolean => boundaryKey(left.current) === boundaryKey(right.current);

const isDeploymentTombstone = (
  authority: WorkflowDefinitionDeploymentAuthority
): authority is WorkflowDefinitionDeploymentTombstone => 'removed' in authority;

const authorityWorkflowId = (authority: WorkflowDefinitionDeploymentAuthority): string =>
  isDeploymentTombstone(authority) ? authority.workflowId : authority.current.workflowId;

const supportedBoundaryKeys = (deployment: WorkflowDefinitionDeployment): ReadonlySet<string> =>
  new Set(deployment.supportedDefinitions.map(boundaryKey));

const hasSameSupportedDefinitions = (
  left: WorkflowDefinitionDeployment,
  right: WorkflowDefinitionDeployment
): boolean => {
  const leftKeys = supportedBoundaryKeys(left);
  const rightKeys = supportedBoundaryKeys(right);
  return (
    leftKeys.size === rightKeys.size && [...leftKeys].every(boundary => rightKeys.has(boundary))
  );
};

const isSameDeployment = (
  left: WorkflowDefinitionDeployment,
  right: WorkflowDefinitionDeployment
): boolean => hasSameCurrent(left, right) && hasSameSupportedDefinitions(left, right);

const isStrictSupportedSubset = (
  subset: WorkflowDefinitionDeployment,
  superset: WorkflowDefinitionDeployment
): boolean => {
  const subsetKeys = supportedBoundaryKeys(subset);
  const supersetKeys = supportedBoundaryKeys(superset);
  return (
    subsetKeys.size < supersetKeys.size &&
    [...subsetKeys].every(boundary => supersetKeys.has(boundary))
  );
};

const hasPreviousBoundary = (
  state: WorkflowDefinitionDeploymentState,
  boundary: WorkflowDefinitionBoundary
): boolean => state.previous !== null && hasBoundary(state.previous, boundary);

/** Distinguishes a newer registry from an older replica without keeping unbounded history. */
export const classifyWorkflowDefinitionDeployment = (
  deployed: WorkflowDefinitionDeploymentState | null,
  local: WorkflowDefinitionDeployment
): WorkflowDefinitionDeploymentDecision => {
  if (!deployed) return 'initialize';
  if (isDeploymentTombstone(deployed.current)) {
    return hasPreviousBoundary(deployed, local.current) ? 'stale' : 'promote';
  }
  if (isSameDeployment(deployed.current, local)) return 'unchanged';
  if (deployed.previous && isSameDeployment(deployed.previous, local)) return 'stale';

  if (hasSameCurrent(deployed.current, local)) {
    if (isStrictSupportedSubset(local, deployed.current)) return 'promote';
    if (isStrictSupportedSubset(deployed.current, local)) return 'stale';
    return 'conflict';
  }
  if (hasBoundary(local, deployed.current.current)) return 'promote';
  if (
    hasBoundary(deployed.current, local.current) ||
    hasPreviousBoundary(deployed, local.current)
  ) {
    return 'stale';
  }
  return 'conflict';
};

export interface WorkflowDefinitionReconciliationStore {
  activateDeployments(
    deployments: readonly WorkflowDefinitionDeployment[]
  ): Promise<readonly WorkflowDefinitionDeploymentAuthority[]>;
  failNextRun(
    boundary: WorkflowDefinitionBoundary,
    authority: WorkflowDefinitionDeploymentAuthority
  ): Promise<WorkflowDefinitionRunFailureResult>;
  listActiveBoundaries(): Promise<readonly WorkflowDefinitionBoundary[]>;
}

export interface WorkflowDefinitionAvailabilityRegistry {
  listDefinitionDeployments(): readonly WorkflowDefinitionDeployment[];
  resolve(
    workflowId: string,
    definitionHash: string
  ): { readonly definitionHashVersion: number } | null;
}

interface DefinitionBoundaryRow {
  definition_hash: string;
  definition_hash_version: number;
  workflow_id: string;
}

interface RunIdRow {
  id: string;
}

interface ReconciliationRunRow extends RunIdRow {
  status: WorkflowRun['status'];
}

interface InsertedDeploymentRow {
  workflow_id: string;
}

interface DefinitionDeploymentRow {
  current_deployment: unknown;
  previous_deployment: unknown;
}

interface DefinitionRegistryDeploymentRow {
  current_manifest: unknown;
  current_workflow_set_version: string;
  previous_manifest: unknown;
  previous_workflow_set_version: string | null;
  removed_workflow_ids: unknown;
}

interface InsertedRegistryDeploymentRow {
  registry_scope: string;
}

interface DeploymentActivationDecision {
  readonly decision: WorkflowDefinitionDeploymentDecision;
  readonly deployment: WorkflowDefinitionDeployment;
}

interface RegistryDeploymentState {
  readonly current: readonly WorkflowDefinitionDeployment[];
  readonly currentWorkflowSetVersion: number;
  readonly previous: readonly WorkflowDefinitionDeployment[] | null;
  readonly previousWorkflowSetVersion: number | null;
  readonly removedWorkflowIds: readonly string[];
}

/** Locks deployment authority and returns the locally supported definitions it still permits. */
export const lockAuthorizedWorkflowDefinitions = async (
  sql: TransactionSql,
  definitions: readonly WorkflowDefinitionBoundary[]
): Promise<readonly WorkflowDefinitionBoundary[]> => {
  if (definitions.length === 0) return [];
  const requested = toPostgresDefinitionBoundaryArrays(definitions);
  const rows = await sql<DefinitionBoundaryRow[]>`
    select
      deployment.workflow_id,
      supported ->> 'definitionHash' as definition_hash,
      (supported ->> 'definitionHashVersion')::integer as definition_hash_version
    from public.workflow_definition_deployments deployment
    cross join lateral jsonb_array_elements(
      deployment.current_deployment -> 'supportedDefinitions'
    ) supported
    where exists (
      select 1
      from unnest(
        ${sql.array(requested.workflowIds)}::text[],
        ${sql.array(requested.definitionHashes)}::text[],
        ${sql.array(requested.definitionHashVersions)}::integer[]
      ) requested_definition(workflow_id, definition_hash, definition_hash_version)
      where requested_definition.workflow_id = deployment.workflow_id
        and supported ->> 'workflowId' = requested_definition.workflow_id
        and supported ->> 'definitionHash' = requested_definition.definition_hash
        and (supported ->> 'definitionHashVersion')::integer =
          requested_definition.definition_hash_version
    )
    order by deployment.workflow_id, definition_hash, definition_hash_version
    for share of deployment
  `;
  return rows.map(row => ({
    definitionHash: row.definition_hash,
    definitionHashVersion: row.definition_hash_version,
    workflowId: row.workflow_id,
  }));
};

const DEFINITION_UNAVAILABLE_FAILURE: StepFailure = {
  code: 'workflow_definition_unavailable',
  kind: 'permanent',
  message: 'The workflow definition required to resume this run is unavailable.',
};

const isDefinitionAvailable = (
  registry: WorkflowDefinitionAvailabilityRegistry,
  boundary: WorkflowDefinitionBoundary
): boolean => {
  const definition = registry.resolve(boundary.workflowId, boundary.definitionHash);
  return definition?.definitionHashVersion === boundary.definitionHashVersion;
};

const parseDefinitionBoundary = (value: unknown): WorkflowDefinitionBoundary => {
  if (
    !isRecord(value) ||
    typeof value.definitionHash !== 'string' ||
    !Number.isSafeInteger(value.definitionHashVersion) ||
    typeof value.workflowId !== 'string'
  ) {
    throw new Error('Stored workflow definition boundary is invalid.');
  }
  return {
    definitionHash: value.definitionHash,
    definitionHashVersion: value.definitionHashVersion as number,
    workflowId: value.workflowId,
  };
};

const parseDefinitionDeployment = (value: unknown): WorkflowDefinitionDeployment => {
  if (!isRecord(value) || !Array.isArray(value.supportedDefinitions)) {
    throw new Error('Stored workflow definition deployment is invalid.');
  }
  const current = parseDefinitionBoundary(value.current);
  const supportedDefinitions = value.supportedDefinitions.map(parseDefinitionBoundary);
  if (
    supportedDefinitions.length === 0 ||
    supportedDefinitions.some(boundary => boundary.workflowId !== current.workflowId) ||
    !supportedDefinitions.some(boundary => boundaryKey(boundary) === boundaryKey(current))
  ) {
    throw new Error('Stored workflow definition deployment is inconsistent.');
  }
  return { current, supportedDefinitions };
};

const parseDefinitionDeploymentAuthority = (
  value: unknown
): WorkflowDefinitionDeploymentAuthority => {
  if (isRecord(value) && value.removed === true && typeof value.workflowId === 'string') {
    return { removed: true, workflowId: value.workflowId };
  }
  return parseDefinitionDeployment(value);
};

const parseDeploymentState = (row: DefinitionDeploymentRow): WorkflowDefinitionDeploymentState => ({
  current: parseDefinitionDeploymentAuthority(row.current_deployment),
  previous:
    row.previous_deployment === null ? null : parseDefinitionDeployment(row.previous_deployment),
});

const orderDeployments = (
  deployments: readonly WorkflowDefinitionDeployment[]
): readonly WorkflowDefinitionDeployment[] =>
  [...deployments].sort((left, right) =>
    left.current.workflowId.localeCompare(right.current.workflowId)
  );

const parseDefinitionManifest = (value: unknown): readonly WorkflowDefinitionDeployment[] => {
  if (!Array.isArray(value)) throw new Error('Stored workflow definition manifest is invalid.');
  const deployments = orderDeployments(value.map(parseDefinitionDeployment));
  if (
    deployments.some(
      (deployment, index) =>
        index > 0 && deployment.current.workflowId === deployments[index - 1]?.current.workflowId
    )
  ) {
    throw new Error('Stored workflow definition manifest contains duplicate workflow identifiers.');
  }
  return deployments;
};

const parseRemovedWorkflowIds = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.some(workflowId => typeof workflowId !== 'string')) {
    throw new Error('Stored removed workflow identifiers are invalid.');
  }
  return [...new Set(value)].sort((left, right) => left.localeCompare(right));
};

const parseWorkflowSetVersion = (value: string | null, name: string): number | null => {
  if (value === null) return null;
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`Stored ${name} is invalid.`);
  }
  return version;
};

const parseRegistryDeploymentState = (
  row: DefinitionRegistryDeploymentRow
): RegistryDeploymentState => {
  const currentWorkflowSetVersion = parseWorkflowSetVersion(
    row.current_workflow_set_version,
    'workflow-set version'
  );
  if (currentWorkflowSetVersion === null) {
    throw new Error('Stored workflow-set version is required.');
  }
  return {
    current: parseDefinitionManifest(row.current_manifest),
    currentWorkflowSetVersion,
    previous:
      row.previous_manifest === null ? null : parseDefinitionManifest(row.previous_manifest),
    previousWorkflowSetVersion: parseWorkflowSetVersion(
      row.previous_workflow_set_version,
      'previous workflow-set version'
    ),
    removedWorkflowIds: parseRemovedWorkflowIds(row.removed_workflow_ids),
  };
};

const hasSameManifest = (
  left: readonly WorkflowDefinitionDeployment[],
  right: readonly WorkflowDefinitionDeployment[]
): boolean =>
  left.length === right.length &&
  left.every((deployment, index) => {
    const candidate = right[index];
    return candidate ? isSameDeployment(deployment, candidate) : false;
  });

const hasSameWorkflowIds = (
  left: readonly WorkflowDefinitionDeployment[],
  right: readonly WorkflowDefinitionDeployment[]
): boolean =>
  left.length === right.length &&
  left.every(
    (deployment, index) => deployment.current.workflowId === right[index]?.current.workflowId
  );

const isStaleManifestReplica = (
  state: RegistryDeploymentState,
  localManifest: readonly WorkflowDefinitionDeployment[]
): boolean => {
  if (state.current.length !== localManifest.length) return false;

  let foundStaleDeployment = false;
  for (let index = 0; index < localManifest.length; index += 1) {
    const deployed = state.current[index];
    const local = localManifest[index];
    if (!local) return false;
    if (deployed?.current.workflowId !== local.current.workflowId) return false;
    const previous = state.previous?.find(
      candidate => candidate.current.workflowId === local.current.workflowId
    );
    const decision = classifyWorkflowDefinitionDeployment(
      { current: deployed, previous: previous ?? null },
      local
    );
    if (decision === 'promote' || decision === 'conflict' || decision === 'initialize') {
      return false;
    }
    foundStaleDeployment ||= decision === 'stale';
  }
  return foundStaleDeployment;
};

const isSameAuthority = (
  left: WorkflowDefinitionDeploymentAuthority,
  right: WorkflowDefinitionDeploymentAuthority
): boolean => {
  if (isDeploymentTombstone(left) || isDeploymentTombstone(right)) {
    return (
      isDeploymentTombstone(left) &&
      isDeploymentTombstone(right) &&
      left.workflowId === right.workflowId
    );
  }
  return isSameDeployment(left, right);
};

const activateDeploymentInTransaction = async (
  sql: TransactionSql,
  deployment: WorkflowDefinitionDeployment
): Promise<WorkflowDefinitionDeploymentDecision> => {
  const inserted = await sql<InsertedDeploymentRow[]>`
    insert into public.workflow_definition_deployments (
      workflow_id, current_deployment
    ) values (
      ${deployment.current.workflowId}, ${sql.json(asPostgresJson(deployment))}
    )
    on conflict (workflow_id) do nothing
    returning workflow_id
  `;
  if (inserted[0]) return 'initialize';

  const rows = await sql<DefinitionDeploymentRow[]>`
    select current_deployment, previous_deployment
    from public.workflow_definition_deployments
    where workflow_id = ${deployment.current.workflowId}
    for update
  `;
  const row = rows[0];
  if (!row) throw new Error('Workflow definition deployment could not be locked.');
  const state = parseDeploymentState(row);
  const decision = classifyWorkflowDefinitionDeployment(state, deployment);
  if (decision === 'promote') {
    if (isDeploymentTombstone(state.current)) {
      await sql`
        update public.workflow_definition_deployments
        set current_deployment = ${sql.json(asPostgresJson(deployment))},
            updated_at = clock_timestamp()
        where workflow_id = ${deployment.current.workflowId}
      `;
    } else {
      await sql`
        update public.workflow_definition_deployments
        set previous_deployment = current_deployment,
            current_deployment = ${sql.json(asPostgresJson(deployment))},
            updated_at = clock_timestamp()
        where workflow_id = ${deployment.current.workflowId}
      `;
    }
  }
  return decision;
};

const tombstoneDeploymentInTransaction = async (
  sql: TransactionSql,
  workflowId: string
): Promise<WorkflowDefinitionDeploymentTombstone> => {
  const rows = await sql<DefinitionDeploymentRow[]>`
    select current_deployment, previous_deployment
    from public.workflow_definition_deployments
    where workflow_id = ${workflowId}
    for update
  `;
  const row = rows[0];
  if (!row) throw new Error(`Workflow definition deployment ${workflowId} is missing.`);
  const state = parseDeploymentState(row);
  if (isDeploymentTombstone(state.current)) return state.current;

  const tombstone = { removed: true, workflowId } as const;
  await sql`
    update public.workflow_definition_deployments
    set previous_deployment = current_deployment,
        current_deployment = ${sql.json(asPostgresJson(tombstone))},
        updated_at = clock_timestamp()
    where workflow_id = ${workflowId}
  `;
  return tombstone;
};

const lockRegistryDeployment = async (
  sql: TransactionSql,
  registryScope: string,
  workflowSetVersion: number,
  localManifest: readonly WorkflowDefinitionDeployment[]
): Promise<{
  decision: 'conflict' | 'initialize' | 'promote' | 'stale' | 'unchanged';
  state: RegistryDeploymentState;
}> => {
  const inserted = await sql<InsertedRegistryDeploymentRow[]>`
    insert into public.workflow_definition_registry_deployments (
      registry_scope, current_workflow_set_version, current_manifest
    ) values (
      ${registryScope}, ${workflowSetVersion}, ${sql.json(asPostgresJson(localManifest))}
    )
    on conflict (registry_scope) do nothing
    returning registry_scope
  `;
  if (inserted[0]) {
    return {
      decision: 'initialize',
      state: {
        current: localManifest,
        currentWorkflowSetVersion: workflowSetVersion,
        previous: null,
        previousWorkflowSetVersion: null,
        removedWorkflowIds: [],
      },
    };
  }

  const rows = await sql<DefinitionRegistryDeploymentRow[]>`
    select
      current_manifest,
      current_workflow_set_version::text,
      previous_manifest,
      previous_workflow_set_version::text,
      removed_workflow_ids
    from public.workflow_definition_registry_deployments
    where registry_scope = ${registryScope}
    for update
  `;
  const row = rows[0];
  if (!row) throw new Error('Workflow definition registry deployment could not be locked.');
  const state = parseRegistryDeploymentState(row);
  if (workflowSetVersion < state.currentWorkflowSetVersion) return { decision: 'stale', state };
  if (workflowSetVersion > state.currentWorkflowSetVersion) return { decision: 'promote', state };
  if (hasSameManifest(state.current, localManifest)) return { decision: 'unchanged', state };
  if (
    state.previous &&
    state.previousWorkflowSetVersion === workflowSetVersion &&
    hasSameManifest(state.previous, localManifest)
  ) {
    return { decision: 'stale', state };
  }
  if (!hasSameWorkflowIds(state.current, localManifest)) return { decision: 'conflict', state };
  if (isStaleManifestReplica(state, localManifest)) return { decision: 'stale', state };
  return { decision: 'promote', state };
};

const removedWorkflowIdsAfterActivation = (
  state: RegistryDeploymentState,
  localManifest: readonly WorkflowDefinitionDeployment[]
): readonly string[] => {
  const localWorkflowIds = new Set(localManifest.map(deployment => deployment.current.workflowId));
  return [
    ...new Set([
      ...state.removedWorkflowIds,
      ...state.current.map(deployment => deployment.current.workflowId),
    ]),
  ]
    .filter(workflowId => !localWorkflowIds.has(workflowId))
    .sort((left, right) => left.localeCompare(right));
};

const updateRegistryDeployment = async (
  sql: TransactionSql,
  input: {
    localManifest: readonly WorkflowDefinitionDeployment[];
    registryScope: string;
    removedWorkflowIds: readonly string[];
    workflowSetVersion: number;
  }
): Promise<void> => {
  await sql`
    update public.workflow_definition_registry_deployments
    set previous_workflow_set_version = current_workflow_set_version,
        previous_manifest = current_manifest,
        current_workflow_set_version = ${input.workflowSetVersion},
        current_manifest = ${sql.json(asPostgresJson(input.localManifest))},
        removed_workflow_ids = ${sql.json(asPostgresJson(input.removedWorkflowIds))},
        updated_at = clock_timestamp()
    where registry_scope = ${input.registryScope}
  `;
};

/** Fails runs or pending cleanup whose exact durable definition was intentionally removed. */
export const reconcileUnavailableWorkflowDefinitions = async (input: {
  registry: WorkflowDefinitionAvailabilityRegistry;
  store: WorkflowDefinitionReconciliationStore;
}): Promise<readonly string[]> => {
  const failedRunIds: string[] = [];
  const authorities = new Map(
    (await input.store.activateDeployments(input.registry.listDefinitionDeployments())).map(
      authority => [authorityWorkflowId(authority), authority]
    )
  );
  const boundaries = await input.store.listActiveBoundaries();
  for (const boundary of boundaries) {
    const authority = authorities.get(boundary.workflowId);
    if (!authority) continue;
    if (isDefinitionAvailable(input.registry, boundary)) continue;
    while (true) {
      const result = await input.store.failNextRun(boundary, authority);
      if (result.status === 'failed') {
        failedRunIds.push(result.runId);
        continue;
      }
      if (result.status === 'retry') continue;
      break;
    }
  }
  return failedRunIds;
};

export class PostgresWorkflowDefinitionReconciliationStore
  implements WorkflowDefinitionReconciliationStore
{
  constructor(
    private readonly sql: Sql,
    private readonly logger: WorkflowLogger = consoleWorkflowLogger,
    private readonly registryScope = 'nous-reader',
    private readonly workflowSetVersion = 1
  ) {
    if (!registryScope.trim()) throw new Error('Workflow definition registry scope is required.');
    if (!Number.isSafeInteger(workflowSetVersion) || workflowSetVersion < 1) {
      throw new Error('Workflow-set version must be a positive safe integer.');
    }
  }

  async activateDeployments(
    deployments: readonly WorkflowDefinitionDeployment[]
  ): Promise<readonly WorkflowDefinitionDeploymentAuthority[]> {
    const orderedDeployments = orderDeployments(deployments);
    let activation: {
      authorities: readonly WorkflowDefinitionDeploymentAuthority[];
      decisions: readonly DeploymentActivationDecision[];
    };
    try {
      activation = await this.sql.begin(async sql => {
        const registry = await lockRegistryDeployment(
          sql,
          this.registryScope,
          this.workflowSetVersion,
          orderedDeployments
        );
        if (registry.decision === 'stale') return { authorities: [], decisions: [] };
        if (registry.decision === 'conflict') {
          throw new WorkflowDefinitionRegistryDeploymentConflictError(this.registryScope);
        }

        const results: DeploymentActivationDecision[] = [];
        for (const deployment of orderedDeployments) {
          const decision = await activateDeploymentInTransaction(sql, deployment);
          if (decision === 'conflict' || decision === 'stale') {
            throw new WorkflowDefinitionDeploymentConflictError(deployment.current.workflowId);
          }
          results.push({ decision, deployment });
        }
        const removedWorkflowIds = removedWorkflowIdsAfterActivation(
          registry.state,
          orderedDeployments
        );
        const tombstones: WorkflowDefinitionDeploymentTombstone[] = [];
        for (const workflowId of removedWorkflowIds) {
          tombstones.push(await tombstoneDeploymentInTransaction(sql, workflowId));
        }
        if (registry.decision === 'promote') {
          await updateRegistryDeployment(sql, {
            localManifest: orderedDeployments,
            registryScope: this.registryScope,
            removedWorkflowIds,
            workflowSetVersion: this.workflowSetVersion,
          });
        }
        return {
          authorities: [...orderedDeployments, ...tombstones],
          decisions: results,
        };
      });
    } catch (error) {
      if (error instanceof WorkflowDefinitionDeploymentConflictError) {
        const deployment = orderedDeployments.find(
          candidate => candidate.current.workflowId === error.workflowId
        );
        if (deployment) {
          emitWorkflowLog(this.logger, {
            action: 'conflict',
            boundary: deployment.current,
            entity: 'definition',
            supportedDefinitionCount: deployment.supportedDefinitions.length,
          });
        }
      }
      throw error;
    }

    for (const { decision, deployment } of activation.decisions) {
      emitWorkflowLog(this.logger, {
        action: decision,
        boundary: deployment.current,
        entity: 'definition',
        supportedDefinitionCount: deployment.supportedDefinitions.length,
      });
    }
    return activation.authorities;
  }

  async listActiveBoundaries(): Promise<readonly WorkflowDefinitionBoundary[]> {
    const rows = await this.sql<DefinitionBoundaryRow[]>`
      select distinct workflow_id, definition_hash, definition_hash_version
      from public.workflow_runs
      where status in ('queued', 'running', 'waiting')
         or cleanup_status in ('pending', 'running')
      order by workflow_id, definition_hash, definition_hash_version
    `;
    return rows.map(row => ({
      definitionHash: row.definition_hash,
      definitionHashVersion: row.definition_hash_version,
      workflowId: row.workflow_id,
    }));
  }

  async failNextRun(
    boundary: WorkflowDefinitionBoundary,
    authority: WorkflowDefinitionDeploymentAuthority
  ): Promise<WorkflowDefinitionRunFailureResult> {
    const result = await this.sql.begin(async sql => {
      const deployments = await sql<DefinitionDeploymentRow[]>`
        select current_deployment, previous_deployment
        from public.workflow_definition_deployments
        where workflow_id = ${boundary.workflowId}
        for share
      `;
      const deployed = deployments[0];
      if (!deployed || !isSameAuthority(parseDeploymentState(deployed).current, authority)) {
        return { status: 'stale' } as const;
      }

      const candidates = await sql<RunIdRow[]>`
        select id
        from public.workflow_runs
        where workflow_id = ${boundary.workflowId}
          and definition_hash = ${boundary.definitionHash}
          and definition_hash_version = ${boundary.definitionHashVersion}
          and (
            status in ('queued', 'running', 'waiting')
            or cleanup_status in ('pending', 'running')
          )
        order by created_at, id
        limit 1
      `;
      const candidate = candidates[0];
      if (!candidate) return { status: 'empty' } as const;

      // Node -> undo -> run matches the worker transaction lock order.
      await sql`
        select node_instance_id
        from public.workflow_node_runs
        where run_id = ${candidate.id}
        order by node_instance_id
        for update
      `;
      await sql`
        select node_instance_id
        from public.workflow_undo_runs
        where run_id = ${candidate.id}
        order by reverse_order, node_instance_id
        for update
      `;
      const runs = await sql<ReconciliationRunRow[]>`
        select id, status
        from public.workflow_runs
        where id = ${candidate.id}
          and workflow_id = ${boundary.workflowId}
          and definition_hash = ${boundary.definitionHash}
          and definition_hash_version = ${boundary.definitionHashVersion}
          and (
            status in ('queued', 'running', 'waiting')
            or cleanup_status in ('pending', 'running')
          )
        for update
      `;
      const run = runs[0];
      if (!run) return { status: 'retry' } as const;

      if (!['queued', 'running', 'waiting'].includes(run.status)) {
        await sql`
          update public.workflow_undo_attempts
          set status = 'lost',
              error = ${sql.json(asPostgresJson(DEFINITION_UNAVAILABLE_FAILURE))},
              finished_at = clock_timestamp()
          where run_id = ${candidate.id} and status = 'running'
        `;
        await sql`
          update public.workflow_undo_runs
          set status = 'failed',
              error = ${sql.json(asPostgresJson(DEFINITION_UNAVAILABLE_FAILURE))},
              worker_id = null,
              lease_expires_at = null,
              fencing_token = fencing_token + case when status = 'running' then 1 else 0 end,
              updated_at = clock_timestamp()
          where run_id = ${candidate.id} and status in ('queued', 'running', 'retrying')
        `;
        const failedCleanup = await sql<RunIdRow[]>`
          update public.workflow_runs
          set cleanup_status = 'failed',
              updated_at = clock_timestamp(),
              version = version + 1
          where id = ${candidate.id} and cleanup_status in ('pending', 'running')
          returning id
        `;
        if (!failedCleanup[0]) {
          throw new Error('Unavailable workflow definition cleanup could not be failed.');
        }
        return { runId: failedCleanup[0].id, status: 'failed' } as const;
      }

      await sql`
        update public.workflow_node_attempts
        set status = 'lost',
            error = ${sql.json(asPostgresJson(DEFINITION_UNAVAILABLE_FAILURE))},
            finished_at = clock_timestamp()
        where run_id = ${candidate.id} and status = 'running'
      `;
      await sql`
        update public.workflow_node_runs
        set status = 'cancelled',
            error = ${sql.json(asPostgresJson(DEFINITION_UNAVAILABLE_FAILURE))},
            worker_id = null,
            lease_expires_at = null,
            fencing_token = fencing_token + case when status = 'running' then 1 else 0 end,
            completed_at = coalesce(completed_at, clock_timestamp()),
            updated_at = clock_timestamp()
        where run_id = ${candidate.id} and status in ('queued', 'running', 'retrying', 'waiting')
      `;
      await sql`
        update public.workflow_waits
        set status = 'cancelled', finished_at = clock_timestamp()
        where run_id = ${candidate.id} and status = 'waiting'
      `;
      const failed = await sql<RunIdRow[]>`
        update public.workflow_runs
        set status = 'failed',
            cleanup_status = case
              when exists (
                select 1
                from public.workflow_node_runs
                where run_id = ${candidate.id} and status = 'completed' and has_undo
              ) then 'failed'
              else 'not-required'
            end,
            error = ${sql.json(asPostgresJson(DEFINITION_UNAVAILABLE_FAILURE))},
            cancellation_requested = true,
            completed_at = clock_timestamp(),
            updated_at = clock_timestamp(),
            version = version + 1
        where id = ${candidate.id}
        returning id
      `;
      if (!failed[0]) throw new Error('Unavailable workflow definition run could not be failed.');
      return { runId: failed[0].id, status: 'failed' } as const;
    });
    if (result.status === 'failed') {
      emitWorkflowLog(this.logger, {
        action: 'definition-unavailable',
        entity: 'run',
        failure: DEFINITION_UNAVAILABLE_FAILURE,
        runId: result.runId,
        runStatus: 'failed',
        workflowId: boundary.workflowId,
      });
    }
    return result;
  }
}
