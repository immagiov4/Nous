import { generateText } from 'ai';

import {
  type GlobalModelConfig,
  resolveAiProviderForSlot,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
} from '../config/modelConfig.js';
import { createConfiguredTextModel } from './aiSdkTextModel.js';
import { runCodexAppServerTurn } from './codexAppServer.js';
import type { ExtractedPdfImage } from './pdfImageExtractor.js';
import { retryProviderCall } from './providerRetry.js';

const OPENROUTER_PDF_IMAGE_CAPTION_MODEL =
  process.env.MODEL_PDF_IMAGE_CAPTION || 'nvidia/nemotron-nano-12b-v2-vl';

const buildCaptionPrompt = (image: ExtractedPdfImage): string => {
  const context = [
    image.textBefore ? `Text immediately above the image:\n${image.textBefore.trim()}` : '',
    image.textCurrent ? `Text aligned with the image area:\n${image.textCurrent.trim()}` : '',
    image.textAfter ? `Text immediately below the image:\n${image.textAfter.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const contextBlock = context
    ? `\nPDF text context near the image:\nPage ${image.pageNumber}\n${context}`
    : '';
  return `Describe this technical PDF figure in Italian with a concise, factual caption.
Rules:
- Mention the figure type when visible: diagram, schema, chart, UI mockup, architecture, map, raycast/visibility cone, labeled components, timeline, code screenshot, or illustration.
- Mention labels, geometric relations, arrows, regions, overlays, or compared elements if clearly visible.
- Max 45 words.
- No speculation.
- Use nearby PDF text only to disambiguate a figure that is already visually recognizable. Do not use the PDF text to guess the content of a blurry, partial, cropped, or unreadable image.
- If the image is decorative, partial, heavily cropped, blurry, mostly empty background, just a border/frame/wrapper, a section box, a separator, an icon, a badge, a ribbon, a logo, an ornament, or if the main subject is not clearly distinguishable, answer exactly: DECORATIVE
${contextBlock}`;
};

const resolveCaptionModel = (config: GlobalModelConfig): string => {
  const provider = resolveAiProviderForSlot(config, 'research');
  if (provider === 'codex') return config.codexLessonModel;
  if (provider === 'openai') return config.openAiLessonModel;
  return OPENROUTER_PDF_IMAGE_CAPTION_MODEL;
};

export const captionPdfImage = async (
  image: ExtractedPdfImage,
  config: GlobalModelConfig,
  signal: AbortSignal
): Promise<string | null> => {
  const prompt = buildCaptionPrompt(image);
  const provider = resolveAiProviderForSlot(config, 'research');
  const caption = await retryProviderCall(
    async () => {
      if (provider === 'codex') {
        return runCodexAppServerTurn({
          allowWebSearch: false,
          developerInstructions:
            'Describe only what is visibly recognizable in the supplied PDF figure. Do not use tools or access local files.',
          input: [
            { type: 'image', url: image.dataUrl },
            { text: prompt, type: 'text' },
          ],
          model: resolveCaptionModel(config),
          reasoningEffort: resolveTextModelConfig(config, 'lesson').reasoningEffort,
          serviceTier: resolveCodexServiceTierForSlot(config, 'lesson'),
          signal,
        });
      }
      const configured = createConfiguredTextModel(config, 'research', {
        model: resolveCaptionModel(config),
      });
      const response = await generateText({
        abortSignal: signal,
        messages: [
          {
            content: [
              { image: image.dataUrl, type: 'image' },
              { text: prompt, type: 'text' },
            ],
            role: 'user',
          },
        ],
        model: configured.model,
        providerOptions: configured.providerOptions,
      });
      return response.text;
    },
    { delay: 500, retries: 2, signal }
  );

  const normalized = caption.trim();
  return !normalized || /^DECORATIVE$/iu.test(normalized) ? null : normalized;
};
