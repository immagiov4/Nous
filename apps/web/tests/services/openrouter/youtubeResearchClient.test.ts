import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchWithSupabaseAuthMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: fetchWithSupabaseAuthMock,
}));

vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));

const { getYouTubeResearchContext, getYouTubeVideoClipsEnabled, mergeYouTubeResearchContexts } =
  await import('../../../services/openrouter/youtubeResearchClient.ts');

describe('getYouTubeResearchContext', () => {
  beforeEach(() => {
    fetchWithSupabaseAuthMock.mockReset();
  });

  test('keeps the backend clip policy separate from transcript content', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          context: '[00:12-00:18] Traccio la prima linea.',
          rationale: 'Un transcript pertinente incluso.',
          videoCandidates: [
            {
              segments: [{ startSeconds: 12, endSeconds: 18, text: 'Traccio la prima linea.' }],
              title: 'Prima linea',
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
      rationale: 'Un transcript pertinente incluso.',
      videoCandidates: [
        {
          segments: [{ startSeconds: 12, endSeconds: 18, text: 'Traccio la prima linea.' }],
          title: 'Prima linea',
          url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
        },
      ],
      videoClipsEnabled: true,
    });
  });

  test('sends only the research query to the shared backend pipeline', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValue(
      Response.json({ success: true, context: '', videoClipsEnabled: false })
    );

    await getYouTubeResearchContext('luce e volume', 'Italiano');

    const request = fetchWithSupabaseAuthMock.mock.calls[0];
    expect(JSON.parse(request[1].body)).toEqual({
      language: 'Italiano',
      query: 'luce e volume',
    });
  });

  test('fails closed when the route is unavailable', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValue(new Response('', { status: 503 }));

    await expect(getYouTubeResearchContext('disegno', 'Italiano')).resolves.toEqual({
      context: '',
      failed: true,
      rationale: 'La ricerca YouTube non è stata completata.',
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

  test('merges complementary course searches and deduplicates videos by URL', () => {
    expect(
      mergeYouTubeResearchContexts([
        {
          context: 'Fondamenti.',
          rationale: 'Ricerca generale.',
          videoCandidates: [
            {
              segments: [{ startSeconds: 1, endSeconds: 4, text: 'Introduzione.' }],
              title: 'Fondamenti',
              url: 'https://youtube.test/shared',
            },
          ],
          videoClipsEnabled: true,
        },
        {
          context: 'Percorso pratico.',
          rationale: 'Ricerca applicata.',
          videoCandidates: [
            {
              segments: [{ startSeconds: 5, endSeconds: 9, text: 'Duplicato.' }],
              title: 'Percorso pratico',
              url: 'https://youtube.test/shared',
            },
          ],
          videoClipsEnabled: true,
        },
      ])
    ).toEqual({
      context: 'Fondamenti.\n\nPercorso pratico.',
      failed: false,
      rationale: 'Ricerca generale. Ricerca applicata.',
      videoCandidates: [
        {
          segments: [{ startSeconds: 1, endSeconds: 4, text: 'Introduzione.' }],
          title: 'Fondamenti',
          url: 'https://youtube.test/shared',
        },
      ],
      videoClipsEnabled: true,
    });
  });
});
