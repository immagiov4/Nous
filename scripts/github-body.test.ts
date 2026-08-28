import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  assertGitHubRendering,
  previewGitHubBody,
  updateGitHubBody,
  validateMarkdownBody,
  verifyGitHubBody,
} from './github-body.mjs';

const validBody =
  '## Summary\n\nThe body keeps its paragraphs separate.\n\n- First item\n- Second item\n\n' +
  '## Testing\n\nThe focused test passed.\n';
const validRenderedBody =
  '<h2>Summary</h2><p>The body keeps its paragraphs separate.</p>' +
  '<ul><li>First item</li><li>Second item</li></ul>' +
  '<h2>Testing</h2><p>The focused test passed.</p>';
const managedSuffix =
  '<!-- This is an auto-generated description by cubic. -->\n\nGenerated review context.\n\n' +
  '<!-- End of auto-generated description by cubic. -->\n\n[Review in Cubic](https://www.cubic.dev/)\n';
const managedRenderedBody =
  `${validRenderedBody}<p>Generated review context.</p>` +
  '<p><a href="https://www.cubic.dev/">Review in Cubic</a></p>';
const temporaryDirectories: string[] = [];
const createBodyFile = async (body = validBody) => {
  const directory = await mkdtemp(join(tmpdir(), 'nous-github-body-test-'));
  temporaryDirectories.push(directory);
  const bodyFile = join(directory, 'body.md');
  await writeFile(bodyFile, body, 'utf8');
  return bodyFile;
};
type RunGhCommand = (args: string[]) => Promise<string>;
const prTarget = { kind: 'pr', number: 42, repository: 'immagiov4/Nous' } as const;
const updatePrBody = (bodyFile: string, runGhCommand: RunGhCommand) =>
  updateGitHubBody({ bodyFile, runGhCommand, ...prTarget });
const verifyPrBody = (bodyFile: string, runGhCommand: RunGhCommand) =>
  verifyGitHubBody({ bodyFile, runGhCommand, ...prTarget });
