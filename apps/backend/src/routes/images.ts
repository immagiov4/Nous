import { type Request, type Response, Router } from 'express';

import { getResolvedModelConfigForProvider } from '../config/modelConfig.js';
import { DEFAULT_IMAGE_MODEL, imageClient } from '../services/imageClient.js';

const router = Router();
const MAX_IMAGE_PROMPT_CHARS = 12_000;
const IMAGE_GENERATION_UNAVAILABLE_CODE = 'IMAGE_GENERATION_UNAVAILABLE';
const CODEX_IMAGE_GENERATION_UNAVAILABLE =
  'Generazione immagini non disponibile con il provider Codex.';

router.get('/models', async (req: Request, res: Response) => {
  try {
    const modelConfig = await getResolvedModelConfigForProvider(req.get('x-nous-ai-provider'));
    if (modelConfig.aiProvider === 'codex') {
      return res.json({
        success: true,
        available: false,
        code: IMAGE_GENERATION_UNAVAILABLE_CODE,
        provider: 'codex',
        models: [],
      });
    }

    const models = await imageClient.listModels();
    return res.json({
      success: true,
      available: true,
      defaultModel: DEFAULT_IMAGE_MODEL,
      selectedModel:
        modelConfig.aiProvider === 'openai' ? modelConfig.openAiImageModel : modelConfig.imageModel,
      models,
    });
  } catch (error) {
    console.error('[Image Models Route] Error:', error);
    return res.status(502).json({
      success: false,
      error: 'Impossibile recuperare i modelli immagini.',
    });
  }
});

router.post('/generate', async (req: Request, res: Response) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt || prompt.length > MAX_IMAGE_PROMPT_CHARS) {
    return res.status(400).json({
      success: false,
      error: 'Descrizione immagine non valida.',
    });
  }

  try {
    const modelConfig = await getResolvedModelConfigForProvider(req.get('x-nous-ai-provider'));
    if (modelConfig.aiProvider === 'codex') {
      return res.status(503).json({
        success: false,
        code: IMAGE_GENERATION_UNAVAILABLE_CODE,
        error: CODEX_IMAGE_GENERATION_UNAVAILABLE,
      });
    }

    const provider = modelConfig.aiProvider === 'openai' ? 'openai' : 'openrouter';
    const image = await imageClient.generateImage({
      prompt,
      provider,
      model: provider === 'openai' ? modelConfig.openAiImageModel : modelConfig.imageModel,
    });
    if (image.generationId) {
      res.set('X-Generation-Id', image.generationId);
    }

    return res.json({
      success: true,
      dataUrl: image.dataUrl,
      mediaType: image.mediaType,
      usage: image.usage,
    });
  } catch (error) {
    console.error('[Images Route] Error:', error);
    return res.status(502).json({
      success: false,
      error: 'Generazione immagine non riuscita.',
    });
  }
});

export default router;
