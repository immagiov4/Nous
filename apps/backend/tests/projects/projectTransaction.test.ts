import type { TransactionSql } from 'postgres';
import { describe, expect, test, vi } from 'vitest';
import { ProjectRevisionConflictError } from '../../src/projects/projectRevision.js';
import {
  ProjectTransactionTargetNotFoundError,
  patchProjectInTransaction,
} from '../../src/projects/projectTransaction.js';
import type { ProjectSnapshot, SavedProjectMeta } from '../../src/projects/types.js';

interface SqlCall {
  statement: string;
  values: unknown[];
}

const normalizeStatement = (strings: TemplateStringsArray): string =>
  strings.join('?').replace(/\s+/g, ' ').trim();

const createTransactionSql = (results: unknown[][]) => {
  const calls: SqlCall[] = [];
  const json = vi.fn((value: unknown) => value);
  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ statement: normalizeStatement(strings), values });
      return Promise.resolve(results.shift() ?? []);
    }),
    { json }
  ) as unknown as TransactionSql;

  return { calls, json, sql };
};

const STORED_META: SavedProjectMeta = {
  id: 'project-1',
  title: 'Titolo precedente',
  sourceKind: 'document',
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-07-01T08:00:00.000Z',
  lastOpenedAt: '2026-07-02T08:00:00.000Z',
  lessonCount: 1,
  completedCount: 0,
  exerciseCount: 0,
  completedExercises: 0,
  hasSourceFile: true,
  coverLabel: '1 lezioni',
  isFavorite: true,
};

const STORED_SNAPSHOT: ProjectSnapshot = {
  activeSectionId: null,
  projectFormatVersion: 1,
  id: 'project-1',
  isLearnMode: false,
  version: '4.1',
  title: 'Titolo precedente',
  sourceKind: 'document',
  state: 'READING',
  source: {
    file: { data: 'c291cmNl', mimeType: 'text/plain', name: 'source.txt' },
    kind: 'document',
  },
  learningPlan: {
    title: 'Titolo precedente',
    sections: [{ id: 'section-1', content: 'Contenuto precedente' }],
  },
  syllabus: [],
  userProfile: null,
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-07-01T08:00:00.000Z',
  lastOpenedAt: '2026-07-02T08:00:00.000Z',
};

