/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchWithSupabaseAuthMock = vi.hoisted(() => vi.fn());
const CORRELATION_ID = '48eb116c-a283-440b-b875-a528e5e4f5f1';

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: fetchWithSupabaseAuthMock,
}));

vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));

const {
  cancelCourseInterview,
  getActiveCourseInterview,
  sendCourseInterviewAnswer,
  sendCourseInterviewDecision,
  startCourseInterview,
} = await import('../../../services/openrouter/courseInterviewClient.ts');

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

const runSummaryResponse = (runId = 'interview-1', status = 'running'): Response =>
  jsonResponse({
    run: {
      createdAt: '2026-08-08T10:00:00.000Z',
      id: runId,
      projectId: 'project-1',
      status,
      updatedAt: '2026-08-08T10:00:00.000Z',
    },
    success: true,
  });

const event = (eventType: string, payload: unknown, sequence: string) => ({
  createdAt: '2026-08-08T10:00:00.000Z',
  eventType,
  payload,
  schemaVersion: 1,
  sequence,
});

const runStateResponse = ({
  cleanupStatus = 'not-required',
  correlationId,
  events = [],
  projectId = 'project-1',
  runId = 'interview-1',
  status,
  waits = [],
}: {
  cleanupStatus?: string;
  correlationId?: string;
  events?: unknown[];
  projectId?: string;
  runId?: string;
  status: string;
  waits?: unknown[];
}): Response =>
  jsonResponse({
    state: {
      publishedEvents: events,
      run: {
        cleanupStatus,
        ...(correlationId ? { correlationId } : {}),
        id: runId,
        projectId,
        status,
        workflowId: 'course-interview',
      },
      waits,
    },
    success: true,
  });

const userAnswerWait = {
  createdAt: '2026-08-08T10:00:01.000Z',
  expiresAt: '2026-08-09T10:00:01.000Z',
  nodeInstanceId: 'ask-1',
  schemaVersion: 1,
  signalType: 'user-answer',
  waitId: 'wait-answer-1',
};

const decisionWait = {
  ...userAnswerWait,
  nodeInstanceId: 'confirm-1',
  signalType: 'course-decision',
  waitId: 'wait-decision-1',
};

const proposal = {
  context: 'Progetto personale',
  experienceLevel: 'Intermedio',
  goals: 'Costruire API robuste',
  language: 'Italiano',
  learningStyle: 'Pratico e progressivo',
  topic: 'TypeScript e Bun',
};

const requestBody = (callIndex: number): Record<string, unknown> =>
  JSON.parse(String(fetchWithSupabaseAuthMock.mock.calls[callIndex]?.[1]?.body));

