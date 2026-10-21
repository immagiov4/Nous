import { describe, expect, test } from 'vitest';
import { validateChangeReport } from './github-body.mjs';

const pr =
  '**Problem:** Readers wait.\n\n**Approach:** Remove duplicate work.\n\n**Result:** Not measured.\n\n## Testing\n\nFocused checks passed.\n';
const codes = (body: string) => validateChangeReport(body).map(entry => entry.code);

describe('change report shape', () => {
  test('requires labelled openings and Testing for PRs', () => {
    expect(codes(pr)).toEqual([]);
    expect(codes(`${pr}\n## Sonar merge decision\n\nPending.`)).toContain('sonar-section');
    expect(codes('## Summary\n\nDense technical prose.\n')).toContain('opening');
    expect(codes(pr.replace('**Approach:**', '**Result:**'))).toContain('opening');
    expect(codes(pr.replace('## Testing', '## Checks'))).toContain('testing');
    expect(codes(`<!-- instructions -->\n\n${pr}`)).toEqual([]);
    expect(codes(`\`\`\`md\n${pr}\`\`\``)).toContain('opening');
  });
  test('requires evidence inside Result', () => {
    expect(
      codes(
        pr.replace('Not measured.', '[Screenshot][shot]') +
          '\n[shot]: https://example.com/result.png'
      )
    ).toEqual([]);
    const table = '| Before | After |\n| --- | --- |\n| 2 reads | 1 read |';
    expect(codes(pr.replace('Not measured.', `\n\n${table}`))).toEqual([]);
    expect(
      codes(pr.replace('Not measured.', '[Screenshot](https://example.com/result.png)'))
    ).toEqual([]);
    expect(codes(pr.replace('Not measured.', 'Done.'))).toContain('result-evidence');
    expect(codes(`${pr.replace('Not measured.', 'Done.')}\n${table}`)).toContain('result-evidence');
    expect(codes(pr.replace('Not measured.', '`Not measured`'))).toContain('result-evidence');
  });
  test('omits nested details and comments from the visible-word count', () => {
    expect(
      codes(
        pr +
          '\n<details><summary>Details</summary>\n\n' +
          'word '.repeat(500) +
          '\n<details><summary>More</summary>\n\nnotes\n\n</details>\n\n</details>'
      )
    ).toEqual([]);
    const failures = validateChangeReport(`${pr}\n${'word '.repeat(200)}`);
    expect(failures.find(entry => entry.code === 'visible-word-limit')?.message).toMatch(
      /\d+ visible words.*200/
    );
    expect(codes(`<details>\n\n${pr}\n</details>`)).toContain('opening');
    expect(codes(`${pr}\n<!-- ${'word '.repeat(500)} -->`)).toEqual([]);
  });
});
