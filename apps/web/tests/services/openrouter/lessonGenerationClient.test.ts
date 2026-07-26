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
      'http://localhost:3301/api/generation-jobs/job-1/wait'
    );
  });

  test('rejoins the latest active job after a page reload without posting a duplicate', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            job: { id: 'job-reconnected', kind: 'lesson', status: 'running' },
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
      'http://localhost:3301/api/generation-jobs/lessons/project-1/lesson-1/latest'
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

  test('reuses the regeneration request key after a disconnected wait', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            job: { id: 'job-1', kind: 'lesson', status: 'running' },
          }),
          { status: 200 }
        )
      )
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            job: { id: 'job-1', kind: 'lesson', result: completedResult, status: 'completed' },
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
