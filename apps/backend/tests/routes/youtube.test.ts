import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createSupabaseTestToken } from '../helpers/auth.js';

const youtubeResearchMocks = vi.hoisted(() => ({
  buildYouTubeResearchBundle: vi.fn(),
  buildYouTubeResearchDiagnostic: vi.fn(),
  buildYouTubeResearchOutcome: vi.fn(),
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
      DECODO_SCRAPING_API_KEY: 'decodo-test-key',
      SUPABASE_JWT_SECRET: 'test-secret',
    };
    youtubeResearchMocks.buildYouTubeResearchDiagnostic.mockReset();
    youtubeResearchMocks.buildYouTubeResearchBundle.mockReset();
    youtubeResearchMocks.buildYouTubeResearchOutcome.mockReset();
    youtubeResearchMocks.buildYouTubeResearchBundle.mockResolvedValue({
      context: 'SOURCE Pixel art',
      videoCandidates: [],
    });
    youtubeResearchMocks.buildYouTubeResearchDiagnostic.mockResolvedValue({
      budget: {
        contextWindowTokens: 128_000,
        nonYouTubePromptTokens: 8_000,
        perTranscriptMaxTokens: 44_000,
        remainingTokens: 88_000,
        reservedOutputTokens: 32_000,
        residualTokens: 88_000,
        transcriptBudgetTokens: 88_000,
        usedTokens: 0,
      },
      bundle: { context: 'SOURCE Pixel art', videoCandidates: [] },
      candidates: [],
      errors: [],
      limits: {
        discoveryVideos: 6,
        playlistResults: 2,
        transcriptConcurrency: 2,
      },
      operations: {
        discoveryRequests: 1,
        playlistPreviewsExpanded: 1,
        transcriptRequests: 5,
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
      productionVideoClipsEnabled: true,
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

  test('returns a stable gateway error when discovery fails', async () => {
    youtubeResearchMocks.buildYouTubeResearchDiagnostic.mockRejectedValueOnce(
      new Error('Decodo credential failed at C:\\private\\path')
    );

    const response = await request(createApp())
      .post('/api/youtube/admin/research-lab')
      .set('Authorization', authHeader('admin'))
      .send({ query: 'Pixel art' });

    expect(response.status).toBe(502);
    expect(response.body.error).toBe(
      'Ricerca YouTube non disponibile. Controlla la configurazione Decodo e riprova.'
    );
    expect(JSON.stringify(response.body)).not.toContain('private');
  });
});

describe('/api/youtube/research-context', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      AUTH_MODE: 'supabase',
      DECODO_SCRAPING_API_KEY: 'decodo-test-key',
      SUPABASE_JWT_SECRET: 'test-secret',
    };
    youtubeResearchMocks.buildYouTubeResearchBundle.mockReset();
    youtubeResearchMocks.buildYouTubeResearchOutcome.mockReset();
    youtubeResearchMocks.buildYouTubeResearchOutcome.mockResolvedValue({
      context: 'SOURCE Pixel art',
      rationale: 'Un transcript incluso.',
      videoCandidates: [],
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('uses the shared transcript provider during normal course and lesson research', async () => {
    const response = await request(createApp())
      .post('/api/youtube/research-context')
      .set('Authorization', authHeader('user'))
      .send({
        language: 'Italiano',
        query: 'Luce piani e volume',
      });

    expect(response.status).toBe(200);
    expect(youtubeResearchMocks.buildYouTubeResearchOutcome).toHaveBeenCalledWith(
      'Luce piani e volume',
      'Italiano'
    );
    expect(response.body.videoClipsEnabled).toBe(true);
    expect(response.body.rationale).toBe('Un transcript incluso.');
  });

  test('exposes production discovery failures as gateway errors', async () => {
    youtubeResearchMocks.buildYouTubeResearchOutcome.mockRejectedValueOnce(
      new Error('Decodo request failed')
    );

    const response = await request(createApp())
      .post('/api/youtube/research-context')
      .set('Authorization', authHeader('user'))
      .send({ language: 'Italiano', query: 'Luce piani e volume' });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      error: 'Ricerca YouTube non disponibile. Riprova tra poco.',
      success: false,
    });
  });

  test('enables video clips whenever Decodo is configured', async () => {
    const response = await request(createApp())
      .get('/api/youtube/config')
      .set('Authorization', authHeader('user'));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, videoClipsEnabled: true });
  });
});
