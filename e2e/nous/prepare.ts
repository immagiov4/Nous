import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import postgres from 'postgres';
import * as z from 'zod';
import { PostgresProjectStore } from '../../apps/backend/src/projects/postgresProjectStore';
import { createProjectAssetStorage } from '../../apps/backend/src/projects/projectAsset';
import { PostgresProjectAssetDeletionQueue } from '../../apps/backend/src/projects/projectAssetDeletionQueue';
import { PostgresProjectAssetImporter } from '../../apps/backend/src/projects/projectAssetImport';
import { SupabaseProjectSourceStorage } from '../../apps/backend/src/projects/projectSourceStorage';
import type { ProjectSnapshot } from '../../apps/backend/src/projects/types';
import type { Story, Viewport } from '../../packages/playtest/src/types';
import { assertIsolatedStatus, dataRoot, type StackStatus, stackStatus } from './stack';

export function syntheticCourse(): ProjectSnapshot {
  const markdown =
    '## Il ciclo dell’acqua\n\nIl Sole scalda l’acqua e provoca evaporazione. Il vapore si raffredda e forma le nuvole per condensazione. Le precipitazioni riportano l’acqua al suolo.\n\n**Domanda:** quali sono le tre fasi principali?';
  const lesson = {
    content: markdown,
    contentBlocks: [{ markdown, type: 'markdown' as const }],
    description: 'Una breve lezione di scienze.',
    generatedVisuals: [],
    id: 'lesson-water',
    imageRefs: [],
    isCompleted: true,
    kind: 'lesson' as const,
    learningAids: [],
    quiz: [],
    title: 'Il ciclo dell’acqua',
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
      modules: [{ children: [lesson], id: 'module-water', title: 'Acqua e ambiente' }],
      title: 'Scienze: il ciclo dell’acqua',
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

async function fixtureBytes(name: string): Promise<Buffer> {
  const root = await realpath(join(dataRoot(), 'fixtures')).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error('Required fixture directory is missing.');
      throw error;
    }
  );
  const path = await realpath(join(root, name)).catch(() => {
    throw new Error(`Required fixture is missing: ${name}.`);
  });
  const within = relative(root, path);
  if (!within || within.startsWith('..') || isAbsolute(within))
    throw new Error('Required fixture must be a file within NOUS_E2E_DATA/fixtures.');
  return readFile(path).catch(() => {
    throw new Error(`Required fixture is not readable: ${name}.`);
  });
}

/** Fresh credentials stay with the operator. The store receives explicit isolated storage URLs. */
export async function prepare(
  story: Story,
  viewport: Viewport,
  status?: StackStatus
): Promise<{ credentials: { email: string; password: string } }> {
  const unsupported = Object.keys(story.requires).filter(key => key !== 'course');
  if (unsupported.length)
    throw new Error(`Unsupported story preconditions: ${unsupported.join(', ')}.`);
  const course = z.string().optional().parse(story.requires.course);
  if (course !== undefined && course !== 'synthetic-short' && !course.startsWith('fixture:'))
    throw new Error(`Unsupported course precondition: ${course}.`);
  const bytes = course?.startsWith('fixture:')
    ? await fixtureBytes(course.slice('fixture:'.length))
    : undefined;
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
  const user = z.object({ id: z.string().uuid() }).parse(await response.json());
  if (course !== undefined) {
    const sql = postgres(isolated.DB_URL);
    const storageConfig = {
      serviceRoleKey: isolated.SERVICE_ROLE_KEY,
      supabaseUrl: isolated.API_URL,
    };
    const assets = createProjectAssetStorage(storageConfig);
    const store = new PostgresProjectStore(
      isolated.DB_URL,
      sql,
      new SupabaseProjectSourceStorage(storageConfig),
      new PostgresProjectAssetDeletionQueue(sql, assets),
      new PostgresProjectAssetImporter(sql, assets)
    );
    try {
      if (course === 'synthetic-short') await store.saveProject(user.id, syntheticCourse());
      else if (bytes) {
        // Product exports use JSON for snapshots and ZIP for projects with attachments.
        if (course.endsWith('.json'))
          await store.importProject(user.id, JSON.parse(bytes.toString('utf8')));
        else await store.importProjectArchive(user.id, bytes, crypto.randomUUID());
      }
    } finally {
      await store.close();
    }
  }
  return { credentials };
}
