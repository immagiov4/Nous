import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    });
    expect(markdown).not.toContain('<script>');
    expect(markdown).not.toContain('\n# forged heading');
    expect(markdown).not.toContain('![image]');
    expect(markdown.match(/&lt;script&gt;/g)).toHaveLength(5);
    expect(markdown).toContain('&#10;');
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
