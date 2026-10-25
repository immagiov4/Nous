import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const EXIT_POLL_MS = 20;
export const WINDOWS_JOB_SCRIPT = fileURLToPath(
  new URL('./heavy-run-windows-job.mjs', import.meta.url)
);
let nativeJobRunning;
let nativeStopJob;
if (process.platform === 'win32' && process.versions.bun) {
  const { jobRunning, stopJob } = await import('./heavy-run-windows-job.mjs');
  nativeJobRunning = jobRunning;
  nativeStopJob = stopJob;
}

/** Node callers use the same Bun FFI helper; no PID ancestry approximation is involved. */
export function windowsJobRunning(name) {
  if (nativeJobRunning) return nativeJobRunning(name);
  return query('bun', [WINDOWS_JOB_SCRIPT, 'query', name]) === 'true';
}

export async function waitWindowsJob(name) {
  while (windowsJobRunning(name)) await delay(EXIT_POLL_MS);
}

export async function stopWindowsJob(name) {
  if (nativeStopJob) return nativeStopJob(name);
  query('bun', [WINDOWS_JOB_SCRIPT, 'stop', name], 'Failed to stop the Windows lease Job.');
}
const bootId =
  process.platform === 'linux'
    ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    : '';

function linuxProcess(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // After pid/comm: state is field 3, pgrp is 5, and boot-relative starttime is 22.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], group: Number(fields[2]), identity: `${bootId}:${fields[19]}` };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    throw error;
  }
}

function query(command, args, failure = 'Cannot inspect the lease process identity.') {
  const result = spawnSync(command, args, { windowsHide: true, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(failure);
  return result.stdout.trim();
}

/** Read the OS creation identity, independent of the reusable numeric PID. */
export function processIdentity(pid, registeredAt) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid lease process identifier.');
  if (process.platform === 'linux') return linuxProcess(pid)?.identity ?? null;
  if (process.platform === 'win32') {
    // A process born after registration cannot be the spawned worker, even during capture.
    const creationLimit =
      registeredAt === undefined
        ? '$true'
        : `$started -lt [DateTimeOffset]::FromUnixTimeMilliseconds(${registeredAt + 1}).UtcDateTime`;
    return (
      query(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference='Stop'; try { $p=[System.Diagnostics.Process]::GetProcessById(${pid}); $started=$p.StartTime.ToUniversalTime(); if (${creationLimit}) { $started.Ticks.ToString() } } catch [System.ArgumentException] { exit 0 } catch { if ($p.HasExited) { exit 0 }; throw }`,
      ]) || null
    );
  }
  return query('ps', ['-p', String(pid), '-o', 'lstart=']) || null;
}

/** Zombies have exited and perform no work, even while kill(pid, 0) still succeeds. */
export function processRunning(pid) {
  if (process.platform === 'linux') {
    const record = linuxProcess(pid);
    return Boolean(record && record.state !== 'Z' && record.state !== 'X');
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export function processTreeRunning(group) {
  if (process.platform === 'win32') return processRunning(group);
  if (process.platform === 'linux') {
    return readdirSync('/proc')
      .filter(name => /^\d+$/u.test(name))
      .some(pid => {
        const record = linuxProcess(pid);
        return record?.group === group && !['Z', 'X'].includes(record.state);
      });
  }
  return query('ps', ['-axo', 'pgid=,stat='])
    .split('\n')
    .some(line => {
      const [pid, state] = line.trim().split(/\s+/u);
      return Number(pid) === group && !state.startsWith('Z');
    });
}

/** Stop the owned tree and retain capacity until every group member has ceased work. */
export async function stopChild(
  child,
  ownedGroupPid = process.env.HEAVY_RUN_GROUP_PID || child?.pid
) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const code = await new Promise((resolve, reject) => {
      const killer = spawn(
        join(process.env.SystemRoot, 'System32/taskkill.exe'),
        ['/pid', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' }
      );
      killer.once('error', reject);
      killer.once('exit', resolve);
    });
    if (code !== 0 && processRunning(child.pid))
      throw new Error('Failed to stop the lease command tree.');
    while (processRunning(child.pid)) await delay(EXIT_POLL_MS);
    return;
  }
  const group = Number(ownedGroupPid);
  if (!Number.isSafeInteger(group) || group <= 0)
    throw new Error('Invalid heavy-run process group.');
  try {
    process.kill(-group, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  while (processTreeRunning(group)) await delay(EXIT_POLL_MS);
}
