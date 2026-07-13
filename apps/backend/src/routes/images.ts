import { type Request, type Response, Router } from 'express';

import { getCurrentUser } from '../auth/currentUser.js';
import { type AiProvider, getResolvedModelConfigForProvider } from '../config/modelConfig.js';
import { DEFAULT_IMAGE_MODEL, imageClient } from '../services/imageClient.js';

const router = Router();
const MAX_IMAGE_PROMPT_CHARS = 12_000;

const resolveImageProvider = (aiProvider: AiProvider) => aiProvider;

router.get('/models', async (req: Request, res: Response) => {
  try {
    const modelConfig = await getResolvedModelConfigForProvider(getCurrentUser(req).aiProvider);
    const provider = resolveImageProvider(modelConfig.aiProvider);
    const models =
      provider === 'openrouter' ? await imageClient.listModels() : imageClient.listOpenAiModels();
    return res.json({
      success: true,
      available: true,
      defaultModel: provider === 'openrouter' ? DEFAULT_IMAGE_MODEL : modelConfig.openAiImageModel,
      selectedModel:
        provider === 'openrouter' ? modelConfig.imageModel : modelConfig.openAiImageModel,
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
    const modelConfig = await getResolvedModelConfigForProvider(getCurrentUser(req).aiProvider);
    const provider = resolveImageProvider(modelConfig.aiProvider);
    const image = await imageClient.generateImage({
      prompt,
      provider,
      model:
        provider === 'codex'
          ? modelConfig.codexArtifactModel
          : provider === 'openai'
            ? modelConfig.openAiImageModel
            : modelConfig.imageModel,
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
