import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { setupCodexCloud } from './setup-codex-cloud.mjs';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nous-codex-cloud-'));
  directories.push(root);
  const project = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(join(project, '.github/workflows'), { recursive: true });
  mkdirSync(join(project, '.geppetto'), { recursive: true });
  mkdirSync(home);
  writeFileSync(
    join(project, '.github/workflows/pr-gate.yml'),
    'jobs:\n  sections:\n    steps:\n      - with:\n          repository: immagiov4/Geppetto\n          ref: 0123456789abcdef0123456789abcdef01234567\n'
  );
  writeFileSync(
    join(project, '.geppetto/config.json'),
    JSON.stringify({ memory: { buckets: ['nous'] } })
  );
  const skills = [
    ['geppetto', 'geppetto-build'],
    ['my-codex-skills', 'engineering-workflow'],
    ['my-codex-skills', 'principle-boundary-discipline'],
    ['my-codex-skills', 'principle-build-the-lever'],
    ['my-codex-skills', 'principle-encode-lessons-in-structure'],
    ['my-codex-skills', 'principle-exhaust-the-design-space'],
    ['my-codex-skills', 'principle-explain-the-number'],
    ['my-codex-skills', 'principle-fix-root-causes'],
    ['my-codex-skills', 'principle-foundational-thinking'],
    ['my-codex-skills', 'principle-laziness-protocol'],
    ['my-codex-skills', 'principle-outcome-oriented-execution'],
    ['my-codex-skills', 'principle-prove-it-works'],
    ['my-codex-skills', 'principle-redesign-from-first-principles'],
    ['my-codex-skills', 'principle-separate-before-serializing-shared-state'],
    ['my-codex-skills', 'principle-sequence-verifiable-units'],
    ['my-codex-skills', 'principle-subtract-before-you-add'],
    ['my-codex-skills', 'principle-test-behavior-not-implementation'],
    ['ponytail', 'ponytail'],
  ].map(([name, skill]) => {
    const path = join(root, name, 'skills', skill, 'SKILL.md');
    mkdirSync(join(root, name, 'skills', skill), { recursive: true });
    writeFileSync(path, `---\nname: ${skill}\n---\n`);
    return { name: `${name}:${skill}`, enabled: true, path };
  });
  const server = join(root, 'geppetto/skills/geppetto-adopt/scripts/codex-hook-trust.mjs');
  mkdirSync(join(root, 'geppetto/skills/geppetto-adopt/scripts'), { recursive: true });
  const inventory = { data: [{ cwd: project, skills, errors: [] }] };
  writeFileSync(
    server,
    `export function connectCodex() { return { initialize: async () => {}, request: async () => (${JSON.stringify(inventory)}), close: async () => {} }; }`
  );
  const run = (command: string, args: string[]) => {
    if (command === 'codex' && args[1] === 'marketplace' && args[2] === 'list')
      return JSON.stringify({ marketplaces: [] });
    if (command === 'git' && args.includes('rev-list')) return '0\n';
    if (command === 'git' && args.includes('rev-parse'))
      return JSON.parse(readFileSync(join(args[1], '.codex-marketplace-install.json'), 'utf8'))
        .revision;
    if (command === 'git' && args.includes('get-url'))
      return 'https://github.com/immagiov4/llm-memories.git\n';
    if (command === 'codex' && args[1] === 'add')
      return JSON.stringify({ installedPath: join(root, args[2].split('@')[0]) });
    return '{}';
  };
  const execute = vi.fn(run);
  return { root, project, home, execute, server, run };
}

test('installs the requested packs and scopes trust to their installed hook files', async () => {
  const { project, home, execute, root } = fixture();
  await setupCodexCloud({ project, home, codexHome: join(home, '.codex'), execute });
  const calls = execute.mock.calls;
  expect(calls).toContainEqual([
    'codex',
    [
      'plugin',
      'marketplace',
      'add',
      'immagiov4/Geppetto',
      '--ref',
      '0123456789abcdef0123456789abcdef01234567',
      '--json',
    ],
  ]);
  for (const name of ['geppetto', 'my-codex-skills', 'ponytail']) {
    expect(calls).toContainEqual(['codex', ['plugin', 'add', `${name}@${name}`, '--json']]);
  }
  for (const [repository, ref] of [
    ['immagiov4/my-codex-skills', 'ba2d9376617439437db32982c58b4db8a8fbfdce'],
    ['DietrichGebert/ponytail', '96608e078b2d5ea607c5c3b8b5a54d1c1fba6846'],
  ])
    expect(calls).toContainEqual([
      'codex',
      ['plugin', 'marketplace', 'add', repository, '--ref', ref, '--json'],
    ]);
  const trust = calls.filter(([, args]) => args.includes('--approve'));
  expect(trust).toHaveLength(2);
  expect(trust.every(([, args]) => args.includes('--plugin'))).toBe(true);
  expect(trust.map(([, args]) => args[args.indexOf('--plugin') + 1])).toEqual([
    'geppetto@geppetto',
    'ponytail@ponytail',
  ]);
  expect(
    calls.some(
      ([, args]) =>
        args[0] === join(root, 'geppetto/skills/geppetto-adopt/scripts/install.mjs') &&
        args.includes('--plugin-hooks')
    )
  ).toBe(true);
});

