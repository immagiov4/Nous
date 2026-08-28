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

    const bodyWithThematicBreak = 'First paragraph.\n\n- - -\n\nSecond paragraph.\n';
    expect(validateMarkdownBody(bodyWithThematicBreak)).toEqual([]);
    expect(() =>
      assertGitHubRendering(
        bodyWithThematicBreak,
        '<p>First paragraph.</p><hr><p>Second paragraph.</p>'
      )
    ).not.toThrow();

    const setextBody = 'Title\n=====\n\nParagraph.\n';
    expect(validateMarkdownBody(setextBody)).toEqual([]);
    expect(() =>
      assertGitHubRendering(setextBody, '<h1>Title</h1><p>Paragraph.</p>')
    ).not.toThrow();
    expect(() => assertGitHubRendering(setextBody, '<p>Title Paragraph.</p>')).toThrow(
      /lost Markdown headings/u
    );
    const multilineSetextBody = 'First heading line\nsecond heading line\n---\n\nParagraph.\n';
    expect(() =>
      assertGitHubRendering(
        multilineSetextBody,
        '<h2>First heading line second heading line</h2><p>Paragraph.</p>'
      )
    ).not.toThrow();
  });

  test('rejects literal newline separators from shell-flattened bodies', () => {
    const issues = validateMarkdownBody('## Summary\\nText\\n\\n## Testing\\n- bun run test');

    expect(issues.map(candidate => candidate.code)).toContain('missing-real-newline');
    expect(issues.map(candidate => candidate.code)).toContain('literal-newline');
    expect(validateMarkdownBody('## Summary\n\nUse C:\\new\\file as an example.\n')).toEqual([]);
    expect(validateMarkdownBody('## Summary\n\nUse docs\\new\\file as an example.\n')).toEqual([]);
    expect(
      validateMarkdownBody('## Summary\n\nChanged docs\\new\\file\\n## Testing\n\nDone.\n').map(
        candidate => candidate.code
      )
    ).toContain('literal-newline');
    expect(
      validateMarkdownBody(
        '## Summary\n\nfirst paragraph\\nsecond paragraph\n\n## Testing\n\nDone.\n'
      ).map(candidate => candidate.code)
    ).toContain('literal-newline');
    expect(
      validateMarkdownBody('## Summary\n\nSummary:\\ntext\n').map(candidate => candidate.code)
    ).toContain('literal-newline');
  });

  test('rejects a single flattened content line even with an editor newline at EOF', () => {
    const issues = validateMarkdownBody('Everything was flattened into one content line.\n');

    expect(issues.map(candidate => candidate.code)).toContain('missing-real-newline');
    expect(
      validateMarkdownBody('<!-- one -->\n<!-- two -->\n').map(candidate => candidate.code)
    ).toContain('missing-real-newline');
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
    expect(
      validateMarkdownBody('Title\n=====\nParagraph\n').map(candidate => candidate.code)
    ).toContain('heading-spacing');
  });

  test('allows literal newline notation inside code', () => {
    const body = '## Example\n\nUse `\\n` in a string.\n\n```text\n\\n\n```\n';

    expect(validateMarkdownBody(body)).toEqual([]);
    expect(validateMarkdownBody('## Example\n\nUse # for headings in prose.\n')).toEqual([]);
    expect(
      validateMarkdownBody('## Example\n\nUse ``text ` marker ## not-a-heading`` safely.\n')
    ).toEqual([]);
    expect(
      validateMarkdownBody('## Example\n\nUse `first line\nDescription ## Not-a-heading` safely.\n')
    ).toEqual([]);
    expect(
      validateMarkdownBody(
        '## Example\n\nCode follows.\n\n    Description ## Not-a-heading\n    \\n\n'
      )
    ).toEqual([]);
    expect(
      validateMarkdownBody(
        '## Example\n\n<details><summary>Why ## Not a heading</summary></details>\n'
      )
    ).toEqual([]);
    expect(
      validateMarkdownBody('## Example\n\n<div>\nDescription ## Not-a-heading\n</div>\n')
    ).toEqual([]);
    expect(
      validateMarkdownBody('## Example\n\n<div>\ntext\n</div>\nDescription ## Not-a-heading\n')
    ).toEqual([]);
    expect(
      validateMarkdownBody(
        '## Example\n\n<div></div>\nDescription ## Not-a-heading\n\nParagraph.\n'
      )
    ).toEqual([]);
    expect(
      validateMarkdownBody(
        '## Example\n\n<span>Label</span> Description ## Testing\n\nParagraph.\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody('## Example\n\n<br> Description ## Testing\n\nParagraph.\n').map(
        candidate => candidate.code
      )
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody(
        '## Example\n\nParagraph\n<span>\nDescription ## Testing\n\nMore.\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody('```text\ncode\n```\n<span>\nDescription ## Not-a-heading\n\nMore.\n')
    ).toEqual([]);
    expect(
      validateMarkdownBody(
        '## Example\n\n<details>\n<summary>More</summary>\n\nDescription ## Testing\n\n</details>\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    expect(validateMarkdownBody('## Example\n\n```text\nsample\n```\n')).toEqual([]);
    expect(validateMarkdownBody('```text\nfirst\nsecond\n```\n')).toEqual([]);
    expect(validateMarkdownBody('<div>\nfirst\nsecond\n</div>\n')).toEqual([]);

    const issues = validateMarkdownBody(
      '## Example\n\nUse `<!--` literally.\n\nDescription ## Testing\n'
    );
    expect(issues.map(candidate => candidate.code)).toContain('inline-heading');
    expect(
      validateMarkdownBody('## Example\n\nNote <!-- ` --> and `text ## Not-a-heading` here.\n')
    ).toEqual([]);
    expect(
      validateMarkdownBody(
        '## Example\n\nNote <!-- ` --> and `<!--` then.\n\nDescription ## Testing\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody(
        '## Example\n\n`closed` <!-- ` --> and `<!--` then.\n\nDescription ## Testing\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody(
        '## Example\n\nUse `ok` <!-- ` --> and `<!--` literal. Description ## Testing\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody(
        '## Example\n\nUse `` ` inner `` <!-- note --> and `<!--` literal. Description ## Testing\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody(
        '## Example\n\nUse `` ` `` <!-- `work` --> then `<!--` literally.\n\nDescription ## Testing\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody(
        '## Example\n\nUse `` ` `` <!-- `work` --> then `text ## Not-a-heading`.\n'
      )
    ).toEqual([]);
    expect(
      validateMarkdownBody(
        '## Example\n\nUse `code\n<!-- still code\nends` here.\n\nDescription ## Testing\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody(
        '## Example\n\nNote <!-- ` --> and `code\n<!-- literal\nends` here.\n\nDescription ## Testing\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody(
        '## Example\n\n<!--\n```\n-->\nUse `code\n<!-- still code\nends` here.\n\nDescription ## Testing\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody(
        '## Example\n\n```\n<!--\n```\nUse `<!--` literally.\n\nDescription ## Testing\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody(
        '## Example\n\n<!--\n```\n-->\nUse `<!--` literally.\n\nDescription ## Testing\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    const unmatchedCodeIssues = validateMarkdownBody(
      '## Example\n\nUse an unmatched ` marker.\n\nDescription ## Testing\n'
    );
    expect(unmatchedCodeIssues.map(candidate => candidate.code)).toContain('inline-heading');

    const commentIssues = validateMarkdownBody(
      '## Example\n\nText.\n\n<!-- open\n```\n`-->`\nDescription ## Testing\n'
    );
    expect(commentIssues.map(candidate => candidate.code)).toContain('inline-heading');
  });

  test('accepts prose punctuation and wrapped list items', () => {
    const body = `## Summary

Node + Bun are supported. The update is safe - it avoids shell interpolation.

- First item
  with a wrapped continuation
- Second item
`;

    expect(validateMarkdownBody(body)).toEqual([]);

    const markerOnlyList = '-\n  First item\n';
    expect(validateMarkdownBody(markerOnlyList)).toEqual([]);
    expect(() =>
      assertGitHubRendering(markerOnlyList, '<ul><li>First item</li></ul>')
    ).not.toThrow();

    const referenceDefinition = '[docs]: https://example.com\n  "Documentation"\n\nSee [docs].\n';
    expect(validateMarkdownBody(referenceDefinition)).toEqual([]);
    expect(() =>
      assertGitHubRendering(
        referenceDefinition,
        '<p>See <a href="https://example.com" title="Documentation">docs</a>.</p>'
      )
    ).not.toThrow();
    const splitReferenceDefinition =
      '[docs]:\n  https://example.com\n  "Documentation"\n\nSee [docs].\n';
    expect(validateMarkdownBody(splitReferenceDefinition)).toEqual([]);
    expect(() =>
      assertGitHubRendering(
        splitReferenceDefinition,
        '<p>See <a href="https://example.com" title="Documentation">docs</a>.</p>'
      )
    ).not.toThrow();

    const blockquotedList = '> - First item\n> - Second item\n';
    expect(validateMarkdownBody('> # Previous heading\n>\n> - [ ] Previous task\n')).toEqual([]);
    expect(() =>
      assertGitHubRendering(
        blockquotedList,
        '<blockquote><ul><li>First item</li><li>Second item</li></ul></blockquote>'
      )
    ).not.toThrow();

    const blockquotedProse = '> ## Heading\n>\n> First paragraph.\n>\n> Second paragraph.\n';
    expect(validateMarkdownBody(blockquotedProse)).toEqual([]);
    expect(() =>
      assertGitHubRendering(
        blockquotedProse,
        '<blockquote><h2>Heading</h2><p>First paragraph.</p><p>Second paragraph.</p></blockquote>'
      )
    ).not.toThrow();
    expect(() =>
      assertGitHubRendering(
        blockquotedProse,
        '<blockquote><p>First paragraph.</p><p>Second paragraph.</p></blockquote>'
      )
    ).toThrow(/lost Markdown headings/u);
    expect(() =>
      assertGitHubRendering(
        '> First paragraph.\n>\n> Second paragraph.\n',
        '<blockquote><p>First paragraph. Second paragraph.</p></blockquote>'
      )
    ).toThrow(/collapsed paragraphs/u);

    const blockquotedCode =
      '> ## Example\n>\n> Code sample follows.\n>\n> ```text\n> \\n\n> Description ## Not-a-heading\n> ```\n';
    expect(validateMarkdownBody(blockquotedCode)).toEqual([]);
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

    const managedBodyFile = await createBodyFile(validBody + managedCubicDescription);
    const verifyManagedGhCommand = vi.fn<(args: string[]) => Promise<string>>().mockResolvedValue(
      JSON.stringify({
        body: validBody + managedCubicDescription,
        body_html: renderedBody,
      })
    );
    await expect(
      verifyGitHubBody({
        bodyFile: managedBodyFile,
        kind: 'pr',
        number: 42,
        repository: 'immagiov4/Nous',
        runGhCommand: verifyManagedGhCommand,
      })
    ).resolves.toEqual({
      endpoint: 'repos/immagiov4/Nous/pulls/42',
      htmlLength: renderedBody.length,
    });

    const plainBodyFile = await createBodyFile(validBody);
    const verifyAppendedGhCommand = vi.fn<(args: string[]) => Promise<string>>().mockResolvedValue(
      JSON.stringify({
        body: validBody + managedCubicDescription,
        body_html: renderedBody,
      })
    );
    await expect(
      verifyGitHubBody({
        bodyFile: plainBodyFile,
        kind: 'pr',
        number: 42,
        repository: 'immagiov4/Nous',
        runGhCommand: verifyAppendedGhCommand,
      })
    ).resolves.toEqual({
      endpoint: 'repos/immagiov4/Nous/pulls/42',
      htmlLength: renderedBody.length,
    });
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
