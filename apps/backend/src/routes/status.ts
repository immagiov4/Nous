// Exposes the backend status endpoint.
import { type Request, type Response, Router } from 'express';

import { getStatusSnapshot } from '../services/statusService.js';
import { sendErrorResponse } from '../utils/httpResponses.js';

const router = Router();

/**
 * GET /api/status
 * Get OpenRouter TTS readiness.
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const status = await getStatusSnapshot();
    res.json({
      success: true,
      status,
    });
  } catch (error) {
    console.error('[Status Route] Error:', error);
    sendErrorResponse(res, 500, error, 'Failed to get status');
  }
});

export default router;
