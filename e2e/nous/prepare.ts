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
import { type FixtureImport, importFixture } from './fixtures';
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

function projectStore(isolated: StackStatus): PostgresProjectStore {
  const sql = postgres(isolated.DB_URL);
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
async function cleanupUser(isolated: StackStatus, userId: string): Promise<void> {
  const store = projectStore(isolated);
  try {
    for (const project of await store.listProjects(userId))
      await store.deleteProject(userId, project.id);
    const response = await fetch(`${isolated.API_URL}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: {
        apikey: isolated.SERVICE_ROLE_KEY,
        Authorization: `Bearer ${isolated.SERVICE_ROLE_KEY}`,
      },
    });
    if (!response.ok)
      throw new Error(`Synthetic account cleanup failed (HTTP ${response.status}).`);
  } finally {
    await store.close();
  }
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

/** Fresh credentials stay with the operator. The store receives explicit isolated storage URLs. */
export async function prepare(
  story: Story,
  viewport: Viewport,
  status?: StackStatus
): Promise<{
  credentials: { email: string; password: string };
  cleanup: () => Promise<void>;
  fixture?: FixtureImport;
}> {
  const unsupported = Object.keys(story.requires).filter(
    key => !['course', 'onboarding', 'affect'].includes(key)
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
  const onboarding = z.literal('first-run').optional().parse(story.requires.onboarding);
  if (
    course !== undefined &&
    course !== 'synthetic-short' &&
    course !== 'synthetic-law-short' &&
    !course.startsWith('fixture:')
  )
    throw new Error(`Unsupported course precondition: ${course}.`);
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
    body: JSON.stringify({ ...credentials, email_confirm: true }),
  });
  if (!response.ok) throw new Error(`Synthetic account creation failed (HTTP ${response.status}).`);
  const user = z.object({ id: z.uuid() }).parse(await response.json());
  const cleanup = () => cleanupUser(isolated, user.id);
  let fixture: FixtureImport | undefined;
  try {
    if (onboarding !== 'first-run') {
      await skipAccountSetup(isolated, user.id);
    }
    fixture = await populateCourse({ isolated, userId: user.id, course });
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      recordDiagnostic('preparation-cleanup', cleanupError);
      throw new AggregateError(
        [error, cleanupError],
        'Story preparation and synthetic account cleanup failed.'
      );
    }
    throw error;
  }
  return { credentials, cleanup, ...(fixture ? { fixture } : {}) };
}
