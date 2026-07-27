/** @vitest-environment jsdom */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchWithSupabaseAuthMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: fetchWithSupabaseAuthMock,
}));

vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));

const { generateDurableLesson, LessonGenerationBusyError } = await import(
  '../../../services/openrouter/lessonGenerationClient.ts'
);

const completedResult = {
  content: '## Fotosintesi\n\nLa luce viene convertita.',
  contentBlocks: [{ markdown: '## Fotosintesi\n\nLa luce viene convertita.', type: 'markdown' }],
  generatedVisuals: [],
  imageRefs: [],
  learningAids: [],
  projectId: 'project-1',
  projectRevision: 7,
  quiz: [],
  sectionId: 'lesson-1',
};

describe('generateDurableLesson', () => {
  beforeEach(() => {
    fetchWithSupabaseAuthMock.mockReset();
    globalThis.sessionStorage.clear();
  });

  test('rejoins an active backend job and returns its persisted lesson', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            job: {
              id: 'job-1',
              kind: 'lesson',
              payload: { projectId: 'project-1', sectionId: 'lesson-1' },
              stage: 'running',
              status: 'running',
            },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            job: {
              id: 'job-1',
              kind: 'lesson',
              result: completedResult,
              stage: 'completed',
              status: 'completed',
            },
          }),
          { status: 200 }
        )
      );

    await expect(
      generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' })
    ).resolves.toMatchObject(completedResult);
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      3,
      'http://localhost:3301/api/generation-jobs/job-1/wait?afterStage=running',
      { cache: 'no-store' }
    );
  });

  test('rejoins the latest active job after a page reload without posting a duplicate', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            job: {
              id: 'job-reconnected',
              kind: 'lesson',
              stage: 'running',
              status: 'running',
            },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            job: {
              id: 'job-reconnected',
              kind: 'lesson',
              result: completedResult,
              stage: 'completed',
              status: 'completed',
            },
          }),
          { status: 200 }
        )
      );

    await expect(
      generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' })
    ).resolves.toMatchObject(completedResult);
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(2);
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3301/api/generation-jobs/lessons/project-1/lesson-1/latest',
      { cache: 'no-store' }
    );
  });

  test('reports every authoritative backend stage while waiting for the lesson', async () => {
    const stages = ['sources', 'structure', 'drafting', 'quiz', 'verification'] as const;
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            job: { id: 'job-progress', kind: 'lesson', stage: 'queued', status: 'queued' },
          }),
          { status: 202 }
        )
      );
    for (const stage of stages) {
      fetchWithSupabaseAuthMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            job: { id: 'job-progress', kind: 'lesson', stage, status: 'running' },
          }),
          { status: 200 }
        )
      );
    }
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          job: {
            id: 'job-progress',
            kind: 'lesson',
            result: completedResult,
            stage: 'completed',
            status: 'completed',
          },
        }),
        { status: 200 }
      )
    );
    const onProgressStage = vi.fn();

    await generateDurableLesson({
      onProgressStage,
      projectId: 'project-1',
      sectionId: 'lesson-1',
    });

    expect(onProgressStage.mock.calls.map(([stage]) => stage)).toEqual(stages);
    expect(fetchWithSupabaseAuthMock).toHaveBeenLastCalledWith(
      'http://localhost:3301/api/generation-jobs/job-progress/wait?afterStage=verification',
      { cache: 'no-store' }
    );
  });

  test('reports the other lesson holding the authoritative project lock', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: false,
            error: 'busy',
            job: {
              id: 'job-1',
              kind: 'lesson',
              payload: { projectId: 'project-1', sectionId: 'lesson-2' },
              stage: 'running',
              status: 'running',
            },
          }),
          { status: 409 }
        )
      );

    const promise = generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' });
    await expect(promise).rejects.toBeInstanceOf(LessonGenerationBusyError);
    await expect(promise).rejects.toMatchObject({ activeSectionId: 'lesson-2' });
  });

  test('rejects a completed result for a different lesson', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          job: {
            id: 'job-1',
            kind: 'lesson',
            result: { ...completedResult, sectionId: 'lesson-2' },
            stage: 'completed',
            status: 'completed',
          },
        }),
        { status: 200 }
      )
    );

    await expect(
      generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' })
    ).rejects.toThrow('La generazione della lezione non è riuscita');
  });

  test('surfaces the latest failed job without silently starting another attempt', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          job: {
            errorCode: 'lesson_provider_failed',
            id: 'failed-job',
            kind: 'lesson',
            stage: 'failed',
            status: 'failed',
          },
        }),
        { status: 200 }
      )
    );

    await expect(
      generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' })
    ).rejects.toThrow('La generazione della lezione non è riuscita');
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(1);
  });

  test('starts a replacement job when the backend interrupted the previous attempt', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            job: {
              errorCode: 'backend_restarted',
              id: 'interrupted-job',
              kind: 'lesson',
              stage: 'failed',
              status: 'failed',
            },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            job: {
              id: 'replacement-job',
              kind: 'lesson',
              result: completedResult,
              stage: 'completed',
              status: 'completed',
            },
          }),
          { status: 202 }
        )
      );

    await expect(
      generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' })
    ).resolves.toMatchObject(completedResult);
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3301/api/generation-jobs/lessons',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('reuses the regeneration request key after a disconnected wait', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            job: { id: 'job-1', kind: 'lesson', stage: 'running', status: 'running' },
          }),
          { status: 200 }
        )
      )
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            job: {
              id: 'job-1',
              kind: 'lesson',
              result: completedResult,
              stage: 'completed',
              status: 'completed',
            },
          }),
          { status: 200 }
        )
      );

    await expect(
      generateDurableLesson({
        forceRegenerate: true,
        projectId: 'project-1',
        sectionId: 'lesson-1',
      })
    ).rejects.toThrow('connection lost');
    await expect(
      generateDurableLesson({
        forceRegenerate: true,
        projectId: 'project-1',
        sectionId: 'lesson-1',
      })
    ).resolves.toMatchObject(completedResult);

    const firstBody = JSON.parse(
      String((fetchWithSupabaseAuthMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)
    ) as { requestKey: string };
    const rejoinedBody = JSON.parse(
      String((fetchWithSupabaseAuthMock.mock.calls[2]?.[1] as RequestInit | undefined)?.body)
    ) as { requestKey: string };
    expect(rejoinedBody.requestKey).toBe(firstBody.requestKey);
  });
});
