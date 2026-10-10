import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createLessonPlaybackApi } from '../../src/workflows/lessonPlaybackApi.js';
import { createProductionRegistry } from '../../src/workflows/runtime/workflowRuntimeComposition.js';
import { playbackProject, preparedPlayback } from '../helpers/lessonPlayback.js';
import {
  createPostgresWorkflowIntegrationContext,
  createStore,
  setupPostgresWorkflowIntegrationContext,
  teardownPostgresWorkflowIntegrationContext,
} from './postgresWorkflowStore.integration.fixture.js';

const context = createPostgresWorkflowIntegrationContext();
describe.skipIf(!context.enabled)('durable playback request deduplication', () => {
  beforeAll(() => setupPostgresWorkflowIntegrationContext(context));
  afterAll(() => teardownPostgresWorkflowIntegrationContext(context));

  test('two simultaneous requests start one run; other voices and blocks wait on that run', async () => {
    if (!context.sql) throw new Error('Workflow integration database is required.');
    const store = createStore(context.sql);
    const snapshot = { ...playbackProject(), id: context.projectId };
    const api = createLessonPlaybackApi({
      projectReader: {
        loadProjectWithRevision: async () => ({
          snapshot,
          incarnationId: 'incarnation-1',
          revision: 1,
        }),
      },
      registry: createProductionRegistry(),
      store,
      resolveTtsModel: async () => 'tts-model',
    });
    const target = {
      projectId: context.projectId,
      userId: context.userId,
      sectionId: 'section-1',
      blockId: '0',
      voice: 'Kore',
      lessonKey: preparedPlayback().lessonKey,
    };
    const [first, second] = await Promise.all([api.prepare(target), api.prepare(target)]);
    expect(first).toEqual(second);
    expect(await api.prepare({ ...target, voice: 'Zephyr', blockId: '1' })).toEqual(first);
    const rows =
      await context.sql`select id from public.workflow_runs where user_id = ${context.userId} and project_id = ${context.projectId} and workflow_id = 'prepare-lesson-playback-block'`;
    expect(rows).toHaveLength(1);
  });
});
