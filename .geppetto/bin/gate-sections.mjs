import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { cli, isMain, parseArgs, UsageError, jsonFile, exists } from './common.mjs';

// Preserve line numbers while removing fenced examples and HTML comments.
export function markdownLines(text, { keepCode = false } = {}) {
  let fence = null;
  let comment = false;
  return text.replace(/\r\n/g, '\n').split('\n').map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return keepCode ? line : '';
    }
    if (!comment && marker && !(marker[1][0] === '`' && marker[2].includes('`'))) { fence = marker[1]; return keepCode ? line : ''; }
    let visible = '';
    for (let i = 0; i < line.length;) {
      if (comment) { const end = line.indexOf('-->', i); if (end < 0) break; comment = false; i = end + 3; }
      else { const start = line.indexOf('<!--', i); if (start < 0) { visible += line.slice(i); break; } visible += line.slice(i, start); comment = true; i = start + 4; }
    }
    return visible;
  });
}

export function markdownHeadings(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const atx = lines[i].match(/^ {0,3}(#{1,6})(?:\s+(.+?)\s*#*\s*|\s*)$/);
    if (atx) found.push({ title: atx[2] ?? '', level: atx[1].length, line: i, start: i + 1 });
    else if (lines[i].trim() && !/^ {4}|^\t/.test(lines[i]) && /^ {0,3}(=+|-+)\s*$/.test(lines[i + 1] ?? '')) {
      found.push({ title: lines[i].trim(), level: lines[i + 1].trim()[0] === '=' ? 1 : 2, line: i, start: i + 2 }); i++;
    }
  }
  return found;
}

export function checkSections(text, required, file = '<stdin>') {
  const lines = markdownLines(text);
  const contentLines = markdownLines(text, { keepCode: true });
  const sections = markdownHeadings(lines);
  const errors = [];
  for (const title of required) {
    const matches = sections.filter(h => h.title.toLowerCase() === title.toLowerCase());
    if (!matches.length) { errors.push(`${file}:1: Missing section: ${title}`); continue; }
    for (const heading of matches) {
      const end = sections.find(h => h.line > heading.line && h.level <= heading.level)?.line ?? lines.length;
      const childHeadings = new Set(sections.filter(h => h.line > heading.line && h.line < end).flatMap(h => Array.from({ length: h.start - h.line }, (_, index) => h.line + index)));
      const body = contentLines.slice(heading.start, end).filter((line, index) => !childHeadings.has(index + heading.start) && !/^ {0,3}(?:`{3,}|~{3,})[^\n]*$/.test(line)).join('\n').trim();
      if (!body.replace(/[\s*_`#>\-]/g, '')) errors.push(`${file}:${heading.line + 1}: Empty section: ${title}`);
      else if (/^not applicable\b[\s.,:;!\-–—]*$/i.test(body)) errors.push(`${file}:${heading.line + 1}: Not applicable needs a reason: ${title}`);
    }
  }
  return errors;
}

function globRegex(pattern) {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { regex += '(?:.*/)?'; i++; } else regex += '.*'; }
    else if (char === '*') regex += '[^/]*';
    else if (char === '?') regex += '[^/]';
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${regex}$`);
}

async function expand(pattern) {
  const absolute = resolve(pattern).split(sep).join('/');
  if (!/[?*]/.test(absolute)) return [resolve(pattern)];
  const prefix = absolute.slice(0, absolute.search(/[?*]/));
  const root = prefix.slice(0, prefix.lastIndexOf('/')) || '/';
  const regex = globRegex(absolute);
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name)) await walk(path);
      else if (entry.isFile() && regex.test(path.split(sep).join('/'))) found.push(path);
    }
  }
  await walk(root);
  if (!found.length) throw new Error(`${pattern}:1: No documents match`);
  return found.sort();
}

export async function main(args) {
  const opts = parseArgs(args, { values: ['--pr', '--config'], repeat: ['--docs'] });
  if (opts._.length || Boolean(opts['--pr']) === Boolean(opts['--docs'])) throw new UsageError('Usage: gate-sections.mjs (--pr <file|-> | --docs <glob>...) [--config <path>]');
  const configPath = opts['--config'] ?? resolve('.geppetto/config.json');
  const config = opts['--config'] || await exists(configPath) ? await jsonFile(configPath) : {};
  const kind = opts['--pr'] ? 'pr' : 'featureDocs';
  const required = config.sections?.[kind] ?? ['Observability'];
  if (!Array.isArray(required) || required.some(h => typeof h !== 'string' || !h.trim())) throw new Error(`${configPath}:1: sections.${kind} must be an array of nonempty headings`);
  const files = opts['--pr'] ? [opts['--pr']] : [...new Set((await Promise.all(opts['--docs'].map(expand))).flat())];
  let errors = [];
  for (const file of files) {
    const text = file === '-' ? readFileSync(0, 'utf8') : await readFile(file, 'utf8');
    errors.push(...checkSections(text, required, file === '-' ? '<stdin>' : file));
  }
  if (errors.length) { console.error(errors.join('\n')); return 1; }
  console.log(`Sections OK (${files.length} document${files.length === 1 ? '' : 's'})`);
  return 0;
}

if (isMain(import.meta.url)) await cli(main);
