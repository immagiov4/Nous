import { open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as z from 'zod';
import { reviewRecordedTrace } from './xray-reviewer.js';

const text = z.string().regex(/\S/);
export const XrayReviewSchema = z.strictObject({
  findings: z.array(
    z.strictObject({
      exchangeIndex: z.number().int().nonnegative(),
      category: z.enum(['ambiguity', 'inefficiency', 'error', 'unexpected-reasoning']),
      severity: z.enum(['low', 'medium', 'high']),
      evidence: text,
      explanation: text,
      suggestedCorrection: text,
    })
  ),
  evidenceLimits: z.array(text).min(1),
});
const { $schema: _dialect, ...outputSchema } = XrayReviewSchema.toJSONSchema();
type Review = z.infer<typeof XrayReviewSchema>;
const ManifestSchema = z.looseObject({
  runId: text,
  scenario: text,
  provider: text,
  slots: z.record(z.string(), z.unknown()),
  git: z.strictObject({ commitSha: text, dirty: z.boolean() }),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  outcome: z.enum(['running', 'passed', 'failed']),
  errorCode: z.string().nullable(),
  measurements: z.array(z.unknown()),
  workflows: z.array(z.unknown()),
  aiUsage: z.array(z.unknown()),
});
const ExchangeSchema = z.looseObject({
  provider: z.enum(['codex', 'openrouter']),
  model: text,
  serviceTier: text,
  request: z.unknown(),
  response: z.string().optional(),
  toolCalls: z.array(z.unknown()),
  status: text,
  startedAt: z.iso.datetime(),
});

/** Retain original line indexes as references; equal timestamps preserve capture order. */
export const loadXrayTrace = async (directory: string) => {
  const [manifestText, exchangesText] = await Promise.all([
    readFile(join(directory, 'manifest.json'), 'utf8'),
    readFile(join(directory, 'model-exchanges.jsonl'), 'utf8'),
  ]);
  const manifest = ManifestSchema.parse(JSON.parse(manifestText));
  const exchanges = exchangesText
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map((line, exchangeIndex) => ({
      exchangeIndex,
      exchange: ExchangeSchema.parse(JSON.parse(line)),
    }))
    .toSorted(
      (left, right) => Date.parse(left.exchange.startedAt) - Date.parse(right.exchange.startedAt)
    );
  if (!exchanges.length) throw new Error('The run contains no recorded exchanges.');
  return {
    manifest,
    exchanges,
    sourceBytes: Buffer.byteLength(manifestText) + Buffer.byteLength(exchangesText),
  };
};
type Trace = Awaited<ReturnType<typeof loadXrayTrace>>;

const recordedStrings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(recordedStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(recordedStrings);
  return [];
};

/** Reject invented exchange references and quotations at the reviewer boundary. */
export const validateXrayReview = (response: unknown, trace: Trace): Review => {
  const review = XrayReviewSchema.parse(response);
  const exchanges = new Map(trace.exchanges.map(entry => [entry.exchangeIndex, entry.exchange]));
  for (const finding of review.findings) {
    const exchange = exchanges.get(finding.exchangeIndex);
    if (!exchange) throw new Error('Review references an unrecorded exchange.');
    const evidence = recordedStrings(exchange);
    if (!evidence.some(record => record.includes(finding.evidence))) {
      throw new Error('Review evidence is not quoted from the referenced exchange.');
    }
  }
  return review;
};

interface XrayReport extends Review {
  status: 'reviewed' | 'needs-maintainer';
  runId: string;
  sourceBytes: number;
  inputBytes: number;
  exchangeCount: number;
  durationMs: number;
  reviewer: { model: string; reasoningEffort: string } | null;
  failure: string | null;
  reviewerResponse: string | null;
}
const escapeMarkdown = (value: string): string =>
  value
    .replaceAll(/[\\`*_{}[\]()#+.!|~:-]/g, String.raw`\$&`)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\n', '&#10;');

/** Model text is inert even when it contains HTML, Markdown links or new headings. */
export const renderXrayMarkdown = (report: XrayReport): string => {
  const reviewerDescription = report.reviewer
    ? `${report.reviewer.model} (${report.reviewer.reasoningEffort})`
    : 'unavailable';
  return [
    '# X-ray review',
    '',
    `Run: ${escapeMarkdown(report.runId)}`,
    '',
    `Status: ${report.status}`,
    '',
    `Exchanges: ${report.exchangeCount}; source bytes: ${report.sourceBytes}; input bytes: ${report.inputBytes}; review duration: ${report.durationMs} ms.`,
    '',
    `Reviewer: ${escapeMarkdown(reviewerDescription)}`,
    '',
    ...(report.failure ? [`Failure: ${escapeMarkdown(report.failure)}`, ''] : []),
    '## Findings',
    '',
    ...(report.findings.length
      ? report.findings.flatMap(finding => [
          `### Exchange ${finding.exchangeIndex}: ${finding.category} (${finding.severity})`,
          '',
          `Evidence: ${escapeMarkdown(finding.evidence)}`,
          '',
          `Explanation: ${escapeMarkdown(finding.explanation)}`,
          '',
          `Suggested correction: ${escapeMarkdown(finding.suggestedCorrection)}`,
          '',
        ])
      : ['No supported findings recorded.', '']),
    '## Evidence limits',
    '',
    ...report.evidenceLimits.map(limit => `- ${escapeMarkdown(limit)}`),
    '',
  ].join('\n');
};

