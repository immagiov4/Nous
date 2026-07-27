import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createApp } from '../../src/index.js';
import { resetWaitlistRateLimitsForTesting } from '../../src/routes/waitlist.js';
import {
  setWaitlistStoreForTesting,
  type WaitlistStore,
} from '../../src/waitlist/waitlistStore.js';

const addWaitlistEntry = vi.fn<WaitlistStore['add']>();

describe('POST /api/waitlist', () => {
  beforeEach(() => {
    addWaitlistEntry.mockReset();
    addWaitlistEntry.mockResolvedValue(undefined);
    setWaitlistStoreForTesting({ add: addWaitlistEntry });
    resetWaitlistRateLimitsForTesting();
  });

  afterEach(() => {
    setWaitlistStoreForTesting(null);
    resetWaitlistRateLimitsForTesting();
  });

  test('accepts and normalizes a valid email without authentication', async () => {
    const response = await request(createApp()).post('/api/waitlist').send({
      email: '  Student@Example.COM  ',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(addWaitlistEntry).toHaveBeenCalledWith('student@example.com');
  });

  test.each([
    '',
    'missing-at.example.com',
    'name@localhost',
    `${'a'.repeat(250)}@example.com`,
  ])('rejects invalid public input: %s', async email => {
    const response = await request(createApp()).post('/api/waitlist').send({ email });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: 'Inserisci un indirizzo email valido.',
    });
    expect(addWaitlistEntry).not.toHaveBeenCalled();
  });

  test('does not expose database errors to public visitors', async () => {
    addWaitlistEntry.mockRejectedValue(new Error('postgres connection secret'));

    const response = await request(createApp())
      .post('/api/waitlist')
      .send({ email: 'student@example.com' });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      success: false,
      error: 'La richiesta non è disponibile in questo momento. Riprova più tardi.',
    });
    expect(JSON.stringify(response.body)).not.toContain('postgres');
  });

  test('rate limits repeated public submissions by client', async () => {
    const app = createApp();
    const acceptedResponses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        request(app)
          .post('/api/waitlist')
          .send({ email: `student${index}@example.com` })
      )
    );
    const limitedResponse = await request(app)
      .post('/api/waitlist')
      .send({ email: 'another@example.com' });

    expect(acceptedResponses.every(response => response.status === 200)).toBe(true);
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.body).toEqual({
      success: false,
      error: 'Hai inviato troppe richieste. Riprova tra qualche minuto.',
    });
    expect(addWaitlistEntry).toHaveBeenCalledTimes(6);
  });
});
