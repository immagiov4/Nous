import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

    expect(() => assertGitHubRendering('[docs]: /url\n---\n', '<hr>')).not.toThrow();
    expect(() => assertGitHubRendering('***\n---\n', '<hr><hr>')).not.toThrow();
    expect(validateMarkdownBody('[docs]: /url\n---\n\nParagraph.\n')).toEqual([]);
    expect(validateMarkdownBody('***\n---\n')).toEqual([]);
    expect(validateMarkdownBody('Title\n---\nText.\n').map(candidate => candidate.code)).toContain(
      'heading-spacing'
    );
    expect(() => assertGitHubRendering('Title\n---\n', '<p>Title</p><hr>')).toThrow(
      /lost Markdown headings/u
    );
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
    expect(
      validateMarkdownBody('Tasks 123456789. [ ] run tests\n\nSecond content line.\n').map(
        candidate => candidate.code
      )
    ).toContain('inline-list');
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
    expect(validateMarkdownBody('`first line\nsecond line`\n')).toEqual([]);
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
        '## Example\n\n <custom-tag>\nDescription ## Not-a-heading\n\nParagraph.\n'
      )
    ).toEqual([]);
    for (const malformedTag of ['<span/foo>', '<span=foo>', '<span.foo>']) {
      expect(
        validateMarkdownBody(
          `## Example\n\n${malformedTag}\nDescription ## Testing\n\nParagraph.\n`
        ).map(candidate => candidate.code)
      ).toContain('inline-heading');
    }
    expect(
      validateMarkdownBody('## Example\n\n<span =foo>\nDescription ## Testing\n\nParagraph.\n').map(
        candidate => candidate.code
      )
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody(
        '## Example\n\n<custom-tag data-value="<">\nDescription ## Not-a-heading\n\nParagraph.\n'
      )
    ).toEqual([]);
    expect(
      validateMarkdownBody(
        '## Example\n\n<custom-tag data-value=">">\nDescription ## Not-a-heading\n\nParagraph.\n'
      )
    ).toEqual([]);
    expect(
      validateMarkdownBody(
        '## Example\n\n<span data-value=one>  \nDescription ## Not-a-heading\n\nParagraph.\n'
      )
    ).toEqual([]);
    expect(
      validateMarkdownBody(
        '## Example\n\n<x data-value=one/two>\nDescription ## Testing\n\nParagraph.\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody(
        '## Example\n\n<x data-value=one/>\nDescription ## Not-a-heading\n\nParagraph.\n'
      )
    ).toEqual([]);
    expect(
      validateMarkdownBody(
        '## Example\n\n<details>\n<summary>More</summary>\n\nDescription ## Testing\n\n</details>\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    expect(validateMarkdownBody('## Example\n\n```text\nsample\n```\n')).toEqual([]);
    expect(validateMarkdownBody('```text\nfirst\nsecond\n```\n')).toEqual([]);
    expect(validateMarkdownBody('<div>\nfirst\nsecond\n</div>\n')).toEqual([]);
    expect(
      validateMarkdownBody('## Example\n\n<div\nclass="note">\nWhy ## Not-a-heading\n</div>\n')
    ).toEqual([]);
    expect(
      validateMarkdownBody(
        '## Example\n\n<custom-tag\nclass="note">\nDescription ## Testing\n\nParagraph.\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    for (const rawBlock of [
      '<?processing\nWhy ## Not-a-heading?>',
      '<!DECLARATION\nWhy ## Not-a-heading>',
      '<![CDATA[\nWhy ## Not-a-heading]]>',
    ]) {
      expect(validateMarkdownBody(`## Example\n\nParagraph.\n\n${rawBlock}\n`)).toEqual([]);
    }
    expect(
      validateMarkdownBody('```text`\nDescription ## Testing\n\nSecond paragraph.\n').map(
        candidate => candidate.code
      )
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody('```text`\nSummary\\n## Testing\n\nParagraph.\n').map(
        candidate => candidate.code
      )
    ).toContain('literal-newline');

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

    const referenceDefinition =
      '[docs]: https://example.com\n  "Documentation"\n\nSee [docs].\n\nMore context.\n';
    expect(validateMarkdownBody(referenceDefinition)).toEqual([]);
    expect(() =>
      assertGitHubRendering(
        referenceDefinition,
        '<p>See <a href="https://example.com" title="Documentation">docs</a>.</p><p>More context.</p>'
      )
    ).not.toThrow();
    const splitReferenceDefinition =
      '[docs]:\n  https://example.com\n  "Documentation"\n\nSee [docs].\n\nMore context.\n';
    expect(validateMarkdownBody(splitReferenceDefinition)).toEqual([]);
    expect(() =>
      assertGitHubRendering(
        splitReferenceDefinition,
        '<p>See <a href="https://example.com" title="Documentation">docs</a>.</p><p>More context.</p>'
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

    expect(
      validateMarkdownBody('## Links\n\nSee [docs](https://example.com "Why ## this matters").\n')
    ).toEqual([]);
    expect(
      validateMarkdownBody(
        '## Links\n\nSee [docs](https://example.com "Why ## this matters") then Description ## Testing.\n'
      ).map(candidate => candidate.code)
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody(
        '[docs]: https://example.com "Why ## this matters"\n\nSee [docs].\n\nMore context.\n'
      )
    ).toEqual([]);
    expect(
      validateMarkdownBody('See [Why ## this matters][docs].\n\n[docs]: /url\n\nMore context.\n')
    ).toEqual([]);
    expect(
      validateMarkdownBody('See [Why ## this matters](a(b(c)d)e).\n\nMore context.\n')
    ).toEqual([]);
    expect(validateMarkdownBody('See [Why \\] ## this matters](/url).\n\nMore context.\n')).toEqual(
      []
    );
    for (const multilineLink of [
      'See [Why\nDescription ## this matters](/url).\n\nMore context.\n',
      'See [Why ## this matters](\n/url\n).\n\nMore context.\n',
      'See [Why ## this matters](/url\n  "title").\n\nMore context.\n',
      'See [Why\n[id]: Description ## this matters](/url).\n\nMore context.\n',
      'See [Why ## this matters\n2. continuation](/url).\n\nMore context.\n',
      'See [Why ## this matters\n| --- | --- |\ncontinued](/url).\n\nMore context.\n',
    ]) {
      expect(validateMarkdownBody(multilineLink)).toEqual([]);
    }
    expect(
      validateMarkdownBody('See [Why\n\nDescription ## Testing](/url).\n\nMore context.\n').map(
        candidate => candidate.code
      )
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody('Description [x ## Testing](a\\ b)\n\nSecond content line.\n').map(
        candidate => candidate.code
      )
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody('[ab]: /url\n\nDescription [x ## Testing][a\\b]\n\nMore context.\n').map(
        candidate => candidate.code
      )
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody('Description [x ## Testing](not valid)\n\nSecond content line.\n').map(
        candidate => candidate.code
      )
    ).toContain('inline-heading');
    expect(
      validateMarkdownBody('[one]: /one\n[two]: /two\n').map(candidate => candidate.code)
    ).toContain('missing-real-newline');
    expect(
      validateMarkdownBody('[one]: /one\n\nOnly one rendered line.\n').map(
        candidate => candidate.code
      )
    ).toContain('missing-real-newline');
    expect(validateMarkdownBody('```text\n[first]: /one\n[second]: /two\n```\n')).toEqual([]);
    expect(validateMarkdownBody('[one]: not valid\n[two]: also invalid\n')).toEqual([]);
    expect(validateMarkdownBody('[one]: /a(b\n[two]: /c(d\n')).toEqual([]);
    expect(validateMarkdownBody('[id]: /a(b\n  /valid\n\nOnly one rendered line.\n')).toEqual([]);
  });

  test('keeps indented paragraph continuations in the open paragraph', () => {
    const body = 'First line\n    continuation\nthird line\n';

    expect(validateMarkdownBody(body)).toEqual([]);
    expect(() =>
      assertGitHubRendering(body, '<p>First line\ncontinuation\nthird line</p>')
    ).not.toThrow();
    expect(validateMarkdownBody('First line\n\n    code line\n')).toEqual([]);
  });

  test('aggregates repeated heading levels when checking rendered HTML', () => {
    const body = '## One\n\nText.\n\n## Two\n\nText.\n\n### Three\n\nText.\n';

    expect(() => assertGitHubRendering(body, '<h2>One</h2><h3>Three</h3><p>Text.</p>')).toThrow(
      'expected 2 h2, received 1'
    );
  });

  test('counts incomplete HTML-looking text as paragraph content', () => {
    const body = '<custom\ntext\n\nSecond.\n';

    expect(() => assertGitHubRendering(body, '<p>&lt;custom text Second.</p>')).toThrow(
      'expected 2, received 1'
    );
    expect(
      validateMarkdownBody('<custom\n---\nText.\n').map(candidate => candidate.code)
    ).toContain('heading-spacing');
  });
});

