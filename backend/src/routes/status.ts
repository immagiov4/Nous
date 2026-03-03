import { Router, Request, Response } from 'express';
import { processManager } from '../services/processManager.js';
import { ttsClient } from '../services/ttsClient.js';
import { loadServerConfig } from '../config/serverConfig.js';

const router = Router();

/**
 * GET /api/status
 * Get TTS server status
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const processState = processManager.getState();
    const config = loadServerConfig();
    
    // Check actual server health
    const health = await ttsClient.checkHealth();
    
    // Calculate uptime
    const uptime = processState.startTime 
      ? Math.floor((Date.now() - processState.startTime) / 1000) 
      : 0;

    res.json({
      success: true,
      status: {
        isRunning: processState.isRunning,
        isReady: processState.isReady && health.healthy,
        modelLoaded: health.healthy,
        currentDevice: config.device,
        uptime,
        pid: processState.pid,
        restartAttempts: processState.restartAttempts,
        lastError: processState.lastError,
        healthMessage: health.message
      }
    });
  } catch (error: any) {
    console.error('[Status Route] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to get status' 
    });
  }
});

/**
 * POST /api/status/start
 * Start the TTS server
 */
router.post('/start', async (req: Request, res: Response) => {
  try {
    const state = processManager.getState();
    
    if (state.isRunning) {
      return res.json({ 
        success: true, 
        message: 'TTS server is already running' 
      });
    }

    const started = await processManager.start();
    
    if (started) {
      res.json({ 
        success: true, 
        message: 'TTS server starting...' 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: 'Failed to start TTS server' 
      });
    }
  } catch (error: any) {
    console.error('[Status Route] Error starting server:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to start TTS server' 
    });
  }
});

/**
 * POST /api/status/stop
 * Stop the TTS server
 */
router.post('/stop', async (req: Request, res: Response) => {
  try {
    await processManager.stop();
    res.json({ 
      success: true, 
      message: 'TTS server stopped' 
    });
  } catch (error: any) {
    console.error('[Status Route] Error stopping server:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to stop TTS server' 
    });
  }
});

export default router;
