/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchWithSupabaseAuthMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: fetchWithSupabaseAuthMock,
}));

vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));

const { generateDurableCourse, repairDurablePdfMapping, resumeActiveDurableCourse } = await import(
  '../../../services/openrouter/courseGenerationClient.ts'
);

const completedResult = {
  firstSectionId: 'lesson-1',
  projectId: 'project-1',
  projectRevision: 7,
};
const CORRELATION_ID = '123e4567-e89b-42d3-a456-426614174000';

const workflowResponse = (job: Record<string, unknown>, status = 200): Response =>
  new Response(
    JSON.stringify({
      job: {
        createdAt: '2026-07-30T08:00:00.000Z',
        retrying: false,
        updatedAt: '2026-07-30T08:00:00.000Z',
        ...job,
      },
      success: status < 400,
    }),
    { status }
  );

const noActiveWorkflowResponse = (): Response =>
  new Response(
    JSON.stringify({
      code: 'course_generation_active_run_not_found',
      error: 'Nessuna generazione attiva.',
      success: false,
    }),
    { status: 404 }
  );

const advancePoll = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(1_000);
};

const requestBody = (callIndex: number) =>
  JSON.parse(
    String((fetchWithSupabaseAuthMock.mock.calls[callIndex]?.[1] as RequestInit | undefined)?.body)
  ) as {
    assessmentHistory: Array<{ role: 'model' | 'user'; text: string }>;
    mode: 'document' | 'learn';
    projectId: string;
    requestKey: string;
  };