describe('GitHub body remote update', () => {
  test('preserves the managed suffix, uploads from a file, then verifies remote raw and HTML', async () => {
    const bodyFile = await createBodyFile();
    const renderedBody =
      '<h2>Summary</h2><p>The body keeps its paragraphs separate.</p>' +
      '<ul><li>First item</li><li>Second item</li></ul>' +
      '<h2>Testing</h2><p>The focused test passed.</p>' +
      '<p><a>Review in Cubic</a></p>';
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
    let uploadedBody = '';
    const runGhCommand = vi.fn<(args: string[]) => Promise<string>>(async args => {
      if (args.includes('PATCH')) {
        const bodyArgument = args.find(argument => argument.startsWith('body=@'));
        if (!bodyArgument) throw new Error('Expected body file argument.');
        uploadedBody = await readFile(bodyArgument.slice('body=@'.length), 'utf8');
        return '';
      }
      return JSON.stringify({
        body: uploadedBody || validBody + managedCubicDescription,
        body_html: renderedBody,
      });
    });

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

    expect(runGhCommand).toHaveBeenNthCalledWith(1, readCommand);
    expect(runGhCommand).toHaveBeenNthCalledWith(2, [
      'api',
      'repos/immagiov4/Nous/pulls/42',
      '--method',
      'PATCH',
      '--header',
      'X-GitHub-Api-Version: 2022-11-28',
      '--field',
      expect.stringMatching(/^body=@.+nous-github-body-upload-.+body\.md$/u),
      '--silent',
    ]);
    expect(runGhCommand).toHaveBeenNthCalledWith(3, readCommand);
    expect(uploadedBody).toBe(validBody + managedCubicDescription);

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

  test('uses the requested body file directly when no managed suffix exists', async () => {
    const bodyFile = await createBodyFile();
    const renderedBody =
      '<h2>Summary</h2><p>The body keeps its paragraphs separate.</p>' +
      '<ul><li>First item</li><li>Second item</li></ul>' +
      '<h2>Testing</h2><p>The focused test passed.</p>';
    const remoteResponse = JSON.stringify({ body: validBody, body_html: renderedBody });
    const runGhCommand = vi
      .fn<(args: string[]) => Promise<string>>()
      .mockResolvedValueOnce(JSON.stringify({ body: null, body_html: null }))
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(remoteResponse);

    await updateGitHubBody({
      bodyFile,
      kind: 'pr',
      number: 42,
      repository: 'immagiov4/Nous',
      runGhCommand,
    });

    expect(runGhCommand.mock.calls[1]?.[0]).toContain(`body=@${bodyFile}`);
  });

  test('keeps the current remote managed suffix when the file contains an older copy', async () => {
    const olderManagedDescription = managedCubicDescription.replace('/example', '/older');
    const bodyFile = await createBodyFile(
      (validBody + olderManagedDescription).replace(/\n/gu, '\r\n')
    );
    const remoteManagedSuffix = `${managedCubicDescription}\n## Summary by Bot\n\nManaged text.\n`;
    const renderedBody =
      '<h2>Summary</h2><p>The body keeps its paragraphs separate.</p>' +
      '<ul><li>First item</li><li>Second item</li></ul>' +
      '<h2>Testing</h2><p>The focused test passed.</p>' +
      '<p><a>Review in Cubic</a></p><h2>Summary by Bot</h2><p>Managed text.</p>';
    let uploadedBody = '';
    const runGhCommand = vi.fn<(args: string[]) => Promise<string>>(async args => {
      if (args.includes('PATCH')) {
        const bodyArgument = args.find(argument => argument.startsWith('body=@'));
        if (!bodyArgument) throw new Error('Expected body file argument.');
        uploadedBody = await readFile(bodyArgument.slice('body=@'.length), 'utf8');
        return '';
      }
      return JSON.stringify({
        body: uploadedBody || validBody + remoteManagedSuffix,
        body_html: renderedBody,
      });
    });

    await updateGitHubBody({
      bodyFile,
      kind: 'pr',
      number: 42,
      repository: 'immagiov4/Nous',
      runGhCommand,
    });

    expect(uploadedBody).toBe(validBody + remoteManagedSuffix);
    expect(uploadedBody).not.toContain('/older');
  });

  test('rejects a pull request passed as an issue before any remote mutation', async () => {
    const bodyFile = await createBodyFile();
    const runGhCommand = vi.fn<(args: string[]) => Promise<string>>().mockResolvedValue(
      JSON.stringify({
        body: validBody,
        body_html: '<p>Pull request body</p>',
        pull_request: { url: 'https://api.github.test/pulls/7' },
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
    ).rejects.toThrow('is a pull request; use --kind pr');
    expect(runGhCommand).toHaveBeenCalledTimes(1);
    expect(runGhCommand.mock.calls[0]?.[0]).toContain('GET');

    await expect(
      verifyGitHubBody({
        bodyFile,
        kind: 'issue',
        number: 7,
        repository: 'immagiov4/Nous',
        runGhCommand,
      })
    ).rejects.toThrow('is a pull request; use --kind pr');
    expect(runGhCommand).toHaveBeenCalledTimes(2);
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