describe('courseInterviewClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchWithSupabaseAuthMock.mockReset();
    globalThis.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('starts the interview, polls the generic workflow and maps messages and its active wait', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(runSummaryResponse())
      .mockResolvedValueOnce(runStateResponse({ status: 'running' }))
      .mockResolvedValueOnce(
        runStateResponse({
          events: [
            event(
              'course-interview-message',
              { message: { role: 'model', text: 'Qual è il tuo obiettivo?' } },
              '2'
            ),
            event(
              'course-interview-message',
              { message: { role: 'user', text: 'Voglio imparare TypeScript.' } },
              '1'
            ),
          ],
          status: 'waiting',
          waits: [userAnswerWait],
        })
      );

    const pending = startCourseInterview({
      hasReliableSourceContext: true,
      initialMessage: 'Voglio imparare TypeScript.',
      mode: 'learn',
      projectId: 'project-1',
      sourceContext: 'Documentazione TypeScript.',
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toMatchObject({
      messages: [
        { role: 'user', text: 'Voglio imparare TypeScript.' },
        { role: 'model', text: 'Qual è il tuo obiettivo?' },
      ],
      projectId: 'project-1',
      proposal: null,
      runId: 'interview-1',
      status: 'waiting',
      wait: {
        expiresAt: userAnswerWait.expiresAt,
        signalType: 'user-answer',
        waitId: 'wait-answer-1',
      },
    });
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3301/api/course-interviews',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      3,
      'http://localhost:3301/api/workflows/runs/interview-1',
      { cache: 'no-store', signal: undefined }
    );
    expect(requestBody(0)).toMatchObject({
      hasReliableSourceContext: true,
      initialMessage: 'Voglio imparare TypeScript.',
      mode: 'learn',
      projectId: 'project-1',
      sourceContext: 'Documentazione TypeScript.',
      requestKey: expect.any(String),
    });
    expect(globalThis.sessionStorage).toHaveLength(0);
  });

  test('finds the authoritative active interview and returns null when none exists', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(runSummaryResponse('interview-active', 'waiting'))
      .mockResolvedValueOnce(
        runStateResponse({
          events: [event('course-proposal-ready', { proposal }, '1')],
          runId: 'interview-active',
          status: 'waiting',
          waits: [decisionWait],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ success: false }, 404));

    await expect(getActiveCourseInterview('project-1')).resolves.toMatchObject({
      proposal,
      runId: 'interview-active',
      wait: { signalType: 'course-decision', waitId: 'wait-decision-1' },
    });
    await expect(getActiveCourseInterview('project-1')).resolves.toBeNull();
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3301/api/course-interviews/project-1/active',
      { cache: 'no-store', signal: undefined },
      { expectedStatuses: [404] }
    );
  });

  test('does not expose an old proposal while the interview is waiting for more details', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(runSummaryResponse('interview-active', 'waiting'))
      .mockResolvedValueOnce(
        runStateResponse({
          events: [
            event('course-proposal-ready', { proposal }, '1'),
            event(
              'course-interview-message',
              { message: { role: 'model', text: 'Quale dettaglio vuoi aggiungere?' } },
              '2'
            ),
          ],
          runId: 'interview-active',
          status: 'waiting',
          waits: [userAnswerWait],
        })
      );

    await expect(getActiveCourseInterview('project-1')).resolves.toMatchObject({
      proposal: null,
      wait: { signalType: 'user-answer' },
    });
  });

  test('sends a validated answer through the generic signal route and waits for the proposal', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(jsonResponse({ signal: { accepted: true }, success: true }))
      .mockResolvedValueOnce(
        runStateResponse({
          events: [event('course-proposal-ready', { proposal }, '1')],
          status: 'waiting',
          waits: [decisionWait],
        })
      );

    await expect(
      sendCourseInterviewAnswer({
        projectId: 'project-1',
        runId: 'interview-1',
        text: 'Voglio costruire API robuste.',
        waitId: 'wait-answer-1',
      })
    ).resolves.toMatchObject({
      proposal,
      wait: { signalType: 'course-decision' },
    });
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3301/api/workflows/runs/interview-1/waits/wait-answer-1/signals',
      expect.objectContaining({ method: 'POST' })
    );
    expect(requestBody(0)).toMatchObject({
      payload: { text: 'Voglio costruire API robuste.' },
      requestKey: expect.any(String),
      signalType: 'user-answer',
    });
  });

  test('approves the proposal and maps the generation started by the completed interview', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(jsonResponse({ signal: { accepted: true }, success: true }))
      .mockResolvedValueOnce(
        runStateResponse({
          events: [
            event(
              'course-generation-started',
              { generationRunId: 'course-run-1', projectId: 'project-1' },
              '1'
            ),
            event(
              'course-interview-ended',
              {
                generationRunId: 'course-run-1',
                kind: 'approved',
                projectId: 'project-1',
              },
              '2'
            ),
          ],
          status: 'completed',
        })
      );

    await expect(
      sendCourseInterviewDecision({
        decision: { kind: 'approve' },
        projectId: 'project-1',
        runId: 'interview-1',
        waitId: 'wait-decision-1',
      })
    ).resolves.toMatchObject({
      generationRunId: 'course-run-1',
      result: {
        generationRunId: 'course-run-1',
        kind: 'approved',
        projectId: 'project-1',
      },
      status: 'completed',
      wait: null,
    });
    expect(requestBody(0)).toMatchObject({
      payload: { kind: 'approve' },
      signalType: 'course-decision',
    });
  });

  test('maps cancellation when draft cleanup deletes the interview run', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(jsonResponse({ signal: { accepted: true }, success: true }))
      .mockResolvedValueOnce(jsonResponse({ success: false }, 404));

    await expect(
      sendCourseInterviewDecision({
        decision: { kind: 'cancel' },
        projectId: 'project-1',
        runId: 'interview-1',
        waitId: 'wait-decision-1',
      })
    ).resolves.toMatchObject({
      projectId: 'project-1',
      result: { kind: 'cancelled', projectId: 'project-1' },
      status: 'cancelled',
      wait: null,
    });
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(2);
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3301/api/workflows/runs/interview-1',
      { cache: 'no-store', signal: undefined },
      { expectedStatuses: [404] }
    );
  });

  test('records the persisted support code for a failed interview snapshot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(runSummaryResponse())
      .mockResolvedValueOnce(runStateResponse({ correlationId: CORRELATION_ID, status: 'failed' }));

    const snapshot = await startCourseInterview({
      hasReliableSourceContext: false,
      mode: 'learn',
      projectId: 'project-1',
    });

    expect(snapshot.status).toBe('failed');
    expect(warn).toHaveBeenCalledWith(`[Nous][API] Codice assistenza: ${CORRELATION_ID}`);
    warn.mockRestore();
  });

  test('records the persisted support code for a malformed completed interview', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(runSummaryResponse())
      .mockResolvedValueOnce(
        runStateResponse({ correlationId: CORRELATION_ID, events: [], status: 'completed' })
      );

    await expect(
      startCourseInterview({
        hasReliableSourceContext: false,
        mode: 'learn',
        projectId: 'project-1',
      })
    ).rejects.toThrow('L’intervista per il corso non è riuscita. Riprova.');
    expect(warn).toHaveBeenCalledWith(`[Nous][API] Codice assistenza: ${CORRELATION_ID}`);
    warn.mockRestore();
  });

  test('records the support code before rejecting malformed interview event metadata', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(runSummaryResponse()).mockResolvedValueOnce(
      runStateResponse({
        correlationId: CORRELATION_ID,
        events: [event('course-interview-ended', {}, 'invalid-sequence')],
        status: 'completed',
      })
    );

    await expect(
      startCourseInterview({
        hasReliableSourceContext: false,
        mode: 'learn',
        projectId: 'project-1',
      })
    ).rejects.toThrow('L’intervista per il corso non è riuscita. Riprova.');
    expect(warn).toHaveBeenCalledWith(`[Nous][API] Codice assistenza: ${CORRELATION_ID}`);
    warn.mockRestore();
  });

  test('rejects a generic snapshot that belongs to another project', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(runSummaryResponse())
      .mockResolvedValueOnce(runStateResponse({ projectId: 'project-2', status: 'waiting' }));

    await expect(
      startCourseInterview({
        hasReliableSourceContext: false,
        mode: 'learn',
        projectId: 'project-1',
      })
    ).rejects.toThrow('L’intervista per il corso non è riuscita. Riprova.');
  });

  test('validates the project before cancelling an interview during a question', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(runStateResponse({ status: 'waiting', waits: [userAnswerWait] }))
      .mockResolvedValueOnce(jsonResponse({ cancellation: { requested: true }, success: true }))
      .mockResolvedValueOnce(
        runStateResponse({ cleanupStatus: 'completed', status: 'cancelled', waits: [] })
      );

    await expect(
      cancelCourseInterview({ projectId: 'project-1', runId: 'interview-1' })
    ).resolves.toBeUndefined();
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3301/api/workflows/runs/interview-1/cancellation',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(3);
  });

  test('finishes cancellation when cleanup deletes the interview run', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(runStateResponse({ status: 'waiting', waits: [userAnswerWait] }))
      .mockResolvedValueOnce(jsonResponse({ cancellation: { requested: true }, success: true }))
      .mockResolvedValueOnce(jsonResponse({ success: false }, 404));

    await expect(
      cancelCourseInterview({ projectId: 'project-1', runId: 'interview-1' })
    ).resolves.toBeUndefined();
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(3);
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      3,
      'http://localhost:3301/api/workflows/runs/interview-1',
      { cache: 'no-store', signal: undefined },
      { expectedStatuses: [404] }
    );
  });

  test('records the persisted support code when interview cleanup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(runStateResponse({ status: 'waiting', waits: [userAnswerWait] }))
      .mockResolvedValueOnce(jsonResponse({ cancellation: { requested: true }, success: true }))
      .mockResolvedValueOnce(
        runStateResponse({
          cleanupStatus: 'failed',
          correlationId: CORRELATION_ID,
          status: 'cancelled',
        })
      );

    await expect(
      cancelCourseInterview({ projectId: 'project-1', runId: 'interview-1' })
    ).rejects.toThrow('L’intervista per il corso non è riuscita. Riprova.');
    expect(warn).toHaveBeenCalledWith(`[Nous][API] Codice assistenza: ${CORRELATION_ID}`);
    warn.mockRestore();
  });

  test('rejects cancellation when the interview belongs to another project', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      runStateResponse({ projectId: 'project-2', status: 'waiting' })
    );

    await expect(
      cancelCourseInterview({ projectId: 'project-1', runId: 'interview-1' })
    ).rejects.toThrow('L’intervista per il corso non è riuscita. Riprova.');
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(1);
  });
});
