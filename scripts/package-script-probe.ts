import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function runFixtureCommand(directory: string, script: string): Promise<string[]> {
  // The fixture executes the developer's Bun installation and repository-owned script names.
  const child = spawn(
    'bun', // NOSONAR: Developer-controlled Bun installation; repository-owned commands only.
    ['run', script],
    {
      cwd: directory,
      env: { ...process.env, CI: 'true', HEAVY_RUN_HELD: '', HEAVY_RUN_GROUP_PID: '' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  await new Promise<void>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolveExit();
      else reject(new Error(`Package fixture exited ${code}: ${stderr}`));
    });
  });
  return stdout
    .trim()
    .split('\n')
    .flatMap(line => JSON.parse(line) as string[]);
}

/** Execute the actual gate/package expressions with observable, service-free leaf commands. */
export async function probePackageScripts(commands: string[]): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), 'nous-package-probe-'));
  try {
    const { scripts } = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const name of ['quality:ci', 'check:fallow:ci', 'test:coverage']) {
      scripts[name] = `bun scripts/probe.mjs ${name}`;
    }
    await mkdir(join(directory, 'scripts'));
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module', scripts }));
    await copyFile(resolve('scripts/heavy-run.mjs'), join(directory, 'scripts/heavy-run.mjs'));
    await copyFile(
      resolve('scripts/heavy-run-process.mjs'),
      join(directory, 'scripts/heavy-run-process.mjs')
    );
    await copyFile(
      resolve('scripts/heavy-run-windows-job.mjs'),
      join(directory, 'scripts/heavy-run-windows-job.mjs')
    );
    await copyFile(
      resolve('scripts/heavy-run-windows-job-lifecycle.mjs'),
      join(directory, 'scripts/heavy-run-windows-job-lifecycle.mjs')
    );
    const probe = `console.log(JSON.stringify(process.argv.slice(2)));`;
    await writeFile(join(directory, 'scripts/probe.mjs'), probe);
    await writeFile(join(directory, 'scripts/run-workflow-postgres-contract.ts'), probe);
    return (await Promise.all(commands.map(script => runFixtureCommand(directory, script)))).flat();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
