import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { cli, isMain, parseArgs, UsageError, exists, userHome } from './common.mjs';
import { markdownLines } from './gate-sections.mjs';

const localPath = target => !/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(target) || /^[a-z]:[\\/]/i.test(target);
function pointerPath(target, base) {
  let path = target.replace(/^<|>$/g, '').split('#')[0];
  try { path = decodeURIComponent(path); } catch { throw new Error(`${base}:1: Invalid path encoding: ${target}`); }
  return path.startsWith('~/') ? resolve(userHome(), path.slice(2)) : resolve(dirname(base), path);
}

export async function checkAgents(file, { maxLines = 300, maxBytes = 16384 } = {}) {
  const errors = []; const visited = new Set(); let bytes = 0; let lines = 0;
  async function visit(path, stack = []) {
    const identity = await realpath(path);
    if (stack.includes(identity)) { errors.push(`${path}:1: Import cycle`); return; }
    if (visited.has(identity)) return;
    visited.add(identity);
    const text = await readFile(path, 'utf8');
    const visible = markdownLines(text);
    bytes += Buffer.byteLength(text);
    if (resolve(path) === resolve(file)) lines = text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length : 0;
    for (let i = 0; i < visible.length; i++) {
      const line = visible[i];
      const imports = [...line.matchAll(/(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s`]+))/g)].map(m => m[1] ?? m[2] ?? m[3]);
      const links = [...line.matchAll(/\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/g)].map(m => m[1]);
      const definitions = line.match(/^ {0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/);
      if (definitions) links.push(definitions[1]);
      const codePaths = [...line.matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(s => /^(?:\.\.?\/|~\/|[a-z]:[\\/]|\/)/i.test(s) || /^(?:[\w.-]+[\\/])+[\w.*-]+(?:\.\w+)?$/.test(s) || /^[\w.-]+\.(?:md|mjs|json|ya?ml|toml|txt)$/.test(s));
      for (const target of [...new Set([...imports, ...links, ...codePaths])]) {
        if (!localPath(target) || target.includes('*') || target.startsWith('$')) continue;
        const destination = pointerPath(target, path);
        if (!await exists(destination)) { errors.push(`${path}:${i + 1}: Unresolved local pointer: ${target}`); continue; }
        if (imports.includes(target)) await visit(destination, [...stack, identity]);
      }
    }
  }
  await visit(resolve(file));
  const claude = resolve(dirname(file), 'CLAUDE.md');
  if (await exists(claude)) await visit(claude);
  if (lines > maxLines) errors.push(`${file}:1: Line budget exceeded (${lines} > ${maxLines})`);
  if (bytes > maxBytes) errors.push(`${file}:1: UTF-8 byte budget exceeded (${bytes} > ${maxBytes})`);
  return { errors, lines, bytes, files: visited.size };
}

export async function main(args) {
  const opts = parseArgs(args, { values: ['--file', '--max-lines', '--max-bytes'] });
  if (opts._.length) throw new UsageError('Usage: gate-agents.mjs [--file AGENTS.md] [--max-lines 300] [--max-bytes 16384]');
  const budgets = {};
  for (const [option, key] of [['--max-lines', 'maxLines'], ['--max-bytes', 'maxBytes']]) {
    if (opts[option] !== undefined) {
      if (!/^\d+$/.test(opts[option]) || !Number.isSafeInteger(Number(opts[option])) || Number(opts[option]) < 1) throw new UsageError(`${option} must be a positive integer`);
      budgets[key] = Number(opts[option]);
    }
  }
  const result = await checkAgents(opts['--file'] ?? 'AGENTS.md', budgets);
  if (result.errors.length) { console.error(result.errors.join('\n')); return 1; }
  console.log(`Agents OK (${result.lines} lines, ${result.bytes} bytes, ${result.files} files)`);
  return 0;
}

if (isMain(import.meta.url)) await cli(main);