test('preserves an existing machine memory choice and unrelated configuration', async () => {
  const { project, home, execute } = fixture();
  mkdirSync(join(home, '.geppetto'));
  const original = { memory: { choice: 'native' }, existing: { owner: 'user' } };
  writeFileSync(join(home, '.geppetto/config.json'), JSON.stringify(original));
  await setupCodexCloud({ project, home, codexHome: join(home, '.codex'), execute });
  expect(JSON.parse(readFileSync(join(home, '.geppetto/config.json'), 'utf8'))).toEqual(original);
  expect(execute.mock.calls.some(([command]) => command === 'git')).toBe(false);
});

test('stops installation before approving hooks when a marketplace fails', async () => {
  const { project, home, execute } = fixture();
  execute.mockImplementation(() => {
    throw new Error('marketplace unavailable');
  });
  await expect(
    setupCodexCloud({ project, home, codexHome: join(home, '.codex'), execute })
  ).rejects.toThrow('marketplace unavailable');
  expect(execute).toHaveBeenCalledTimes(1);
});

test('rejects installed packs when their skills are absent from native discovery', async () => {
  const { project, home, execute, server } = fixture();
  writeFileSync(
    server,
    `export function connectCodex() { return { initialize: async () => {}, request: async () => ({ data: [{ cwd: ${JSON.stringify(project)}, skills: [], errors: [] }] }), close: async () => {} }; }`
  );
  await expect(
    setupCodexCloud({ project, home, codexHome: join(home, '.codex'), execute })
  ).rejects.toThrow('Installed skill is not invocable');
});

test('retries sparse preparation after clone succeeds but bucket checkout fails', async () => {
  const { project, home, execute, run } = fixture();
  let interrupted = true;
  execute.mockImplementation((command, args) => {
    if (command === 'git' && args[0] === 'clone')
      mkdirSync(join(home, 'geppetto-memory/.git'), { recursive: true });
    if (command === 'git' && args.includes('sparse-checkout') && interrupted) {
      interrupted = false;
      throw new Error('interrupted checkout');
    }
    return run(command, args);
  });
  await expect(
    setupCodexCloud({ project, home, codexHome: join(home, '.codex'), execute })
  ).rejects.toThrow('interrupted checkout');
  expect(existsSync(join(home, '.geppetto/config.json'))).toBe(false);
  await setupCodexCloud({ project, home, codexHome: join(home, '.codex'), execute });
  expect(
    execute.mock.calls.filter(([command, args]) => command === 'git' && args[0] === 'clone')
  ).toHaveLength(1);
  expect(
    execute.mock.calls.filter(
      ([command, args]) => command === 'git' && args.includes('sparse-checkout')
    )
  ).toHaveLength(2);
});

test('rejects an unrelated existing checkout before changing user configuration', async () => {
  const { project, home, execute, run } = fixture();
  mkdirSync(join(home, 'geppetto-memory/.git'), { recursive: true });
  mkdirSync(join(home, '.geppetto'));
  const original = JSON.stringify({ existing: { owner: 'user' } });
  writeFileSync(join(home, '.geppetto/config.json'), original);
  execute.mockImplementation((command, args) =>
    command === 'git' && args.includes('get-url')
      ? 'https://github.com/example/unrelated.git\n'
      : run(command, args)
  );
  await expect(
    setupCodexCloud({ project, home, codexHome: join(home, '.codex'), execute })
  ).rejects.toThrow('memory repository');
  expect(readFileSync(join(home, '.geppetto/config.json'), 'utf8')).toBe(original);
  expect(execute.mock.calls.some(([, args]) => args.includes('sparse-checkout'))).toBe(false);
});

