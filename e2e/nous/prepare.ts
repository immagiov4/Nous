import postgres from 'postgres';
import * as z from 'zod';
import { PostgresAccountStore } from '../../apps/backend/src/account/accountStore';
import { PostgresProjectStore } from '../../apps/backend/src/projects/postgresProjectStore';
import { createProjectAssetStorage } from '../../apps/backend/src/projects/projectAsset';
import { PostgresProjectAssetDeletionQueue } from '../../apps/backend/src/projects/projectAssetDeletionQueue';
import { PostgresProjectAssetImporter } from '../../apps/backend/src/projects/projectAssetImport';
import { SupabaseProjectSourceStorage } from '../../apps/backend/src/projects/projectSourceStorage';
import { recordDiagnostic } from '../../packages/playtest/src/diagnostics';
import type { Story, Viewport } from '../../packages/playtest/src/types';
import { withRunCleanup } from '../../scripts/run-evidence';
import { withGenerationSettings } from './backend';
import { type FixtureImport, importFixture } from './fixtures';
import { createPreparationDeadline, type FreshnessEvidence, regenerateLesson } from './freshness';
import { ACCOUNT_CLEANUP_STEP, type PreparationDeadline } from './preparationDeadline';
import { assertIsolatedStatus, type StackStatus, stackStatus } from './stack';
import { syntheticCourse } from './syntheticCourse';
import { settleAccountWorkflows } from './workflowCleanup';

export { syntheticCourse } from './syntheticCourse';

function projectStore(
  isolated: StackStatus,
  deadline?: PreparationDeadline,
  cleanup = false
): PostgresProjectStore {
  const sql = postgres(isolated.DB_URL);
  deadline?.ownConnection(sql, cleanup);
  const storageConfig = {
    serviceRoleKey: isolated.SERVICE_ROLE_KEY,
    supabaseUrl: isolated.API_URL,
  };
  const assets = createProjectAssetStorage(storageConfig);
  return new PostgresProjectStore(
    isolated.DB_URL,
    sql,
    new SupabaseProjectSourceStorage(storageConfig),
    new PostgresProjectAssetDeletionQueue(sql, assets),
    new PostgresProjectAssetImporter(sql, assets)
  );
}

