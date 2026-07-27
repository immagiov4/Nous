import { type Request, type Response, Router } from 'express';

import { isRecord } from '../utils/validation.js';
import { getWaitlistStore } from '../waitlist/waitlistStore.js';

const EMAIL_MAX_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_LIMIT_MAX_REQUESTS = 6;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const INVALID_EMAIL_MESSAGE = 'Inserisci un indirizzo email valido.';
const WAITLIST_UNAVAILABLE_MESSAGE =
  'La richiesta non è disponibile in questo momento. Riprova più tardi.';

interface RateLimitWindow {
  expiresAt: number;
  requestCount: number;
}

const rateLimitWindows = new Map<string, RateLimitWindow>();

const readNormalizedEmail = (body: unknown): string | null => {
  if (!isRecord(body) || typeof body.email !== 'string') {
    return null;
  }

  const email = body.email.trim().toLowerCase();
  return email.length > 0 && email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email)
    ? email
    : null;
};

const resolveClientKey = (request: Request): string =>
  request.ip || request.socket.remoteAddress || 'unknown-client';

const consumeRateLimit = (clientKey: string, now = Date.now()): boolean => {
  const currentWindow = rateLimitWindows.get(clientKey);
  if (!currentWindow || currentWindow.expiresAt <= now) {
    rateLimitWindows.set(clientKey, {
      expiresAt: now + RATE_LIMIT_WINDOW_MS,
      requestCount: 1,
    });
    return true;
  }

  if (currentWindow.requestCount >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  currentWindow.requestCount += 1;
  return true;
};

export const resetWaitlistRateLimitsForTesting = (): void => {
  rateLimitWindows.clear();
};

const router = Router();

router.post('/', async (request: Request, response: Response) => {
  if (!consumeRateLimit(resolveClientKey(request))) {
    response.status(429).json({
      success: false,
      error: 'Hai inviato troppe richieste. Riprova tra qualche minuto.',
    });
    return;
  }

  const email = readNormalizedEmail(request.body);
  if (!email) {
    response.status(400).json({ success: false, error: INVALID_EMAIL_MESSAGE });
    return;
  }

  try {
    await getWaitlistStore().add(email);
    response.json({ success: true });
  } catch (error) {
    console.error('[Nous][Waitlist] Failed to store a waitlist request.', error);
    response.status(503).json({ success: false, error: WAITLIST_UNAVAILABLE_MESSAGE });
  }
});

export default router;
