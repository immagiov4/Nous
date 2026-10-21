import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { expect, it } from 'vitest';
import * as z from 'zod';
import { prepareIsolatedProof } from '../../../scripts/isolated-proof-supabase';

it('builds a dedicated UUID project with distinct OS-selected ports and the checkout SQL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nous-isolated-proof-'));
  try {
    await mkdir(join(root, 'checkout/supabase/migrations'), { recursive: true });
    const sql = 'create table public.branch_only (id integer);\n';
    await writeFile(join(root, 'checkout/supabase/migrations/20990101000000_branch.sql'), sql);
    const first = await prepareIsolatedProof(join(root, 'checkout'), join(root, 'state'));
    const second = await prepareIsolatedProof(join(root, 'checkout'), join(root, 'state'));
    expect(z.uuid().parse(first.project)).toBe(first.project);
    expect(second.project).not.toBe(first.project);
    const config = parse(await readFile(join(first.workdir, 'supabase/config.toml'), 'utf8'));
    expect(config.project_id).toBe(first.project);
    const api = config.api as { port: number };
    const db = config.db as { port: number; shadow_port: number };
    expect(new Set([api.port, db.port, db.shadow_port]).size).toBe(3);
    expect(
      [api.port, db.port, db.shadow_port].every(port => Number.isInteger(port) && port > 0)
    ).toBe(true);
    expect(
      await readFile(join(first.workdir, 'supabase/migrations/20990101000000_branch.sql'), 'utf8')
    ).toBe(sql);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
