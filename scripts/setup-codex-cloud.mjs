import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { parse } from 'yaml';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEMORY_REPOSITORY = 'https://github.com/immagiov4/llm-memories.git';
const PACKS = [
  { name: 'geppetto', repository: 'immagiov4/Geppetto' },
  {
    name: 'my-codex-skills',
    repository: 'immagiov4/my-codex-skills',
    ref: '4ce5ba501e90429e8f39dd19049f1dd7ac1d6893',
    required: [
      'engineering-workflow',
      'write-pr',
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
  {
    name: 'ponytail',
    repository: 'DietrichGebert/ponytail',
    ref: '96608e078b2d5ea607c5c3b8b5a54d1c1fba6846',
    required: ['ponytail'],
  },
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

function reconcileMarketplace(pack, ref, marketplaces, configured, execute) {
  const existing = marketplaces.find(item => item.name === pack.name);
  if (!existing) return;
  const expected = repositoryIdentity(`https://github.com/${pack.repository}.git`);
  if (
    existing.marketplaceSource?.sourceType !== 'git' ||
    repositoryIdentity(existing.marketplaceSource.source) !== expected
  )
    throw new Error(`Preserve the existing ${pack.name} marketplace: its source is user-managed.`);
  const source = configured[pack.name];
  if (
    source?.source_type !== 'git' ||
    repositoryIdentity(source.source) !== expected ||
    source.sparse_paths?.length
  )
    throw new Error(
      `Preserve the existing ${pack.name} marketplace: its source configuration differs.`
    );
  const sparse = execute('git', [
    '-C',
    existing.root,
    'config',
    '--type=bool',
    '--default=false',
    '--get',
    'core.sparseCheckout',
  ]).trim();
  if (sparse === 'true')
    throw new Error(`Preserve the Git sparse checkout in the ${pack.name} marketplace.`);
  const changes = execute('git', [
    '-C',
    existing.root,
    'status',
    '--ignored=matching',
    '--porcelain',
    '--untracked-files=all',
  ])
    .split(/\r?\n/)
    .filter(
      line =>
        line &&
        !['?? .codex-marketplace-install.json', '!! .codex-marketplace-install.json'].includes(line)
    );
  const revision = execute('git', ['-C', existing.root, 'rev-parse', 'HEAD']).trim();
  const unpublished = execute('git', [
    '-C',
    existing.root,
    'rev-list',
    '--count',
    '--all',
    '--not',
    '--remotes',
  ]).trim();
  if (changes.length || unpublished !== '0')
    throw new Error(`Preserve local changes in the ${pack.name} marketplace before updating it.`);
  if (source.ref !== ref || revision !== ref)
    execute('codex', ['plugin', 'marketplace', 'remove', pack.name, '--json']);
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
  codexHome = process.env.CODEX_HOME || resolve(home, '.codex'),
  execute = runCommand,
} = {}) {
  const workflow = parse(readFileSync(resolve(project, '.github/workflows/pr-gate.yml'), 'utf8'));
  const gate = workflow.jobs.sections.steps.find(
    step => step.with?.repository === 'immagiov4/Geppetto'
  );
  const pin = gate?.with?.ref;
  if (!/^[a-f\d]{40}$/i.test(pin ?? ''))
    throw new Error('The Geppetto CI gate needs an immutable commit before cloud setup.');
  const { marketplaces } = JSON.parse(
    execute('codex', ['plugin', 'marketplace', 'list', '--json'])
  );
  const configPath = resolve(codexHome, 'config.toml');
  const configured = existsSync(configPath)
    ? (parseToml(readFileSync(configPath, 'utf8')).marketplaces ?? {})
    : {};
  const installed = new Map();
  for (const pack of PACKS) {
    const { name, repository } = pack;
    const ref = name === 'geppetto' ? pin : pack.ref;
    reconcileMarketplace(pack, ref, marketplaces, configured, execute);
    execute('codex', ['plugin', 'marketplace', 'add', repository, '--ref', ref, '--json']);
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
