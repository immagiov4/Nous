import { type Request, type Response, Router } from 'express';

import { getCurrentUser } from '../auth/currentUser.js';
import {
  getResolvedModelConfigForProvider,
  resolveAiProviderForSlot,
} from '../config/modelConfig.js';
import {
  DEFAULT_IMAGE_MODEL,
  imageClient,
  toGeneratedImageDataUrl,
} from '../services/imageClient.js';

const router = Router();
const MAX_IMAGE_PROMPT_CHARS = 12_000;

router.get('/models', async (req: Request, res: Response) => {
  try {
    const currentUser = getCurrentUser(req);
    const modelConfig = await getResolvedModelConfigForProvider(
      currentUser.aiProvider,
      currentUser.aiProviderOverrides
    );
    const provider = resolveAiProviderForSlot(modelConfig, 'image');
    if (provider === 'codex') {
      const model = modelConfig.codexArtifactModel;
      return res.json({
        success: true,
        available: true,
        defaultModel: model,
        selectedModel: model,
        models: [{ id: model, name: model }],
      });
    }
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
    const currentUser = getCurrentUser(req);
    const modelConfig = await getResolvedModelConfigForProvider(
      currentUser.aiProvider,
      currentUser.aiProviderOverrides
    );
    const provider = resolveAiProviderForSlot(modelConfig, 'image');
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
      dataUrl: toGeneratedImageDataUrl(image),
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
