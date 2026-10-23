import * as processes from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve, sep } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('node:child_process', { spy: true });

import { alignRecording } from '../../../src/services/lessonPlayback/alignRecording.js';

const directories = new Set<string>();
const input = {
  bytes: new Uint8Array([73, 68, 51]),
  speech: 'Prima parola.',
  durationSeconds: 2,
};
const fragments = [
  { begin: '0.1', lines: ['Prima'] },
  { begin: '1.2', lines: ['parola.'] },
];

async function launch(signal = new AbortController().signal) {
  const child = new EventEmitter();
  const started = Promise.withResolvers<{
    command: string;
    args: string[];
    options: processes.SpawnOptions;
  }>();
  vi.spyOn(processes, 'spawn').mockImplementation((command, args, options) => {
    started.resolve({
      command,
      args: args as string[],
      options: options as processes.SpawnOptions,
    });
    return child as processes.ChildProcess;
  });
  const operation = alignRecording({ ...input, signal });
  const call = await started.promise;
  const directory = dirname(call.args[2]);
  directories.add(directory);
  return { child, operation, call, directory };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories) {
    expect(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`)).toBe(true);
    expect(basename(directory).startsWith('nous-alignment-')).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
  directories.clear();
});

test('passes canonical words and recording bytes to the child and returns word onsets', async () => {
  vi.stubEnv('AENEAS_PYTHON', 'configured-python');
  const task = await launch();
  expect(task.call.command).toBe('configured-python');
  expect(task.call.args.slice(0, 2)).toEqual(['-m', 'aeneas.tools.execute_task']);
  expect(task.call.args.slice(4)).toEqual([
    'task_language=ita|is_text_type=plain|os_task_file_format=json',
    task.call.args[5],
    '--presets-word',
  ]);
  expect(task.call.options).toMatchObject({ windowsHide: true, stdio: 'ignore' });
  expect(await readFile(task.call.args[2])).toEqual(Buffer.from(input.bytes));
  expect(await readFile(task.call.args[3], 'utf8')).toBe('Prima\nparola.');
  await writeFile(task.call.args[5], JSON.stringify({ fragments }));
  task.child.emit('close', 0);
  await expect(task.operation).resolves.toEqual({ status: 'aligned', onsets: [0.1, 1.2] });
  await expect(access(task.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each([
  null,
  false,
  'unexpected',
  {},
  { fragments: [] },
  { fragments: null },
  { fragments: [null] },
  { fragments: [true] },
  { fragments: [{ lines: ['Prima'] }] },
  { fragments: [{ begin: '0' }] },
  { fragments: [{ begin: '0', lines: 'Prima' }] },
  { fragments: [{ begin: '0', lines: ['Prima', 'parola.'] }] },
  { fragments: [{ begin: '0', lines: ['Different'] }] },
  { fragments: [{ begin: '0', lines: ['Prima'] }] },
  { fragments: [{ ...fragments[0], begin: '-1' }, fragments[1]] },
  { fragments: [fragments[0], { ...fragments[1], begin: 'NaN' }] },
  { fragments: [fragments[0], { ...fragments[1], begin: '3' }] },
  {
    fragments: [
      { ...fragments[0], begin: '1.2' },
      { ...fragments[1], begin: '0.1' },
    ],
  },
  { fragments: [...fragments, { begin: '1.8', lines: ['extra'] }] },
])('rejects unusable external alignment output and removes its files (%j)', async result => {
  const task = await launch();
  await writeFile(task.call.args[5], JSON.stringify(result));
  task.child.emit('close', 0);
  await expect(task.operation).rejects.toThrow(
    /Invalid alignment|Alignment does not match|Invalid recording/
  );
  await expect(access(task.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('removes intermediates when the child writes invalid JSON', async () => {
  const task = await launch();
  await writeFile(task.call.args[5], '{');
  task.child.emit('close', 0);
  await expect(task.operation).rejects.toBeInstanceOf(SyntaxError);
  await expect(access(task.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('waits for the child to close before reporting a spawn failure and cleaning files', async () => {
  const task = await launch();
  const reason = new Error('Synthetic process launch failure');
  let settled = false;
  const rejected = expect(task.operation).rejects.toBe(reason);
  void task.operation.catch(() => {
    settled = true;
  });
  task.child.emit('error', reason);
  await Promise.resolve();
  expect(settled).toBe(false);
  expect((await stat(task.directory)).isDirectory()).toBe(true);
  task.child.emit('close', null);
  await rejected;
  await expect(access(task.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('rejects an unsuccessful child without accepting an output file', async () => {
  const task = await launch();
  task.child.emit('close', 2);
  await expect(task.operation).rejects.toThrow('Recording alignment failed.');
  await expect(access(task.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('honors cancellation before creating a child', async () => {
  const spawn = vi.spyOn(processes, 'spawn');
  const reason = new Error('Recording replaced');
  await expect(alignRecording({ ...input, signal: AbortSignal.abort(reason) })).rejects.toBe(
    reason
  );
  expect(spawn).not.toHaveBeenCalled();
});

test('discards a completed child result when its recording was cancelled', async () => {
  const controller = new AbortController();
  const task = await launch(controller.signal);
  expect(task.call.options.signal).toBe(controller.signal);
  const reason = new Error('Recording replaced');
  controller.abort(reason);
  task.child.emit('close', 0);
  await expect(task.operation).rejects.toBe(reason);
  await expect(access(task.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
