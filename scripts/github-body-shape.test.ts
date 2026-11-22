import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import geppettoConfig from '../.geppetto/config.json';
import { validateChangeReport } from './github-body.mjs';

const pr =
  '**Problem:** Readers wait.\n\n**Approach:** Remove duplicate work.\n\n**Result:** Not measured.\n\n## Testing\n\nFocused checks passed.\n';
const codes = (body: string) => validateChangeReport(body).map(entry => entry.code);

describe('change report shape', () => {
  // Expected: fewer heading mismatches between the PR template and Write PR.
  // Cost: one more file to update when renaming either PR section.
  test('the pull request template uses the exact headings documented by Write PR', () => {
    const template = readFileSync('.github/pull_request_template.md', 'utf8');
    const instructions = readFileSync('.agents/skills/write-pr/SKILL.md', 'utf8');
    const headings = template.split(/\r?\n/u).filter(line => line.startsWith('## '));

    expect(headings).toEqual(['## 👁️ Inspectability', '## 🧪 Testing']);
    for (const heading of headings) {
      expect(instructions).toContain(`Include \`${heading}\``);
    }
  });

  // Expected: fewer feature pages whose Observability heading differs from the config.
  // Cost: one more file to update when renaming the configured section.
  test('feature pages use the exact configured Observability heading', () => {
    const { root } = geppettoConfig.docs;
    const [heading] = geppettoConfig.sections.featureDocs;
    expect(heading).toBe('👁️ Observability');

    const pages = readdirSync(root)
      .filter(name => name.endsWith('.md'))
      .sort();
    for (const page of pages) {
      const lines = readFileSync(join(root, page), 'utf8').split(/\r?\n/u);
      expect(lines, page).toContain(`## ${heading}`);
    }
  });

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
  test('accepts reference screenshots and counts their visible alt text', () => {
    const screenshot = pr.replace('Not measured.', '![Updated layout][shot]');
    const definition = '\n[shot]: https://example.com/result.png';
    expect(codes(screenshot + definition)).toEqual([]);
    expect(codes(screenshot.replace('Updated layout', 'word '.repeat(200)) + definition)).toContain(
      'visible-word-limit'
    );
  });
  test('accepts emoji headings and a final impact section', () => {
    const decorated = pr.replace(
      '## Testing',
      '## 👁️ Inspectability\n\nOpen the reader trace.\n\n## 🧪 Testing'
    );
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
