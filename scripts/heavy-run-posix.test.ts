import { expect, test } from 'vitest';
import { probePosixLease } from './heavy-run-posix-probe.mjs';

test.skipIf(process.platform === 'win32')(
  'POSIX root exit retains surviving descendants until completion',
  async () => {
    expect(await probePosixLease(false)).toEqual({
      successor: 'admitted',
      descendantRunning: false,
    });
  }
);

test.skipIf(process.platform === 'win32')(
  'POSIX release stops a retained group whose leader has exited',
  async () => {
    expect(await probePosixLease(true)).toEqual({
      successor: 'admitted',
      descendantRunning: false,
    });
  }
);
