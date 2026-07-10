import { beforeEach, expect, test, vi } from 'vitest';

import { joinWaitlist, WaitlistRequestError } from '../../../services/marketing/waitlist.ts';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

test('joinWaitlist sends only the normalized email to the public backend route', async () => {
  fetchMock.mockResolvedValue({ ok: true });

  await joinWaitlist('  Student@Example.COM  ');

  expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3301/api/waitlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'student@example.com' }),
  });
});

test.each([
  [400, 'invalid-email'],
  [429, 'rate-limited'],
  [503, 'unavailable'],
] as const)('joinWaitlist maps HTTP %s to a stable error code', async (status, errorCode) => {
  fetchMock.mockResolvedValue({ ok: false, status });

  await expect(joinWaitlist('student@example.com')).rejects.toEqual(
    new WaitlistRequestError(errorCode)
  );
});

test('joinWaitlist maps network failures without exposing their message', async () => {
  fetchMock.mockRejectedValue(new Error('connection details'));

  await expect(joinWaitlist('student@example.com')).rejects.toEqual(
    new WaitlistRequestError('unavailable')
  );
});
