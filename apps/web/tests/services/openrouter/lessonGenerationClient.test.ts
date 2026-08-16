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
  generateDurableLesson,
  generateDurableSublesson,
  LessonGenerationBusyError,
  LessonSourceUnavailableError,
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

const requestBody = (callIndex: number): { requestKey: string } =>
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
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(response({ id: 'run-malformed', status: 'running' }))
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
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      response({
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
    await advancePoll();
    await advancePoll();

    await completion;
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(3);
    expect(globalThis.sessionStorage).toHaveLength(0);
  });
});