/** Product deletion queues asset cleanup before the synthetic account is removed. */
async function cleanupUser(
  isolated: StackStatus,
  userId: string,
  deadline?: PreparationDeadline
): Promise<void> {
  const store = projectStore(isolated, deadline, true);
  const cleanup = async () => {
    const sql = postgres(isolated.DB_URL);
    deadline?.ownConnection(sql, true);
    await withRunCleanup(
      () => settleAccountWorkflows(sql, userId, deadline?.cleanupSignal),
      () => sql.end()
    );
    deadline?.cleanupSignal.throwIfAborted();
    for (const project of await store.listProjects(userId))
      await store.deleteProject(userId, project.id);
    const response = await fetch(`${isolated.API_URL}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      signal: deadline?.cleanupSignal,
      headers: {
        apikey: isolated.SERVICE_ROLE_KEY,
        Authorization: `Bearer ${isolated.SERVICE_ROLE_KEY}`,
      },
    });
    if (!response.ok)
      throw new Error(`Synthetic account cleanup failed (HTTP ${response.status}).`);
  };
  return withRunCleanup(cleanup, () => store.close());
}

async function skipAccountSetup(isolated: StackStatus, userId: string): Promise<void> {
  const sql = postgres(isolated.DB_URL);
  try {
    await new PostgresAccountStore(sql).finishSetup(userId, { status: 'skipped' });
  } finally {
    await sql.end();
  }
}

async function populateCourse(input: {
  isolated: StackStatus;
  userId: string;
  course?: string;
}): Promise<FixtureImport | undefined> {
  const { isolated, userId, course } = input;
  if (course === undefined) return;
  const store = projectStore(isolated);
  try {
    if (course === 'synthetic-short' || course === 'synthetic-law-short')
      await store.saveProject(userId, syntheticCourse(course));
    else return await importFixture(course.slice('fixture:'.length), store, userId);
  } finally {
    await store.close();
  }
}

function storyPreconditions(story: Story) {
  const unsupported = Object.keys(story.requires).filter(
    key => !['course', 'onboarding', 'affect', 'freshness', 'lesson'].includes(key)
  );
  if (unsupported.length)
    throw new Error(`Unsupported story preconditions: ${unsupported.join(', ')}.`);
  const course = z
    .string()
    .optional()
    .parse(
      story.requires.course === undefined
        ? undefined
        : (process.env.NOUS_E2E_COURSE ?? story.requires.course)
    );
  const freshness = z
    .enum(['any', 'current'])
    .default('any')
    .parse(
      course === undefined
        ? story.requires.freshness
        : (process.env.NOUS_E2E_FRESHNESS ?? story.requires.freshness)
    );
  const sectionId = z
    .string()
    .trim()
    .min(1)
    .optional()
    .parse(process.env.NOUS_E2E_LESSON ?? story.requires.lesson);
  if (freshness === 'current' && (!course?.startsWith('fixture:') || !sectionId))
    throw new Error('Current freshness requires an explicit fixture course and lesson ID.');
  const onboarding = z.literal('first-run').optional().parse(story.requires.onboarding);
  if (
    course !== undefined &&
    course !== 'synthetic-short' &&
    course !== 'synthetic-law-short' &&
    !course.startsWith('fixture:')
  )
    throw new Error(`Unsupported course precondition: ${course}.`);
  return { course, freshness, sectionId, onboarding };
}

/** Fresh credentials stay with the operator. The store receives explicit isolated storage URLs. */
export async function prepare(
  story: Story,
  viewport: Viewport,
  status?: StackStatus
): Promise<{
  credentials: { email: string; password: string };
  cleanup: () => Promise<void>;
  fixture?: FixtureImport;
  freshness?: FreshnessEvidence;
  inspectionSelector?: string;
}> {
  const { course, freshness, sectionId, onboarding } = storyPreconditions(story);
  const isolated = status ?? (await stackStatus());
  assertIsolatedStatus(isolated);
  const credentials = {
    email: `playtest-${viewport}-${crypto.randomUUID()}@example.test`,
    password: crypto.randomUUID(),
  };
  const response = await fetch(`${isolated.API_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: isolated.SERVICE_ROLE_KEY,
      Authorization: `Bearer ${isolated.SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...credentials,
      email_confirm: true,
      ...(freshness === 'current' ? { app_metadata: { ai_provider: 'openrouter' } } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Synthetic account creation failed (HTTP ${response.status}).`);
  const user = z.object({ id: z.uuid() }).parse(await response.json());
  let deadline: PreparationDeadline | undefined;
  const cleanup = () =>
    deadline
      ? deadline.step(
          ACCOUNT_CLEANUP_STEP,
          () => cleanupUser(isolated, user.id, deadline),
          'cleanup'
        )
      : cleanupUser(isolated, user.id);
  let fixture: FixtureImport | undefined;
  let generation: FreshnessEvidence | undefined;
  try {
    if (onboarding !== 'first-run') {
      await skipAccountSetup(isolated, user.id);
    }
    fixture = await populateCourse({ isolated, userId: user.id, course });
    if (freshness === 'current' && fixture && sectionId) {
      const projectId = fixture.importedProjectId;
      deadline = createPreparationDeadline({
        userId: user.id,
        story,
        viewport,
        projectId,
        sectionId,
        isolated,
      });
      const preparing = deadline;
      const store = projectStore(isolated, preparing);
      try {
        generation = await withGenerationSettings(
          user.id,
          () =>
            regenerateLesson({
              story,
              viewport,
              isolated,
              credentials,
              userId: user.id,
              projectId,
              sectionId,
              store,
              deadline: preparing,
            }),
          preparing
        );
      } finally {
        await preparing.step('generation-store-close', () => store.close(), 'cleanup');
      }
    }
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      recordDiagnostic('preparation-cleanup', cleanupError);
      if (deadline?.signal.aborted) throw deadline.signal.reason;
      throw new AggregateError(
        [error, cleanupError],
        'Story preparation and synthetic account cleanup failed.',
        { cause: error }
      );
    }
    throw deadline?.signal.aborted ? deadline.signal.reason : error;
  } finally {
    deadline?.finish();
  }
  return {
    credentials,
    cleanup,
    ...(fixture ? { fixture } : {}),
    ...(generation
      ? {
          freshness: generation,
          inspectionSelector: [
            '[data-nous-lesson-content-root="true"]',
            `[data-nous-project-id=${JSON.stringify(generation.projectId)}]`,
            `[data-nous-section-id=${JSON.stringify(generation.sectionId)}]`,
            `[data-nous-generation-run-id=${JSON.stringify(generation.workflowId)}]`,
          ].join(''),
        }
      : {}),
  };
}
