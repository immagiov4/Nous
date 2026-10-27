import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, isMain, parseArgs, UsageError, run, jsonFile } from './common.mjs';

const gate = fileURLToPath(new URL('./gate-sections.mjs', import.meta.url));
const filesPerPage = 100; // GitHub's maximum page size.
const maxChangedFiles = 3000; // GitHub's PR-files endpoint response limit.

async function githubRequest(path, { raw = false } = {}) {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    headers: { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }
  });
  if (!response.ok) throw new Error(`GitHub document request failed (HTTP ${response.status})`);
  return raw ? response.text() : response.json();
}

function safeDocumentPath(path) {
  if (typeof path !== 'string' || !path || /[\\:\x00-\x1f]/.test(path) || posix.isAbsolute(path) || posix.normalize(path) !== path || path === '..' || path.startsWith('../')) throw new Error('Invalid changed document path');
  return path;
}

async function changedDocPaths(event, root, request) {
  const files = [];
  for (let page = 1; ; page++) {
    const batch = await request(`/repos/${event.repository.full_name}/pulls/${event.number}/files?per_page=${filesPerPage}&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('Invalid GitHub changed-file response');
    for (const file of batch) {
      const path = safeDocumentPath(file.filename);
      if (file.status !== 'removed' && path.toLowerCase().endsWith('.md') && (root === '.' || path.startsWith(`${root}/`))) files.push(path);
    }
    if (batch.length < filesPerPage) break;
  }
  return files.sort();
}

async function changedDocs(event, { cwd, request, execute }) {
  const repository = event.repository?.full_name, head = event.pull_request.head;
  const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  if (!repoPattern.test(repository ?? '') || !repoPattern.test(head?.repo?.full_name ?? '') || !/^[a-f\d]{40}$/i.test(head?.sha ?? '') || !Number.isSafeInteger(event.number) || event.number < 1) throw new Error('GitHub document event needs repository, PR number and immutable head');
  if (event.pull_request.changed_files > maxChangedFiles) throw new Error('GitHub PR file list is truncated; split the PR before checking documents');
  const config = await jsonFile(resolve(cwd, '.geppetto/config.json'), {});
  const root = safeDocumentPath(posix.normalize(config.docs?.root ?? 'docs').replace(/\/$/, ''));
  const files = await changedDocPaths(event, root, request);
  if (!files.length) { console.log('Sections OK (0 changed feature documents)'); return 0; }
  const directory = await mkdtemp(resolve(tmpdir(), 'geppetto-pr-docs-'));
  try {
    await mkdir(resolve(directory, 'documents'));
    const configPath = resolve(directory, 'config.json');
    await writeFile(configPath, JSON.stringify(config));
    const paths = [];
    for (const [index, file] of files.entries()) {
      const path = resolve(directory, 'documents', `${index}.md`);
      const encoded = file.split('/').map(encodeURIComponent).join('/');
      await writeFile(path, await request(`/repos/${head.repo.full_name}/contents/${encoded}?ref=${head.sha}`, { raw: true }));
      paths.push(path);
    }
    const result = execute(process.execPath, [gate, '--config', configPath, '--docs', ...paths], { cwd: directory });
    if (result.stderr) for (const [index, path] of paths.entries()) result.stderr = result.stderr.replaceAll(path, files[index]);
    return report(result);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function report(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(result.error.message);
  return result.status === 0 ? 0 : 1;
}

export async function main(args, { cwd = process.cwd(), request = githubRequest, execute = run } = {}) {
  const opts = parseArgs(args, { values: ['--event'], flags: ['--docs'] });
  const eventPath = opts['--event'] ?? process.env.GITHUB_EVENT_PATH;
  if (opts._.length || !eventPath) throw new UsageError('Usage: pr-event.mjs [--docs] [--event <GitHub-event.json>] (default: GITHUB_EVENT_PATH)');
  let event;
  try { event = JSON.parse(readFileSync(eventPath, 'utf8')); } catch { throw new Error(`${eventPath}:1: Invalid GitHub event JSON`); }
  if (!event.pull_request || !(event.pull_request.body === null || typeof event.pull_request.body === 'string')) throw new Error(`${eventPath}:1: GitHub event needs pull_request.body`);
  if (opts['--docs']) return changedDocs(event, { cwd, request, execute });
  return report(execute(process.execPath, [gate, '--pr', '-'], { cwd, input: event.pull_request.body ?? '' }));
}

if (isMain(import.meta.url)) await cli(main);
