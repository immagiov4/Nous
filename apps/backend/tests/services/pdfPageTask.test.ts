import * as processes from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, vi } from 'vitest';

vi.mock('node:child_process', { spy: true });

import { runPdfPageTask } from '../../src/services/pdfPageTask.js';

const extracted = {
  text: '',
  pages: [],
  sourceHash: 'synthetic',
  parser: 'pdf-parse' as const,
  usedFallbackParser: true,
  outline: [],
  outlineOrigin: 'none' as const,
};

test('returns a safe failure for malformed PDF bytes from the real child', async () => {
  await expect(
    runPdfPageTask(
      Buffer.from('not a PDF'),
      { kind: 'inspect', extracted },
      AbortSignal.timeout(15000)
    )
  ).rejects.toThrow('PDF page processing failed.');
});

test('does not start a child for an already cancelled operation', async () => {
  const reason = new Error('cancelled source');
  const fork = vi.spyOn(processes, 'fork');
  try {
    expect(() =>
      runPdfPageTask(Buffer.alloc(0), { kind: 'inspect', extracted }, AbortSignal.abort(reason))
    ).toThrow(reason);
    expect(fork).not.toHaveBeenCalled();
  } finally {
    fork.mockRestore();
  }
});

test('reaps the actual PDF child before rejecting a cancelled operation', async () => {
  const { fork: original } =
    await vi.importActual<typeof import('node:child_process')>('node:child_process');
  let child: processes.ChildProcess | undefined;
  const fork = vi
    .spyOn(processes, 'fork')
    .mockImplementation((...args: Parameters<typeof processes.fork>) => {
      child = original(...args);
      return child;
    });
  const controller = new AbortController();
  const reason = new Error('source selection cancelled');
  try {
    const bytes = await readFile(new URL('../fixtures/synthetic-proof.pdf', import.meta.url));
    const pending = runPdfPageTask(bytes, { kind: 'inspect', extracted }, controller.signal);
    const rejected = expect(pending).rejects.toBe(reason);
    expect(child).toBeDefined();
    await once(child as processes.ChildProcess, 'spawn');
    controller.abort(reason);
    await rejected;
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
  } finally {
    fork.mockRestore();
    child?.kill('SIGKILL');
  }
});

test('inspects text through the actual Bun backend runtime and Node child', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { stdout } = await promisify(actual.execFile)(
    'bun',
    [fileURLToPath(new URL('../fixtures/pdfPageTaskBunProof.ts', import.meta.url))],
    { windowsHide: true }
  );
  expect(stdout).toContain('"pageCount":1');
});

test('rejects cancellation with an Error when the caller supplied a string reason', async () => {
  const child = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    kill: vi.fn(() => true),
  });
  const fork = vi
    .spyOn(processes, 'fork')
    .mockReturnValue(child as unknown as processes.ChildProcess);
  const controller = new AbortController();
  try {
    const pending = runPdfPageTask(
      Buffer.alloc(0),
      { kind: 'inspect', extracted },
      controller.signal
    );
    const rejected = expect(pending).rejects.toMatchObject({
      message: 'PDF page processing cancelled.',
      cause: 'selection changed',
    });
    controller.abort('selection changed');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null);
    await rejected;
  } finally {
    fork.mockRestore();
  }
});
