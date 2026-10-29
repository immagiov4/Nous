import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEMORY_REPOSITORY = 'https://github.com/immagiov4/llm-memories.git';
const PACKS = [
  { name: 'geppetto', repository: 'immagiov4/Geppetto' },
  {
    name: 'my-codex-skills',
    repository: 'immagiov4/my-codex-skills',
    required: [
      'engineering-workflow',
      'principle-boundary-discipline',
      'principle-build-the-lever',
      'principle-encode-lessons-in-structure',
      'principle-exhaust-the-design-space',
      'principle-explain-the-number',
      'principle-fix-root-causes',
      'principle-foundational-thinking',
      'principle-laziness-protocol',
      'principle-outcome-oriented-execution',
      'principle-prove-it-works',
      'principle-redesign-from-first-principles',
      'principle-separate-before-serializing-shared-state',
      'principle-sequence-verifiable-units',
      'principle-subtract-before-you-add',
      'principle-test-behavior-not-implementation',
    ],
  },
  { name: 'ponytail', repository: 'DietrichGebert/ponytail', required: ['ponytail'] },
];

function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function repositoryIdentity(repository) {
  const expanded = repository.startsWith('git@github.com:')
    ? repository.replace('git@github.com:', 'ssh://git@github.com/')
    : repository;
  try {
    const url = new URL(expanded);
    if (
      !['https:', 'ssh:'].includes(url.protocol) ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      (url.protocol === 'https:' ? url.username : url.username !== 'git')
    )
      return null;
    return `${url.hostname}${url.pathname.replace(/\/$/, '').replace(/\.git$/, '')}`.toLowerCase();
  } catch {
    return null;
  }
}

function prepareMemory(project, home, execute) {
  const path = resolve(home, '.geppetto/config.json');
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const memory = settings.memory;
  if (memory?.choice || memory?.repo || memory?.localPath) return;
  const localPath = resolve(home, 'geppetto-memory');
  if (!existsSync(resolve(localPath, '.git'))) {
    execute('git', ['clone', '--filter=blob:none', '--sparse', MEMORY_REPOSITORY, localPath]);
  }
  let repository;
  for (const options of [[], ['--push']]) {
    const urls = execute('git', [
      '-C',
      localPath,
      'remote',
      'get-url',
      ...options,
      '--all',
      'origin',
    ])
      .trim()
      .split(/\r?\n/);
    if (urls.some(url => repositoryIdentity(url) !== repositoryIdentity(MEMORY_REPOSITORY))) {
      throw new Error(
        'The existing checkout does not match the configured Nous memory repository.'
      );
    }
    repository ??= urls[0];
  }
  const config = JSON.parse(readFileSync(resolve(project, '.geppetto/config.json'), 'utf8'));
  const buckets = [
    'buckets/preferences',
    ...config.memory.buckets.map(bucket => `buckets/${bucket}`),
  ];
  if (buckets.some(bucket => !existsSync(resolve(localPath, bucket, 'index.md')))) {
    execute('git', ['-C', localPath, 'sparse-checkout', 'add', '--', ...buckets]);
  }
  mkdirSync(dirname(path), { recursive: true });
  settings.memory = { repo: repository, localPath };
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

async function verifySkills(project, installed, adopt) {
  const { connectCodex } = await import(pathToFileURL(resolve(adopt, 'codex-hook-trust.mjs')).href);
  const client = connectCodex({ cwd: project });
  try {
    await client.initialize();
    const result = await client.request('skills/list', { cwds: [project], forceReload: true });
    const entry = result.data.find(item => item.cwd === project);
    if (!entry || entry.errors.length)
      throw new Error('Codex skill discovery failed for this project.');
    for (const [name, root] of installed) {
      for (const skill of PACKS.find(pack => pack.name === name).required ?? []) {
        if (!existsSync(resolve(root, 'skills', skill, 'SKILL.md')))
          throw new Error(`Required skill is missing: ${name}:${skill}`);
      }
      for (const skill of readdirSync(resolve(root, 'skills'))) {
        const path = resolve(root, 'skills', skill, 'SKILL.md');
        if (!existsSync(path)) continue;
        if (
          !entry.skills.some(
            item => item.name === `${name}:${skill}` && item.enabled && resolve(item.path) === path
          )
        ) {
          throw new Error(`Installed skill is not invocable: ${name}:${skill}`);
        }
      }
    }
  } finally {
    await client.close();
  }
}

export async function setupCodexCloud({
  project = PROJECT_ROOT,
  home = homedir(),
  execute = runCommand,
} = {}) {
  const workflow = parse(readFileSync(resolve(project, '.github/workflows/pr-gate.yml'), 'utf8'));
  const gate = workflow.jobs.sections.steps.find(
    step => step.with?.repository === 'immagiov4/Geppetto'
  );
  const pin = gate?.with?.ref;
  if (!/^[a-f\d]{40}$/i.test(pin ?? ''))
    throw new Error('The Geppetto CI gate needs an immutable commit before cloud setup.');
  const installed = new Map();
  for (const { name, repository } of PACKS) {
    execute('codex', [
      'plugin',
      'marketplace',
      'add',
      repository,
      ...(name === 'geppetto' ? ['--ref', pin] : []),
      '--json',
    ]);
    const result = JSON.parse(execute('codex', ['plugin', 'add', `${name}@${name}`, '--json']));
    if (!result.installedPath)
      throw new Error(`Codex did not report an installed path for ${name}.`);
    installed.set(name, result.installedPath);
  }
  prepareMemory(project, home, execute);
  const adopt = resolve(installed.get('geppetto'), 'skills/geppetto-adopt/scripts');
  execute(process.execPath, [
    resolve(adopt, 'install.mjs'),
    '--target',
    'codex',
    '--project',
    project,
    '--plugin-hooks',
    '--gate-sha',
    pin,
  ]);
  for (const plugin of ['geppetto@geppetto', 'ponytail@ponytail']) {
    execute(process.execPath, [
      resolve(adopt, 'codex-hook-trust.mjs'),
      '--project',
      project,
      '--plugin',
      plugin,
      '--approve',
    ]);
  }
  execute(process.execPath, [resolve(adopt, 'audit.mjs'), '--project', project, '--verify']);
  await verifySkills(project, installed, adopt);
  return Object.fromEntries(installed);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await setupCodexCloud(), null, 2));
    console.log(
      'Plugins and scoped hook trust configured. Verify hook execution in a fresh Codex session; installation alone is not activation evidence.'
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
