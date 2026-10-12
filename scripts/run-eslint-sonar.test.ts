import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ESLint } from 'eslint';
import { describe, expect, test } from 'vitest';

describe('Sonar ESLint bulk suppressions', () => {
  test('suppresses existing violations, rejects new files cold and cached, and prunes fixed violations', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nous-eslint-sonar-'));
    const runnerPath = fileURLToPath(new URL('./run-eslint-sonar.ts', import.meta.url));
    const cachePath = path.join(directory, '.temp/sonar-test.cache');
    const suppressionsPath = path.join(directory, 'eslint-suppressions.json');
    const existingFile = 'apps/web/existing.ts';
    const newFile = 'apps/web/new.ts';
    const ruleId = 'sonarjs/no-nested-conditional';
    const violation =
      "export const choose = (first: boolean, second: boolean) => first ? (second ? 'both' : 'first') : 'neither';\n";
    const run = (...args: string[]) => {
      const result = spawnSync(
        'bun',
        ['run', runnerPath, '--format', 'json', '--cache-location', cachePath, ...args],
        { cwd: directory, encoding: 'utf8' }
      );
      expect(result.error).toBeUndefined();
      return {
        status: result.status,
        results: JSON.parse(result.stdout) as ESLint.LintResult[],
        stderr: result.stderr,
      };
    };
    const diagnostics = (results: ESLint.LintResult[], file: string) => {
      const result = results.find(entry => entry.filePath === path.join(directory, file));
      assert(result, `Missing lint result for ${file}`);
      return {
        errors: result.messages.map(message => message.ruleId),
        suppressed: result.suppressedMessages.map(message => message.ruleId),
      };
    };

    try {
      // Only dependencies are shared; config, sources, lockfile, cache, and baseline are isolated.
      await symlink(
        path.resolve('node_modules'),
        path.join(directory, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      for (const folder of ['apps/web', 'apps/backend/src', 'packages', 'scripts', 'e2e']) {
        await mkdir(path.join(directory, folder), { recursive: true });
        await writeFile(path.join(directory, folder, 'clean.ts'), 'export {};\n');
      }
      await mkdir(path.join(directory, '.temp'));
      await writeFile(path.join(directory, 'bun.lock'), 'isolated ESLint test dependencies\n');
      await writeFile(
        path.join(directory, 'eslint.sonar.config.mjs'),
        `import parser from '@typescript-eslint/parser';
import sonarjs from 'eslint-plugin-sonarjs';
export default [{
  files: ['**/*.ts'],
  languageOptions: { parser },
  plugins: { sonarjs },
  rules: { '${ruleId}': 'error' },
}];\n`
      );
      await writeFile(path.join(directory, existingFile), violation);
      const baseline = { [existingFile]: { [ruleId]: { count: 1 } } };
      await writeFile(suppressionsPath, JSON.stringify(baseline));

      const existing = run();
      expect(existing.status, existing.stderr).toBe(0);
      expect(diagnostics(existing.results, existingFile)).toEqual({
        errors: [],
        suppressed: [ruleId],
      });

      await writeFile(path.join(directory, newFile), violation);
      await rm(cachePath);
      const cold = run();
      expect(cold.status, cold.stderr).toBe(1);
      expect(diagnostics(cold.results, existingFile)).toEqual({
        errors: [],
        suppressed: [ruleId],
      });
      expect(diagnostics(cold.results, newFile)).toEqual({ errors: [ruleId], suppressed: [] });

      const warm = run('--debug');
      expect(warm.status, warm.stderr).toBe(1);
      expect(warm.stderr).toContain(
        `Skipping file since it hasn't changed: ${path.join(directory, newFile)}`
      );
      expect(diagnostics(warm.results, newFile)).toEqual({ errors: [ruleId], suppressed: [] });
      expect(warm.results).toEqual(cold.results);
      expect(JSON.parse(await readFile(suppressionsPath, 'utf8'))).toEqual(baseline);

      await rm(path.join(directory, newFile));
      await writeFile(path.join(directory, existingFile), 'export const choose = () => true;\n');
      const pruned = run('--prune-suppressions');
      expect(pruned.status, pruned.stderr).toBe(0);
      expect(diagnostics(pruned.results, existingFile)).toEqual({ errors: [], suppressed: [] });
      expect(JSON.parse(await readFile(suppressionsPath, 'utf8'))).toEqual({});
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
