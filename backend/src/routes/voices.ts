import { Router, Request, Response } from 'express';
import { ttsClient } from '../services/ttsClient.js';

const router = Router();

/**
 * GET /api/voices
 * Get available voice profiles
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const profiles = ttsClient.getVoiceProfiles();
    const defaultProfile = ttsClient.getDefaultProfile();

    res.json({
      success: true,
      voices: profiles.map(p => ({
        id: p.id,
        name: p.name,
        language: p.language,
        mode: p.mode
      })),
      defaultVoice: defaultProfile.id
    });
  } catch (error: any) {
    console.error('[Voices Route] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to get voice profiles' 
    });
  }
});

/**
 * GET /api/voices/:id
 * Get a specific voice profile
 */
router.get('/:id', (req: Request, res: Response) => {
  try {
    const profile = ttsClient.getVoiceProfile(req.params.id);

    if (!profile) {
      return res.status(404).json({ 
        success: false, 
        error: 'Voice profile not found' 
      });
    }

    res.json({
      success: true,
      voice: {
        id: profile.id,
        name: profile.name,
        language: profile.language,
        mode: profile.mode,
        settings: profile.modelSettings
      }
    });
  } catch (error: any) {
    console.error('[Voices Route] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to get voice profile' 
    });
  }
});

export default router;
