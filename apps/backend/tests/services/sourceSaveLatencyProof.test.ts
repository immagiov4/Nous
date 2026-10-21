import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';

// The server must run in Bun itself, rather than Vitest's Node worker.
test.runIf(process.env.NOUS_398_LATENCY_PROOF === '1')(
  'keeps project saves below their deadline during real scanned-source preparation',
  async () => {
    await promisify(execFile)(
      'bun',
      [fileURLToPath(new URL('../fixtures/sourceLatencyBunProof.ts', import.meta.url))],
      { windowsHide: true }
    );
  },
  300_000
);
