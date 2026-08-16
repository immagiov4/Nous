import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const statusServiceMocks = vi.hoisted(() => ({
  getStatusSnapshot: vi.fn(),
}));

vi.mock('../../src/services/statusService.js', () => ({
  getStatusSnapshot: statusServiceMocks.getStatusSnapshot,
}));

const { createApp } = await import('../../src/index.js');

describe('GET /api/status', () => {
  beforeEach(() => {
    statusServiceMocks.getStatusSnapshot.mockReset();
    statusServiceMocks.getStatusSnapshot.mockResolvedValue({
      currentDevice: 'cpu',
      healthMessage: 'healthy',
      isReady: true,
      isRunning: true,
      modelLoaded: true,
      restartAttempts: 0,
      uptime: 42,
    });
  });

  test('returns the current status snapshot', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const response = await request(createApp()).get('/api/status');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      status: expect.objectContaining({
        currentDevice: 'cpu',
        healthMessage: 'healthy',
        isReady: true,
        uptime: 42,
      }),
    });
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('GET /api/status'));
    logSpy.mockRestore();
  });

  test('maps service errors to a 500 response', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    statusServiceMocks.getStatusSnapshot.mockRejectedValueOnce(new Error('status failed'));

    const response = await request(createApp()).get('/api/status');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      success: false,
      error: 'status failed',
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"lifecycle"'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"method":"GET"'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"path":"/api/status"'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"statusCode":500'));
    errorSpy.mockRestore();
  });
});
