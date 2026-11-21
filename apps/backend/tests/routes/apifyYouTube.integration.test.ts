import { createServer } from 'node:http';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../../src/index.js';
import { createSupabaseTestToken } from '../helpers/auth.js';
import items from '../services/fixtures/apify-youtube-items.json';

// Public recorded trial dataset; HTTP refusals below are constructed failure fixtures.
describe('Apify research HTTP integration', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('SUPABASE_JWT_SECRET', 'test-secret');
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('APIFY_TOKEN', 'fixture-token');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const authorization = (role: 'user' | 'admin') =>
    `Bearer ${createSupabaseTestToken({ role, secret: 'test-secret' })}`;

  test('delivers real research service evidence and enabled clips through the authenticated endpoint', async () => {
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            String(url).includes('/items')
              ? items
              : { data: { id: 'trial', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } }
          )
        )
    );
    vi.stubGlobal('fetch', fetcher);
    const response = await request(createApp())
      .post('/api/youtube/research-context')
      .set('Authorization', authorization('user'))
      .send({ query: 'photosynthesis explained', language: 'Italiano' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      videoClipsEnabled: true,
      discoveredVideoCount: 6,
    });
    expect(response.body.videoCandidates).toHaveLength(6);
    expect(response.body.context).toContain(items[0].segments[0].text.trim());
    expect(response.body.videoCandidates[0]).toMatchObject({
      likeCount: items[0].likeCount,
      viewCount: items[0].viewCount,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test.each([
    '/research-context',
    '/admin/research-lab',
  ])('delivers a safe allowance failure from the real service at %s', async path => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                type: 'not-enough-usage-to-run-paid-actor',
                message: 'private account token data',
              },
            }),
            { status: 403 }
          )
      )
    );
    const response = await request(createApp())
      .post(`/api/youtube${path}`)
      .set('Authorization', authorization('admin'))
      .send({ query: 'private query', language: 'Italiano' });
    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      success: false,
      code: 'youtube_provider_allowance_exhausted',
      error: 'Ricerca YouTube non disponibile: il credito del servizio è esaurito.',
    });
    expect(JSON.stringify(response.body)).not.toContain('private');
  });
  test.each([
    '/research-context',
    '/admin/research-lab',
  ])('aborts the active Apify run after a client disconnects from %s', async path => {
    const pollStarted = Promise.withResolvers<AbortSignal | null | undefined>();
    const unfinishedPoll = Promise.withResolvers<Response>();
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/abort')) return Response.json({});
      if (url.includes('/actor-runs/')) {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => unfinishedPoll.reject(signal.reason), {
          once: true,
        });
        pollStarted.resolve(signal);
        return unfinishedPoll.promise;
      }
      return Response.json({ data: { id: 'running', status: 'RUNNING' } });
    });
    vi.stubGlobal('fetch', fetcher);
    const server = createServer(createApp());
    const pending = request(server)
      .post(`/api/youtube${path}`)
      .set('Authorization', authorization('admin'))
      .send({ query: 'photosynthesis' });

    try {
      pending.end(() => {});
      const signal = await pollStarted.promise;
      pending.abort();
      await vi.waitFor(() => {
        expect(signal?.aborted).toBe(true);
        expect(fetcher).toHaveBeenLastCalledWith(
          'https://api.apify.com/v2/actor-runs/running/abort',
          expect.objectContaining({ method: 'POST' })
        );
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      pending.abort();
      unfinishedPoll.resolve(Response.json({ data: { status: 'ABORTED' } }));
      server.close();
    }
  });
});
