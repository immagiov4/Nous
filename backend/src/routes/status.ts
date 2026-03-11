import { Router, type Request, type Response } from 'express';

import { getStatusSnapshot, startTtsServer, stopTtsServer } from '../services/statusService.js';
import { sendErrorResponse } from '../utils/httpResponses.js';

const router = Router();

/**
 * GET /api/status
 * Get TTS server status
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

/**
 * POST /api/status/start
 * Start the TTS server
 */
router.post('/start', async (_req: Request, res: Response) => {
  try {
    const result = await startTtsServer();

    if (result.alreadyRunning) {
      return res.json({ 
        success: true, 
        message: 'TTS server is already running' 
      });
    }

    if (result.started) {
      return res.json({ 
        success: true, 
        message: 'TTS server starting...' 
      });
    }

    res.status(500).json({ 
      success: false, 
      error: 'Failed to start TTS server' 
    });
  } catch (error) {
    console.error('[Status Route] Error starting server:', error);
    sendErrorResponse(res, 500, error, 'Failed to start TTS server');
  }
});

/**
 * POST /api/status/stop
 * Stop the TTS server
 */
router.post('/stop', async (_req: Request, res: Response) => {
  try {
    await stopTtsServer();
    res.json({ 
      success: true, 
      message: 'TTS server stopped' 
    });
  } catch (error) {
    console.error('[Status Route] Error stopping server:', error);
    sendErrorResponse(res, 500, error, 'Failed to stop TTS server');
  }
});

export default router;
