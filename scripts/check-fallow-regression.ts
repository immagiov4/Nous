import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const BASELINE_PATH = '.fallow-baselines/regression.json';
const FINGERPRINT_SCHEMA_VERSION = 1;
const IGNORED_IDENTITY_FIELDS = new Set(['actions', 'col', 'line', 'span_start', 'specifier_col']);
const NON_FINDING_ARRAYS = new Set(['next_steps']);
export const FALLOW_DEAD_CODE_JSON_COMMAND = [
  'bunx',
  'fallow@3.16.0',
  'dead-code',
  '--format',
  'json',
] as const;

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type FallowFinding = {
  category: string;
  fingerprint: string;
  identity: { [key: string]: JsonValue };
};

type FallowFindingComparison = {
  newFindings: FallowFinding[];
  removedFingerprints: string[];
  unchangedFindings: FallowFinding[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const normalizeIdentityValue = (value: unknown): JsonValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeIdentityValue);
  }

  if (!isRecord(value)) {
    throw new TypeError('Fallow finding contains a non-JSON value.');
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !IGNORED_IDENTITY_FIELDS.has(key))
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, nestedValue]) => [key, normalizeIdentityValue(nestedValue)])
  );
};

const fingerprintFinding = (category: string, identity: { [key: string]: JsonValue }): string =>
  `${category}:${createHash('sha256')
    .update(JSON.stringify({ category, identity }))
    .digest('hex')}`;

const compareFindings = (left: FallowFinding, right: FallowFinding) => {
  const categoryOrder = compareText(left.category, right.category);
  return categoryOrder || compareText(left.fingerprint, right.fingerprint);
};

export const collectFallowFindings = (report: unknown): FallowFinding[] => {
  if (
    !isRecord(report) ||
    !Number.isInteger(report.total_issues) ||
    Number(report.total_issues) < 0
  ) {
    throw new TypeError('Fallow did not return a valid dead-code report.');
  }

  const findings: FallowFinding[] = [];
  for (const [category, candidates] of Object.entries(report)) {
    if (!Array.isArray(candidates) || NON_FINDING_ARRAYS.has(category)) continue;

    for (const candidate of candidates) {
      const identity = normalizeIdentityValue(candidate);
      if (!isRecord(identity) || Object.keys(identity).length === 0) {
        throw new TypeError(`Fallow returned an invalid ${category} finding.`);
      }
      findings.push({ category, fingerprint: fingerprintFinding(category, identity), identity });
    }
  }

  if (findings.length !== report.total_issues) {
    throw new TypeError(
      `Fallow reported ${report.total_issues} issues but exposed ${findings.length} identifiable findings.`
    );
  }

  return findings.sort(compareFindings);
};

export const attachFallowFindingsToBaseline = (baseline: unknown, report: unknown): unknown => {
  if (!isRecord(baseline) || !isRecord(baseline.check)) {
    throw new TypeError('Fallow did not produce a valid regression baseline.');
  }

  const findings = collectFallowFindings(report);
  if (baseline.check.total_issues !== findings.length) {
    throw new TypeError('Fallow baseline and JSON report totals do not match.');
  }

  return {
    ...baseline,
    finding_identity: {
      schema_version: FINGERPRINT_SCHEMA_VERSION,
      finding_fingerprints: findings.map(finding => finding.fingerprint),
    },
  };
};

export const parseFallowBaselineFingerprints = (baseline: unknown): string[] => {
  if (!isRecord(baseline) || !isRecord(baseline.check) || !isRecord(baseline.finding_identity)) {
    throw new TypeError(`Invalid Fallow regression baseline: ${BASELINE_PATH}.`);
  }
  if (
    baseline.finding_identity.schema_version !== FINGERPRINT_SCHEMA_VERSION ||
    !Array.isArray(baseline.finding_identity.finding_fingerprints)
  ) {
    throw new TypeError(`Unsupported Fallow finding identity schema in ${BASELINE_PATH}.`);
  }

  const fingerprints = baseline.finding_identity.finding_fingerprints.map(candidate => {
    if (typeof candidate !== 'string' || !/^[a-z][a-z0-9_]*:[a-f0-9]{64}$/u.test(candidate)) {
      throw new TypeError(`Invalid Fallow finding fingerprint in ${BASELINE_PATH}.`);
    }
    return candidate;
  });

  if (baseline.check.total_issues !== fingerprints.length) {
    throw new TypeError('Fallow baseline total does not match its finding identities.');
  }

  return fingerprints.sort(compareText);
};

export const classifyFallowFindings = (
  baselineFingerprints: readonly string[],
  currentFindings: readonly FallowFinding[]
): FallowFindingComparison => {
  const remainingBaselineCounts = new Map<string, number>();
  for (const fingerprint of baselineFingerprints) {
    remainingBaselineCounts.set(fingerprint, (remainingBaselineCounts.get(fingerprint) ?? 0) + 1);
  }

  const newFindings: FallowFinding[] = [];
  const unchangedFindings: FallowFinding[] = [];
  for (const finding of currentFindings) {
    const remainingCount = remainingBaselineCounts.get(finding.fingerprint) ?? 0;
    if (remainingCount === 0) {
      newFindings.push(finding);
      continue;
    }
    unchangedFindings.push(finding);
    remainingBaselineCounts.set(finding.fingerprint, remainingCount - 1);
  }

  const removedFingerprints: string[] = [];
  for (const fingerprint of baselineFingerprints) {
    const remainingCount = remainingBaselineCounts.get(fingerprint) ?? 0;
    if (remainingCount === 0) continue;
    removedFingerprints.push(fingerprint);
    remainingBaselineCounts.set(fingerprint, remainingCount - 1);
  }

  return { newFindings, removedFingerprints, unchangedFindings };
};

const formatNewFinding = (finding: FallowFinding) =>
  `+ ${finding.fingerprint} ${JSON.stringify(finding.identity)}`;

export const formatFallowComparison = (comparison: FallowFindingComparison): string => {
  const lines = [
    `Fallow findings: ${comparison.newFindings.length} new, ` +
      `${comparison.removedFingerprints.length} removed, ` +
      `${comparison.unchangedFindings.length} unchanged.`,
    ...comparison.newFindings.map(formatNewFinding),
    ...comparison.removedFingerprints.map(fingerprint => `- ${fingerprint}`),
  ];
  return `${lines.join('\n')}\n`;
};

export const assertNoFallowRegression = (comparison: FallowFindingComparison) => {
  if (comparison.newFindings.length > 0) {
    throw new Error(`Fallow regression detected: ${comparison.newFindings.length} new findings.`);
  }
};

const runFallowRegressionCheck = async () => {
  const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as unknown;
  const baselineFingerprints = parseFallowBaselineFingerprints(baseline);

  const fallowProcess = Bun.spawn(FALLOW_DEAD_CODE_JSON_COMMAND, {
    stderr: 'inherit',
    stdout: 'pipe',
  });
  const output = await new Response(fallowProcess.stdout).text();
  const exitCode = await fallowProcess.exited;
  if (exitCode > 1) {
    throw new Error(`Fallow analysis failed with exit code ${exitCode}.`);
  }

  const currentFindings = collectFallowFindings(JSON.parse(output) as unknown);
  const comparison = classifyFallowFindings(baselineFingerprints, currentFindings);
  process.stdout.write(formatFallowComparison(comparison));
  assertNoFallowRegression(comparison);
};

if (import.meta.main) {
  await runFallowRegressionCheck();
}
