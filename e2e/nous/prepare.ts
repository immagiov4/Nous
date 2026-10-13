import postgres from 'postgres';
import * as z from 'zod';
import { PostgresAccountStore } from '../../apps/backend/src/account/accountStore';
import { PostgresProjectStore } from '../../apps/backend/src/projects/postgresProjectStore';
import { createProjectAssetStorage } from '../../apps/backend/src/projects/projectAsset';
import { PostgresProjectAssetDeletionQueue } from '../../apps/backend/src/projects/projectAssetDeletionQueue';
import { PostgresProjectAssetImporter } from '../../apps/backend/src/projects/projectAssetImport';
import { SupabaseProjectSourceStorage } from '../../apps/backend/src/projects/projectSourceStorage';
import type { ProjectSnapshot } from '../../apps/backend/src/projects/types';
import { recordDiagnostic } from '../../packages/playtest/src/diagnostics';
import type { Story, Viewport } from '../../packages/playtest/src/types';
import { withRunCleanup } from '../../scripts/run-evidence';
import { withGenerationSettings } from './backend';
import { type FixtureImport, importFixture } from './fixtures';
import { createPreparationDeadline, type FreshnessEvidence, regenerateLesson } from './freshness';
import { ACCOUNT_CLEANUP_STEP, type PreparationDeadline } from './preparationDeadline';
import { assertIsolatedStatus, type StackStatus, stackStatus } from './stack';

export function syntheticCourse(
  kind: 'synthetic-short' | 'synthetic-law-short' = 'synthetic-short'
): ProjectSnapshot {
  const law = kind === 'synthetic-law-short';
  const markdown = law
    ? '## La validità del contratto\n\nUn contratto richiede accordo, causa, oggetto e, quando la legge la impone per la validità, una forma specifica. La nullità riguarda difetti come la mancanza di un requisito essenziale o una causa illecita: il contratto nullo è invalido fin dall’origine. Per esempio, un accordo che promette un compenso per commettere un reato ha una causa illecita.\n\nL’annullabilità protegge invece una parte in situazioni come l’incapacità legale o un consenso viziato da errore, violenza o dolo, alle condizioni previste dalla legge. Il contratto annullabile produce effetti finché viene annullato. Per esempio, una persona indotta a firmare con una minaccia può chiedere l’annullamento.\n\nPer distinguere le due figure, chiediti quale difetto colpisce il contratto e chi viene protetto. **Domanda:** perché la minaccia dell’esempio porta all’annullabilità?'
    : '## Il ciclo dell’acqua\n\nIl Sole scalda l’acqua e provoca evaporazione. Il vapore si raffredda e forma le nuvole per condensazione. Le precipitazioni riportano l’acqua al suolo.\n\n**Domanda:** quali sono le tre fasi principali?';
  const lesson = {
    content: markdown,
    contentBlocks: [{ markdown, type: 'markdown' as const }],
    description: law
      ? 'Una breve lezione introduttiva di diritto privato.'
      : 'Una breve lezione di scienze.',
    generatedVisuals: [],
    id: law ? 'lesson-contract' : 'lesson-water',
    imageRefs: [],
    isCompleted: true,
    kind: 'lesson' as const,
    learningAids: [],
    quiz: [],
    title: law ? 'La validità del contratto' : 'Il ciclo dell’acqua',
    type: 'core' as const,
  };
  const date = new Date().toISOString();
  return {
    activeSectionId: lesson.id,
    createdAt: date,
    id: crypto.randomUUID(),
    isLearnMode: false,
    lastOpenedAt: date,
    learningPlan: {
      applicationExercisePlanningStatus: 'not-run',
      modules: [
        {
          children: [lesson],
          id: law ? 'module-law' : 'module-water',
          title: law ? 'Il contratto' : 'Acqua e ambiente',
        },
      ],
      title: law ? 'Diritto privato: la validità del contratto' : 'Scienze: il ciclo dell’acqua',
    },
    source: null,
    sourceKind: 'document',
    state: 'READING',
    syllabus: [],
    updatedAt: date,
    userProfile: null,
    version: '4.1',
  };
}

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
  const freshness = z.enum(['any', 'current']).default('any').parse(story.requires.freshness);
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
