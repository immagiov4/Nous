import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadXrayTrace, renderXrayMarkdown, runXray, validateXrayReview } from './xray.js';
import { reviewRecordedTrace } from './xray-reviewer.js';

vi.mock('./xray-reviewer.js', () => ({ reviewRecordedTrace: vi.fn() }));
const review = {
  findings: [
    {
      exchangeIndex: 0,
      category: 'ambiguity' as const,
      severity: 'medium' as const,
      evidence: 'recorded response',
      explanation: 'Unclear answer.',
      suggestedCorrection: 'Clarify the answer.',
    },
  ],
  evidenceLimits: ['Internal reasoning is absent.'],
};
let directory: string;
const exchange = (startedAt: string, response: string) => ({
  provider: 'codex',
  model: 'configured-model',
  serviceTier: 'normal',
  request: { text: 'prompt' },
  toolCalls: [],
  status: 'completed',
  startedAt,
  response,
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nous-xray-'));
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      runId: 'run',
      scenario: 'test',
      provider: 'codex',
      slots: {},
      git: { commitSha: 'sha', dirty: true },
      startedAt: '2026-10-12T00:00:00Z',
      endedAt: null,
      durationMs: null,
      outcome: 'running',
      errorCode: null,
      measurements: [],
      workflows: [],
      aiUsage: [],
    })
  );
  await writeFile(
    join(directory, 'model-exchanges.jsonl'),
    [
      exchange('2026-10-12T00:00:02Z', 'recorded response'),
      exchange('2026-10-12T00:00:01Z', 'earlier'),
      exchange('2026-10-12T00:00:01Z', 'same time'),
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n')
  );
  vi.mocked(reviewRecordedTrace).mockResolvedValue({
    response: JSON.stringify(review),
    reviewer: { model: 'configured-model', reasoningEffort: 'medium' },
  });
});
afterEach(async () => {
  vi.resetAllMocks();
  await rm(directory, { recursive: true, force: true });
});
describe('X-ray recorded run review', () => {
  it('loads context and reviews every exchange chronologically with stable original references', async () => {
    const report = await runXray(directory);
    const input = JSON.parse(vi.mocked(reviewRecordedTrace).mock.calls[0][0]);
    expect(input.manifest.runId).toBe('run');
    expect(
      input.chronologicalExchanges.map((entry: { exchangeIndex: number }) => entry.exchangeIndex)
    ).toEqual([1, 2, 0]);
    expect(
      input.chronologicalExchanges.map(
        (entry: { exchange: { response: string } }) => entry.exchange.response
      )
    ).toEqual(['earlier', 'same time', 'recorded response']);
    expect(report.status).toBe('reviewed');
    expect(report.reviewerResponse).toBe(JSON.stringify(review));
    expect(JSON.parse(await readFile(join(directory, 'xray.json'), 'utf8')).findings).toEqual(
      review.findings
    );
    expect(await readFile(join(directory, 'xray.md'), 'utf8')).toContain(
      'Exchange 0: ambiguity (medium)'
    );
  });
  it('reviews recorded run/node/attempt groups separately with manifest context and merges references', async () => {
    const identity = { runId: 'workflow-run', nodeInstanceId: 'node', attemptNumber: 1 };
    const entries = [
      { ...exchange('2026-10-12T00:00:04Z', 'recorded response'), workflow: identity },
      {
        ...exchange('2026-10-12T00:00:02Z', 'attempt two'),
        workflow: { ...identity, attemptNumber: 2 },
      },
      { ...exchange('2026-10-12T00:00:01Z', 'first'), workflow: identity },
      exchange('2026-10-12T00:00:03Z', 'unassigned'),
      {
        ...exchange('2026-10-12T00:00:05Z', 'other run'),
        workflow: { ...identity, runId: 'other' },
      },
      {
        ...exchange('2026-10-12T00:00:06Z', 'other node'),
        workflow: { ...identity, nodeInstanceId: 'other' },
      },
      exchange('2026-10-12T00:00:07Z', 'unassigned later'),
    ];
    await writeFile(
      join(directory, 'model-exchanges.jsonl'),
      entries.map(entry => JSON.stringify(entry)).join('\n')
    );
    vi.mocked(reviewRecordedTrace).mockImplementation(async input => {
      const group = JSON.parse(input);
      expect(group.manifest).toEqual((await loadXrayTrace(directory)).manifest);
      const entry = group.chronologicalExchanges[0];
      return {
        response: JSON.stringify({
          ...review,
          findings: [
            {
              ...review.findings[0],
              exchangeIndex: entry.exchangeIndex,
              evidence: entry.exchange.response,
            },
          ],
        }),
        reviewer: { model: 'configured-model', reasoningEffort: 'medium' },
      };
    });
    const report = await runXray(directory);
    expect(
      vi
        .mocked(reviewRecordedTrace)
        .mock.calls.map(([input]) =>
          JSON.parse(input).chronologicalExchanges.map(
            (entry: { exchangeIndex: number }) => entry.exchangeIndex
          )
        )
    ).toEqual([[2, 0], [1], [3, 6], [4], [5]]);
    expect(report.status).toBe('reviewed');
    expect(report.findings.map(finding => finding.exchangeIndex)).toEqual([2, 1, 3, 4, 5]);
    expect(JSON.parse(await readFile(join(directory, 'xray.json'), 'utf8')).findings).toEqual(
      report.findings
    );
    expect(await readFile(join(directory, 'xray.md'), 'utf8')).toContain(
      'Exchange 5: ambiguity (medium)'
    );
    expect(report.nodeReviews.map(node => node.status)).toEqual(Array(5).fill('reviewed'));
  });
  it('continues after a rejected oversized node, retaining findings and exact complete input sizes', async () => {
    const largeResponse = 'é'.repeat(1_048_577);
    const identity = { runId: 'workflow-run', nodeInstanceId: 'large', attemptNumber: 1 };
    await writeFile(
      join(directory, 'model-exchanges.jsonl'),
      [
        { ...exchange('2026-10-12T00:00:01Z', largeResponse), workflow: identity },
        {
          ...exchange('2026-10-12T00:00:02Z', 'recorded response'),
          workflow: { ...identity, nodeInstanceId: 'small' },
        },
      ]
        .map(entry => JSON.stringify(entry))
        .join('\n')
    );
    vi.mocked(reviewRecordedTrace)
      .mockRejectedValueOnce(new Error('Input exceeds the maximum length'))
      .mockResolvedValueOnce({
        response: JSON.stringify({
          ...review,
          findings: [{ ...review.findings[0], exchangeIndex: 1 }],
        }),
        reviewer: { model: 'configured-model', reasoningEffort: 'medium' },
      });
    const report = await runXray(directory);
    const input = vi.mocked(reviewRecordedTrace).mock.calls[0][0];
    expect(JSON.parse(input).chronologicalExchanges[0].exchange.response).toBe(largeResponse);
    expect(report.status).toBe('needs-maintainer');
    expect(report.findings[0].exchangeIndex).toBe(1);
    expect(report.nodeReviews.map(node => node.status)).toEqual(['needs-maintainer', 'reviewed']);
    expect(report.nodeReviews[0]).toMatchObject({
      inputBytes: Buffer.byteLength(input),
      inputCharacters: input.length,
      exchangeIndexes: [0],
    });
    expect(report.inputBytes).toBe(
      vi
        .mocked(reviewRecordedTrace)
        .mock.calls.reduce((sum, [text]) => sum + Buffer.byteLength(text), 0)
    );
    expect(report.evidenceLimits[0]).toContain(
      `${Buffer.byteLength(input)} bytes, ${input.length} characters`
    );
    expect(await readFile(join(directory, 'xray.md'), 'utf8')).toContain(
      'Exchange 1: ambiguity (medium)'
    );
    expect(JSON.parse(await readFile(join(directory, 'xray.json'), 'utf8')).nodeReviews).toEqual(
      report.nodeReviews
    );
  });
  it('rejects a finding referencing a different group even if its quotation exists in the run', async () => {
    await writeFile(
      join(directory, 'model-exchanges.jsonl'),
      [
        {
          ...exchange('2026-10-12T00:00:01Z', 'first'),
          workflow: { runId: 'run', nodeInstanceId: 'first', attemptNumber: 1 },
        },
        exchange('2026-10-12T00:00:02Z', 'recorded response'),
      ]
        .map(entry => JSON.stringify(entry))
        .join('\n')
    );
    vi.mocked(reviewRecordedTrace).mockResolvedValue({
      response: JSON.stringify({
        ...review,
        findings: [{ ...review.findings[0], exchangeIndex: 1 }],
      }),
      reviewer: { model: 'configured-model', reasoningEffort: 'medium' },
    });
    const report = await runXray(directory);
    expect(report.status).toBe('needs-maintainer');
    expect(report.nodeReviews.map(node => node.status)).toEqual(['needs-maintainer', 'reviewed']);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].exchangeIndex).toBe(1);
  });
  it('validates the strict output and rejects invalid categories, severity, empty evidence and extra fields', async () => {
    const trace = await loadXrayTrace(directory);
    expect(validateXrayReview(review, trace)).toEqual(review);
    for (const change of [
      { category: 'other' },
      { severity: 'urgent' },
      { evidence: '' },
      { invented: true },
    ]) {
      expect(() =>
        validateXrayReview({ ...review, findings: [{ ...review.findings[0], ...change }] }, trace)
      ).toThrow();
    }
    expect(() => validateXrayReview({ ...review, evidenceLimits: [] }, trace)).toThrow();
  });
  it('rejects invented references and quotations from another exchange', async () => {
    const trace = await loadXrayTrace(directory);
    for (const change of [
      { exchangeIndex: 9 },
      { evidence: 'invented quotation' },
      { evidence: 'earlier' },
    ]) {
      expect(() =>
        validateXrayReview({ ...review, findings: [{ ...review.findings[0], ...change }] }, trace)
      ).toThrow();
    }
  });
  it.each([
    '"request":{"text":"prompt"}',
    String.raw`first\nsecond`,
    '"toolCalls":[]',
    'completed","startedAt',
  ])('persists needs-maintainer for serialization-only evidence %s', async evidence => {
    await writeFile(
      join(directory, 'model-exchanges.jsonl'),
      JSON.stringify(exchange('2026-10-12T00:00:02Z', 'recorded response\nfirst\nsecond'))
    );
    vi.mocked(reviewRecordedTrace).mockResolvedValue({
      response: JSON.stringify({ ...review, findings: [{ ...review.findings[0], evidence }] }),
      reviewer: { model: 'configured-model', reasoningEffort: 'medium' },
    });
    const report = await runXray(directory);
    expect(report.status).toBe('needs-maintainer');
    expect(report.findings).toEqual([]);
    expect(JSON.parse(await readFile(join(directory, 'xray.json'), 'utf8')).status).toBe(
      'needs-maintainer'
    );
  });
  it.each([
    'first\nsecond',
    String.raw`nested "quote" with \ path`,
    'tool result',
  ])('accepts exact recorded string evidence %s', async evidence => {
    await writeFile(
      join(directory, 'model-exchanges.jsonl'),
      JSON.stringify({
        ...exchange('2026-10-12T00:00:02Z', 'first\nsecond'),
        request: { messages: [{ text: String.raw`nested "quote" with \ path` }] },
        toolCalls: [{ result: { content: ['tool result'] } }],
      })
    );
    const trace = await loadXrayTrace(directory);
    const quotedReview = { ...review, findings: [{ ...review.findings[0], evidence }] };
    expect(validateXrayReview(quotedReview, trace)).toEqual(quotedReview);
  });
  it.each([
    'xray.json',
    'xray.md',
  ])('refuses to overwrite existing %s before calling the model', async filename => {
    await writeFile(join(directory, filename), 'existing review');
    await expect(runXray(directory)).rejects.toThrow();
    expect(await readFile(join(directory, filename), 'utf8')).toBe('existing review');
    expect(reviewRecordedTrace).not.toHaveBeenCalled();
  });
  it('escapes model text in Markdown as inert text', () => {
    const attack = '![image](https://example.test) <script>alert(1)</script>\n# forged heading';
    const markdown = renderXrayMarkdown({
      ...review,
      findings: [
        {
          ...review.findings[0],
          evidence: attack,
          explanation: attack,
          suggestedCorrection: attack,
        },
      ],
      evidenceLimits: [attack],
      status: 'reviewed',
      runId: attack,
      sourceBytes: 1,
      inputBytes: 1,
      exchangeCount: 1,
      durationMs: 1,
      reviewer: null,
      failure: null,
      reviewerResponse: null,
      nodeReviews: [],
    });
    expect(markdown).not.toContain('<script>');
    expect(markdown).not.toContain('\n# forged heading');
    expect(markdown).not.toContain('![image]');
    expect(markdown.match(/&lt;script&gt;/g)).toHaveLength(5);
    expect(markdown).toContain('&#10;');
  });
  it('persists reviewer failure messages, causes and provider diagnostics in the run directory', async () => {
    const providerError = new APICallError({
      message: 'Provider rejected the schema',
      url: 'https://provider.example/review',
      requestBodyValues: {},
      statusCode: 400,
      responseBody: '{"error":{"message":"Unsupported schema"}}',
      data: { error: { code: 'invalid_schema' } },
      cause: new Error('Schema validation failed'),
    });
    vi.mocked(reviewRecordedTrace).mockRejectedValue(
      new Error('Review failed', { cause: providerError })
    );
    await runXray(directory);
    const saved = JSON.parse(await readFile(join(directory, 'xray.json'), 'utf8'));
    expect(saved.nodeReviews[0].failureDiagnostic).toMatchObject({
      originalMessage: 'Review failed',
      cause: {
        originalMessage: 'Provider rejected the schema',
        status: 400,
        providerResponse: '{"error":{"message":"Unsupported schema"}}',
        cause: { originalMessage: 'Schema validation failed' },
      },
    });
    expect(saved.status).toBe('needs-maintainer');
    expect(await readFile(join(directory, 'xray.md'), 'utf8')).toContain(String.raw`xray\.json`);
  });
  it('redacts credentials from persisted reviewer failure diagnostics', async () => {
    vi.mocked(reviewRecordedTrace).mockRejectedValue(
      new Error('Review failed: api_key=outer-secret', {
        cause: new APICallError({
          message: 'Rejected Bearer provider-secret',
          url: 'https://user:url-secret@provider.example/review?token=query-secret',
          requestBodyValues: { apiKey: 'request-secret' },
          statusCode: 401,
          responseBody: JSON.stringify({
            error: {
              message: 'Unauthorized',
              api_key: 'body-secret',
              authorization: 'Bearer body-token',
            },
          }),
          data: { error: { code: 'unauthorized' } },
          cause: new Error('password=cause-secret'),
        }),
      })
    );
    await runXray(directory);
    const json = await readFile(join(directory, 'xray.json'), 'utf8');
    const markdown = await readFile(join(directory, 'xray.md'), 'utf8');
    expect(JSON.parse(json).nodeReviews[0].failureDiagnostic).toMatchObject({
      originalMessage: 'Review failed: api_key=[REDACTED]',
      cause: {
        originalMessage: 'Rejected Bearer [REDACTED]',
        status: 401,
        providerResponse: JSON.stringify({
          error: { message: 'Unauthorized', api_key: '[REDACTED]', authorization: '[REDACTED]' },
        }),
        cause: { originalMessage: 'password=[REDACTED]' },
      },
    });
    for (const secret of [
      'outer-secret',
      'provider-secret',
      'url-secret',
      'query-secret',
      'request-secret',
      'body-secret',
      'body-token',
      'cause-secret',
    ]) {
      expect(json + markdown).not.toContain(secret);
    }
  });
  it('preserves measured size and needs-maintainer when the provider rejects the complete input', async () => {
    vi.mocked(reviewRecordedTrace).mockRejectedValue(new Error('contextWindowExceeded'));
    const report = await runXray(directory);
    expect(report.status).toBe('needs-maintainer');
    expect(report.findings).toEqual([]);
    expect(report.inputBytes).toBe(
      Buffer.byteLength(vi.mocked(reviewRecordedTrace).mock.calls[0][0])
    );
    expect(report.sourceBytes).toBe(
      Buffer.byteLength(await readFile(join(directory, 'manifest.json'))) +
        Buffer.byteLength(await readFile(join(directory, 'model-exchanges.jsonl')))
    );
    expect(JSON.parse(await readFile(join(directory, 'xray.json'), 'utf8')).status).toBe(
      'needs-maintainer'
    );
  });
});
