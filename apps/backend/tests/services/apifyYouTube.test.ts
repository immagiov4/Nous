import { afterEach, describe, expect, test, vi } from 'vitest';
import { isResearchProviderUnavailable } from '../../src/services/researchProviderAvailability.js';
import {
  ApifyYouTubeProvider,
  buildYouTubeResearchDiagnostic,
} from '../../src/services/youtubeResearch.js';
import { readRetryAfterMs } from '../../src/workflows/retryPolicy.js';
import items from './fixtures/apify-youtube-items.json';

// Recorded public trial for #508, 2026-11-01; segments shortened to two per video.
describe('Apify lesson research', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('collects candidates, timed captions and engagement in one Actor run', async () => {
    vi.stubEnv('APIFY_TOKEN', 'secret');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify(
            String(url).includes('/items')
              ? items
              : {
                  data: { id: 'trial', status: 'SUCCEEDED', defaultDatasetId: 'dataset' },
                }
          )
        );
      })
    );
    const result = await buildYouTubeResearchDiagnostic('photosynthesis explained', 'Italiano');
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/acts/tubetext~youtube-transcript-fast/runs');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      searchQueries: ['photosynthesis explained'],
      searchSortBy: 'relevance',
      searchPublishedWithin: 'any',
      maxVideosPerSource: 6,
      languages: ['it', 'en'],
      preferManualCaptions: true,
      includeSegments: true,
      includeTimestampedText: false,
      aiFallback: false,
    });
    expect(calls[0].init?.headers).toMatchObject({ Authorization: 'Bearer secret' });
    expect(result.candidates.map(item => item.id)).toEqual(items.map(item => item.videoId));
    expect(result.candidates.map(item => item.transcript?.kind)).toEqual([
      'translated',
      'manual',
      'automatic',
      'automatic',
      'manual',
      'manual',
    ]);
    expect(result.bundle.videoCandidates).toHaveLength(6);
    expect(result.bundle.videoCandidates[0]).toMatchObject({
      viewCount: items[0].viewCount,
      likeCount: items[0].likeCount,
    });
    expect(result.bundle.videoCandidates[0].segments[0]).toMatchObject({
      startSeconds: Math.floor(items[0].segments[0].start),
      endSeconds: Math.ceil(items[0].segments[0].start + items[0].segments[0].duration),
      text: items[0].segments[0].text.trim(),
    });
    expect(result.operations).toMatchObject({
      discoveryRequests: 1,
      transcriptRequests: 0,
      transcriptLookups: 6,
    });
  });

  test.each([
    { type: 'monthly-usage-hard-limit-reached', status: 403 },
    { type: 'not-enough-usage-to-run-paid-actor', status: 403 },
    { type: 'x402-payment-required', status: 402 },
  ])('keeps payment refusal $type distinct from a successful empty search', async ({
    type,
    status,
  }) => {
    vi.stubEnv('APIFY_TOKEN', 'secret');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                type,
                message: 'private query secret account details',
              },
            }),
            { status }
          )
      )
    );
    const failure = await buildYouTubeResearchDiagnostic('private query', 'Italiano').catch(
      error => error
    );
    expect(failure).toMatchObject({
      code:
        status === 402
          ? 'youtube_provider_payment_required'
          : 'youtube_provider_allowance_exhausted',
      status,
    });
    expect(JSON.stringify(failure)).not.toContain('private query');
    expect(JSON.stringify(failure)).not.toContain('secret');
  });
  test('keeps language variants and excludes out-of-language evidence from clips and context', async () => {
    vi.stubEnv('APIFY_TOKEN', 'secret');
    const variant = { ...items[0], language: 'en-GB' };
    const unrelated = { ...items[1], language: 'de' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        Response.json(
          url.includes('/items')
            ? [variant, unrelated]
            : { data: { id: 'trial', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } }
        )
      )
    );

    const diagnostic = await buildYouTubeResearchDiagnostic('photosynthesis', 'Italiano');

    expect(diagnostic.limits.playlistResults).toBe(0);
    expect(diagnostic.bundle.videoCandidates.map(item => item.url)).toEqual([variant.url]);
    expect(diagnostic.candidates.map(item => item.decision)).toEqual([
      'context-included',
      'no-transcript',
    ]);
  });

  test('waits for the same run and passes cancellation through every request', async () => {
    const controller = new AbortController();
    const calls: Array<{ url: string; signal?: AbortSignal | null }> = [];
    const provider = new ApifyYouTubeProvider('token', async (url, init) => {
      calls.push({ url: String(url), signal: init?.signal });
      return new Response(
        JSON.stringify(
          calls.length === 1
            ? { data: { id: 'run', status: 'RUNNING' } }
            : calls.length === 2
              ? { data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } }
              : items
        )
      );
    });
    const candidates = await provider.search('photosynthesis', controller.signal);
    expect(candidates).toHaveLength(6);
    expect(calls.map(call => call.url)).toEqual([
      'https://api.apify.com/v2/acts/tubetext~youtube-transcript-fast/runs',
      'https://api.apify.com/v2/actor-runs/run?waitForFinish=60',
      'https://api.apify.com/v2/datasets/dataset/items?clean=true',
    ]);
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(calls.every(call => call.signal === calls[0].signal)).toBe(true);
    expect(candidates[0].availableLanguages).toEqual(items[0].availableLanguages);
    expect(candidates[0]).toMatchObject({
      channelTitle: items[0].channelName,
      durationSeconds: items[0].durationSeconds,
    });
  });

  test('aborts an unfinished Apify run at the 90-second deadline', async () => {
    vi.useFakeTimers();
    const pollStarted = Promise.withResolvers<void>();
    const poll = Promise.withResolvers<Response>();
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/abort')) return Response.json({});
      if (url.includes('/actor-runs/')) {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => poll.reject(signal.reason), { once: true });
        pollStarted.resolve();
        return poll.promise;
      }
      return Response.json({ data: { id: 'running', status: 'RUNNING' } });
    });
    const provider = new ApifyYouTubeProvider('token', fetcher);
    const outcome = provider.search('private query').catch(error => error);
    try {
      await pollStarted.promise;
      await vi.advanceTimersByTimeAsync(89_999);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher).toHaveBeenLastCalledWith(
        'https://api.apify.com/v2/actor-runs/running/abort',
        expect.objectContaining({ method: 'POST' })
      );
      expect(fetcher).toHaveBeenCalledTimes(3);
      const failure = await outcome;
      expect(failure).toMatchObject({ code: 'youtube_provider_deadline_exceeded', status: 504 });
      expect(JSON.stringify(failure)).not.toContain('private query');
    } finally {
      poll.resolve(Response.json({ data: { status: 'ABORTED' } }));
      await outcome;
      vi.useRealTimers();
    }
  });

  const completedDataset = (read: () => Promise<Response>) => {
    const fetcher = vi.fn(async (url: string) =>
      String(url).includes('/items')
        ? read()
        : Response.json({
            data: { id: 'paid', status: 'SUCCEEDED', defaultDatasetId: 'paid-dataset' },
          })
    );
    const provider = new ApifyYouTubeProvider('token', fetcher);
    return { fetcher, provider };
  };

  const paidDatasetUrl = 'https://api.apify.com/v2/datasets/paid-dataset/items?clean=true';
  const startUrl = 'https://api.apify.com/v2/acts/tubetext~youtube-transcript-fast/runs';

  test('retries the same completed dataset after a network error and a 503', async () => {
    vi.useFakeTimers();
    const read = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('network disconnected'))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(Response.json(items));
    const { fetcher, provider } = completedDataset(read);
    const result = provider.search('query').catch(error => error);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await result).toHaveLength(6);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      startUrl,
      paidDatasetUrl,
      paidDatasetUrl,
      paidDatasetUrl,
    ]);
  });

  test.each([
    'seconds',
    'date',
  ])('honors Retry-After in %s on a completed dataset', async format => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T00:00:00Z'));
    const retryAfter = format === 'seconds' ? '7' : new Date(Date.now() + 7_000).toUTCString();
    const read = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response('{}', { status: 429, headers: { 'retry-after': retryAfter } })
      )
      .mockResolvedValueOnce(Response.json(items));
    const { fetcher, provider } = completedDataset(read);
    const result = provider.search('query').catch(error => error);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toHaveLength(6);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      startUrl,
      paidDatasetUrl,
      paidDatasetUrl,
    ]);
  });

  test('backs off exponentially on a 429 without a Retry-After header', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const read = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(new Response('{}', { status: 429 }))
        .mockResolvedValueOnce(new Response('{}', { status: 429 }))
        .mockResolvedValueOnce(Response.json(items));
      const { fetcher, provider } = completedDataset(read);
      const result = provider.search('query').catch(error => error);
      await vi.advanceTimersByTimeAsync(499);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(read).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toHaveLength(6);
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        startUrl,
        paidDatasetUrl,
        paidDatasetUrl,
        paidDatasetUrl,
      ]);
    } finally {
      random.mockRestore();
    }
  });

  test('stops retrying the completed dataset when its next wait would reach the deadline', async () => {
    vi.useFakeTimers();
    const { fetcher, provider } = completedDataset(
      async () => new Response('{}', { status: 429, headers: { 'retry-after': '90' } })
    );
    const result = provider.search('query').catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toMatchObject({ code: 'youtube_provider_deadline_exceeded' });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([startUrl, paidDatasetUrl]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('stops after two additional reads when the completed dataset stays unavailable', async () => {
    vi.useFakeTimers();
    const { fetcher, provider } = completedDataset(async () => new Response('{}', { status: 503 }));
    const result = provider.search('query').catch(error => error);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await result).toMatchObject({
      code: 'youtube_provider_dataset_unavailable',
      status: 503,
      isRetryable: false,
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      startUrl,
      paidDatasetUrl,
      paidDatasetUrl,
      paidDatasetUrl,
    ]);
  });

  test('does not retry a completed dataset HTTP 404', async () => {
    vi.useFakeTimers();
    const { fetcher, provider } = completedDataset(async () => new Response('{}', { status: 404 }));
    await expect(provider.search('query')).rejects.toMatchObject({ status: 404 });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([startUrl, paidDatasetUrl]);
  });

  test('cancels the wait without another read when the caller aborts', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { fetcher, provider } = completedDataset(
      async () => new Response('{}', { status: 429, headers: { 'retry-after': '7' } })
    );
    const result = provider.search('query', controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error('Client disconnected'));
    expect(await result).toMatchObject({ message: 'Client disconnected' });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([startUrl, paidDatasetUrl]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    401, 402, 403, 429, 503,
  ])('preserves HTTP %s and retry headers without caching refusals', async status => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response('{}', {
          status,
          headers: { 'retry-after': '23' },
        })
    );
    const provider = new ApifyYouTubeProvider('token', fetcher);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failure = await provider.getTranscriptDiagnostic('video', ['en']).catch(error => error);
      expect(failure.status).toBe(status);
      expect(readRetryAfterMs(failure)).toBe(23000);
      expect(isResearchProviderUnavailable(failure)).toBe(status === 429 || status >= 500);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test.each([
    'FAILED',
    'ABORTED',
    'TIMED-OUT',
    'unknown',
  ])('rejects run status %s before reading a partial dataset', async status => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { id: 'run', status, defaultDatasetId: 'partial' } }))
      );
    const provider = new ApifyYouTubeProvider('token', fetcher);
    await expect(provider.search('query')).rejects.toMatchObject({
      code: 'youtube_provider_run_failed',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('treats a valid dataset without the requested video as an unavailable lookup', async () => {
    const provider = new ApifyYouTubeProvider('token', async url =>
      Response.json(
        String(url).includes('/items')
          ? [items[0]]
          : { data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } }
      )
    );
    await expect(provider.getTranscriptDiagnostic(items[1].videoId, ['en'])).resolves.toMatchObject(
      {
        transcript: null,
        attempts: [{ outcome: 'unavailable' }],
      }
    );
  });

  // Build 1.0.82's public schema and README document these wire statuses.
  test.each([
    { status: 'error', reason: 'video failed' },
    { status: 'too_long_for_ai', reason: 'video exceeds the AI length limit' },
    { status: 'no_transcript', reason: 'private video' },
    { status: 'no_transcript', reason: 'members-only video' },
    { status: 'no_transcript', reason: 'age-restricted video' },
    { status: 'no_transcript', reason: 'music-only video without captions' },
  ])('keeps five transcripts when $reason returns $status without a title', async ({ status }) => {
    vi.stubEnv('APIFY_TOKEN', 'secret');
    const [first, , ...remaining] = items;
    const validRows = [first, ...remaining];
    const mixedDataset = [
      first,
      { videoId: items[1].videoId, status, title: null, error: 'Private upstream failure details' },
      ...remaining,
    ];
    const fetcher = vi.fn(async (url: string) =>
      Response.json(
        url.includes('/items')
          ? mixedDataset
          : { data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } }
      )
    );
    vi.stubGlobal('fetch', fetcher);

    const diagnostic = await buildYouTubeResearchDiagnostic('photosynthesis', 'Italiano');

    expect(diagnostic.bundle.videoCandidates.map(video => video.url)).toEqual(
      validRows.map(row => row.url)
    );
    expect(diagnostic.bundle.videoCandidates).toHaveLength(5);
    expect(diagnostic.errors).toEqual(['provider-item-unavailable']);
    expect(JSON.stringify(diagnostic)).not.toContain('Private upstream failure details');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test.each([
    { rows: [{}], name: 'empty object' },
    { rows: [{ videoId: 'video-1' }], name: 'missing status' },
    { rows: [{ videoId: 'video-1', status: 'mystery' }], name: 'unknown status' },
    { rows: [{ status: 'error' }], name: 'unavailable status without video ID' },
    { rows: [{ ...items[0], videoId: ' ' }], name: 'blank video ID' },
  ])('rejects $name as a malformed dataset', async ({ rows }) => {
    const unavailable = vi.fn();
    const provider = new ApifyYouTubeProvider('token', async url =>
      Response.json(
        String(url).includes('/items')
          ? rows
          : { data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } }
      )
    );
    await expect(provider.search('query', undefined, unavailable)).rejects.toMatchObject({
      code: 'youtube_provider_invalid_dataset',
    });
    expect(unavailable).not.toHaveBeenCalled();
  });

  test.each([
    [{ ...items[0], segments: [] }],
    { unexpected: 'envelope' },
  ])('rejects invalid dataset rows instead of returning a successful empty result (%#)', async dataset => {
    const provider = new ApifyYouTubeProvider(
      'token',
      async url =>
        new Response(
          JSON.stringify(
            String(url).includes('/items')
              ? dataset
              : { data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } }
          )
        )
    );
    await expect(provider.search('query')).rejects.toThrow();
  });

  test('distinguishes genuine no-result and no-caption responses from refusal', async () => {
    const missing = { ...items[0], status: 'no_transcript', segments: [] };
    let dataset: unknown = [];
    const provider = new ApifyYouTubeProvider(
      'token',
      async url =>
        new Response(
          JSON.stringify(
            String(url).includes('/items')
              ? dataset
              : { data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } }
          )
        )
    );
    await expect(provider.search('no results')).resolves.toEqual([]);
    dataset = [missing];
    await expect(provider.search('no captions')).resolves.toHaveLength(1);
    await expect(
      provider.getTranscriptDiagnostic(missing.videoId, ['it', 'en'])
    ).resolves.toMatchObject({
      cached: true,
      transcript: null,
      attempts: [{ outcome: 'empty' }],
    });
  });

  test.each([
    ['ok', 6 * 60 * 60 * 1000],
    ['no_transcript', 15 * 60 * 1000],
  ] as const)('keeps %s cache lifetime and language identity', async (status, ttl) => {
    vi.useFakeTimers();
    let requests = 0;
    const provider = new ApifyYouTubeProvider('token', async url => {
      requests += 1;
      return new Response(
        JSON.stringify(
          String(url).includes('/items')
            ? [{ ...items[0], status }]
            : { data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } }
        )
      );
    });
    const id = items[0].videoId;
    await provider.getTranscriptDiagnostic(id, ['it', 'en']);
    vi.advanceTimersByTime(ttl - 1);
    expect((await provider.getTranscriptDiagnostic(id, ['it', 'en'])).cached).toBe(true);
    expect(requests).toBe(2);
    await provider.getTranscriptDiagnostic(id, ['en']);
    expect(requests).toBe(4);
    vi.advanceTimersByTime(1);
    expect((await provider.getTranscriptDiagnostic(id, ['it', 'en'])).cached).not.toBe(true);
    expect(requests).toBe(6);
  });

  test('preserves exact provider segment boundaries in the cache', async () => {
    const provider = new ApifyYouTubeProvider(
      'token',
      async url =>
        new Response(
          JSON.stringify(
            String(url).includes('/items')
              ? items
              : { data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } }
          )
        )
    );
    await provider.search('photosynthesis');
    const transcript = await provider.getTranscript(items[0].videoId, ['it', 'en']);
    expect(transcript?.segments).toEqual(
      items[0].segments.map(segment => ({
        startSeconds: segment.start,
        endSeconds: segment.start + segment.duration,
        text: segment.text.trim(),
      }))
    );
  });

  test('normalizes network and response-stream failures without leaking request content', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('private query token'));
    const provider = new ApifyYouTubeProvider('secret', fetcher);
    const failure = await provider.search('private query').catch(error => error);
    expect(isResearchProviderUnavailable(failure)).toBe(true);
    expect(failure.cause).toBeInstanceOf(TypeError);
    expect(JSON.stringify(failure)).not.toContain('private');
    fetcher.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('private stream details'));
            },
          })
        )
    );
    expect(
      isResearchProviderUnavailable(await provider.search('query').catch(error => error))
    ).toBe(true);
    fetcher.mockResolvedValue(new Response('private invalid JSON'));
    await expect(provider.search('query')).rejects.toMatchObject({
      code: 'youtube_provider_invalid_response',
    });
  });

  test('does not cache cancellation or send a pre-cancelled paid request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
    const provider = new ApifyYouTubeProvider('token', fetcher);
    const controller = new AbortController();
    controller.abort(new Error('Cancelled'));
    await expect(
      provider.getTranscriptDiagnostic('video', ['en'], controller.signal)
    ).rejects.toThrow('Cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    const other = new AbortController();
    fetcher.mockImplementation(async () => {
      other.abort(new Error('Disconnected'));
      return new Response('{}');
    });
    await expect(provider.search('query', other.signal)).rejects.toThrow('Disconnected');
  });
  test('requests remote cancellation once a running Actor ID is known', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const provider = new ApifyYouTubeProvider('token', async url => {
      calls.push(String(url));
      if (String(url).includes('/abort')) return new Response('{}');
      if (calls.length === 1)
        return new Response(JSON.stringify({ data: { id: 'running', status: 'RUNNING' } }));
      controller.abort(new Error('Cancelled'));
      throw controller.signal.reason;
    });
    await expect(provider.search('query', controller.signal)).rejects.toThrow('Cancelled');
    expect(calls.at(-1)).toBe('https://api.apify.com/v2/actor-runs/running/abort');
    expect(calls).toHaveLength(3);
  });

  test('does not let a concurrent caption miss replace successful cached evidence', async () => {
    let resolveMiss: ((response: Response) => void) | undefined;
    let datasetRequests = 0;
    const provider = new ApifyYouTubeProvider('token', async url => {
      if (!String(url).includes('/items'))
        return new Response(
          JSON.stringify({ data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } })
        );
      datasetRequests += 1;
      if (datasetRequests === 2)
        return new Promise(resolve => {
          resolveMiss = resolve;
        });
      return new Response(JSON.stringify([items[0]]));
    });
    const success = provider.getTranscriptDiagnostic(items[0].videoId, ['it']);
    const miss = provider.getTranscriptDiagnostic(items[0].videoId, ['it']);
    await success;
    resolveMiss?.(new Response(JSON.stringify([{ ...items[0], status: 'no_transcript' }])));
    await expect(miss).resolves.toMatchObject({ transcript: null });
    await expect(provider.getTranscriptDiagnostic(items[0].videoId, ['it'])).resolves.toMatchObject(
      {
        cached: true,
        transcript: { kind: 'translated' },
      }
    );
    expect(datasetRequests).toBe(2);
  });
});
