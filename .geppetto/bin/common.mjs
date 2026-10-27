import { readFile, lstat, readdir, mkdir, rename, writeFile, appendFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export class UsageError extends Error {}
export const userHome = () => homedir();
export const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', timeout: 15000, ...options, windowsHide: true, shell: false });
export const isMain = url => process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === url;

export async function cli(main) {
  try { process.exitCode = (await main(process.argv.slice(2))) ?? 0; }
  catch (error) { console.error(`${error.path ? `${error.path}:1: ` : ''}${error.message}`); process.exitCode = error instanceof UsageError ? 2 : 1; }
}

export function parseArgs(args, { values = [], flags = [], repeat = [] } = {}) {
  const result = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags.includes(arg)) { result[arg] = true; continue; }
    if (values.includes(arg) || repeat.includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new UsageError(`Missing value for ${arg}`);
      if (repeat.includes(arg)) {
        result[arg] ??= [];
        do { result[arg].push(args[++i]); } while (args[i + 1] && !args[i + 1].startsWith('--'));
      } else {
        if (arg in result) throw new UsageError(`Repeated option: ${arg}`);
        result[arg] = args[++i];
      }
      continue;
    }
    if (arg.startsWith('--')) throw new UsageError(`Unknown option: ${arg}`);
    result._.push(arg);
  }
  return result;
}

export async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function projectRoot(cwd) {
  // The home directory's .geppetto/ holds user-level config, so it never marks a project root.
  const home = resolve(userHome());
  for (let root = resolve(cwd); ; root = dirname(root)) {
    if ((root !== home && await exists(resolve(root, '.geppetto/config.json'))) || await exists(resolve(root, '.git'))) return root;
    if (root === home || dirname(root) === root) return resolve(cwd);
  }
}

export async function jsonFile(path, fallback) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`${path}:1: ${error instanceof SyntaxError ? 'Invalid JSON' : error.message}`, { cause: error });
  }
}

export async function atomicJson(path, value, { mode } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode });
  await rename(temp, path);
}

export function contained(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel));
}

export async function filesUnder(root) {
  const files = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${path}:1: Symbolic links require manual reconciliation`);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

// Twenty calls catches tool-heavy work; five minutes also catches long single-command turns.
export const learnNudgeDefaults = { enabled: true, benchmark: null, minToolCalls: 20, minDurationMs: 300000 };
export const signalLearningDefaults = () => ({ enabled: true, benchmark: null, writeApproval: false });
export const skillSelectorDefaults = { enabled: true, model: 'perplexity/pplx-decider-v1.2', threshold: 0.75, timeoutMs: 8000, batchSize: 80 };
export const memoryClassifierDefaults = { enabled: true, benchmark: null, model: 'perplexity/pplx-decider-flash-v1.2', bucketThreshold: 0.65, pageThreshold: 0.65, timeoutMs: 8000 };
export const defaultConfig = () => ({ version: 1, docs: { root: 'docs', style: 'project', referenceRepo: null }, sections: { pr: ['Observability'], featureDocs: ['Observability'], optional: ['Verification'] }, review: { engine: 'code-review' }, unitCoverage: 'behaviour', packs: [], pillars: {}, hooks: { learnNudge: { ...learnNudgeDefaults }, signalLearning: signalLearningDefaults(), memoryClassifier: { enabled: true, benchmark: null }, skillSelector: { enabled: true, benchmark: null } } });

export async function ignoreLocalFiles(project, paths) {
  const ignorePath = resolve(project, '.geppetto/.gitignore');
  for (const path of [dirname(ignorePath), ignorePath]) {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`${path}:1: Reconcile symbolic link before updating local ignore rules`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(dirname(ignorePath), { recursive: true });
  let ignored = '';
  try { ignored = await readFile(ignorePath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lines = ignored.split(/\r?\n/);
  // A later negation can reinclude a local file; restore its exclusion after it.
  const lastNegation = lines.findLastIndex(line => line.startsWith('!'));
  const missing = paths.filter(path => lines.lastIndexOf(path) <= lastNegation);
  if (missing.length) await appendFile(ignorePath, `${ignored && !ignored.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

export function validateConfig(config, file) {
  const fail = reason => { throw new Error(`${file}:1: Invalid Geppetto config: ${reason}`); };
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.version !== 1) fail('version must be 1');
  if (!config.docs || typeof config.docs.root !== 'string' || typeof config.docs.style !== 'string' || !(config.docs.referenceRepo === null || typeof config.docs.referenceRepo === 'string')) fail('docs needs root, style and referenceRepo');
  for (const key of ['pr', 'featureDocs', 'optional']) if (!Array.isArray(config.sections?.[key]) || config.sections[key].some(s => typeof s !== 'string' || !s.trim())) fail(`sections.${key} must be an array of nonempty headings`);
  if (typeof config.review?.engine !== 'string' || !['behaviour', 'full'].includes(config.unitCoverage) || !Array.isArray(config.packs)) fail('review, unitCoverage or packs');
  if (!config.pillars || Array.isArray(config.pillars) || Object.values(config.pillars).some(s => !['installed', 'declined', 'n/a'].includes(s))) fail('pillars must use installed, declined or n/a');
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks) || Object.values(config.hooks).some(h => !h || typeof h.enabled !== 'boolean' || !('benchmark' in h))) fail('hooks need enabled and benchmark');
  for (const key of ['minToolCalls', 'minDurationMs']) if (config.hooks.learnNudge?.[key] !== undefined && (!Number.isSafeInteger(config.hooks.learnNudge[key]) || config.hooks.learnNudge[key] <= 0)) fail(`hooks.learnNudge.${key} must be a positive integer`);
  const learning = config.hooks.signalLearning;
  if (learning?.writeApproval !== undefined && typeof learning.writeApproval !== 'boolean') fail('hooks.signalLearning.writeApproval must be boolean');
  validateMemory(config.memory, file);
  return config;
}

export function validateMemory(memory, file) {
  if (memory === undefined) return;
  if (!memory || typeof memory !== 'object' || Array.isArray(memory)) throw new Error(`${file}:1: memory must be an object`);
  for (const key of ['repo', 'localPath', 'projectBucket']) if (key in memory && (typeof memory[key] !== 'string' || !memory[key].trim())) throw new Error(`${file}:1: memory.${key} must be a nonempty string`);
  if (memory.projectBucket && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(memory.projectBucket)) throw new Error(`${file}:1: memory.projectBucket must be a single directory name`);
  if (memory.buckets !== undefined && (!Array.isArray(memory.buckets) || memory.buckets.some(bucket => typeof bucket !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(bucket)))) throw new Error(`${file}:1: memory.buckets must be an array of single directory names`);
}
