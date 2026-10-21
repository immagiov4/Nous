import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { checkPublication, runHook } from './github-body-hook.mjs';

const good =
  '**Problem:** Waiting.\n\n**Approach:** Simplify.\n\n**Result:** Not measured.\n\n## Testing\n\nChecks passed.\n';
describe('publication guard', () => {
  test('blocks malformed inline bodies for both shell payloads', async () => {
    for (const input of [
      { command: 'gh pr create --body "Dense prose"' },
      { cmd: 'gh pr create --body "Dense prose"' },
    ]) {
      await expect(runHook({ tool_input: input })).rejects.toThrow('**Problem:**');
    }
    await expect(
      checkPublication('gh issue edit 403 --body "Dense prose"')
    ).resolves.toBeUndefined();
    await expect(checkPublication(`gh pr create --body '${good}'`)).resolves.toBeUndefined();
  });
  test('reads literal body files and API input without executing the command', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'body-hook-'));
    try {
      await writeFile(join(directory, 'body.md'), good);
      await writeFile(join(directory, 'input.json'), JSON.stringify({ body: good }));
      for (const command of [
        'gh pr create --body-file body.md',
        'gh pr edit 4 --body-file=body.md',
        'gh -R a/b pr create --body-file body.md',
        'gh api repos/a/b/pulls/4 -X PATCH -Fbody=@body.md',
        'gh api repos/a/b/pulls/4 -X PATCH -F body=@body.md',
        'gh api repos/a/b/pulls/4 --input input.json',
      ]) {
        await expect(checkPublication(command, directory)).resolves.toBeUndefined();
      }
      await writeFile(join(directory, 'body.md'), 'Wrong body');
      await expect(checkPublication('gh pr create --body-file body.md', directory)).rejects.toThrow(
        '**Problem:**'
      );
      await expect(
        checkPublication('gh api repos/a/b/pulls/4 -X PATCH -F body=@body.md', directory)
      ).rejects.toThrow('**Problem:**');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test('refuses unreadable publication forms and leaves read commands alone', async () => {
    for (const command of [
      'gh pr create',
      'gh pr create -e --body-file valid.md',
      'gh pr create -de --body-file valid.md',
      'gh pr create -dw --body-file valid.md',
      'gh pr create -e=true --body-file valid.md',
      'gh pr create -w=true --body-file valid.md',
      'gh pr create -fed=true --body-file valid.md',
      'gh pr create -w --body-file valid.md',
      'gh pr view 4\ngh pr create --body bad',
      'gh api repos/a/b/pulls -f title=Title -f head=branch -f base=main',
      'gh pr create --fill # --body-file good.md',
      'gh pr create --body-file good.md\ngh pr create --fill',
      'gh pr create --body-file -',
      'gh pr create --body "$BODY"',
      'cat body.md | gh pr create --body-file -',
      'cd elsewhere; gh pr create --body-file body.md',
      'gh api graphql -f query=mutation -f body=bad',
      'gh api repos/a/b/pulls/4 -X PATCH --input -',
    ]) {
      await expect(checkPublication(command)).rejects.toThrow('Use a single gh command');
    }
    await expect(checkPublication('gh "pr" create --body bad')).rejects.toThrow('**Problem:**');
    await expect(checkPublication('gh pr --repo a/b create --body bad')).rejects.toThrow(
      '**Problem:**'
    );
    await expect(checkPublication('gh pr -R a/b edit 4 --body bad')).rejects.toThrow(
      '**Problem:**'
    );
    await expect(checkPublication('gh pr edit 4 --title okay -bbad')).rejects.toThrow(
      '**Problem:**'
    );
    await expect(checkPublication('gh api repos/a/b/pulls/4 -X PATCH -fbody=bad')).rejects.toThrow(
      '**Problem:**'
    );
    for (const command of [
      'gh pr view 4',
      'gh api repos/a/b/issues/4 -X PATCH -f "body=Investigate pulls"',
      'gh issue list',
      'gh pr edit 4 --title "A title"',
      'gh api repos/a/b/pulls/4',
      'echo hello',
    ]) {
      await expect(checkPublication(command)).resolves.toBeUndefined();
    }
  });
});

describe('configured Claude and Codex guards', () => {
  test.each([
    '.claude/settings.json',
    '.codex/hooks.json',
  ])('%s blocks publication before gh runs', async filename => {
    const { spawnSync } = await import('node:child_process');
    const { readFile } = await import('node:fs/promises');
    const config = JSON.parse(await readFile(filename, 'utf8'));
    const command = config.hooks.PreToolUse.at(-1).hooks[0].command;
    const script = command.slice('bun -e "'.length, -1);
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: join(process.cwd(), 'scripts'),
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'gh pr create --body "Dense prose"' },
      }),
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('**Problem:**');
    expect(result.stderr).toContain('references/change-reports.md');
  });
});
