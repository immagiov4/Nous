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

const validBody = `## Summary

The body keeps its paragraphs separate.

- First item
- Second item

## Testing

The focused test passed.
`;

const validRenderedBody =
  '<h2>Summary</h2><p>The body keeps its paragraphs separate.</p>' +
  '<ul><li>First item</li><li>Second item</li></ul>' +
  '<h2>Testing</h2><p>The focused test passed.</p>';

const managedSuffix = `<!-- This is an auto-generated description by cubic. -->

Generated review context.

<!-- End of auto-generated description by cubic. -->

[Review in Cubic](https://www.cubic.dev/)
`;

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

const issueCodes = (body: string) => new Set(validateMarkdownBody(body).map(issue => issue.code));

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true }))
  );
});

describe('GitHub body Markdown contract', () => {
  test('accepts explicit blocks while leaving literal notation inside code to Remark', () => {
    const bodyWithCode = `${validBody}
Use \`C:\\new\\notes\` as a documented path.

\`\`\`text
Literal \\n stays inside this example.
\`\`\`
`;

    expect(validateMarkdownBody(validBody)).toEqual([]);
    expect(validateMarkdownBody(bodyWithCode)).toEqual([]);
  });

  test('rejects empty, single-line, and literal-newline bodies', () => {
    expect(issueCodes('')).toContain('empty-body');
    expect(issueCodes('Only one physical line')).toContain('missing-newline');
    expect(issueCodes('## Summary\n\nText\\n## Testing\\n- item\n\nDone.\n')).toContain(
      'literal-newline'
    );
  });

  test('uses AST blocks without treating ordinary prose as flattened Markdown', () => {
    const ordinaryProse = `${validBody}
Use # tags in GitHub.
Compare old - new behavior, or use option 1) now.
`;

    expect(validateMarkdownBody(ordinaryProse)).toEqual([]);
  });

  test('requires blank boundaries after headings and around top-level lists', () => {
    expect(issueCodes('## Summary\nText.\n')).toContain('heading-spacing');
    const listIssues = issueCodes('Text.\n- First\n- Second\nNext.\n');
    expect(listIssues).toContain('list-spacing-before');
    expect(validateMarkdownBody(validBody)).toEqual([]);
  });

  test('verifies the rendered heading, paragraph, and list structure', () => {
    expect(() => assertGitHubRendering(validBody, validRenderedBody)).not.toThrow();
    expect(() => assertGitHubRendering(validBody, '<h2>Summary</h2><p>Collapsed.</p>')).toThrow(
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
    const bodyFile = await createBodyFile();
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

    await expect(
      updateGitHubBody({
        bodyFile,
        kind: 'pr',
        number: 42,
        repository: 'immagiov4/Nous',
        runGhCommand,
      })
    ).resolves.toMatchObject({ endpoint: 'repos/immagiov4/Nous/pulls/42' });
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

    await expect(
      updateGitHubBody({
        bodyFile,
        kind: 'pr',
        number: 42,
        repository: 'immagiov4/Nous',
        runGhCommand,
      })
    ).rejects.toThrow('GitHub rendering lost Markdown blocks');
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

    await expect(
      updateGitHubBody({
        bodyFile,
        kind: 'pr',
        number: 42,
        repository: 'immagiov4/Nous',
        runGhCommand,
      })
    ).rejects.toThrow('GitHub body changed during update');
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
      await expect(
        updateGitHubBody({
          bodyFile,
          kind: 'pr',
          number: 42,
          repository: 'immagiov4/Nous',
          runGhCommand,
        })
      ).rejects.toThrow('managed pull request body markers are incomplete');
      expect(runGhCommand).toHaveBeenCalledTimes(1);
    }
  });

  test('fails verification when the remote raw body differs from the file', async () => {
    const bodyFile = await createBodyFile();
    const runGhCommand = vi.fn().mockResolvedValue(
      JSON.stringify({
        body: validBody.replace('focused test passed', 'remote body changed'),
        body_html: validRenderedBody,
      })
    );

    await expect(
      verifyGitHubBody({
        bodyFile,
        kind: 'pr',
        number: 42,
        repository: 'immagiov4/Nous',
        runGhCommand,
      })
    ).rejects.toThrow('GitHub raw body does not match');
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
