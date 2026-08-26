/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchWithSupabaseAuthMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: fetchWithSupabaseAuthMock,
}));

vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));

const {
  clearAllDurableLessonRequests,
  clearDurableLessonRequestsForProject,
  generateDurableLesson,
  generateDurableSublesson,
  hasDurableLessonRequest,
  isDurableSublessonRequestForSection,
  LessonGenerationBusyError,
  LessonSourceUnavailableError,
  resolveDurableSublessonRequestForSection,
} = await import('../../../services/openrouter/lessonGenerationClient.ts');

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
  warnings: [],
};
const CORRELATION_ID = '123e4567-e89b-42d3-a456-426614174000';

const terminalPhaseMessages = [
  [
    'sublesson_planning_failed',
    'Non è stato possibile preparare la lezione di approfondimento. Riprova.',
  ],
  [
    'sublesson_source_mapping_failed',
    'Non è stato possibile preparare le fonti della lezione di approfondimento. Riprova.',
  ],
  [
    'lesson_preparation_failed',
    'Non è stato possibile preparare la generazione della lezione. Riprova.',
  ],
  [
    'lesson_source_coverage_failed',
    'Non è stato possibile verificare la copertura delle fonti. Riprova.',
  ],
  [
    'lesson_document_sources_failed',
    'Non è stato possibile elaborare le immagini delle fonti PDF. Riprova.',
  ],
  ['lesson_youtube_research_failed', 'La ricerca nei video non è riuscita. Riprova.'],
  ['lesson_research_failed', 'La ricerca per la lezione non è riuscita. Riprova.'],
  ['lesson_draft_failed', 'Non è stato possibile creare la bozza della lezione. Riprova.'],
  ['lesson_review_failed', 'La verifica della lezione non è riuscita. Riprova.'],
  ['lesson_learning_aids_failed', 'Non è stato possibile preparare gli aiuti didattici. Riprova.'],
  [
    'lesson_normalization_failed',
    'Non è stato possibile preparare il contenuto finale della lezione. Riprova.',
  ],
  ['lesson_persistence_failed', 'Non è stato possibile salvare la lezione. Riprova.'],
  [
    'lesson_finalization_failed',
    'Non è stato possibile completare il salvataggio della lezione. Riprova.',
  ],
] as const;

const response = (job: Record<string, unknown>, status = 200, headers?: HeadersInit): Response =>
  new Response(
    JSON.stringify({
      job: {
        createdAt: '2026-07-29T20:00:00.000Z',
        retrying: false,
        updatedAt: '2026-07-29T20:00:00.000Z',
        ...job,
      },
      success: status < 400,
    }),
    { headers, status }
  );

const advancePoll = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(1_000);
};

const requestBody = (callIndex: number): { forceRegenerate?: boolean; requestKey: string } =>
  JSON.parse(
    String((fetchWithSupabaseAuthMock.mock.calls[callIndex]?.[1] as RequestInit | undefined)?.body)
  ) as { requestKey: string };

