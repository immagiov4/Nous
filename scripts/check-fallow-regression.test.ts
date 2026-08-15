import { describe, expect, test } from 'vitest';
import {
  assertNoFallowRegression,
  classifyFallowFindings,
  collectFallowFindings,
  formatFallowComparison,
} from './check-fallow-regression';

const reportWithUnusedExport = (path: string, exportName: string, line = 1) => ({
  total_issues: 1,
  unused_exports: [
    {
      actions: [{ description: 'Remove it', type: 'remove-export' }],
      col: 7,
      export_name: exportName,
      line,
      path,
      span_start: 20,
    },
  ],
  next_steps: [{ id: 'not-a-finding' }],
});

describe('Fallow finding identity', () => {
  test('is stable across source positions and remediation details', () => {
    const first = collectFallowFindings(reportWithUnusedExport('src/example.ts', 'unused', 3));
    const second = collectFallowFindings({
      ...reportWithUnusedExport('src/example.ts', 'unused', 30),
      unused_exports: [
        {
          actions: [{ description: 'Different wording', type: 'suppress-line' }],
          col: 20,
          export_name: 'unused',
          line: 30,
          path: 'src/example.ts',
          span_start: 500,
        },
      ],
    });

    expect(second).toEqual(first);
  });

  test('preserves order when an array is part of the finding identity', () => {
    const first = collectFallowFindings({
      circular_dependencies: [{ cycle: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }],
      total_issues: 1,
    });
    const second = collectFallowFindings({
      circular_dependencies: [{ cycle: ['src/a.ts', 'src/c.ts', 'src/b.ts'] }],
      total_issues: 1,
    });

    expect(second[0]?.fingerprint).not.toBe(first[0]?.fingerprint);
  });

  test('detects a one-for-one replacement that leaves the total unchanged', () => {
    const baseline = collectFallowFindings(reportWithUnusedExport('src/old.ts', 'oldExport'));
    const current = collectFallowFindings(reportWithUnusedExport('src/new.ts', 'newExport'));

    const comparison = classifyFallowFindings(
      baseline.map(finding => finding.fingerprint),
      current
    );

    expect(comparison.newFindings).toEqual(current);
    expect(comparison.removedFingerprints).toEqual(baseline.map(finding => finding.fingerprint));
    expect(comparison.unchangedFindings).toEqual([]);
    expect(formatFallowComparison(comparison)).toContain('1 new, 1 removed, 0 unchanged');
    expect(() => assertNoFallowRegression(comparison)).toThrow('1 new findings');
  });

  test('classifies repeated identities by occurrence count', () => {
    const current = collectFallowFindings({
      total_issues: 2,
      unresolved_imports: [
        { line: 1, path: 'src/example.ts', specifier: './missing' },
        { line: 2, path: 'src/example.ts', specifier: './missing' },
      ],
    });
    const comparison = classifyFallowFindings([current[0]?.fingerprint ?? ''], current);

    expect(comparison.newFindings).toHaveLength(1);
    expect(comparison.removedFingerprints).toEqual([]);
    expect(comparison.unchangedFindings).toHaveLength(1);
  });

  test('rejects reports whose issue total omits an exposed finding', () => {
    expect(() =>
      collectFallowFindings({
        ...reportWithUnusedExport('src/example.ts', 'unused'),
        total_issues: 0,
      })
    ).toThrow('exposed 1 identifiable findings');
  });
});
