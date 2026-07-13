import { Router } from 'express';
import { buildYouTubeResearchContext } from '../services/youtubeResearch.js';

const router = Router();
const MAX_QUERY_LENGTH = 500;

router.post('/research-context', async (req, res) => {
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  const language = typeof req.body?.language === 'string' ? req.body.language.trim() : 'Italiano';
  if (!query || query.length > MAX_QUERY_LENGTH) {
    return res.status(400).json({ success: false, error: 'Query YouTube non valida.' });
  }

  try {
    const context = await buildYouTubeResearchContext(query, language);
    return res.json({ success: true, context });
  } catch (error) {
    console.warn('[Backend] YouTube research unavailable:', error);
    return res.json({ success: true, context: '' });
  }
});

export default router;
