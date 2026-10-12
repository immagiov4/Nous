import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// ESLint invalidates config changes but not plugin upgrades; the lockfile covers dependencies.
export const resolveEslintCachePath = async (check: string): Promise<string> => {
  const dependencyHash = createHash('sha256')
    .update(await readFile('bun.lock'))
    .digest('hex');
  return path.resolve('.temp/eslint', `${check}-${dependencyHash}.cache`);
};
