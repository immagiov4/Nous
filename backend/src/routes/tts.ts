import { Router, Request, Response } from 'express';
import { ttsClient } from '../services/ttsClient.js';

const router = Router();

/**
 * POST /api/tts
 * Generate speech from text
 * 
 * Body: { text: string, voice?: string, speed?: number }
 * Returns: audio/wav binary data
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { text, voice, speed } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ 
        success: false, 
        error: 'Text is required and must be a string' 
      });
    }

    if (text.length > 10000) {
      return res.status(400).json({ 
        success: false, 
        error: 'Text too long. Maximum 10000 characters per request.' 
      });
    }

    const audioBuffer = await ttsClient.generateSpeech({ text, voice, speed });

    // Set appropriate headers for audio
    res.set({
      'Content-Type': 'audio/wav',
      'Content-Length': audioBuffer.byteLength.toString(),
      'Cache-Control': 'public, max-age=3600'
    });

    res.send(Buffer.from(audioBuffer));
  } catch (error: any) {
    console.error('[TTS Route] Error:', error);
    
    // Check if it's a connection error (TTS server not running)
    if (error.code === 'ECONNREFUSED' || error.message?.includes('Connection failed')) {
      return res.status(503).json({ 
        success: false, 
        error: 'TTS server is not available. Please ensure the TTS server is running.' 
      });
    }

    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to generate speech' 
    });
  }
});

export default router;