/** Exclusive reservations prevent concurrent or partial reviews from being overwritten. */
const reserveReviewFiles = async (directory: string) => {
  const jsonPath = join(directory, 'xray.json');
  const json = await open(jsonPath, 'wx');
  try {
    return { json, markdown: await open(join(directory, 'xray.md'), 'wx') };
  } catch (error) {
    await json.close();
    await unlink(jsonPath);
    throw error;
  }
};

export const runXray = async (directory: string): Promise<XrayReport> => {
  const trace = await loadXrayTrace(directory);
  const input = JSON.stringify({
    manifest: trace.manifest,
    chronologicalExchanges: trace.exchanges,
  });
  const files = await reserveReviewFiles(directory);
  const started = performance.now();
  const report: XrayReport = {
    status: 'needs-maintainer',
    runId: trace.manifest.runId,
    sourceBytes: trace.sourceBytes,
    inputBytes: Buffer.byteLength(input),
    exchangeCount: trace.exchanges.length,
    durationMs: 0,
    reviewer: null,
    failure: null,
    reviewerResponse: null,
    findings: [],
    evidenceLimits: [],
  };
  try {
    try {
      const result = await reviewRecordedTrace(input, outputSchema);
      report.reviewer = result.reviewer;
      report.reviewerResponse = result.response;
      Object.assign(report, validateXrayReview(JSON.parse(result.response), trace));
      report.status = 'reviewed';
    } catch (error) {
      console.error('X-ray reviewer failed.', error);
      report.failure = error instanceof Error ? error.name : 'UnknownError';
      report.evidenceLimits = [
        'The reviewer did not return a valid complete review. No findings can be concluded. The complete measured input was prepared without truncation; provider context rejection requires a maintainer decision. See the command diagnostic for the failure.',
      ];
    }
    report.durationMs = performance.now() - started;
    await files.json.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await files.markdown.writeFile(renderXrayMarkdown(report));
    return report;
  } finally {
    await Promise.all([files.json.close(), files.markdown.close()]);
  }
};

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const args = process.argv.slice(2).filter(argument => argument !== '--');
  if (args.length !== 1) throw new Error('Usage: bun run xray -- <run-directory>');
  const report = await runXray(resolve(args[0]));
  console.log(
    `X-ray: ${report.status}; ${report.findings.length} findings; ${report.evidenceLimits.length} evidence limits.`
  );
  if (report.status === 'needs-maintainer') process.exitCode = 1;
}