describe('courseGenerationClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchWithSupabaseAuthMock.mockReset();
    globalThis.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('starts, polls, and forwards authoritative progress without rebuilding it', async () => {
    const queuedSnapshot = {
      createdAt: '2026-07-30T08:00:00.000Z',
      id: 'run-1',
      mode: 'document',
      projectId: 'project-1',
      retrying: false,
      stage: 'sources',
      status: 'queued',
      updatedAt: '2026-07-30T08:00:00.000Z',
    } as const;
    const completedSnapshot = {
      ...queuedSnapshot,
      result: completedResult,
      stage: 'ready',
      status: 'completed',
      updatedAt: '2026-07-30T08:04:00.000Z',
    } as const;
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(workflowResponse(queuedSnapshot, 202))
      .mockResolvedValueOnce(workflowResponse(completedSnapshot));
    const onProgressStage = vi.fn();
    const onWorkflowSnapshot = vi.fn();

    const course = generateDurableCourse({
      assessmentHistory: [{ role: 'user', text: 'Conosco già le basi.' }],
      mode: 'document',
      onProgressStage,
      onWorkflowSnapshot,
      projectId: 'project-1',
    });
    await advancePoll();

    await expect(course).resolves.toEqual(completedResult);
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3301/api/course-workflows/courses',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3301/api/course-workflows/runs/run-1',
      { cache: 'no-store' }
    );
    expect(requestBody(0)).toMatchObject({
      assessmentHistory: [{ role: 'user', text: 'Conosco già le basi.' }],
      mode: 'document',
      projectId: 'project-1',
    });
    expect(onProgressStage.mock.calls.map(([stage]) => stage)).toEqual(['sources', 'ready']);
    expect(onWorkflowSnapshot.mock.calls.map(([snapshot]) => snapshot)).toEqual([
      queuedSnapshot,
      completedSnapshot,
    ]);
  });

  test('returns an already-ready PDF mapping without starting a polling loop', async () => {
    const result = {
      projectId: 'project-1',
      projectRevision: 4,
      repaired: false,
    } as const;
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ result, success: true }), { status: 200 })
    );

    await expect(repairDurablePdfMapping({ projectId: 'project-1' })).resolves.toEqual(result);
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(1);
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledWith(
      'http://localhost:3301/api/course-workflows/pdf-mapping-repairs',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('polls a durable PDF mapping repair and forwards the caller abort signal', async () => {
    const queued = {
      createdAt: '2026-08-01T08:00:00.000Z',
      id: 'repair-run-1',
      projectId: 'project-1',
      stage: 'mapping',
      status: 'queued',
      updatedAt: '2026-08-01T08:00:00.000Z',
    } as const;
    const result = {
      projectId: 'project-1',
      projectRevision: 5,
      repaired: true,
    } as const;
    const completed = {
      ...queued,
      result,
      stage: 'ready',
      status: 'completed',
    } as const;
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ created: true, job: queued, success: true }), { status: 202 })
      )
      .mockResolvedValueOnce(workflowResponse(completed));
    const signal = new AbortController().signal;

    const repair = repairDurablePdfMapping({ projectId: 'project-1', signal });
    await advancePoll();

    await expect(repair).resolves.toEqual(result);
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3301/api/course-workflows/pdf-mapping-repairs/repair-run-1',
      { cache: 'no-store', signal }
    );
  });

  test('continues polling after a disconnection and clears the completed request key', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        workflowResponse({
          id: 'run-reconnected',
          mode: 'learn',
          projectId: 'project-1',
          stage: 'structure',
          status: 'running',
        })
      )
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(
        workflowResponse({
          id: 'run-reconnected',
          mode: 'learn',
          projectId: 'project-1',
          result: completedResult,
          stage: 'ready',
          status: 'completed',
        })
      )
      .mockResolvedValueOnce(
        workflowResponse({
          id: 'run-new',
          mode: 'learn',
          projectId: 'project-1',
          result: completedResult,
          stage: 'ready',
          status: 'completed',
        })
      );
    const input = { assessmentHistory: [], mode: 'learn' as const, projectId: 'project-1' };

    const reconnected = generateDurableCourse(input);
    const completion = expect(reconnected).resolves.toEqual(completedResult);
    await advancePoll();
    await advancePoll();
    await completion;
    await generateDurableCourse(input);

    expect(requestBody(3).requestKey).not.toBe(requestBody(0).requestKey);
  });

  test('rejects a successful response whose course job violates the client contract', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(workflowResponse({ id: 'run-malformed', status: 'running' }))
      .mockResolvedValueOnce(
        workflowResponse({
          id: 'run-malformed',
          mode: 'learn',
          projectId: 'project-1',
          result: completedResult,
          stage: 'ready',
          status: 'completed',
        })
      );

    const course = generateDurableCourse({
      assessmentHistory: [],
      mode: 'learn',
      projectId: 'project-1',
    });
    const rejection = expect(course).rejects.toThrow(
      'La generazione del corso non è riuscita. Riprova.'
    );
    await advancePoll();

    await rejection;
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(1);
  });

  test('retains the course request key when the start response is transient', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false }), { status: 503 })
    );

    await expect(
      generateDurableCourse({ assessmentHistory: [], mode: 'learn', projectId: 'project-1' })
    ).rejects.toThrow('La generazione del corso non è riuscita. Riprova.');

    expect(globalThis.sessionStorage.getItem('nous:course-workflow-request:project-1')).toBe(
      requestBody(0).requestKey
    );
  });

  test('clears the course request key before reading a definitive rejection body', async () => {
    const interruptedBody = {
      json: vi.fn().mockRejectedValue(new TypeError('response stream interrupted')),
      ok: false,
      status: 400,
    } as unknown as Response;
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(interruptedBody);

    await expect(
      generateDurableCourse({ assessmentHistory: [], mode: 'learn', projectId: 'project-1' })
    ).rejects.toThrow('response stream interrupted');

    expect(globalThis.sessionStorage.getItem('nous:course-workflow-request:project-1')).toBeNull();
  });

  test('resumes the active run without starting a second course workflow', async () => {
    globalThis.sessionStorage.setItem(
      'nous:course-workflow-request:project-1',
      'request-for-running-course'
    );
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        workflowResponse({
          id: 'run-active',
          mode: 'document',
          projectId: 'project-1',
          stage: 'drafting',
          status: 'running',
        })
      )
      .mockResolvedValueOnce(
        workflowResponse({
          id: 'run-active',
          mode: 'document',
          projectId: 'project-1',
          result: completedResult,
          stage: 'ready',
          status: 'completed',
        })
      );

    const course = resumeActiveDurableCourse({ projectId: 'project-1' });
    await advancePoll();

    await expect(course).resolves.toEqual(completedResult);
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3301/api/course-workflows/courses/project-1/active',
      { cache: 'no-store' }
    );
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(2);
    expect(globalThis.sessionStorage.getItem('nous:course-workflow-request:project-1')).toBeNull();
  });

  test('resuming an old run cannot clear a newer course request key', async () => {
    const storageKey = 'nous:course-workflow-request:project-1';
    globalThis.sessionStorage.setItem(storageKey, 'request-for-old-run');
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        workflowResponse({
          id: 'run-old',
          mode: 'document',
          projectId: 'project-1',
          stage: 'drafting',
          status: 'running',
        })
      )
      .mockResolvedValueOnce(
        workflowResponse({
          id: 'run-old',
          mode: 'document',
          projectId: 'project-1',
          result: completedResult,
          stage: 'ready',
          status: 'completed',
        })
      );

    const resumed = resumeActiveDurableCourse({ projectId: 'project-1' });
    await Promise.resolve();
    globalThis.sessionStorage.setItem(storageKey, 'request-for-new-run');
    await advancePoll();

    await expect(resumed).resolves.toEqual(completedResult);
    expect(globalThis.sessionStorage.getItem(storageKey)).toBe('request-for-new-run');
  });

  test('returns null when the project has no active course workflow', async () => {
    globalThis.sessionStorage.setItem(
      'nous:course-workflow-request:project-1',
      'request-without-active-run'
    );
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(noActiveWorkflowResponse());

    await expect(resumeActiveDurableCourse({ projectId: 'project-1' })).resolves.toBeNull();
    expect(globalThis.sessionStorage.getItem('nous:course-workflow-request:project-1')).toBeNull();
  });

  test.each([
    [
      'failed',
      {
        errorCode: 'course_generation_failed',
        id: 'run-failed-after-reload',
        mode: 'document',
        projectId: 'project-1',
        stage: 'drafting',
        status: 'failed',
      },
    ],
    [
      'completed with a malformed result',
      {
        id: 'run-malformed-after-reload',
        mode: 'document',
        projectId: 'project-1',
        result: { projectId: 'project-1' },
        stage: 'ready',
        status: 'completed',
      },
    ],
  ])('clears the request key after a %s terminal snapshot', async (_description, job) => {
    globalThis.sessionStorage.setItem(
      'nous:course-workflow-request:project-1',
      'request-for-terminal-run'
    );
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(workflowResponse(job));

    await expect(resumeActiveDurableCourse({ projectId: 'project-1' })).rejects.toThrow(
      'La generazione del corso non è riuscita. Riprova.'
    );
    expect(globalThis.sessionStorage.getItem('nous:course-workflow-request:project-1')).toBeNull();
  });

  test('keeps resuming after a transient poll disconnection', async () => {
    globalThis.sessionStorage.setItem(
      'nous:course-workflow-request:project-1',
      'request-for-active-run'
    );
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        workflowResponse({
          id: 'run-active-after-reload',
          mode: 'document',
          projectId: 'project-1',
          stage: 'drafting',
          status: 'running',
        })
      )
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(
        workflowResponse({
          id: 'run-active-after-reload',
          mode: 'document',
          projectId: 'project-1',
          result: completedResult,
          stage: 'ready',
          status: 'completed',
        })
      );

    const resumed = resumeActiveDurableCourse({ projectId: 'project-1' });
    const completion = expect(resumed).resolves.toEqual(completedResult);
    await advancePoll();
    await advancePoll();
    await completion;
    expect(globalThis.sessionStorage.getItem('nous:course-workflow-request:project-1')).toBeNull();
  });

  test('retries the initial active-course lookup after a transient response', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false }), { status: 503 }))
      .mockResolvedValueOnce(
        workflowResponse({
          id: 'run-active-after-retry',
          mode: 'document',
          projectId: 'project-1',
          stage: 'drafting',
          status: 'running',
        })
      )
      .mockResolvedValueOnce(
        workflowResponse({
          id: 'run-active-after-retry',
          mode: 'document',
          projectId: 'project-1',
          result: completedResult,
          stage: 'ready',
          status: 'completed',
        })
      );

    const resumed = resumeActiveDurableCourse({ projectId: 'project-1' });
    const completion = expect(resumed).resolves.toEqual(completedResult);
    await advancePoll();
    await advancePoll();

    await completion;
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(3);
  });

  test('rejects a successful response whose PDF repair job violates the client contract', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(workflowResponse({ id: 'repair-malformed', status: 'running' }))
      .mockResolvedValueOnce(
        workflowResponse({
          id: 'repair-malformed',
          projectId: 'project-1',
          result: { projectId: 'project-1', projectRevision: 8, repaired: true },
          stage: 'ready',
          status: 'completed',
        })
      );

    const repair = repairDurablePdfMapping({ projectId: 'project-1' });
    const rejection = expect(repair).rejects.toThrow('La mappatura del PDF non è riuscita.');
    await advancePoll();

    await rejection;
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(1);
  });

  test('retains the PDF repair request key when its start response is transient', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false }), { status: 503 })
    );

    await expect(repairDurablePdfMapping({ projectId: 'project-1' })).rejects.toThrow(
      'La mappatura del PDF non è riuscita.'
    );

    expect(
      globalThis.sessionStorage.getItem('nous:pdf-mapping-repair-request:project-1')
    ).not.toBeNull();
  });

  test('clears the PDF repair request key before reading a definitive rejection body', async () => {
    const interruptedBody = {
      json: vi.fn().mockRejectedValue(new TypeError('response stream interrupted')),
      ok: false,
      status: 400,
    } as unknown as Response;
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(interruptedBody);

    await expect(repairDurablePdfMapping({ projectId: 'project-1' })).rejects.toThrow(
      'response stream interrupted'
    );

    expect(
      globalThis.sessionStorage.getItem('nous:pdf-mapping-repair-request:project-1')
    ).toBeNull();
  });

  test('clears the PDF repair request key before validating a terminal result', async () => {
    const queued = {
      id: 'repair-invalid-result',
      projectId: 'project-1',
      stage: 'mapping',
      status: 'queued',
    };
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(workflowResponse(queued, 202))
      .mockResolvedValueOnce(
        workflowResponse({
          ...queued,
          result: { projectId: 'project-1', repaired: true },
          stage: 'ready',
          status: 'completed',
        })
      );

    const repair = repairDurablePdfMapping({ projectId: 'project-1' });
    const rejection = expect(repair).rejects.toThrow('La mappatura del PDF non è riuscita.');
    await advancePoll();

    await rejection;
    expect(
      globalThis.sessionStorage.getItem('nous:pdf-mapping-repair-request:project-1')
    ).toBeNull();
  });

  test('clears the PDF repair request key before validating an immediate result', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { projectId: 'project-1', repaired: true }, success: true }),
        { status: 200 }
      )
    );

    await expect(repairDurablePdfMapping({ projectId: 'project-1' })).rejects.toThrow(
      'La mappatura del PDF non è riuscita.'
    );

    expect(
      globalThis.sessionStorage.getItem('nous:pdf-mapping-repair-request:project-1')
    ).toBeNull();
  });

  test('records the support code from a terminal PDF repair failure', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const queued = {
      id: 'repair-failed',
      projectId: 'project-1',
      stage: 'mapping',
      status: 'queued',
    };
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(workflowResponse(queued, 202))
      .mockResolvedValueOnce(
        workflowResponse({
          ...queued,
          correlationId: CORRELATION_ID,
          errorCode: 'pdf_mapping_repair_failed',
          status: 'failed',
        })
      );

    const repair = repairDurablePdfMapping({ projectId: 'project-1' });
    const rejection = expect(repair).rejects.toThrow('La mappatura del PDF non è riuscita.');
    await advancePoll();

    await rejection;
    expect(warning).toHaveBeenCalledWith(`[Nous][API] Codice assistenza: ${CORRELATION_ID}`);
  });

  test('does not expose backend failure details', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      workflowResponse({
        correlationId: CORRELATION_ID,
        errorCode: 'course_provider_secret_failure',
        id: 'run-failed',
        mode: 'document',
        projectId: 'project-1',
        stage: 'drafting',
        status: 'failed',
      })
    );

    await expect(
      generateDurableCourse({
        assessmentHistory: [],
        mode: 'document',
        projectId: 'project-1',
      })
    ).rejects.toThrow('La generazione del corso non è riuscita. Riprova.');
    expect(warning).toHaveBeenCalledWith(`[Nous][API] Codice assistenza: ${CORRELATION_ID}`);
    warning.mockRestore();
  });

  test('explains when an app update intentionally stops the stored workflow definition', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      workflowResponse({
        errorCode: 'workflow_definition_unavailable',
        id: 'run-retired',
        mode: 'document',
        projectId: 'project-1',
        stage: 'drafting',
        status: 'failed',
      })
    );

    await expect(
      generateDurableCourse({ assessmentHistory: [], mode: 'document', projectId: 'project-1' })
    ).rejects.toThrow(
      'L’app è stata aggiornata mentre questa generazione era in corso. Avvia una nuova generazione.'
    );
  });

  test('rejects a completed result belonging to another project', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      workflowResponse({
        id: 'run-invalid',
        mode: 'document',
        projectId: 'project-1',
        result: { ...completedResult, projectId: 'project-2' },
        stage: 'ready',
        status: 'completed',
      })
    );

    await expect(
      generateDurableCourse({
        assessmentHistory: [],
        mode: 'document',
        projectId: 'project-1',
      })
    ).rejects.toThrow('La generazione del corso non è riuscita. Riprova.');
  });
});
