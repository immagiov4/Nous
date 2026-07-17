import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { GlobalModelConfig } from '../../src/config/modelConfig.js';
import type { ProjectSnapshot, ProjectStore, SavedProjectMeta } from '../../src/projects/types.js';

const {
  createConfiguredTextModelMock,
  generateImageMock,
  generateTextMock,
  getProjectStoreMock,
  getResolvedModelConfigMock,
  runCodexAppServerTurnMock,
} = vi.hoisted(() => ({
  createConfiguredTextModelMock: vi.fn(),
  generateImageMock: vi.fn(),
  generateTextMock: vi.fn(),
  getProjectStoreMock: vi.fn(),
  getResolvedModelConfigMock: vi.fn(),
  runCodexAppServerTurnMock: vi.fn(),
}));

vi.mock('ai', async importOriginal => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generateTextMock,
}));

vi.mock('../../src/projects/projectStore.js', () => ({
  getProjectStore: getProjectStoreMock,
}));

vi.mock('../../src/config/modelConfig.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/config/modelConfig.js')>()),
  getResolvedModelConfigForProvider: getResolvedModelConfigMock,
}));

vi.mock('../../src/services/aiSdkTextModel.js', () => ({
  createConfiguredTextModel: createConfiguredTextModelMock,
}));

vi.mock('../../src/services/codexAppServer.js', () => ({
  runCodexAppServerTurn: runCodexAppServerTurnMock,
}));

vi.mock('../../src/services/imageClient.js', () => ({
  imageClient: { generateImage: generateImageMock },
}));

const { getCourseCoverRegenerationStatus, startOrResumeCourseCoverRegeneration } = await import(
  '../../src/services/courseCoverRegeneration.js'
);

const MODEL_CONFIG = {
  aiProvider: 'openrouter',
  assessmentModel: 'openrouter/assessment',
  assessmentReasoningEffort: 'low',
  codexAssessmentModel: 'codex/assessment',
  codexArtifactModel: 'codex/image',
  imageModel: 'openrouter/image',
  openAiAssessmentModel: 'openai/assessment',
  openAiImageModel: 'openai/image',
} as GlobalModelConfig;
const MAX_CONCURRENT_TEST_SLOTS = 4;

const direction = {
  composition: 'Close editorial crop from above.',
  distinctiveDetails: 'Visible domain-specific tools and precise illustrative marks.',
  subject: 'A recognizable course subject.',
};

const project = (id: string): SavedProjectMeta => ({
  completedCount: 0,
  completedExercises: 0,
  coverLabel: `${id}.pdf`,
  createdAt: '2026-07-17T00:00:00.000Z',
  exerciseCount: 0,
  hasSourceFile: true,
  id,
  lastOpenedAt: '2026-07-17T00:00:00.000Z',
  lessonCount: 1,
  revision: 1,
  sourceKind: 'document',
  title: `Course ${id}`,
  updatedAt: '2026-07-17T00:00:00.000Z',
});

const snapshotFor = (meta: SavedProjectMeta): ProjectSnapshot => ({
  createdAt: meta.createdAt,
  id: meta.id,
  lastOpenedAt: meta.lastOpenedAt,
  sourceKind: meta.sourceKind,
  title: meta.title,
  updatedAt: meta.updatedAt,
  version: '1',
});

const imageResult = {
  dataUrl: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
  mediaType: 'image/png' as const,
};

const buildStore = (projects: SavedProjectMeta[]) =>
  ({
    listProjects: vi.fn(async () => projects),
    loadProject: vi.fn(async (_userId: string, id: string) => {
      const meta = projects.find(candidate => candidate.id === id);
      return meta ? snapshotFor(meta) : null;
    }),
    saveProjectCover: vi.fn(async () => true),
  }) as unknown as ProjectStore & {
    listProjects: ReturnType<typeof vi.fn>;
    loadProject: ReturnType<typeof vi.fn>;
    saveProjectCover: ReturnType<typeof vi.fn>;
  };

const waitForTerminalJob = async (userId: string) => {
  await vi.waitFor(() => {
    expect(getCourseCoverRegenerationStatus(userId)?.status).not.toBe('running');
  });
  const job = getCourseCoverRegenerationStatus(userId);
  if (!job) throw new Error('Expected course cover regeneration job.');
  return job;
};