test.skipIf(process.platform === 'win32')(
  'keeps cloud temporary fixtures outside the checkout Git ancestry',
  () => {
    const { root, project } = fixture();
    expect(spawnSync('git', ['init', '-q'], { cwd: root, windowsHide: true }).status).toBe(0);
    expect(spawnSync('git', ['init', '-q'], { cwd: project, windowsHide: true }).status).toBe(0);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const supervisor = join(bin, 'docker-init');
    writeFileSync(
      supervisor,
      `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2);if(args[0]!=='-s'||args[1]!=='--')process.exit(2);const child=spawnSync(args[2],args.slice(3),{stdio:'inherit'});process.exit(child.status??1);`
    );
    const bun = join(bin, 'bun');
    writeFileSync(
      bun,
      `#!${process.execPath}\nconst {mkdtempSync,writeFileSync}=require('node:fs');const {tmpdir}=require('node:os');const {join}=require('node:path');const {spawnSync}=require('node:child_process');const path=mkdtempSync(join(tmpdir(),'ancestry-'));const result=spawnSync('git',['rev-parse','--is-inside-work-tree'],{cwd:path});writeFileSync(process.env.CLOUD_PROBE_OUTPUT,JSON.stringify({inGit:result.status===0}));`
    );
    chmodSync(supervisor, 0o755);
    chmodSync(bun, 0o755);
    const output = join(root, 'probe.json');
    const command = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      .scripts['gate:cloud'];
    const child = spawnSync('sh', ['-c', command], {
      cwd: project,
      windowsHide: true,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLOUD_PROBE_OUTPUT: output },
    });
    expect(child.status, child.stderr.toString()).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8')).inGit).toBe(false);
  }
);

test('reuses the existing GitHub memory transport instead of mistaking SSH for another repository', async () => {
  const { project, home, execute, run } = fixture();
  const repository = 'git@github.com:immagiov4/llm-memories.git';
  mkdirSync(join(home, 'geppetto-memory/.git'), { recursive: true });
  for (const bucket of ['preferences', 'nous']) {
    mkdirSync(join(home, 'geppetto-memory/buckets', bucket), { recursive: true });
    writeFileSync(join(home, 'geppetto-memory/buckets', bucket, 'index.md'), '# Existing index');
  }
  execute.mockImplementation((command, args) =>
    command === 'git' && args.includes('get-url') ? repository : run(command, args)
  );
  await setupCodexCloud({ project, home, codexHome: join(home, '.codex'), execute });
  expect(JSON.parse(readFileSync(join(home, '.geppetto/config.json'), 'utf8')).memory.repo).toBe(
    repository
  );
  expect(execute.mock.calls.some(([, args]) => args.includes('sparse-checkout'))).toBe(false);
});

test.each([
  ['my-codex-skills', 'engineering-workflow'],
  ['my-codex-skills', 'principle-test-behavior-not-implementation'],
  ['ponytail', 'ponytail'],
])('rejects a pack missing the required %s:%s source', async (pack, skill) => {
  const { root, project, home, execute } = fixture();
  rmSync(join(root, pack, 'skills', skill), { recursive: true });
  await expect(
    setupCodexCloud({ project, home, codexHome: join(home, '.codex'), execute })
  ).rejects.toThrow(`Required skill is missing: ${pack}:${skill}`);
});

function existingMarketplace(root: string, ref: string) {
  const checkout = join(root, 'existing-geppetto');
  mkdirSync(checkout);
  mkdirSync(join(root, 'home/.codex'));
  writeFileSync(
    join(root, 'home/.codex/config.toml'),
    `[marketplaces.geppetto]\nsource_type = "git"\nsource = "https://github.com/immagiov4/Geppetto.git"\nref = "${ref}"\n`
  );
  writeFileSync(
    join(checkout, '.codex-marketplace-install.json'),
    JSON.stringify({
      source_type: 'git',
      source: 'https://github.com/immagiov4/Geppetto.git',
      ref_name: ref,
      revision: ref,
    })
  );
  return {
    name: 'geppetto',
    root: checkout,
    marketplaceSource: {
      sourceType: 'git',
      source: 'https://github.com/immagiov4/Geppetto.git',
    },
  };
}

