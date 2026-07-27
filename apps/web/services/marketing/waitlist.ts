import { getBackendUrl } from '../openrouter/config.ts';

export type WaitlistErrorCode = 'invalid-email' | 'rate-limited' | 'unavailable';

export class WaitlistRequestError extends Error {
  readonly code: WaitlistErrorCode;

  constructor(code: WaitlistErrorCode) {
    super(code);
    this.name = 'WaitlistRequestError';
    this.code = code;
  }
}

const getWaitlistErrorCode = (status: number): WaitlistErrorCode => {
  if (status === 400) {
    return 'invalid-email';
  }

  if (status === 429) {
    return 'rate-limited';
  }

  return 'unavailable';
};

export const joinWaitlist = async (email: string): Promise<void> => {
  try {
    const response = await fetch(`${getBackendUrl()}/api/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim().toLowerCase() }),
    });

    if (!response.ok) {
      throw new WaitlistRequestError(getWaitlistErrorCode(response.status));
    }
  } catch (error) {
    if (error instanceof WaitlistRequestError) {
      throw error;
    }

    throw new WaitlistRequestError('unavailable');
  }
};