describe('generateDurableLesson', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchWithSupabaseAuthMock.mockReset();
    globalThis.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('starts the durable workflow and polls its short status route to completion', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        response(
          {
            id: 'run-1',
            projectId: 'project-1',
            sectionId: 'lesson-1',
            stage: 'sources',
            status: 'queued',
          },
          202
        )
      )
      .mockResolvedValueOnce(
        response({
          id: 'run-1',
          projectId: 'project-1',
          sectionId: 'lesson-1',
          stage: 'drafting',
          status: 'running',
        })
      )
      .mockResolvedValueOnce(
        response({
          id: 'run-1',
          projectId: 'project-1',
          result: completedResult,
          sectionId: 'lesson-1',
          stage: 'verification',
          status: 'completed',
        })
      );

    const lesson = generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' });
    await advancePoll();
    await advancePoll();

    await expect(lesson).resolves.toMatchObject(completedResult);
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3301/api/lesson-workflows/lessons',
      expect.objectContaining({ method: 'POST' }),
      { expectedStatuses: [409] }
    );
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      3,
      'http://localhost:3301/api/lesson-workflows/runs/run-1',
      { cache: 'no-store' }
    );
  });

  test('continues the same workflow after a disconnected poll', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        response({
          id: 'run-reconnected',
          projectId: 'project-1',
          sectionId: 'lesson-1',
          stage: 'structure',
          status: 'running',
        })
      )
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(
        response({
          id: 'run-reconnected',
          projectId: 'project-1',
          result: completedResult,
          sectionId: 'lesson-1',
          stage: 'verification',
          status: 'completed',
        })
      );

    const lesson = generateDurableLesson({
      projectId: 'project-1',
      sectionId: 'lesson-1',
    });
    const completion = expect(lesson).resolves.toMatchObject(completedResult);
    await advancePoll();
    await advancePoll();

    await completion;
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(3);
    expect(globalThis.sessionStorage).toHaveLength(0);
  });

  test.each([
    ['the response stream is interrupted', new TypeError('response stream interrupted')],
    ['the response contains truncated JSON', new SyntaxError('Unexpected end of JSON input')],
  ])('continues polling when %s', async (_case, bodyError) => {
    const interruptedBody = {
      json: vi.fn().mockRejectedValue(bodyError),
      ok: true,
      status: 200,
    } as unknown as Response;
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        response({
          id: 'run-interrupted-body',
          projectId: 'project-1',
          sectionId: 'lesson-1',
          stage: 'structure',
          status: 'running',
        })
      )
      .mockResolvedValueOnce(interruptedBody)
      .mockResolvedValueOnce(
        response({
          id: 'run-interrupted-body',
          projectId: 'project-1',
          result: completedResult,
          sectionId: 'lesson-1',
          stage: 'verification',
          status: 'completed',
        })
      );

    const lesson = generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' });
    const completion = expect(lesson).resolves.toMatchObject(completedResult);
    await advancePoll();
    await advancePoll();

    await completion;
    expect(interruptedBody.json).toHaveBeenCalledTimes(1);
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(3);
  });

  test('rejects a successful response whose running job violates the client contract', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        response({ correlationId: CORRELATION_ID, id: 'run-malformed', status: 'running' })
      )
      .mockResolvedValueOnce(
        response({
          id: 'run-malformed',
          projectId: 'project-1',
          result: completedResult,
          sectionId: 'lesson-1',
          stage: 'verification',
          status: 'completed',
        })
      );

    const lesson = generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' });
    const rejection = expect(lesson).rejects.toThrow(
      'La generazione della lezione non è riuscita. Riprova.'
    );
    await advancePoll();

    await rejection;
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(`[Nous][API] Codice assistenza: ${CORRELATION_ID}`);
  });

  test('retains the lesson request key when a successful start body is malformed', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      new Response('{"success":true', { status: 202 })
    );

    await expect(
      generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' })
    ).rejects.toThrow('La generazione della lezione non è riuscita. Riprova.');

    expect(
      globalThis.sessionStorage.getItem('nous:lesson-workflow-request:project-1:lesson-1')
    ).toBe(requestBody(0).requestKey);
  });

  test('clears the lesson request key before reading a definitive rejection body', async () => {
    const interruptedBody = {
      json: vi.fn().mockRejectedValue(new TypeError('response stream interrupted')),
      ok: false,
      status: 400,
    } as unknown as Response;
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(interruptedBody);

    await expect(
      generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' })
    ).rejects.toThrow('response stream interrupted');

    expect(
      globalThis.sessionStorage.getItem('nous:lesson-workflow-request:project-1:lesson-1')
    ).toBeNull();
  });

  test('does not follow a polling response that switches to another workflow run', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        response({
          id: 'run-original',
          projectId: 'project-1',
          sectionId: 'lesson-1',
          stage: 'structure',
          status: 'running',
        })
      )
      .mockResolvedValueOnce(
        response({
          id: 'run-other',
          projectId: 'project-1',
          sectionId: 'lesson-1',
          stage: 'drafting',
          status: 'running',
        })
      );

    const lesson = generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' });
    const rejection = expect(lesson).rejects.toThrow(
      'La generazione della lezione non è riuscita. Riprova.'
    );
    await advancePoll();

    await rejection;
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(2);
  });

  test.each([429, 503])('continues polling after one transient %i response', async status => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        response({
          id: 'run-recovering',
          projectId: 'project-1',
          sectionId: 'lesson-1',
          stage: 'structure',
          status: 'running',
        })
      )
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(
        response({
          id: 'run-recovering',
          projectId: 'project-1',
          result: completedResult,
          sectionId: 'lesson-1',
          stage: 'verification',
          status: 'completed',
        })
      );

    const lesson = generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' });
    const completion = expect(lesson).resolves.toMatchObject(completedResult);
    await advancePoll();
    await advancePoll();

    await completion;
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(3);
  });

  test('stops polling after a definitive status response', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        response({
          id: 'run-missing',
          projectId: 'project-1',
          sectionId: 'lesson-1',
          stage: 'structure',
          status: 'running',
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false }), { status: 404 }));

    const lesson = generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' });
    const rejection = expect(lesson).rejects.toThrow('La generazione della lezione non è riuscita');
    await advancePoll();

    await rejection;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(2);
  });

  test('reports each authoritative stage once while polling', async () => {
    const stages = ['sources', 'structure', 'drafting', 'quiz', 'verification'] as const;
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response(
        {
          id: 'run-progress',
          projectId: 'project-1',
          sectionId: 'lesson-1',
          stage: 'sources',
          status: 'queued',
        },
        202
      )
    );
    for (const stage of stages.slice(1)) {
      fetchWithSupabaseAuthMock.mockResolvedValueOnce(
        response({
          id: 'run-progress',
          projectId: 'project-1',
          sectionId: 'lesson-1',
          stage,
          status: 'running',
        })
      );
    }
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response({
        id: 'run-progress',
        projectId: 'project-1',
        result: completedResult,
        sectionId: 'lesson-1',
        stage: 'verification',
        status: 'completed',
      })
    );
    const onProgressStage = vi.fn();

    const lesson = generateDurableLesson({
      onProgressStage,
      projectId: 'project-1',
      sectionId: 'lesson-1',
    });
    for (let index = 0; index < stages.length; index += 1) await advancePoll();
    await lesson;

    expect(onProgressStage.mock.calls.map(([stage]) => stage)).toEqual(stages);
  });

  test('forwards every authoritative workflow snapshot without rebuilding its timing or retry state', async () => {
    const queuedSnapshot = {
      createdAt: '2026-07-29T20:00:00.000Z',
      id: 'run-progress',
      projectId: 'project-1',
      retrying: false,
      sectionId: 'lesson-1',
      stage: 'sources',
      status: 'queued',
      updatedAt: '2026-07-29T20:00:00.000Z',
    } as const;
    const completedSnapshot = {
      createdAt: queuedSnapshot.createdAt,
      id: queuedSnapshot.id,
      projectId: queuedSnapshot.projectId,
      result: completedResult,
      retrying: false,
      sectionId: queuedSnapshot.sectionId,
      stage: 'verification',
      startedAt: '2026-07-29T20:00:01.000Z',
      status: 'completed',
      updatedAt: '2026-07-29T20:04:00.000Z',
    } as const;
    const retryingSnapshot = {
      attempt: 2,
      createdAt: queuedSnapshot.createdAt,
      failure: { code: 'lesson_provider_unavailable', kind: 'operational' as const },
      id: queuedSnapshot.id,
      projectId: queuedSnapshot.projectId,
      retrying: true,
      sectionId: queuedSnapshot.sectionId,
      stage: 'drafting' as const,
      startedAt: '2026-07-29T20:00:01.000Z',
      status: 'running' as const,
      updatedAt: '2026-07-29T20:01:00.000Z',
    };
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(response(queuedSnapshot, 202))
      .mockResolvedValueOnce(response(retryingSnapshot))
      .mockResolvedValueOnce(response(completedSnapshot));
    const onWorkflowSnapshot = vi.fn();

    const lesson = generateDurableLesson({
      onWorkflowSnapshot,
      projectId: 'project-1',
      sectionId: 'lesson-1',
    });
    await advancePoll();
    await advancePoll();
    await lesson;

    expect(onWorkflowSnapshot.mock.calls.map(([snapshot]) => snapshot)).toEqual([
      queuedSnapshot,
      retryingSnapshot,
      completedSnapshot,
    ]);
  });

  test('reports the other lesson holding the project generation lock', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response(
        {
          id: 'run-1',
          projectId: 'project-1',
          sectionId: 'lesson-2',
          stage: 'structure',
          status: 'running',
        },
        409
      )
    );

    const lesson = generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' });
    await expect(lesson).rejects.toBeInstanceOf(LessonGenerationBusyError);
    await expect(lesson).rejects.toMatchObject({ activeSectionId: 'lesson-2' });
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledWith(
      'http://localhost:3301/api/lesson-workflows/lessons',
      expect.objectContaining({ method: 'POST' }),
      { expectedStatuses: [409] }
    );
  });

  test('reattaches when the active project workflow owns the requested section', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        response(
          {
            id: 'run-sublesson',
            projectId: 'project-1',
            sectionId: 'deep-lesson',
            stage: 'drafting',
            status: 'running',
          },
          409
        )
      )
      .mockResolvedValueOnce(
        response({
          id: 'run-sublesson',
          projectId: 'project-1',
          result: { ...completedResult, sectionId: 'deep-lesson' },
          sectionId: 'deep-lesson',
          stage: 'verification',
          status: 'completed',
        })
      );

    const lesson = generateDurableLesson({ projectId: 'project-1', sectionId: 'deep-lesson' });
    const completion = expect(lesson).resolves.toMatchObject({ sectionId: 'deep-lesson' });
    await vi.advanceTimersByTimeAsync(0);
    expect(hasDurableLessonRequest('project-1', 'deep-lesson')).toBe(true);
    await advancePoll();

    await completion;
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(2);
  });

  test('does not reattach a matching section from another project', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response(
        {
          id: 'run-other-project',
          projectId: 'project-2',
          sectionId: 'deep-lesson',
          stage: 'drafting',
          status: 'running',
        },
        409
      )
    );

    await expect(
      generateDurableLesson({ projectId: 'project-1', sectionId: 'deep-lesson' })
    ).rejects.toBeInstanceOf(LessonGenerationBusyError);
  });

  test('propagates a terminal failure from the reattached section workflow', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response(
        {
          errorCode: 'lesson_draft_failed',
          id: 'run-sublesson',
          projectId: 'project-1',
          sectionId: 'deep-lesson',
          stage: 'drafting',
          status: 'failed',
        },
        409
      )
    );

    await expect(
      generateDurableLesson({ projectId: 'project-1', sectionId: 'deep-lesson' })
    ).rejects.toThrow('Non è stato possibile creare la bozza della lezione. Riprova.');
  });

  test('records a malformed busy response as a backend failure', async () => {
    const correlationId = '48eb116c-a283-440b-b875-a528e5e4f5f1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response({ projectId: 'project-1', sectionId: 'lesson-2', status: 'unexpected' }, 409, {
        'x-request-id': correlationId,
      })
    );

    await expect(
      generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' })
    ).rejects.toThrow('La generazione della lezione non è riuscita. Riprova.');
    expect(warn).toHaveBeenCalledWith(`[Nous][API] Codice assistenza: ${correlationId}`);
    warn.mockRestore();
  });

  test('rejects a completed result belonging to a different lesson', async () => {
    const correlationId = '58eb116c-a283-440b-b875-a528e5e4f5f2';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response({
        correlationId,
        id: 'run-1',
        projectId: 'project-1',
        result: { ...completedResult, sectionId: 'lesson-2' },
        sectionId: 'lesson-1',
        stage: 'verification',
        status: 'completed',
      })
    );

    await expect(
      generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' })
    ).rejects.toThrow('La generazione della lezione non è riuscita');
    expect(warn).toHaveBeenCalledWith(`[Nous][API] Codice assistenza: ${correlationId}`);
    warn.mockRestore();
  });

  test('surfaces a terminal workflow failure without exposing backend details', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response({
        correlationId: '123e4567-e89b-12d3-a456-426614174000',
        errorCode: 'lesson_provider_failed',
        id: 'run-failed',
        projectId: 'project-1',
        sectionId: 'lesson-1',
        stage: 'drafting',
        status: 'failed',
      })
    );

    await expect(
      generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' })
    ).rejects.toThrow('La generazione della lezione non è riuscita');
    expect(warn).toHaveBeenCalledWith(
      '[Nous][API] Codice assistenza: 123e4567-e89b-12d3-a456-426614174000'
    );
    warn.mockRestore();
  });

  test.each(
    terminalPhaseMessages
  )('maps terminal phase %s to its specific sanitized message', async (errorCode, expectedMessage) => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response({
        errorCode,
        id: 'run-failed',
        projectId: 'project-1',
        sectionId: 'lesson-1',
        stage: 'drafting',
        status: 'failed',
      })
    );

    await expect(
      generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' })
    ).rejects.toThrow(expectedMessage);
  });

  test('explains when an app update intentionally stops the stored workflow definition', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response({
        errorCode: 'workflow_definition_unavailable',
        id: 'run-retired',
        projectId: 'project-1',
        sectionId: 'lesson-1',
        stage: 'drafting',
        status: 'failed',
      })
    );

    await expect(
      generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' })
    ).rejects.toThrow(
      'L’app è stata aggiornata mentre questa generazione era in corso. Avvia una nuova generazione.'
    );
  });

  test('turns a missing durable source into a stable relink signal', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response({
        errorCode: 'lesson_source_unavailable',
        id: 'run-missing-source',
        projectId: 'project-1',
        sectionId: 'lesson-1',
        stage: 'sources',
        status: 'failed',
      })
    );

    await expect(
      generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' })
    ).rejects.toBeInstanceOf(LessonSourceUnavailableError);
  });

  test('maps the workflow timeout to the specific safe timeout message', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response({
        errorCode: 'workflow_step_timeout',
        id: 'run-timeout',
        projectId: 'project-1',
        sectionId: 'lesson-1',
        stage: 'drafting',
        status: 'failed',
      })
    );

    await expect(
      generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' })
    ).rejects.toThrow('ha superato il tempo disponibile');
  });

  test('clears a terminal request key so a later explicit generation receives a new identity', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        response({
          id: 'run-1',
          projectId: 'project-1',
          result: completedResult,
          sectionId: 'lesson-1',
          stage: 'verification',
          status: 'completed',
        })
      )
      .mockResolvedValueOnce(
        response({
          id: 'run-2',
          projectId: 'project-1',
          result: completedResult,
          sectionId: 'lesson-1',
          stage: 'verification',
          status: 'completed',
        })
      );

    await generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' });
    await generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' });

    expect(requestBody(1).requestKey).not.toBe(requestBody(0).requestKey);
  });

  test('resumes a retained ordinary lesson without replaying its force flag', async () => {
    globalThis.sessionStorage.setItem(
      'nous:lesson-workflow-request:project-1:lesson-1',
      'forced-regeneration-request'
    );
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response({
        id: 'run-retained-lesson',
        projectId: 'project-1',
        result: completedResult,
        sectionId: 'lesson-1',
        stage: 'verification',
        status: 'completed',
      })
    );

    await expect(
      generateDurableLesson({
        forceRegenerate: false,
        projectId: 'project-1',
        sectionId: 'lesson-1',
      })
    ).resolves.toMatchObject(completedResult);

    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledWith(
      'http://localhost:3301/api/lesson-workflows/requests/resolve',
      expect.objectContaining({
        body: JSON.stringify({ requestKey: 'forced-regeneration-request' }),
        method: 'POST',
      }),
      { expectedStatuses: [404] }
    );
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(1);
    expect(globalThis.sessionStorage).toHaveLength(0);
  });

  test('starts a new forced run instead of replaying a terminal retained lesson', async () => {
    globalThis.sessionStorage.setItem(
      'nous:lesson-workflow-request:project-1:lesson-1',
      'terminal-request'
    );
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        response({
          id: 'run-terminal',
          projectId: 'project-1',
          result: completedResult,
          sectionId: 'lesson-1',
          stage: 'verification',
          status: 'completed',
        })
      )
      .mockResolvedValueOnce(
        response({
          id: 'run-forced',
          projectId: 'project-1',
          result: completedResult,
          sectionId: 'lesson-1',
          stage: 'verification',
          status: 'completed',
        })
      );

    await generateDurableLesson({
      forceRegenerate: true,
      projectId: 'project-1',
      sectionId: 'lesson-1',
    });

    expect(requestBody(1)).toMatchObject({ forceRegenerate: true });
    expect(requestBody(1).requestKey).not.toBe('terminal-request');
  });

  test('preserves force regeneration when a retained key has no backend run yet', async () => {
    globalThis.sessionStorage.setItem(
      'nous:lesson-workflow-request:project-1:lesson-1',
      'pending-force-request'
    );
    globalThis.sessionStorage.setItem(
      'nous:lesson-workflow-request:project-1:lesson-1:force-regenerate',
      'true'
    );
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        response({
          id: 'run-restarted-force',
          projectId: 'project-1',
          result: completedResult,
          sectionId: 'lesson-1',
          stage: 'verification',
          status: 'completed',
        })
      );

    await generateDurableLesson({ projectId: 'project-1', sectionId: 'lesson-1' });

    expect(requestBody(1).forceRegenerate).toBe(true);
    expect(globalThis.sessionStorage).toHaveLength(0);
  });

  test('keeps a force-only retained lesson discoverable across another reload', () => {
    globalThis.sessionStorage.setItem(
      'nous:lesson-workflow-request:project-1:lesson-1:force-regenerate',
      'true'
    );

    expect(hasDurableLessonRequest('project-1', 'lesson-1')).toBe(true);
  });

  test('clears every retained lesson identity for one deleted project', () => {
    globalThis.sessionStorage.setItem(
      'nous:lesson-workflow-request:project-1:lesson-1',
      'request-1'
    );
    globalThis.sessionStorage.setItem(
      'nous:lesson-workflow-request:project-1:lesson-1:force-regenerate',
      'true'
    );
    globalThis.sessionStorage.setItem(
      'nous:lesson-workflow-request:project-2:lesson-1',
      'request-2'
    );

    clearDurableLessonRequestsForProject('project-1');

    expect(globalThis.sessionStorage).toHaveLength(1);
    expect(
      globalThis.sessionStorage.getItem('nous:lesson-workflow-request:project-2:lesson-1')
    ).toBe('request-2');
  });

  test('clears retained lesson identities when the account session ends', () => {
    globalThis.sessionStorage.setItem(
      'nous:lesson-workflow-request:project-1:lesson-1',
      'request-1'
    );
    globalThis.sessionStorage.setItem(
      'nous:lesson-workflow-request:project-2:lesson-2:force-regenerate',
      'true'
    );
    globalThis.sessionStorage.setItem('unrelated-session-state', 'keep');

    clearAllDurableLessonRequests();

    expect(globalThis.sessionStorage).toHaveLength(1);
    expect(globalThis.sessionStorage.getItem('unrelated-session-state')).toBe('keep');
  });

  test('starts a server-owned sublesson without sending a section id or parent content', async () => {
    const sublessonResult = {
      ...completedResult,
      sectionId: 'sublesson-server-id',
    };
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response(
        {
          id: 'run-sublesson',
          projectId: 'project-1',
          result: sublessonResult,
          sectionId: 'sublesson-server-id',
          stage: 'verification',
          status: 'completed',
        },
        202
      )
    );

    await expect(
      generateDurableSublesson({
        annotationNote: 'Nota locale',
        contextAfter: 'Dopo',
        contextBefore: 'Prima',
        instructions: 'Approfondisci il concetto',
        parentSectionId: 'lesson-1',
        projectId: 'project-1',
        selectedText: 'testo selezionato',
      })
    ).resolves.toMatchObject(sublessonResult);

    const body = JSON.parse(
      String((fetchWithSupabaseAuthMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)
    ) as Record<string, unknown>;
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledWith(
      'http://localhost:3301/api/lesson-workflows/sublessons',
      expect.objectContaining({ method: 'POST' }),
      { expectedStatuses: [409] }
    );
    expect(body).toMatchObject({
      annotationNote: 'Nota locale',
      contextAfter: 'Dopo',
      contextBefore: 'Prima',
      instructions: 'Approfondisci il concetto',
      parentSectionId: 'lesson-1',
      projectId: 'project-1',
      selectedText: 'testo selezionato',
    });
    expect(body).not.toHaveProperty('parentContent');
    expect(body).not.toHaveProperty('sectionId');
  });

  test('continues the same sublesson workflow after a disconnected poll', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        response({
          id: 'run-sublesson',
          projectId: 'project-1',
          sectionId: 'sublesson-server-id',
          stage: 'structure',
          status: 'running',
        })
      )
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(
        response({
          id: 'run-sublesson',
          projectId: 'project-1',
          result: { ...completedResult, sectionId: 'sublesson-server-id' },
          sectionId: 'sublesson-server-id',
          stage: 'verification',
          status: 'completed',
        })
      );
    const input = {
      instructions: 'Approfondisci',
      parentSectionId: 'lesson-1',
      projectId: 'project-1',
      selectedText: 'testo selezionato',
    };

    const sublesson = generateDurableSublesson(input);
    const completion = expect(sublesson).resolves.toMatchObject({
      sectionId: 'sublesson-server-id',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(
      globalThis.sessionStorage.getItem('nous:lesson-workflow-request:project-1:sublesson:lesson-1')
    ).toBe(requestBody(0).requestKey);
    await advancePoll();
    await advancePoll();

    await completion;
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(3);
    expect(globalThis.sessionStorage).toHaveLength(0);
  });

  test('retires a terminal retained request before starting another sublesson', async () => {
    globalThis.sessionStorage.setItem(
      'nous:lesson-workflow-request:project-1:sublesson:lesson-1',
      'terminal-request'
    );
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        response({
          id: 'run-terminal',
          projectId: 'project-1',
          sectionId: 'old-deep-lesson',
          stage: 'verification',
          status: 'failed',
        })
      )
      .mockResolvedValueOnce(
        response(
          {
            id: 'run-new',
            projectId: 'project-1',
            result: { ...completedResult, sectionId: 'new-deep-lesson' },
            sectionId: 'new-deep-lesson',
            stage: 'verification',
            status: 'completed',
          },
          202
        )
      );

    await expect(
      generateDurableSublesson({
        instructions: 'Nuovo approfondimento',
        parentSectionId: 'lesson-1',
        projectId: 'project-1',
        selectedText: 'nuovo testo',
      })
    ).resolves.toMatchObject({ sectionId: 'new-deep-lesson' });

    expect(requestBody(1).requestKey).not.toBe('terminal-request');
    expect(globalThis.sessionStorage).toHaveLength(0);
  });

  test('keeps an active retained sublesson request instead of replacing it', async () => {
    globalThis.sessionStorage.setItem(
      'nous:lesson-workflow-request:project-1:sublesson:lesson-1',
      'active-request'
    );
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response({
        id: 'run-active',
        projectId: 'project-1',
        sectionId: 'active-deep-lesson',
        stage: 'drafting',
        status: 'running',
      })
    );

    await expect(
      generateDurableSublesson({
        instructions: 'Altro approfondimento',
        parentSectionId: 'lesson-1',
        projectId: 'project-1',
        selectedText: 'altro testo',
      })
    ).rejects.toMatchObject({
      activeSectionId: 'active-deep-lesson',
      name: 'LessonGenerationBusyError',
    });

    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(1);
    expect(
      globalThis.sessionStorage.getItem('nous:lesson-workflow-request:project-1:sublesson:lesson-1')
    ).toBe('active-request');
  });

  test('resolves a recoverable sublesson with its original request identity', async () => {
    globalThis.sessionStorage.setItem(
      'nous:lesson-workflow-request:project-1:sublesson:lesson-1',
      'sublesson-request'
    );
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response({
        id: 'run-sublesson',
        projectId: 'project-1',
        result: { ...completedResult, sectionId: 'deep-lesson' },
        sectionId: 'deep-lesson',
        stage: 'verification',
        status: 'completed',
      })
    );

    await generateDurableLesson({
      parentSectionId: 'lesson-1',
      projectId: 'project-1',
      sectionId: 'deep-lesson',
    });

    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledWith(
      'http://localhost:3301/api/lesson-workflows/requests/resolve',
      expect.objectContaining({
        body: JSON.stringify({ requestKey: 'sublesson-request' }),
        method: 'POST',
      }),
      { expectedStatuses: [404] }
    );
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(1);
    expect(globalThis.sessionStorage).toHaveLength(0);
  });

  test('reuses a resolved sublesson snapshot without a second resolver request', async () => {
    globalThis.sessionStorage.setItem(
      'nous:lesson-workflow-request:project-1:sublesson:lesson-1',
      'sublesson-request'
    );
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response({
        id: 'run-sublesson',
        projectId: 'project-1',
        result: { ...completedResult, sectionId: 'deep-lesson' },
        sectionId: 'deep-lesson',
        stage: 'verification',
        status: 'completed',
      })
    );

    const recovery = await resolveDurableSublessonRequestForSection(
      'project-1',
      'lesson-1',
      'deep-lesson'
    );
    expect(recovery).not.toBeNull();
    if (!recovery) throw new Error('Expected retained sublesson recovery');
    await generateDurableLesson({
      parentSectionId: 'lesson-1',
      projectId: 'project-1',
      recovery,
      sectionId: 'deep-lesson',
    });

    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(1);
    expect(globalThis.sessionStorage).toHaveLength(0);
  });

  test('replays a terminal sublesson failure without starting ordinary generation', async () => {
    globalThis.sessionStorage.setItem(
      'nous:lesson-workflow-request:project-1:sublesson:lesson-1',
      'sublesson-request'
    );
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response({
        errorCode: 'lesson_source_unavailable',
        id: 'run-sublesson',
        projectId: 'project-1',
        sectionId: 'deep-lesson',
        stage: 'sources',
        status: 'failed',
      })
    );

    await expect(
      generateDurableLesson({
        parentSectionId: 'lesson-1',
        projectId: 'project-1',
        sectionId: 'deep-lesson',
      })
    ).rejects.toBeInstanceOf(LessonSourceUnavailableError);

    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(1);
    expect(globalThis.sessionStorage).toHaveLength(0);
  });

  test('does not assign a retained sublesson request to a sibling section', async () => {
    globalThis.sessionStorage.setItem(
      'nous:lesson-workflow-request:project-1:sublesson:lesson-1',
      'sublesson-request'
    );
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response({
        id: 'run-sublesson',
        projectId: 'project-1',
        sectionId: 'deep-lesson-a',
        stage: 'drafting',
        status: 'running',
      })
    );

    await expect(
      isDurableSublessonRequestForSection('project-1', 'lesson-1', 'deep-lesson-b')
    ).resolves.toBe(false);

    expect(
      globalThis.sessionStorage.getItem('nous:lesson-workflow-request:project-1:sublesson:lesson-1')
    ).toBe('sublesson-request');
  });
});