describe('patchProjectInTransaction', () => {
  test('locks, validates and persists the project inside the supplied transaction', async () => {
    const updatedAt = '2026-07-29T12:00:00.000Z';
    const persistedMeta = { ...STORED_META, title: 'Titolo aggiornato', updatedAt };
    const { calls, json, sql } = createTransactionSql([
      [
        {
          document_index: { pages: [{ pageNumber: 1 }] },
          meta: STORED_META,
          revision: '4',
          snapshot: STORED_SNAPSHOT,
        },
      ],
      [{ meta: persistedMeta, revision: '5' }],
      [{ id: 'project-1' }],
    ]);
    const buildPatch = vi.fn(
      ({ revision, snapshot }: { revision: number; snapshot: ProjectSnapshot }) => {
        expect(revision).toBe(4);
        expect(snapshot.documentIndex).toEqual({ pages: [{ pageNumber: 1 }] });
        return { title: 'Titolo aggiornato' };
      }
    );

    const result = await patchProjectInTransaction(sql, {
      buildPatch,
      projectId: 'project-1',
      updatedAt,
      userId: 'user-1',
    });

    expect(buildPatch).toHaveBeenCalledTimes(1);
    expect(calls[0].statement).toContain('for update of project, project_snapshot nowait');
    expect(calls[1].statement).toContain('revision = revision + 1');
    expect(calls[2].statement).toContain('update public.project_snapshots');
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ isFavorite: true }));
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'project-1',
        title: 'Titolo aggiornato',
        updatedAt,
      })
    );
    expect(json).toHaveBeenCalledWith({ pages: [{ pageNumber: 1 }] });
    expect(result).toEqual({
      projectChanged: true,
      meta: { ...persistedMeta, revision: 5 },
      snapshot: {
        ...STORED_SNAPSHOT,
        documentIndex: { pages: [{ pageNumber: 1 }] },
        learningPlan: { ...STORED_SNAPSHOT.learningPlan, title: 'Titolo aggiornato' },
        projectFormatVersion: 1,
        title: 'Titolo aggiornato',
        updatedAt,
      },
    });
  });

  test('preserves a newer stored timestamp while applying the requested patch', async () => {
    const storedUpdatedAt = '2026-07-29T14:00:00.000Z';
    const requestedUpdatedAt = '2026-07-29T12:00:00.000Z';
    const storedMeta = { ...STORED_META, updatedAt: storedUpdatedAt };
    const storedSnapshot = { ...STORED_SNAPSHOT, updatedAt: storedUpdatedAt };
    const persistedMeta = { ...storedMeta, title: 'Titolo aggiornato' };
    const { calls, json, sql } = createTransactionSql([
      [
        {
          document_index: null,
          meta: storedMeta,
          revision: '4',
          snapshot: storedSnapshot,
        },
      ],
      [{ meta: persistedMeta, revision: '5' }],
      [{ id: 'project-1' }],
    ]);

    const result = await patchProjectInTransaction(sql, {
      buildPatch: () => ({ title: 'Titolo aggiornato' }),
      projectId: 'project-1',
      updatedAt: requestedUpdatedAt,
      userId: 'user-1',
    });

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Titolo aggiornato', updatedAt: storedUpdatedAt })
    );
    expect(calls[1].values).toContain(storedUpdatedAt);
    expect(calls[2].values).toContain(storedUpdatedAt);
    expect(result).toEqual({
      projectChanged: true,
      meta: { ...persistedMeta, revision: 5 },
      snapshot: {
        ...storedSnapshot,
        learningPlan: { ...storedSnapshot.learningPlan, title: 'Titolo aggiornato' },
        projectFormatVersion: 1,
        title: 'Titolo aggiornato',
      },
    });
  });

  test('canonicalizes lesson content in whole learning-plan patches before persistence', async () => {
    const updatedAt = '2026-07-29T12:00:00.000Z';
    const { json, sql } = createTransactionSql([
      [
        {
          document_index: null,
          meta: STORED_META,
          revision: '4',
          snapshot: STORED_SNAPSHOT,
        },
      ],
      [{ meta: { ...STORED_META, updatedAt }, revision: '5' }],
      [{ id: 'project-1' }],
    ]);
    const divergentLearningPlan = {
      ...STORED_SNAPSHOT.learningPlan,
      sections: [
        {
          content: 'Copia Markdown obsoleta',
          contentBlocks: [{ markdown: 'Contenuto strutturato.', type: 'markdown' }],
          id: 'section-1',
        },
      ],
    };

    const result = await patchProjectInTransaction(sql, {
      buildPatch: () => ({ learningPlan: divergentLearningPlan }),
      projectId: 'project-1',
      updatedAt,
      userId: 'user-1',
    });

    expect(result.snapshot.learningPlan?.sections?.[0]).toMatchObject({
      content: 'Contenuto strutturato.',
      contentBlocks: [{ markdown: 'Contenuto strutturato.', type: 'markdown' }],
    });
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        learningPlan: expect.objectContaining({
          sections: [
            expect.objectContaining({
              content: 'Contenuto strutturato.',
            }),
          ],
        }),
      })
    );
  });

  test('waits for the project lock when applying a safely rebasable patch', async () => {
    const { calls, sql } = createTransactionSql([
      [
        {
          document_index: null,
          meta: STORED_META,
          revision: '5',
          snapshot: {
            ...STORED_SNAPSHOT,
            learningPlan: {
              ...STORED_SNAPSHOT.learningPlan,
              sections: [{ id: 'section-1', content: 'Lezione generata' }],
            },
          },
        },
      ],
      [{ meta: STORED_META, revision: '6' }],
      [{ id: 'project-1' }],
    ]);

    const result = await patchProjectInTransaction(sql, {
      buildPatch: () => ({ activeSectionId: 'section-1' }),
      projectId: 'project-1',
      updatedAt: '2026-07-29T12:00:00.000Z',
      userId: 'user-1',
      waitForProjectLock: true,
    });

    expect(calls[0].statement).toContain('for update of project, project_snapshot');
    expect(calls[0].statement).not.toContain('nowait');
    expect(result.snapshot.activeSectionId).toBe('section-1');
    expect(result.snapshot.learningPlan?.sections?.[0]).toMatchObject({
      content: 'Lezione generata',
    });
  });

  test('does not write when the target project does not exist', async () => {
    const { calls, sql } = createTransactionSql([[]]);

    await expect(
      patchProjectInTransaction(sql, {
        buildPatch: () => ({ title: 'Titolo aggiornato' }),
        projectId: 'missing-project',
        updatedAt: '2026-07-29T12:00:00.000Z',
        userId: 'user-1',
      })
    ).rejects.toBeInstanceOf(ProjectTransactionTargetNotFoundError);
    expect(calls).toHaveLength(1);
  });

  test('returns the locked project without a revision write when the patch is unnecessary', async () => {
    const { calls, sql } = createTransactionSql([
      [
        {
          document_index: null,
          meta: STORED_META,
          revision: '4',
          snapshot: STORED_SNAPSHOT,
        },
      ],
    ]);

    const result = await patchProjectInTransaction(sql, {
      buildPatch: () => null,
      projectId: 'project-1',
      updatedAt: '2026-07-29T12:00:00.000Z',
      userId: 'user-1',
    });

    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      projectChanged: false,
      meta: { ...STORED_META, revision: 4 },
      snapshot: { ...STORED_SNAPSHOT, projectFormatVersion: 1 },
    });
  });

  test('rolls back through the caller when validation rejects the locked snapshot', async () => {
    const { calls, sql } = createTransactionSql([
      [
        {
          document_index: null,
          meta: STORED_META,
          revision: '4',
          snapshot: STORED_SNAPSHOT,
        },
      ],
    ]);
    const staleResult = new Error('Il risultato non corrisponde piu alla lezione corrente.');

    await expect(
      patchProjectInTransaction(sql, {
        buildPatch: () => {
          throw staleResult;
        },
        projectId: 'project-1',
        updatedAt: '2026-07-29T12:00:00.000Z',
        userId: 'user-1',
      })
    ).rejects.toBe(staleResult);
    expect(calls).toHaveLength(1);
  });

  test('reports a revision conflict if the locked row cannot be updated', async () => {
    const { calls, sql } = createTransactionSql([
      [
        {
          document_index: null,
          meta: STORED_META,
          revision: '4',
          snapshot: STORED_SNAPSHOT,
        },
      ],
      [],
    ]);

    await expect(
      patchProjectInTransaction(sql, {
        buildPatch: () => ({ title: 'Titolo aggiornato' }),
        projectId: 'project-1',
        updatedAt: '2026-07-29T12:00:00.000Z',
        userId: 'user-1',
      })
    ).rejects.toBeInstanceOf(ProjectRevisionConflictError);
    expect(calls).toHaveLength(2);
  });
});
