import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  assertGitHubRendering,
  updateGitHubBody,
  validateMarkdownBody,
  verifyGitHubBody,
} from './github-body.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true }))
  );
});

const validBody = `## Summary

The body keeps its paragraphs separate.

- First item
- Second item

## Testing

The focused test passed.
`;

const managedCubicDescription = `

<!-- This is an auto-generated description by cubic. -->
<a href="https://cubic.dev/pr/example">Review in Cubic</a>
<!-- End of auto-generated description by cubic. -->
`;

async function createBodyFile(body = validBody): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nous-github-body-'));
  temporaryDirectories.push(directory);
  const bodyFile = join(directory, 'body.md');
  await writeFile(bodyFile, body, 'utf8');
  return bodyFile;
}

describe('GitHub body Markdown validation', () => {
  test('accepts headings, paragraphs, and lists with explicit block boundaries', () => {
    expect(validateMarkdownBody(validBody)).toEqual([]);
  });

  test('rejects literal newline separators from shell-flattened bodies', () => {
    const issues = validateMarkdownBody('## Summary\\nText\\n\\n## Testing\\n- bun run test');

    expect(issues.map(candidate => candidate.code)).toContain('missing-real-newline');
    expect(issues.map(candidate => candidate.code)).toContain('literal-newline');
  });

  test('rejects a single flattened content line even with an editor newline at EOF', () => {
    const issues = validateMarkdownBody('Everything was flattened into one content line.\n');

    expect(issues.map(candidate => candidate.code)).toContain('missing-real-newline');
  });

  test('rejects headings and list items flattened into a paragraph', () => {
    const issues = validateMarkdownBody(
      '## Summary\n\nDescription ## Testing\n\n- [ ] bun run test - [ ] git diff --check\n'
    );

    expect(issues.map(candidate => candidate.code)).toContain('inline-heading');
    expect(issues.map(candidate => candidate.code)).toContain('inline-list');
  });

  test('rejects repeated task items flattened after paragraph text', () => {
    const issues = validateMarkdownBody(
      'Tasks - [ ] run tests - [ ] inspect rendering\n\nSecond content line.\n'
    );

    expect(issues.map(candidate => candidate.code)).toContain('inline-list');
  });

  test('requires a blank line after headings and around list blocks', () => {
    const issues = validateMarkdownBody('## Summary\nText\n- First\nParagraph\n');

    expect(issues.map(candidate => candidate.code)).toEqual([
      'heading-spacing',
      'list-spacing-before',
      'list-spacing-after',
    ]);
  });

  test('allows literal newline notation inside code', () => {
    const body = '## Example\n\nUse `\\n` in a string.\n\n```text\n\\n\n```\n';

    expect(validateMarkdownBody(body)).toEqual([]);
  });

  test('accepts prose punctuation and wrapped list items', () => {
    const body = `## Summary

Node + Bun are supported. The update is safe - it avoids shell interpolation.

- First item
  with a wrapped continuation
- Second item
`;

    expect(validateMarkdownBody(body)).toEqual([]);
  });
});

describe('GitHub body remote update', () => {
  test('uploads from the file, then verifies raw and rendered remote representations', async () => {
    const bodyFile = await createBodyFile();
    const renderedBody =
      '<h2>Summary</h2><p>The body keeps its paragraphs separate.</p>' +
      '<ul><li>First item</li><li>Second item</li></ul>' +
      '<h2>Testing</h2><p>The focused test passed.</p>';
    const runGhCommand = vi
      .fn<(args: string[]) => Promise<string>>()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(
        JSON.stringify({ body: validBody + managedCubicDescription, body_html: renderedBody })
      );

    await expect(
      updateGitHubBody({
        bodyFile,
        kind: 'pr',
        number: 42,
        repository: 'immagiov4/Nous',
        runGhCommand,
      })
    ).resolves.toEqual({
      endpoint: 'repos/immagiov4/Nous/pulls/42',
      htmlLength: renderedBody.length,
    });

    expect(runGhCommand).toHaveBeenNthCalledWith(1, [
      'api',
      'repos/immagiov4/Nous/pulls/42',
      '--method',
      'PATCH',
      '--header',
      'X-GitHub-Api-Version: 2022-11-28',
      '--field',
      `body=@${resolve(bodyFile)}`,
      '--silent',
    ]);
    const readCommand = [
      'api',
      'repos/immagiov4/Nous/pulls/42',
      '--method',
      'GET',
      '--header',
      'Accept: application/vnd.github.full+json',
      '--header',
      'X-GitHub-Api-Version: 2022-11-28',
    ];
    expect(runGhCommand).toHaveBeenNthCalledWith(2, readCommand);

    const verifyGhCommand = vi
      .fn<(args: string[]) => Promise<string>>()
      .mockResolvedValue(JSON.stringify({ body: validBody, body_html: renderedBody }));
    await verifyGitHubBody({
      bodyFile,
      kind: 'pr',
      number: 42,
      repository: 'immagiov4/Nous',
      runGhCommand: verifyGhCommand,
    });
    expect(verifyGhCommand).toHaveBeenCalledTimes(1);
    expect(verifyGhCommand).toHaveBeenCalledWith(readCommand);
  });

  test('does not allow the PR-only Cubic suffix on issue bodies', async () => {
    const bodyFile = await createBodyFile();
    const runGhCommand = vi
      .fn<(args: string[]) => Promise<string>>()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(
        JSON.stringify({
          body: validBody + managedCubicDescription,
          body_html: '<p>Unexpected issue suffix</p>',
        })
      );

    await expect(
      updateGitHubBody({
        bodyFile,
        kind: 'issue',
        number: 7,
        repository: 'immagiov4/Nous',
        runGhCommand,
      })
    ).rejects.toThrow('raw body does not match');
  });

  test('fails when GitHub rendering drops Markdown structure', () => {
    expect(() => assertGitHubRendering(validBody, '<p>Everything became one block.</p>')).toThrow(
      'lost Markdown headings'
    );
  });

  test('fails when GitHub rendering collapses separate paragraphs', () => {
    const body = 'First paragraph.\n\nSecond paragraph.\n';

    expect(() => assertGitHubRendering(body, '<p>First paragraph. Second paragraph.</p>')).toThrow(
      'collapsed paragraphs'
    );
  });
});
