/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchWithSupabaseAuthMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: fetchWithSupabaseAuthMock,
}));

vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));

const { generateLessonArtifactDraft } = await import(
  '../../../services/openrouter/artifactDrafts.ts'
);

const ASSET_ID = 'a'.repeat(64);
const CORRELATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const visual = {
  altText: 'Trama e ordito intrecciati',
  anchorHeading: 'Intreccio',
  createdAt: '2026-07-30T10:00:00.000Z',
  id: 'lesson-visual:run-1:artifact-draft',
  render: {
    asset: { byteSize: 4, hash: ASSET_ID, id: ASSET_ID, mediaType: 'image/png' },
    kind: 'image' as const,
  },
  slotId: 'artifact-draft',
  title: 'Trama e ordito',
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

const job = (status: 'completed' | 'failed' | 'queued' | 'running') => ({
  createdAt: '2026-07-30T10:00:00.000Z',
  id: 'run-1',
  projectId: 'project-1',
  ...(status === 'completed' ? { result: { visual } } : {}),
  retrying: false,
  sectionId: 'lesson-1',
  stage: status === 'completed' ? 'finalizing' : 'planning',
  status,
  updatedAt: '2026-07-30T10:00:00.000Z',
});

const lesson = {
  content: '## Intreccio\n\nTrama e ordito si incrociano.',
  description: 'Riconoscere trama e ordito.',
  id: 'lesson-1',
  isCompleted: false,
  title: 'Intreccio',
  type: 'core' as const,
};

describe('generateLessonArtifactDraft', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchWithSupabaseAuthMock.mockReset();
    globalThis.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('starts the backend workflow, polls it and preserves the project asset reference', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        jsonResponse({ created: true, job: job('queued'), success: true }, 202)
      )
      .mockResolvedValueOnce(jsonResponse({ job: job('completed'), success: true }));

    const pending = generateLessonArtifactDraft({
      lesson,
      projectId: 'project-1',
      projectTitle: 'Corso test',
      prompt: 'Crea una visuale che mostri l’intreccio.',
      requestKey: 'tool-call-1',
      requestedVisualKind: 'image',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const draft = await pending;

    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3301/api/artifact-drafts',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3301/api/artifact-drafts/runs/run-1',
      { cache: 'no-store' }
    );
    const requestBody = JSON.parse(
      String((fetchWithSupabaseAuthMock.mock.calls[0]?.[1] as RequestInit).body)
    );
    expect(requestBody).toMatchObject({
      projectId: 'project-1',
      requestText: 'Crea una visuale che mostri l’intreccio.',
      requestedVisualKind: 'image',
      sectionDescription: lesson.description,
      sectionId: 'lesson-1',
      sectionTitle: 'Intreccio',
    });
    expect(requestBody.lessonMarkdown).toContain('Crea una visuale che mostri l’intreccio.');
    expect(requestBody.sectionDescription).not.toContain('Richiesta:');
    expect(draft?.visual).toEqual(visual);
    expect(draft?.payload.visual).toEqual(visual);
    expect(JSON.stringify(draft)).not.toContain('data:image');
    expect(globalThis.sessionStorage).toHaveLength(0);
  });

  test('rejects a successful response whose artifact job violates the client contract', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(
        jsonResponse({
          created: true,
          job: { correlationId: CORRELATION_ID, id: 'run-malformed', status: 'running' },
          success: true,
        })
      )
      .mockResolvedValueOnce(jsonResponse({ job: job('completed'), success: true }));

    const draft = generateLessonArtifactDraft({
      lesson,
      projectId: 'project-1',
      projectTitle: 'Corso test',
      prompt: 'Crea una visuale.',
      requestKey: 'tool-call-malformed',
    });
    const rejection = expect(draft).rejects.toThrow(
      'La generazione dell’artefatto visuale non è riuscita. Riprova.'
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(`[Nous][API] Codice assistenza: ${CORRELATION_ID}`);
  });

  test('retains the artifact request key when a successful start body is malformed', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      new Response('{"success":true', { status: 202 })
    );

    await expect(
      generateLessonArtifactDraft({
        lesson,
        projectId: 'project-1',
        projectTitle: 'Corso test',
        prompt: 'Crea una visuale.',
        requestKey: 'tool-call-interrupted',
      })
    ).rejects.toThrow('La generazione dell’artefatto visuale non è riuscita. Riprova.');

    expect(
      globalThis.sessionStorage.getItem(
        'nous:artifact-draft-request:project-1:tool-call-interrupted'
      )
    ).not.toBeNull();
  });

  test('clears the artifact request key before reading a definitive rejection body', async () => {
    const interruptedBody = {
      json: vi.fn().mockRejectedValue(new TypeError('response stream interrupted')),
      ok: false,
      status: 400,
    } as unknown as Response;
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(interruptedBody);

    await expect(
      generateLessonArtifactDraft({
        lesson,
        projectId: 'project-1',
        projectTitle: 'Corso test',
        prompt: 'Crea una visuale.',
        requestKey: 'tool-call-rejected',
      })
    ).rejects.toThrow('response stream interrupted');

    expect(
      globalThis.sessionStorage.getItem('nous:artifact-draft-request:project-1:tool-call-rejected')
    ).toBeNull();
  });

  test('keeps replacement metadata and excludes durable asset ids from the revision prompt', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      jsonResponse({ created: true, job: job('completed'), success: true }, 202)
    );

    const draft = await generateLessonArtifactDraft({
      lesson,
      mode: 'replacement-draft',
      projectId: 'project-1',
      projectTitle: 'Corso test',
      prompt: 'Rendi la visuale più chiara.',
      requestKey: 'tool-call-2',
      revisionInstructions: 'Evidenzia meglio l’ordito.',
      sourceArtifact: {
        summary: {
          id: 'artifact-source',
          kind: 'generated-visual',
          lessonId: 'lesson-1',
          lessonTitle: 'Intreccio',
          previewMode: 'thumbnail',
          projectId: 'project-1',
          projectTitle: 'Corso test',
          title: 'Intreccio precedente',
        },
        visual,
      },
      sourceArtifactId: 'artifact-source',
    });

    const requestBody = JSON.parse(
      String((fetchWithSupabaseAuthMock.mock.calls[0]?.[1] as RequestInit).body)
    );
    expect(requestBody.lessonMarkdown).toContain(visual.altText);
    expect(requestBody.lessonMarkdown).not.toContain(ASSET_ID);
    expect(requestBody).toMatchObject({
      requestedVisualKind: 'image',
      sourceVisualId: visual.id,
    });
    expect(draft?.payload.summary.replacementOfArtifactId).toBe('artifact-source');
  });

  test('does not put legacy inline image data in a durable replacement request', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      jsonResponse({ created: true, job: job('completed'), success: true }, 202)
    );

    await generateLessonArtifactDraft({
      lesson,
      mode: 'replacement-draft',
      projectId: 'project-1',
      projectTitle: 'Corso test',
      prompt: 'Rendi il widget piu chiaro.',
      requestKey: 'tool-call-legacy',
      sourceArtifact: {
        summary: {
          id: 'legacy-source',
          kind: 'generated-visual',
          lessonId: 'lesson-1',
          lessonTitle: 'Intreccio',
          previewMode: 'chip-only',
          projectId: 'project-1',
          projectTitle: 'Corso test',
          title: 'Widget precedente',
        },
        visual: {
          code: '<style></style><img src="data:image/png;base64,AAAA"><script></script>',
          createdAt: '2026-07-29T10:00:00.000Z',
          id: 'legacy-visual',
          kind: 'html',
          title: 'Widget precedente',
        },
      },
      sourceArtifactId: 'legacy-source',
    });

    const requestBody = JSON.parse(
      String((fetchWithSupabaseAuthMock.mock.calls[0]?.[1] as RequestInit).body)
    );
    expect(requestBody.requestedVisualKind).toBe('html');
    expect(requestBody.sourceVisualId).toBeUndefined();
    expect(JSON.stringify(requestBody)).not.toContain('data:image');
  });

  test('returns null when the planner deliberately selects no visual', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      jsonResponse(
        {
          created: true,
          job: { ...job('completed'), result: { visual: null } },
          success: true,
        },
        202
      )
    );

    await expect(
      generateLessonArtifactDraft({
        lesson,
        projectId: 'project-1',
        projectTitle: 'Corso test',
        prompt: 'Aggiungi una visuale solo se utile.',
        requestKey: 'tool-call-3',
      })
    ).resolves.toBeNull();
  });

  test('explains when an app update intentionally stops the stored workflow definition', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      jsonResponse({
        created: true,
        job: {
          ...job('failed'),
          correlationId: CORRELATION_ID,
          errorCode: 'workflow_definition_unavailable',
        },
        success: true,
      })
    );

    await expect(
      generateLessonArtifactDraft({
        lesson,
        projectId: 'project-1',
        projectTitle: 'Corso test',
        prompt: 'Crea una visuale.',
        requestKey: 'tool-call-retired',
      })
    ).rejects.toThrow(
      'L’app è stata aggiornata mentre questa generazione era in corso. Avvia una nuova generazione.'
    );
    expect(warning).toHaveBeenCalledWith(`[Nous][API] Codice assistenza: ${CORRELATION_ID}`);
    warning.mockRestore();
  });
});
