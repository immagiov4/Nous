import { afterEach, expect, it, vi } from 'vitest';
import { formatCoverageMap } from '../../../packages/playtest/src/coverage';
import { loadStories } from '../../../packages/playtest/src/stories';
import { runCommand as runNousCommand } from '../run';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('runs the Nous metadata command without external data or provider arguments', async () => {
  vi.stubEnv('NOUS_E2E_DATA', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const map = await runNousCommand(['--', '--coverage-map']);
  expect(map).toBe(formatCoverageMap(await loadStories('e2e/nous/stories')));
  await expect(runNousCommand([])).rejects.toThrow('NOUS_E2E_DATA');
});
