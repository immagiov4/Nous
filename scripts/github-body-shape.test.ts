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
  test('accepts concise results and optional comparison evidence', () => {
    expect(codes(pr.replace('Not measured.', 'The duplicate request is removed.'))).toEqual([]);
    const table = '| Before | → After |\n| --- | --- |\n| 2 reads | 1 read |';
    expect(codes(pr.replace('Not measured.', `\n\n${table}`))).toEqual([]);
    expect(
      codes(pr.replace('Not measured.', '[Screenshot](https://example.com/result.png)'))
    ).toEqual([]);
    expect(codes(pr.replace('Not measured.', ''))).toContain('result-empty');
    expect(codes(pr.replace('Not measured.', '<!-- add result -->'))).toContain('result-empty');
    expect(
      codes(`${pr.replace('Not measured.', '')}\n<details>\n\nHidden result\n\n</details>`)
    ).toContain('result-empty');
  });
  test('accepts emoji headings and a final impact section', () => {
    const decorated = pr.replace('## Testing', '## 🧪 Testing');
    expect(codes(decorated)).toEqual([]);
    expect(codes(decorated.replace('Focused checks passed.', ''))).toContain('testing');
    expect(
      codes(`${decorated}\n## ⚠️ Merge impact\n\nRestore the database snapshot before reverting.`)
    ).toEqual([]);
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
