// Exposes the backend voice catalog route.
import { type Request, type Response, Router } from 'express';

import { getVoiceDetails, listVoices } from '../services/voiceService.js';
import { sendErrorResponse } from '../utils/httpResponses.js';

const router = Router();

/**
 * GET /api/voices
 * Get available voice profiles
 */
router.get('/', (_req: Request, res: Response) => {
  try {
    const payload = listVoices();

    res.json({
      success: true,
      ...payload,
    });
  } catch (error) {
    console.error('[Voices Route] Error:', error);
    sendErrorResponse(res, 500, error, 'Failed to get voice profiles');
  }
});

/**
 * GET /api/voices/:id
 * Get a specific voice profile
 */
router.get('/:id', (req: Request, res: Response) => {
  try {
    const voiceId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const voiceDetails = getVoiceDetails(voiceId);

    if (!voiceDetails) {
      return res.status(404).json({
        success: false,
        error: 'Profilo vocale non trovato.',
      });
    }

    res.json({
      success: true,
      ...voiceDetails,
    });
  } catch (error) {
    console.error('[Voices Route] Error:', error);
    sendErrorResponse(res, 500, error, 'Failed to get voice profile');
  }
});

export default router;
