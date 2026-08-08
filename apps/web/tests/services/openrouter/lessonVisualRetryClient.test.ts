/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchWithSupabaseAuthMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: fetchWithSupabaseAuthMock,
}));

vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));

const { retryDurableLessonVisual } = await import(
  '../../../services/openrouter/lessonVisualRetryClient.ts'
);

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

const startResponse = (runId: string, status = 'queued', responseStatus = 202): Response =>
  jsonResponse(
    {
      created: responseStatus === 202,
      run: { id: runId, status },
      success: true,
    },
    responseStatus
  );

const runResponse = ({
  cleanupStatus = 'not-required',
  errorCode,
  events = [],
  projectId = 'project-1',
  runId = 'run-1',
  status,
}: {
  cleanupStatus?: string;
  errorCode?: string;
  events?: unknown[];
  projectId?: string;
  runId?: string;
  status: string;
}): Response =>
  jsonResponse({
    state: {
      publishedEvents: events,
      run: {
        cleanupStatus,
        ...(errorCode ? { error: { code: errorCode } } : {}),
        id: runId,
        projectId,
        status,
        workflowId: 'retry-lesson-visual',
      },
    },
    success: true,
  });

describe('retryDurableLessonVisual', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchWithSupabaseAuthMock.mockReset();
    globalThis.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('starts quickly, polls the generic runtime and returns the committed revision', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(startResponse('run-1'))
      .mockResolvedValueOnce(runResponse({ status: 'running' }))
      .mockResolvedValueOnce(
        runResponse({
          events: [
            {
              eventType: 'lesson.project-revision',
              payload: { projectId: 'project-1', revision: 14 },
              schemaVersion: 1,
            },
          ],
          status: 'completed',
        })
      );

    const retry = retryDurableLessonVisual({
      projectId: 'project-1',
      sectionId: 'lesson-1',
      slotId: 'slot-1',
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(retry).resolves.toEqual({ projectRevision: 14 });
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3301/api/projects/project-1/sections/lesson-1/visuals/slot-1/retry',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      3,
      'http://localhost:3301/api/workflows/runs/run-1',
      { cache: 'no-store' }
    );
    expect(globalThis.sessionStorage).toHaveLength(0);
  });

  test('continues polling after the first status response is lost', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(startResponse('run-reconnected'))
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(
        runResponse({
          events: [
            {
              eventType: 'lesson.project-revision',
              payload: { projectId: 'project-1', revision: 15 },
              schemaVersion: 1,
            },
          ],
          runId: 'run-reconnected',
          status: 'completed',
        })
      );

    const retry = retryDurableLessonVisual({
      projectId: 'project-1',
      sectionId: 'lesson-1',
      slotId: 'slot-1',
    });
    const completion = expect(retry).resolves.toEqual({ projectRevision: 15 });
    await vi.advanceTimersByTimeAsync(1_000);

    await completion;
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(3);
    expect(globalThis.sessionStorage).toHaveLength(0);
  });

  test('continues polling when the first status response body is interrupted', async () => {
    const interruptedBody = {
      json: vi.fn().mockRejectedValue(new TypeError('response stream interrupted')),
      ok: true,
      status: 200,
    } as unknown as Response;
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(startResponse('run-interrupted-body'))
      .mockResolvedValueOnce(interruptedBody)
      .mockResolvedValueOnce(
        runResponse({
          events: [
            {
              eventType: 'lesson.project-revision',
              payload: { projectId: 'project-1', revision: 16 },
              schemaVersion: 1,
            },
          ],
          runId: 'run-interrupted-body',
          status: 'completed',
        })
      );

    const retry = retryDurableLessonVisual({
      projectId: 'project-1',
      sectionId: 'lesson-1',
      slotId: 'slot-1',
    });
    const completion = expect(retry).resolves.toEqual({ projectRevision: 16 });
    await vi.advanceTimersByTimeAsync(1_000);

    await completion;
    expect(interruptedBody.json).toHaveBeenCalledTimes(1);
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(3);
  });

  test('continues polling when the first status response contains malformed JSON', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(startResponse('run-malformed-json'))
      .mockResolvedValueOnce(new Response('{"success":true', { status: 200 }))
      .mockResolvedValueOnce(
        runResponse({
          events: [
            {
              eventType: 'lesson.project-revision',
              payload: { projectId: 'project-1', revision: 17 },
              schemaVersion: 1,
            },
          ],
          runId: 'run-malformed-json',
          status: 'completed',
        })
      );

    const retry = retryDurableLessonVisual({
      projectId: 'project-1',
      sectionId: 'lesson-1',
      slotId: 'slot-1',
    });
    const completion = expect(retry).resolves.toEqual({ projectRevision: 17 });
    await vi.advanceTimersByTimeAsync(1_000);

    await completion;
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(3);
  });

  test('rejects a completed run without its authoritative revision event', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(startResponse('run-invalid'))
      .mockResolvedValueOnce(
        runResponse({
          events: [
            {
              eventType: 'lesson.project-revision',
              payload: { projectId: 'other-project', revision: 99 },
              schemaVersion: 1,
            },
          ],
          runId: 'run-invalid',
          status: 'completed',
        })
      );

    await expect(
      retryDurableLessonVisual({
        projectId: 'project-1',
        sectionId: 'lesson-1',
        slotId: 'slot-1',
      })
    ).rejects.toThrow('La rigenerazione dell’esempio visivo non è riuscita. Riprova.');
    expect(globalThis.sessionStorage).toHaveLength(0);
  });

  test('waits for pending undo before exposing a terminal workflow failure', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(startResponse('run-undoing'))
      .mockResolvedValueOnce(
        runResponse({ cleanupStatus: 'pending', runId: 'run-undoing', status: 'failed' })
      )
      .mockResolvedValueOnce(
        runResponse({ cleanupStatus: 'completed', runId: 'run-undoing', status: 'failed' })
      );

    const retry = retryDurableLessonVisual({
      projectId: 'project-1',
      sectionId: 'lesson-1',
      slotId: 'slot-1',
    });
    let settled = false;
    void retry.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await vi.waitFor(() => expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    expect(globalThis.sessionStorage).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(retry).rejects.toThrow(
      'La rigenerazione dell’esempio visivo non è riuscita. Riprova.'
    );
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(3);
    expect(globalThis.sessionStorage).toHaveLength(0);
  });

  test('explains when an app update intentionally stops the stored workflow definition', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(startResponse('run-retired'))
      .mockResolvedValueOnce(
        runResponse({
          errorCode: 'workflow_definition_unavailable',
          runId: 'run-retired',
          status: 'failed',
        })
      );

    await expect(
      retryDurableLessonVisual({
        projectId: 'project-1',
        sectionId: 'lesson-1',
        slotId: 'slot-1',
      })
    ).rejects.toThrow(
      'L’app è stata aggiornata mentre questa generazione era in corso. Avvia una nuova generazione.'
    );
  });

  test('stops abandoned polling without discarding the reconnect request key', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(startResponse('run-abandoned'))
      .mockResolvedValueOnce(runResponse({ runId: 'run-abandoned', status: 'running' }));
    const abortController = new AbortController();

    const retry = retryDurableLessonVisual(
      {
        projectId: 'project-1',
        sectionId: 'lesson-1',
        slotId: 'slot-1',
      },
      { signal: abortController.signal }
    );
    await vi.waitFor(() => expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(2));

    abortController.abort();

    await expect(retry).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(2);
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3301/api/workflows/runs/run-abandoned',
      expect.objectContaining({ cache: 'no-store', signal: abortController.signal })
    );
    expect(globalThis.sessionStorage).toHaveLength(1);
  });

  test('keeps the request key when the start response is transient', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(jsonResponse({}, 429));

    await expect(
      retryDurableLessonVisual({
        projectId: 'project-1',
        sectionId: 'lesson-1',
        slotId: 'slot-1',
      })
    ).rejects.toThrow('La rigenerazione dell’esempio visivo non è riuscita. Riprova.');
    expect(globalThis.sessionStorage).toHaveLength(1);
  });
});