test('replaces a clean owned marketplace when the reviewed pin changes', async () => {
  const { root, project, home, execute, run } = fixture();
  const existing = existingMarketplace(root, 'a'.repeat(40));
  let removed = false;
  execute.mockImplementation((command, args) => {
    if (command === 'codex' && args[2] === 'list')
      return JSON.stringify({ marketplaces: [existing] });
    if (command === 'git' && args.includes('status')) return '?? .codex-marketplace-install.json\n';
    if (command === 'codex' && args[2] === 'remove') removed = true;
    if (command === 'codex' && args[2] === 'add' && args[3] === 'immagiov4/Geppetto' && !removed)
      throw new Error('marketplace source conflict');
    return run(command, args);
  });
  await setupCodexCloud({ project, home, codexHome: join(home, '.codex'), execute });
  expect(execute.mock.calls).toContainEqual([
    'codex',
    ['plugin', 'marketplace', 'remove', 'geppetto', '--json'],
  ]);
});

test('reuses a clean marketplace already at the reviewed pin', async () => {
  const { root, project, home, execute, run } = fixture();
  const existing = existingMarketplace(root, '0123456789abcdef0123456789abcdef01234567');
  rmSync(join(existing.root, '.codex-marketplace-install.json'));
  execute.mockImplementation((command, args) => {
    if (command === 'codex' && args[2] === 'list')
      return JSON.stringify({ marketplaces: [existing] });
    if (command === 'git' && args.includes('rev-parse'))
      return '0123456789abcdef0123456789abcdef01234567';
    if (command === 'git' && args.includes('status')) return '?? .codex-marketplace-install.json\n';
    return run(command, args);
  });
  await setupCodexCloud({ project, home, codexHome: join(home, '.codex'), execute });
  expect(execute.mock.calls.some(([, args]) => args[2] === 'remove')).toBe(false);
});

test.each([
  'foreign source',
  'local edits',
  'local commits',
  'sparse configuration',
])('preserves an occupied marketplace with %s', async state => {
  const { root, project, home, execute, run } = fixture();
  const existing = existingMarketplace(root, 'a'.repeat(40));
  if (state === 'foreign source')
    existing.marketplaceSource.source = 'https://github.com/other/Geppetto.git';
  if (state === 'sparse configuration') {
    const config = join(home, '.codex/config.toml');
    writeFileSync(
      config,
      `${readFileSync(config, 'utf8')}sparse_paths = ["skills/geppetto-build"]\n`
    );
  }
  execute.mockImplementation((command, args) => {
    if (command === 'codex' && args[2] === 'list')
      return JSON.stringify({ marketplaces: [existing] });
    if (command === 'git' && args.includes('status'))
      return state === 'local edits' ? ' M skills/geppetto-build/SKILL.md\n' : '';
    if (command === 'git' && args.includes('rev-list'))
      return state === 'local commits' ? '1\n' : '0\n';
    return run(command, args);
  });
  await expect(
    setupCodexCloud({ project, home, codexHome: join(home, '.codex'), execute })
  ).rejects.toThrow(/preserve|local changes/i);
  expect(
    execute.mock.calls.some(([, args]) => args[2] === 'remove' || args.includes('--approve'))
  ).toBe(false);
});

test.each([
  'unpublished branch',
  'ignored file',
  'Git sparse checkout',
])('preserves a real checkout containing %s', async state => {
  const { root, project, home, execute, run } = fixture();
  const existing = existingMarketplace(root, 'a'.repeat(40));
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', existing.root, ...args], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(existing.root, '.gitignore'), '.env\n');
  git('add', '.gitignore');
  git('commit', '-m', 'baseline');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  if (state === 'unpublished branch') {
    git('checkout', '-b', 'local-work');
    git('commit', '--allow-empty', '-m', 'unpublished work');
    git('checkout', 'main');
  } else if (state === 'ignored file') {
    writeFileSync(join(existing.root, '.env'), 'SYNTHETIC_FIXTURE=keep\n');
  } else {
    git('config', 'core.sparseCheckout', 'true');
  }
  const before = git('show-ref');
  execute.mockImplementation((command, args) => {
    if (command === 'codex' && args[2] === 'list')
      return JSON.stringify({ marketplaces: [existing] });
    if (command === 'git' && args[0] === '-C' && args[1] === existing.root)
      return git(...args.slice(2));
    return run(command, args);
  });
  await expect(
    setupCodexCloud({ project, home, codexHome: join(home, '.codex'), execute })
  ).rejects.toThrow(/preserve/i);
  expect(execute.mock.calls.some(([, args]) => args[2] === 'remove')).toBe(false);
  expect(git('show-ref')).toBe(before);
  if (state === 'ignored file')
    expect(readFileSync(join(existing.root, '.env'), 'utf8')).toBe('SYNTHETIC_FIXTURE=keep\n');
});
