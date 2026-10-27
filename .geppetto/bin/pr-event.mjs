import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cli, isMain, parseArgs, UsageError, run } from './common.mjs';

export async function main(args) {
  const opts = parseArgs(args, { values: ['--event'] });
  const eventPath = opts['--event'] ?? process.env.GITHUB_EVENT_PATH;
  if (opts._.length || !eventPath) throw new UsageError('Usage: pr-event.mjs [--event <GitHub-event.json>] (default: GITHUB_EVENT_PATH)');
  let event;
  try { event = JSON.parse(readFileSync(eventPath, 'utf8')); } catch { throw new Error(`${eventPath}:1: Invalid GitHub event JSON`); }
  if (!event.pull_request || !(event.pull_request.body === null || typeof event.pull_request.body === 'string')) throw new Error(`${eventPath}:1: GitHub event needs pull_request.body`);
  const result = run(process.execPath, [fileURLToPath(new URL('./gate-sections.mjs', import.meta.url)), '--pr', '-'], { input: event.pull_request.body ?? '' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(result.error.message);
  return result.status === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) await cli(main);
