import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { main } from './run-eslint-sonar.ts';

describe('Sonar ESLint bulk suppressions', () => {
  let directory: string;
  let cachePath: string;
  let suppressionsPath: string;
  const runnerPath = fileURLToPath(new URL('./run-eslint-sonar.ts', import.meta.url));
  const existingFile = 'apps/web/existing.ts';
  const newFile = 'apps/backend/tests/new.ts';
  const ruleId = 'sonarjs/no-nested-conditional';
  const violation =
    "export const choose = (first: boolean, second: boolean) => first ? (second ? 'both' : 'first') : 'neither';\n";
  const baseline = { [existingFile]: { [ruleId]: { count: 1 } } };
  const run = (...args: string[]) => {
    const result = spawnSync(
      'bun',
      ['run', runnerPath, '--format', 'json', '--cache-location', cachePath, ...args],
      { cwd: directory, encoding: 'utf8', windowsHide: true }
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

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'nous-eslint-sonar-'));
    cachePath = path.join(directory, '.temp/sonar-test.cache');
    suppressionsPath = path.join(directory, 'config/eslint-suppressions.json');
    await mkdir(path.join(directory, 'config'));
    // Only dependencies are shared; config, sources, lockfile, cache, and baseline are isolated.
    await symlink(
      path.resolve('node_modules'),
      path.join(directory, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    for (const folder of [
      'apps/web',
      'apps/backend/src',
      'apps/backend/tests',
      'packages',
      'scripts',
      'e2e',
    ]) {
      await mkdir(path.join(directory, folder), { recursive: true });
      await writeFile(path.join(directory, folder, 'clean.ts'), 'export {};\n');
    }
    await writeFile(
      path.join(directory, 'config/tsconfig.eslint.json'),
      JSON.stringify({
        include: [
          '../apps/web/**/*.ts',
          '../apps/backend/src/**/*.ts',
          '../apps/backend/tests/**/*.ts',
          '../packages/**/*.ts',
          '../scripts/**/*.ts',
          '../e2e/**/*.ts',
        ],
      })
    );
    await mkdir(path.join(directory, '.temp'));
    await writeFile(path.join(directory, 'bun.lock'), 'isolated ESLint test dependencies\n');
    await writeFile(
      path.join(directory, 'config/eslint.sonar.config.mjs'),
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
    await writeFile(suppressionsPath, JSON.stringify(baseline));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test('suppresses existing violations', () => {
    const existing = run();
    expect(existing.status, existing.stderr).toBe(0);
    expect(diagnostics(existing.results, existingFile)).toEqual({
      errors: [],
      suppressed: [ruleId],
    });
  });

  test('rejects new files cold and cached without changing the baseline', async () => {
    await writeFile(path.join(directory, newFile), violation);
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
  });

  test('prunes fixed violations', async () => {
    await writeFile(path.join(directory, existingFile), 'export const choose = () => true;\n');
    const pruned = run('--prune-suppressions');
    expect(pruned.status, pruned.stderr).toBe(0);
    expect(diagnostics(pruned.results, existingFile)).toEqual({ errors: [], suppressed: [] });
    expect(JSON.parse(await readFile(suppressionsPath, 'utf8'))).toEqual({});
  });
});

describe('Sonar ESLint test classification', () => {
  test('reads test directories and inclusion patterns from the Sonar properties', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nous-sonar-classification-'));
    try {
      await mkdir(path.join(directory, 'config'));
      await symlink(
        path.resolve('node_modules'),
        path.join(directory, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      await writeFile(
        path.join(directory, 'config/eslint.sonar.config.mjs'),
        await readFile('config/eslint.sonar.config.mjs', 'utf8')
      );
      await writeFile(
        path.join(directory, 'config/tsconfig.eslint.json'),
        JSON.stringify({ include: ['../**/*.ts', '../**/*.tsx'] })
      );
      await writeFile(
        path.join(directory, 'config/sonar-project.properties'),
        '# Synthetic classification, deliberately different from the repository\r\n' +
          'sonar.tests = custom/unit, custom/integration/\r\n' +
          'sonar.test.inclusions = **/*.verify.ts, **/*.spec.tsx, custom/unit/**/*.target.ts\r\n'
      );
      const eslint = new ESLint({
        cwd: directory,
        overrideConfigFile: path.join(directory, 'config/eslint.sonar.config.mjs'),
      });
      const helper = await eslint.calculateConfigForFile('custom/unit/helper.ts');
      const mainRules = Object.keys(helper.rules);
      expect(mainRules.length).toBeGreaterThan(0);
      for (const file of [
        'custom/unit/example.verify.ts',
        'custom/unit/example.target.ts',
        'custom/unit/nested/example.spec.tsx',
        'custom/integration/example.verify.ts',
        'custom/integration/example.spec.tsx',
      ]) {
        const config = await eslint.calculateConfigForFile(file);
        for (const rule of mainRules) expect(config.rules[rule][0], `${file}: ${rule}`).toBe(0);
      }
      for (const file of [
        'custom/unit/helper.ts',
        'custom/unit/example.test.ts',
        'outside/example.verify.ts',
        'custom/integration/example.target.ts',
      ]) {
        const config = await eslint.calculateConfigForFile(file);
        for (const rule of mainRules) expect(config.rules[rule][0], `${file}: ${rule}`).toBe(2);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('Sonar ESLint command entry', () => {
  afterEach(() => vi.unstubAllGlobals());

  test.each([0, 7])('loads relocated lint inputs and returns child status %s', async code => {
    const spawn = vi.fn().mockReturnValue({ exited: Promise.resolve(code) });
    vi.stubGlobal('Bun', { spawn });
    expect(await main(['--format', 'json'])).toBe(code);
    const command = spawn.mock.calls[0][0] as string[];
    expect(command[command.indexOf('--config') + 1]).toBe('config/eslint.sonar.config.mjs');
    expect(command[command.indexOf('--suppressions-location') + 1]).toBe(
      'config/eslint-suppressions.json'
    );
    expect(command.slice(-8)).toEqual([
      'apps/web',
      'apps/backend/src',
      'apps/backend/tests',
      'packages',
      'scripts',
      'e2e',
      '--format',
      'json',
    ]);
  });
});