const issueCodes = (body: string) => new Set(validateMarkdownBody(body).map(issue => issue.code));
const expectIssue = (body: string, code: string) => expect(issueCodes(body)).toContain(code);
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});
describe('GitHub body Markdown contract', () => {
  test('accepts explicit blocks while leaving literal notation inside code to Remark', () => {
    const bodyWithCode = `${validBody}
Use \`C:\\new\\notes\` as a documented path.

\`\`\`text
Literal \\n stays inside this example.
\`\`\`
`;
    expect(validateMarkdownBody(bodyWithCode)).toEqual([]);
  });
  test('rejects empty, single-line, and literal-newline bodies', () => {
    expectIssue('', 'empty-body');
    expectIssue('Only one physical line', 'missing-newline');
    expectIssue('Only one physical line\n', 'missing-newline');
    expectIssue('## Summary\n\nText\\n## Testing\\n- item\n\nDone.\n', 'literal-newline');
    expectIssue('## Summary\n\n[Text\\nNext](https://example.com)\n', 'literal-newline');
    expect(validateMarkdownBody('## Summary\n\n[Notes](docs\\new\\notes.md)\n')).toEqual([]);
    expectIssue('## Summary\n\n<details>Text\\nNext</details>\n', 'literal-newline');
  });
  test('uses AST blocks without treating ordinary prose as flattened Markdown', () => {
    const ordinaryProse = `${validBody}
Use # tags in GitHub.
Compare old - new behavior, or use option 1) now.
`;
    expect(validateMarkdownBody(ordinaryProse)).toEqual([]);
    expect(
      validateMarkdownBody('## Summary\n\nFirst <span title="Why ## this matters">label</span>.\n')
    ).toEqual([]);
    const flattened = issueCodes(
      '## Summary\n\nDescription ## Testing - [ ] Next task\n\nMore context.\n'
    );
    expect(flattened).toEqual(new Set(['inline-heading', 'inline-list']));
    expect(validateMarkdownBody('> ## Quoted heading\n>\n> - [ ] Quoted task\n')).toEqual([]);
  });
  test('requires blank boundaries after headings and around top-level lists', () => {
    expectIssue('## Summary\nText.\n', 'heading-spacing');
    const listIssues = issueCodes('Text.\n- First\n- Second\n## Next\n\nDone.\n');
    expect(listIssues).toContain('list-spacing-before');
    expect(listIssues).toContain('list-spacing-after');
  });
  test('verifies the rendered heading, paragraph, and list structure', () => {
    const richBody =
      '## Blocks\n\n<h2>Raw heading</h2>\n\n> Quote.\n\n> [!NOTE]\n> Alert.\n\n---\n\n```text\ncode\n```\n\n| A |\n| - |\n| B |\n\n- First.\n\n  Second.\n- Third.\n';
    const richHtml =
      '<h2>Blocks</h2><h2>Raw heading</h2><blockquote><p>Quote.</p></blockquote><div class="markdown-alert"><p>Alert.</p></div><hr><pre><code>code</code></pre>' +
      '<table><tr><th>A</th></tr><tr><td>B</td></tr></table>' +
      '<ul><li><p>First.</p><p>Second.</p></li><li><p>Third.</p></li></ul>';
    for (const missing of [
      '<h2',
      '<blockquote',
      '<hr',
      '<pre',
      '<table',
      '<ul',
      '<li',
      '<p>Second.',
    ]) {
      expect(() => assertGitHubRendering(richBody, richHtml.replace(missing, '<missing'))).toThrow(
        'GitHub rendering lost Markdown blocks'
      );
    }
    expect(() => assertGitHubRendering('<hr/>\n', '<p>Missing.</p>')).toThrow(
      'GitHub rendering lost Markdown blocks'
    );
  });
});
describe('GitHub body remote lifecycle', () => {
  test('previews an immutable file snapshot through GitHub rendering', async () => {
    const bodyFile = await createBodyFile();
    let snapshotBody = '';
    const runGhCommand = vi.fn<(args: string[]) => Promise<string>>(async args => {
      const bodyArgument = args.find(argument => argument.startsWith('text=@'));
      if (!bodyArgument) throw new Error('Expected a Markdown snapshot.');
      snapshotBody = await readFile(bodyArgument.slice('text=@'.length), 'utf8');
      await writeFile(bodyFile, 'Changed after snapshot.\n', 'utf8');
      return validRenderedBody;
    });

    await expect(
      previewGitHubBody({ bodyFile, repository: 'immagiov4/Nous', runGhCommand })
    ).resolves.toEqual({ htmlLength: Buffer.byteLength(validRenderedBody, 'utf8') });
    expect(snapshotBody).toBe(validBody);
    expect(runGhCommand).toHaveBeenCalledWith([
      'api',
      'markdown',
      '--method',
      'POST',
      '--header',
      'X-GitHub-Api-Version: 2022-11-28',
      '--field',
      expect.stringMatching(/^text=@.+nous-github-body-preview-.+body\.md$/u),
      '--field',
      'mode=gfm',
      '--field',
      'context=immagiov4/Nous',
    ]);
  });
  test('uploads one snapshot, preserves the managed suffix, then verifies raw and rendered data', async () => {
    const staleLocalSuffix = managedSuffix.replace(
      'Generated review context.',
      'Stale local review context.'
    );
    const bodyFile = await createBodyFile(`${validBody.trimEnd()}\n\n${staleLocalSuffix}`);
    let remoteBody = `${validBody.trimEnd()}\n\n${managedSuffix}`;
    let uploadedBody = '';
    let patchCount = 0;
    const runGhCommand = vi.fn<(args: string[]) => Promise<string>>(async args => {
      if (args[1] === 'markdown') {
        await writeFile(bodyFile, 'Changed after snapshot.\n', 'utf8');
        return managedRenderedBody;
      }
      if (args.includes('PATCH')) {
        const bodyArgument = args.find(argument => argument.startsWith('body=@'));
        if (!bodyArgument) throw new Error('Expected a body file argument.');
        uploadedBody = await readFile(bodyArgument.slice('body=@'.length), 'utf8');
        remoteBody = uploadedBody;
        patchCount += 1;
        return '';
      }
      return JSON.stringify({ body: remoteBody, body_html: managedRenderedBody });
    });

    await expect(updatePrBody(bodyFile, runGhCommand)).resolves.toMatchObject({
      endpoint: 'repos/immagiov4/Nous/pulls/42',
    });
    expect(uploadedBody).toBe(`${validBody.trimEnd()}\n\n${managedSuffix}`);
    expect(patchCount).toBe(1);
  });
  test('rejects a collapsed GitHub preview before PATCH', async () => {
    const bodyFile = await createBodyFile();
    const runGhCommand = vi.fn<(args: string[]) => Promise<string>>(async args => {
      if (args[1] === 'markdown') return '<p>Collapsed.</p>';
      if (args.includes('PATCH')) throw new Error('PATCH must not run.');
      return JSON.stringify({ body: validBody, body_html: validRenderedBody });
    });

    await expect(updatePrBody(bodyFile, runGhCommand)).rejects.toThrow(
      'GitHub rendering lost Markdown blocks'
    );
    expect(runGhCommand.mock.calls.some(([args]) => args.includes('PATCH'))).toBe(false);
  });

  test('aborts before PATCH when the remote body changes during preflight', async () => {
    const bodyFile = await createBodyFile();
    let getCount = 0;
    const runGhCommand = vi.fn<(args: string[]) => Promise<string>>(async args => {
      if (args[1] === 'markdown') return validRenderedBody;
      if (args.includes('PATCH')) throw new Error('PATCH must not run.');
      getCount += 1;
      const body = getCount === 1 ? validBody : validBody.replace('focused', 'remote');
      return JSON.stringify({ body, body_html: validRenderedBody });
    });

    await expect(updatePrBody(bodyFile, runGhCommand)).rejects.toThrow(
      'GitHub body changed during update'
    );
    expect(runGhCommand.mock.calls.some(([args]) => args.includes('PATCH'))).toBe(false);
  });

  test('rejects incomplete or structurally ambiguous managed markers before mutation', async () => {
    const bodyFile = await createBodyFile();
    const unsafeBodies = [
      `${validBody}\n<!-- This is an auto-generated description by cubic. -->`,
      `${validBody}\n> <!-- This is an auto-generated description by cubic. -->\n> text\n> <!-- End of auto-generated description by cubic. -->`,
      `${validBody}\n<!-- This is an auto-generated description by cubic. --><!-- End of auto-generated description by cubic. -->`,
    ];

    for (const remoteBody of unsafeBodies) {
      const runGhCommand = vi
        .fn()
        .mockResolvedValue(JSON.stringify({ body: remoteBody, body_html: validRenderedBody }));
      await expect(updatePrBody(bodyFile, runGhCommand)).rejects.toThrow(
        'managed pull request body markers are incomplete'
      );
      expect(runGhCommand).toHaveBeenCalledTimes(1);
    }

    const unclosedFenceFile = await createBodyFile('## Summary\n\n```text\nUnclosed fence\n');
    const remoteBody = `${validBody.trimEnd()}\n\n${managedSuffix}`;
    const runGhCommand = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ body: remoteBody, body_html: managedRenderedBody }));
    await expect(updatePrBody(unclosedFenceFile, runGhCommand)).rejects.toThrow(
      'managed pull request body suffix was absorbed'
    );
    expect(runGhCommand).toHaveBeenCalledTimes(1);
  });

  test('fails verification when the remote raw body differs from the file', async () => {
    const bodyFile = await createBodyFile();
    const runGhCommand = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          body: `${validBody.trimEnd()}\n\n${managedSuffix}`,
          body_html: managedRenderedBody,
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          body: validBody.replace('focused test passed', 'remote body changed'),
          body_html: validRenderedBody,
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          body: validBody.trimEnd(),
          body_html: validRenderedBody,
        })
      );

    await expect(verifyPrBody(bodyFile, runGhCommand)).resolves.toMatchObject({
      endpoint: 'repos/immagiov4/Nous/pulls/42',
    });

    await expect(verifyPrBody(bodyFile, runGhCommand)).rejects.toThrow(
      'GitHub raw body does not match'
    );

    await expect(verifyPrBody(bodyFile, runGhCommand)).rejects.toThrow(
      'GitHub raw body does not match'
    );
  });

  test('rejects unsupported targets and pull requests passed as issues before mutation', async () => {
    const bodyFile = await createBodyFile();
    const unsupportedRun = vi.fn();
    await expect(
      updateGitHubBody({
        bodyFile,
        kind: 'discussion',
        number: 42,
        repository: 'immagiov4/Nous',
        runGhCommand: unsupportedRun,
      })
    ).rejects.toThrow('--kind must be issue|pr');
    expect(unsupportedRun).not.toHaveBeenCalled();

    const issueRun = vi.fn<(args: string[]) => Promise<string>>().mockResolvedValue(
      JSON.stringify({
        body: validBody,
        body_html: validRenderedBody,
        pull_request: { url: 'https://api.github.test/pulls/42' },
      })
    );
    await expect(
      updateGitHubBody({
        bodyFile,
        kind: 'issue',
        number: 42,
        repository: 'immagiov4/Nous',
        runGhCommand: issueRun,
      })
    ).rejects.toThrow('is a pull request');
    expect(issueRun).toHaveBeenCalledTimes(1);
  });
});
