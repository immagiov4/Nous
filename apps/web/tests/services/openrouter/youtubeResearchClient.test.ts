import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchWithSupabaseAuthMock = vi.hoisted(() => vi.fn());
const localStorageValues = new Map<string, string>();
const localStorageMock = {
  clear: () => localStorageValues.clear(),
  getItem: (key: string) => localStorageValues.get(key) ?? null,
  setItem: (key: string, value: string) => localStorageValues.set(key, value),
};

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: fetchWithSupabaseAuthMock,
}));

vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));

const { buildLessonYouTubeResearchQuery, getYouTubeResearchContext, getYouTubeVideoClipsEnabled } =
  await import('../../../services/openrouter/youtubeResearchClient.ts');

describe('getYouTubeResearchContext', () => {
  beforeEach(() => {
    fetchWithSupabaseAuthMock.mockReset();
    vi.stubGlobal('localStorage', localStorageMock);
    localStorage.clear();
  });

  test('builds the same lesson and course query used by production research', () => {
    expect(
      buildLessonYouTubeResearchQuery({
        courseTitle: ' Pixel art ',
        keyConcepts: ['sfumature', 'texture'],
        lessonDescription: 'Costruire curve con bordi leggibili',
        lessonTitle: ' Bordi e curve ',
      })
    ).toBe('Bordi e curve Pixel art Costruire curve con bordi leggibili sfumature texture');
    expect(buildLessonYouTubeResearchQuery({ courseTitle: '', lessonTitle: 'Pixel art' })).toBe(
      'Pixel art'
    );
    expect(
      buildLessonYouTubeResearchQuery({
        courseTitle: 'Corso',
        contextPrompt: 'x'.repeat(600),
        lessonTitle: 'Lezione',
      })
    ).toHaveLength(500);
  });

  test('keeps the backend clip policy separate from transcript content', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          context: '[00:12-00:18] Traccio la prima linea.',
          videoCandidates: [
            {
              ranges: [{ startSeconds: 12, endSeconds: 18 }],
              url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
            },
          ],
          videoClipsEnabled: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(getYouTubeResearchContext('ombreggiatura', 'Italiano')).resolves.toEqual({
      context: '[00:12-00:18] Traccio la prima linea.',
      videoCandidates: [
        {
          ranges: [{ startSeconds: 12, endSeconds: 18 }],
          url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
        },
      ],
      videoClipsEnabled: true,
    });
  });

  test('sends saved browser transcripts through the normal generation request', async () => {
    localStorage.setItem(
      'nous:youtube-transcript-overrides',
      JSON.stringify([
        {
          language: 'it',
          videoId: 'light-demo',
          segments: [{ startSeconds: 12, text: 'Ora ombreggio il piano laterale.' }],
        },
      ])
    );
    fetchWithSupabaseAuthMock.mockResolvedValue(
      Response.json({ success: true, context: '', videoClipsEnabled: false })
    );

    await getYouTubeResearchContext('luce e volume', 'Italiano');

    const request = fetchWithSupabaseAuthMock.mock.calls[0];
    expect(JSON.parse(request[1].body)).toEqual({
      language: 'Italiano',
      query: 'luce e volume',
      transcriptOverrides: [
        {
          language: 'it',
          videoId: 'light-demo',
          segments: [{ startSeconds: 12, text: 'Ora ombreggio il piano laterale.' }],
        },
      ],
    });
  });

  test('fails closed when the route is unavailable', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValue(new Response('', { status: 503 }));

    await expect(getYouTubeResearchContext('disegno', 'Italiano')).resolves.toEqual({
      context: '',
      videoCandidates: [],
      videoClipsEnabled: false,
    });
  });

  test('loads the authoritative runtime clip policy from the backend', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValue(
      Response.json({ success: true, videoClipsEnabled: true })
    );

    await expect(getYouTubeVideoClipsEnabled()).resolves.toBe(true);
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledWith(
      'http://localhost:3301/api/youtube/config'
    );
  });
});
