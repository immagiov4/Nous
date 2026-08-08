import { describe, expect, test, vi } from 'vitest';
import { PostgresProjectAssetStore } from '../../src/projects/postgresProjectAssetStore.js';
import {
  buildProjectAssetDescriptor,
  type ProjectAssetObjectStorage,
} from '../../src/projects/projectAsset.js';
import { reconcileProjectAssets } from '../../src/projects/projectAssetReconciliation.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';

const ASSET_ID = 'a'.repeat(64);
const assetRef = {
  byteSize: 12,
  hash: 'b'.repeat(64),
  id: ASSET_ID,
  mediaType: 'image/png',
};

const project = (): ProjectSnapshot => ({
  createdAt: '2026-07-29T10:00:00.000Z',
  id: 'project-1',
  lastOpenedAt: '2026-07-29T10:00:00.000Z',
  learningPlan: {
    sections: [
      {
        generatedVisuals: [{ render: { asset: assetRef, kind: 'image' } }],
        id: 'lesson-1',
      },
    ],
  },
  updatedAt: '2026-07-29T10:00:00.000Z',
  version: '4.1',
});

const createSql = (storedHash = assetRef.hash) => {
  const statements: string[] = [];
  const sql = Object.assign(
    vi.fn((first: TemplateStringsArray | readonly string[]) => {
      if (!Array.isArray(first) || 'raw' in first) {
        const statement = (first as TemplateStringsArray).join('?');
        statements.push(statement);
        if (statement.includes('select id, state, content_hash')) {
          return Promise.resolve([
            {
              byte_size: assetRef.byteSize,
              content_hash: storedHash,
              id: assetRef.id,
              media_type: assetRef.mediaType,
              state: 'active',
            },
          ]);
        }
        if (statement.includes('update public.project_assets')) {
          return Promise.resolve([{ id: 'obsolete-asset' }]);
        }
        return Promise.resolve([]);
      }
      return first;
    }),
    { json: vi.fn((value: unknown) => value) }
  );
  return { sql, statements };
};

describe('project asset reconciliation', () => {
  test('keeps reachable assets and queues only references removed by the snapshot change', async () => {
    const { sql, statements } = createSql();
    const previousSnapshot = project();
    previousSnapshot.learningPlan?.sections?.[0]?.generatedVisuals?.push({
      render: {
        asset: {
          byteSize: 9,
          hash: 'd'.repeat(64),
          id: 'c'.repeat(64),
          mediaType: 'image/png',
        },
        kind: 'image',
      },
    });
    await expect(
      reconcileProjectAssets(sql as never, {
        previousSnapshot,
        projectId: 'project-1',
        snapshot: project(),
        userId: 'user-1',
      })
    ).resolves.toBe(1);

    expect(statements).toHaveLength(2);
    expect(statements[1]).toContain("state = 'active'");
    expect(statements[1]).toContain('id in');
    expect(statements[1]).not.toContain('id not in');
  });

  test('does not queue an active draft that was never referenced by either snapshot', async () => {
    const { sql, statements } = createSql();

    await expect(
      reconcileProjectAssets(sql as never, {
        previousSnapshot: project(),
        projectId: 'project-1',
        snapshot: project(),
        userId: 'user-1',
      })
    ).resolves.toBe(0);

    expect(statements).toHaveLength(1);
  });

  test('rejects metadata that does not match the stored object before queuing anything', async () => {
    const { sql, statements } = createSql('c'.repeat(64));
    await expect(
      reconcileProjectAssets(sql as never, {
        previousSnapshot: project(),
        projectId: 'project-1',
        snapshot: project(),
        userId: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'asset-not-adoptable' });

    expect(statements).toHaveLength(1);
  });
});

describe('project asset staging', () => {
  test('commits recoverable metadata before upload while keeping project-run-asset lock order', async () => {
    const events: string[] = [];
    let transactionNumber = 0;
    const input = {
      bytes: new TextEncoder().encode('generated image'),
      idempotencyKey: 'visual-image',
      mediaType: 'image/png',
      nodeInstanceId: 'root/render-visual',
      projectId: 'project-1',
      runId: '00000000-0000-4000-8000-000000000002',
      signal: new AbortController().signal,
      userId: '00000000-0000-4000-8000-000000000001',
    };
    const descriptor = buildProjectAssetDescriptor(input);
    const row = {
      byte_size: descriptor.byteSize,
      cleanup_fencing_token: 0,
      cleanup_worker_id: null,
      content_hash: descriptor.hash,
      id: descriptor.id,
      idempotency_key: descriptor.idempotencyKey,
      media_type: descriptor.mediaType,
      node_instance_id: input.nodeInstanceId,
      object_path: descriptor.objectPath,
      origin_kind: 'workflow',
      project_id: input.projectId,
      state: 'staged',
      user_id: input.userId,
      workflow_run_id: input.runId,
    };
    const transaction = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        events.push(
          statement.includes('from public.projects')
            ? `tx-${transactionNumber}:project`
            : statement.includes('from public.workflow_runs')
              ? `tx-${transactionNumber}:run`
              : statement.includes('from public.workflow_node_runs')
                ? `tx-${transactionNumber}:node`
                : statement.includes('select asset.*')
                  ? `tx-${transactionNumber}:asset`
                  : `tx-${transactionNumber}:write`
        );
        if (
          statement.includes('from public.projects') ||
          statement.includes('from public.workflow_runs') ||
          statement.includes('from public.workflow_node_runs')
        ) {
          return Promise.resolve([{ found: 1 }]);
        }
        return Promise.resolve(statement.includes('from public.project_assets') ? [row] : []);
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const sql = Object.assign(vi.fn(), {
      begin: vi.fn(async callback => {
        transactionNumber += 1;
        events.push(`tx-${transactionNumber}:begin`);
        const result = await callback(transaction);
        events.push(`tx-${transactionNumber}:commit`);
        return result;
      }),
      json: vi.fn((value: unknown) => value),
    });
    const assetStorage: ProjectAssetObjectStorage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(async () => input.bytes),
      upload: vi.fn(async (_path, _bytes, _mediaType, signal) => {
        expect(signal).toBe(input.signal);
        events.push('storage:upload');
      }),
    };
    const store = new PostgresProjectAssetStore(sql as never, assetStorage);

    await expect(store.stage(input)).resolves.toMatchObject({ id: descriptor.id });

    expect(sql.begin).toHaveBeenCalledTimes(2);
    expect(events.indexOf('tx-1:commit')).toBeLessThan(events.indexOf('storage:upload'));
    expect(events.indexOf('storage:upload')).toBeLessThan(events.indexOf('tx-2:begin'));
    expect(
      transaction.mock.calls.some(([strings]) =>
        (strings as TemplateStringsArray).join('?').includes('origin_kind')
      )
    ).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        'tx-1:project',
        'tx-1:run',
        'tx-1:node',
        'tx-2:project',
        'tx-2:run',
        'tx-2:asset',
      ])
    );
    expect(events.indexOf('tx-1:project')).toBeLessThan(events.indexOf('tx-1:run'));
    expect(events.indexOf('tx-2:project')).toBeLessThan(events.indexOf('tx-2:run'));
    expect(events.indexOf('tx-2:run')).toBeLessThan(events.indexOf('tx-2:asset'));
  });
});
