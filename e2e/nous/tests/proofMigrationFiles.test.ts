import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  checkoutTracksMain,
  proofMigrationSnapshot,
  stageSharedStartup,
} from '../../../scripts/proof-migrations';

const execute = promisify(execFile);
it('compares real checkout bytes with a frozen main tree and starts with no application SQL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nous-migration-files-'));
  const git = async (...args: string[]) =>
    execute('git', ['-C', root, ...args], { windowsHide: true });
  try {
    await mkdir(join(root, 'supabase/migrations'), { recursive: true });
    await mkdir(join(root, 'supabase/templates'));
    await mkdir(join(root, 'state'));
    const migration = join(root, 'supabase/migrations/20261020190000_main.sql');
    const original = 'create table public.main_table (id integer);\n';
    await writeFile(migration, original);
    await writeFile(join(root, 'supabase/config.toml'), 'project_id = "nous-reader"\n');
    await writeFile(join(root, 'supabase/templates/invite.html'), '<p>Invite</p>');
    await git('init');
    await git('-c', 'core.autocrlf=false', 'add', '.');
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'core.hooksPath=',
      'commit',
      '-m',
      'Synthetic migration fixture'
    );
    await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const frozen = await proofMigrationSnapshot(root);
    expect(checkoutTracksMain(frozen)).toBe(true);
    await writeFile(migration, 'create table public.changed_table (id integer);\n');
    expect(checkoutTracksMain(await proofMigrationSnapshot(root))).toBe(false);
    expect(frozen.main[0].sql).toBe(original);
    await writeFile(migration, original);
    await writeFile(
      join(root, 'supabase/migrations/20990101000000_branch.sql'),
      'create table public.branch_table (id integer);\n'
    );
    expect(checkoutTracksMain(await proofMigrationSnapshot(root))).toBe(false);
    const startup = await stageSharedStartup(root, join(root, 'state'));
    expect(await readdir(join(startup, 'supabase/migrations'))).toEqual([]);
    expect(await readFile(join(startup, 'supabase/config.toml'), 'utf8')).toBe(
      'project_id = "nous-reader"\n'
    );
    expect(await readFile(join(startup, 'supabase/templates/invite.html'), 'utf8')).toBe(
      '<p>Invite</p>'
    );
    await writeFile(join(root, 'supabase/migrations/20261020190000_duplicate.sql'), original);
    await expect(proofMigrationSnapshot(root)).rejects.toThrow('Duplicate migration versions');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
