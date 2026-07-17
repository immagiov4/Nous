import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createSupabaseTestToken } from '../helpers/auth.js';

const youtubeResearchMocks = vi.hoisted(() => ({
  buildYouTubeResearchBundle: vi.fn(),
  buildYouTubeResearchDiagnostic: vi.fn(),
  YouTubeTranscriptOverrideProvider: vi.fn(function YouTubeTranscriptOverrideProvider(
    this: { overrides: unknown },
    overrides: unknown
  ) {
    this.overrides = overrides;
  }),
}));

vi.mock('../../src/services/youtubeResearch.js', () => youtubeResearchMocks);

const { createApp } = await import('../../src/index.js');

const ORIGINAL_ENV = { ...process.env };
const authHeader = (role: 'admin' | 'user') =>
  `Bearer ${createSupabaseTestToken({ role, secret: 'test-secret' })}`;

describe('/api/youtube/admin/research-lab', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      AUTH_MODE: 'supabase',
      SUPABASE_JWT_SECRET: 'test-secret',
    };
    youtubeResearchMocks.buildYouTubeResearchDiagnostic.mockReset();
    youtubeResearchMocks.buildYouTubeResearchBundle.mockReset();
    youtubeResearchMocks.buildYouTubeResearchBundle.mockResolvedValue({
      context: 'SOURCE Pixel art',
      videoCandidates: [],
    });
    youtubeResearchMocks.YouTubeTranscriptOverrideProvider.mockClear();
    youtubeResearchMocks.buildYouTubeResearchDiagnostic.mockResolvedValue({
      budget: {
        contextWindowTokens: 128_000,
        nonYouTubePromptTokens: 8_000,
        perTranscriptMaxTokens: 25_600,
        remainingTokens: 52_800,
        reservedOutputTokens: 32_000,
        residualTokens: 88_000,
        transcriptBudgetTokens: 52_800,
        usedTokens: 0,
      },
      bundle: { context: 'SOURCE Pixel art', videoCandidates: [] },
      candidates: [],
      errors: [],
      limits: {
        discoveryVideos: 12,
        playlistResults: 4,
        playlistVideos: 4,
        transcriptConcurrency: 2,
      },
      operations: {
        discoveryCommands: 2,
        playlistExpansionCommands: 1,
        transcriptCommandAttempts: 5,
        transcriptLookups: 1,
      },
      preferredLanguages: ['it', 'en'],
      query: 'Bordi e curve Pixel art',
      timings: { discoveryMs: 12, playlistExpansionMs: 4, totalMs: 30, transcriptsMs: 14 },
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('rejects authenticated non-admin users before running external tools', async () => {
    const response = await request(createApp())
      .post('/api/youtube/admin/research-lab')
      .set('Authorization', authHeader('user'))
      .send({ language: 'Italiano', query: 'Pixel art' });

    expect(response.status).toBe(403);
    expect(youtubeResearchMocks.buildYouTubeResearchDiagnostic).not.toHaveBeenCalled();
  });

  test('lets admins force diagnostics independently from the production clip flag', async () => {
    const response = await request(createApp())
      .post('/api/youtube/admin/research-lab')
      .set('Authorization', authHeader('admin'))
      .send({
        contextWindowTokens: 9_000_000,
        language: 'Italiano',
        nonYouTubePromptTokens: 8_000,
        query: '  Bordi e curve Pixel art  ',
        reservedOutputTokens: 32_000,
      });

    expect(response.status).toBe(200);
    expect(youtubeResearchMocks.buildYouTubeResearchDiagnostic).toHaveBeenCalledWith(
      'Bordi e curve Pixel art',
      'Italiano',
      {
        budget: {
          contextWindowTokens: 2_000_000,
          nonYouTubePromptTokens: 8_000,
          reservedOutputTokens: 32_000,
        },
      }
    );
    expect(response.body).toMatchObject({
      success: true,
      productionVideoClipsEnabled: expect.any(Boolean),
      diagnostic: { query: 'Bordi e curve Pixel art' },
    });
  });

  test('rejects an empty query without starting discovery', async () => {
    const response = await request(createApp())
      .post('/api/youtube/admin/research-lab')
      .set('Authorization', authHeader('admin'))
      .send({ query: ' ' });

    expect(response.status).toBe(400);
    expect(youtubeResearchMocks.buildYouTubeResearchDiagnostic).not.toHaveBeenCalled();
  });

  test('passes validated browser transcripts to an override-first provider', async () => {
    const response = await request(createApp())
      .post('/api/youtube/admin/research-lab')
      .set('Authorization', authHeader('admin'))
      .send({
        query: 'Pixel art',
        transcriptOverrides: [
          {
            language: 'it',
            videoId: 'video-1',
            segments: [
              { startSeconds: 10, text: 'Prima riga' },
              { startSeconds: 13.5, text: 'Seconda riga' },
            ],
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(youtubeResearchMocks.YouTubeTranscriptOverrideProvider).toHaveBeenCalledWith([
      {
        language: 'it',
        videoId: 'video-1',
        segments: [
          { durationSeconds: 3.5, startSeconds: 10, text: 'Prima riga' },
          { durationSeconds: 4, startSeconds: 13.5, text: 'Seconda riga' },
        ],
      },
    ]);
    expect(youtubeResearchMocks.buildYouTubeResearchDiagnostic).toHaveBeenCalledWith(
      'Pixel art',
      'Italiano',
      expect.objectContaining({ transcripts: expect.any(Object) })
    );
  });

  test('rejects malformed browser transcripts before discovery', async () => {
    const response = await request(createApp())
      .post('/api/youtube/admin/research-lab')
      .set('Authorization', authHeader('admin'))
      .send({
        query: 'Pixel art',
        transcriptOverrides: [
          { videoId: 'video-1', segments: [{ startSeconds: -1, text: 'Invalid' }] },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Transcript importati non validi.');
    expect(youtubeResearchMocks.buildYouTubeResearchDiagnostic).not.toHaveBeenCalled();
  });

  test('caps the number of imported browser transcripts', async () => {
    const response = await request(createApp())
      .post('/api/youtube/admin/research-lab')
      .set('Authorization', authHeader('admin'))
      .send({
        query: 'Pixel art',
        transcriptOverrides: Array.from({ length: 31 }, (_, index) => ({
          videoId: `video-${index}`,
          segments: [{ startSeconds: 0, text: 'Transcript' }],
        })),
      });

    expect(response.status).toBe(400);
    expect(youtubeResearchMocks.buildYouTubeResearchDiagnostic).not.toHaveBeenCalled();
  });

  test('returns a stable gateway error when discovery fails', async () => {
    youtubeResearchMocks.buildYouTubeResearchDiagnostic.mockRejectedValueOnce(
      new Error('yt-dlp missing from C:\\private\\path')
    );

    const response = await request(createApp())
      .post('/api/youtube/admin/research-lab')
      .set('Authorization', authHeader('admin'))
      .send({ query: 'Pixel art' });

    expect(response.status).toBe(502);
    expect(response.body.error).toBe(
      'Ricerca YouTube non disponibile. Controlla i tool del backend e riprova.'
    );
    expect(JSON.stringify(response.body)).not.toContain('private');
  });
});

describe('/api/youtube/research-context', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      AUTH_MODE: 'supabase',
      SUPABASE_JWT_SECRET: 'test-secret',
    };
    youtubeResearchMocks.buildYouTubeResearchBundle.mockReset();
    youtubeResearchMocks.buildYouTubeResearchBundle.mockResolvedValue({
      context: 'SOURCE Pixel art',
      videoCandidates: [],
    });
    youtubeResearchMocks.YouTubeTranscriptOverrideProvider.mockClear();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('uses browser transcripts during normal course and lesson research', async () => {
    const response = await request(createApp())
      .post('/api/youtube/research-context')
      .set('Authorization', authHeader('user'))
      .send({
        language: 'Italiano',
        query: 'Luce piani e volume',
        transcriptOverrides: [
          {
            language: 'it',
            videoId: 'light-demo',
            segments: [{ startSeconds: 12, text: 'Ora ombreggio il piano laterale.' }],
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(youtubeResearchMocks.YouTubeTranscriptOverrideProvider).toHaveBeenCalledWith([
      {
        language: 'it',
        videoId: 'light-demo',
        segments: [
          {
            durationSeconds: 4,
            startSeconds: 12,
            text: 'Ora ombreggio il piano laterale.',
          },
        ],
      },
    ]);
    expect(youtubeResearchMocks.buildYouTubeResearchBundle).toHaveBeenCalledWith(
      'Luce piani e volume',
      'Italiano',
      { transcripts: expect.any(Object) }
    );
  });

  test('rejects malformed browser transcripts before normal research', async () => {
    const response = await request(createApp())
      .post('/api/youtube/research-context')
      .set('Authorization', authHeader('user'))
      .send({
        query: 'Luce piani e volume',
        transcriptOverrides: [
          { videoId: 'light-demo', segments: [{ startSeconds: -1, text: 'Invalid' }] },
        ],
      });

    expect(response.status).toBe(400);
    expect(youtubeResearchMocks.buildYouTubeResearchBundle).not.toHaveBeenCalled();
  });
});