describe('course cover regeneration jobs', () => {
  beforeEach(() => {
    generateImageMock.mockReset();
    generateTextMock.mockReset();
    getProjectStoreMock.mockReset();
    getResolvedModelConfigMock.mockReset();
    runCodexAppServerTurnMock.mockReset();
    createConfiguredTextModelMock.mockReset();
    createConfiguredTextModelMock.mockReturnValue({
      model: { modelId: 'assessment' },
      providerOptions: {},
    });
    generateTextMock.mockResolvedValue({ output: direction });
    generateImageMock.mockResolvedValue(imageResult);
    getResolvedModelConfigMock.mockResolvedValue(MODEL_CONFIG);
  });

  test('status-only lookup does not start a job', () => {
    expect(getCourseCoverRegenerationStatus('status-only-user')).toBeNull();
    expect(getProjectStoreMock).not.toHaveBeenCalled();
  });

  test('starts once, exposes progress, and reuses the completed job during cooldown', async () => {
    const store = buildStore([project('owned')]);
    getProjectStoreMock.mockReturnValue(store);
    let finishImage!: (value: typeof imageResult) => void;
    generateImageMock.mockReturnValueOnce(
      new Promise(resolve => {
        finishImage = resolve;
      })
    );

    const first = startOrResumeCourseCoverRegeneration('dedup-user', 'openrouter');
    const duplicate = startOrResumeCourseCoverRegeneration('dedup-user', 'openrouter');

    expect(first.status).toBe('running');
    expect(duplicate.id).toBe(first.id);
    await vi.waitFor(() => expect(generateImageMock).toHaveBeenCalledTimes(1));
    finishImage(imageResult);
    const completed = await waitForTerminalJob('dedup-user');
    expect(completed.summary).toEqual({
      failed: 0,
      pending: 0,
      regenerated: 1,
      skipped: 0,
      total: 1,
    });
    expect(completed.results[0]).toEqual(
      expect.objectContaining({
        coverName: 'owned-cover-v2.png',
        projectId: 'owned',
        status: 'regenerated',
      })
    );
    expect(startOrResumeCourseCoverRegeneration('dedup-user').id).toBe(first.id);
    expect(store.listProjects).toHaveBeenCalledTimes(1);
  });

  test('uses fair global scheduling with at most four active operations across users', async () => {
    const userAProjects = Array.from({ length: 8 }, (_, index) => project(`a-${index}`));
    const userBProjects = [project('b-0')];
    const stores = new Map([
      ['fair-user-a', buildStore(userAProjects)],
      ['fair-user-b', buildStore(userBProjects)],
    ]);
    getProjectStoreMock.mockImplementation(() => {
      const pendingUser =
        getProjectStoreMock.mock.calls.length === 1 ? 'fair-user-a' : 'fair-user-b';
      return stores.get(pendingUser);
    });
    let activeImages = 0;
    let maxActiveImages = 0;
    const starts: string[] = [];
    const releaseInitialSlots: Array<() => void> = [];
    generateImageMock.mockImplementation(async ({ prompt }: { prompt: string }) => {
      const title = /for "([^"]+)"/u.exec(prompt)?.[1] || '';
      starts.push(title);
      activeImages += 1;
      maxActiveImages = Math.max(maxActiveImages, activeImages);
      if (releaseInitialSlots.length < MAX_CONCURRENT_TEST_SLOTS) {
        await new Promise<void>(resolve => releaseInitialSlots.push(resolve));
      }
      activeImages -= 1;
      return imageResult;
    });

    startOrResumeCourseCoverRegeneration('fair-user-a');
    await vi.waitFor(() => expect(releaseInitialSlots).toHaveLength(MAX_CONCURRENT_TEST_SLOTS));
    startOrResumeCourseCoverRegeneration('fair-user-b');
    for (const release of releaseInitialSlots) release();
    const [jobA, jobB] = await Promise.all([
      waitForTerminalJob('fair-user-a'),
      waitForTerminalJob('fair-user-b'),
    ]);

    expect(maxActiveImages).toBe(4);
    expect(starts.indexOf('Course b-0')).toBeLessThanOrEqual(5);
    expect(jobA.summary.regenerated).toBe(8);
    expect(jobB.summary.regenerated).toBe(1);
  });

  test('releases a scheduler slot after rejection and keeps the failed cover untouched', async () => {
    const store = buildStore([project('failed'), project('ok')]);
    getProjectStoreMock.mockReturnValue(store);
    generateImageMock
      .mockRejectedValueOnce(new Error('provider secret detail'))
      .mockResolvedValueOnce(imageResult);

    startOrResumeCourseCoverRegeneration('reject-user');
    const job = await waitForTerminalJob('reject-user');

    expect(job.summary).toMatchObject({ failed: 1, pending: 0, regenerated: 1 });
    expect(store.saveProjectCover).toHaveBeenCalledTimes(1);
    expect(job.results).toEqual([
      expect.objectContaining({ projectId: 'failed', status: 'failed' }),
      expect.objectContaining({ projectId: 'ok', status: 'regenerated' }),
    ]);
  });

  test('does not generate or save when provider planning rejects or returns invalid output', async () => {
    const rejectedStore = buildStore([project('planner-reject')]);
    getProjectStoreMock.mockReturnValue(rejectedStore);
    generateTextMock.mockRejectedValueOnce(new Error('planner unavailable'));
    startOrResumeCourseCoverRegeneration('planner-reject-user');
    const rejectedJob = await waitForTerminalJob('planner-reject-user');

    expect(rejectedJob.results[0]?.status).toBe('failed');
    expect(rejectedStore.saveProjectCover).not.toHaveBeenCalled();
    expect(generateImageMock).not.toHaveBeenCalled();

    const invalidStore = buildStore([project('planner-invalid')]);
    getProjectStoreMock.mockReturnValue(invalidStore);
    generateTextMock.mockResolvedValueOnce({ output: { subject: 'Incomplete' } });
    startOrResumeCourseCoverRegeneration('planner-invalid-user');
    const invalidJob = await waitForTerminalJob('planner-invalid-user');

    expect(invalidJob.results[0]?.status).toBe('failed');
    expect(invalidStore.saveProjectCover).not.toHaveBeenCalled();
  });

  test('skips atomic persistence when the project was renamed or its revision changed', async () => {
    const renamedStore = buildStore([project('renamed')]);
    renamedStore.loadProject.mockResolvedValueOnce({
      ...snapshotFor(project('renamed')),
      title: 'Renamed while generating',
    });
    getProjectStoreMock.mockReturnValue(renamedStore);
    startOrResumeCourseCoverRegeneration('renamed-user');
    const renamedJob = await waitForTerminalJob('renamed-user');
    expect(renamedJob.results[0]?.status).toBe('skipped');
    expect(renamedStore.saveProjectCover).not.toHaveBeenCalled();

    const revisionStore = buildStore([project('revision')]);
    revisionStore.saveProjectCover.mockResolvedValueOnce(false);
    getProjectStoreMock.mockReturnValue(revisionStore);
    startOrResumeCourseCoverRegeneration('revision-user');
    const revisionJob = await waitForTerminalJob('revision-user');
    expect(revisionJob.results[0]?.status).toBe('skipped');
    expect(revisionStore.saveProjectCover).toHaveBeenCalledWith(
      'revision-user',
      'revision',
      expect.any(Object),
      { expectedRevision: 1 }
    );
  });

  test('uses OpenAI assessment and image models', async () => {
    const store = buildStore([project('openai')]);
    getProjectStoreMock.mockReturnValue(store);
    const openAiConfig = { ...MODEL_CONFIG, aiProvider: 'openai' as const };
    getResolvedModelConfigMock.mockResolvedValue(openAiConfig);

    startOrResumeCourseCoverRegeneration('openai-user', 'openai');
    await waitForTerminalJob('openai-user');

    expect(createConfiguredTextModelMock).toHaveBeenCalledWith(openAiConfig, 'assessment');
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
    );
    expect(generateImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'openai/image', provider: 'openai' })
    );
  });

  test('uses the Codex assessment planner and retries immediately after setup failure', async () => {
    const store = buildStore([project('codex')]);
    getProjectStoreMock.mockReturnValue(store);
    getResolvedModelConfigMock
      .mockRejectedValueOnce(new Error('temporary configuration failure'))
      .mockResolvedValueOnce({ ...MODEL_CONFIG, aiProvider: 'codex' });
    runCodexAppServerTurnMock.mockResolvedValue(JSON.stringify(direction));

    const failedStart = startOrResumeCourseCoverRegeneration('retry-user', 'codex');
    const failedJob = await waitForTerminalJob('retry-user');
    expect(failedJob.status).toBe('failed');

    const retryStart = startOrResumeCourseCoverRegeneration('retry-user', 'codex');
    expect(retryStart.id).not.toBe(failedStart.id);
    const completedJob = await waitForTerminalJob('retry-user');
    expect(completedJob.status).toBe('completed');
    expect(runCodexAppServerTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'codex/assessment',
        outputSchema: expect.objectContaining({ type: 'object' }),
      })
    );
    expect(generateImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'codex/image', provider: 'codex' })
    );
  });
});
