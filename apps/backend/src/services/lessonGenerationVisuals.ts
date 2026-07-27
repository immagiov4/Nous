import {
  INTERNAL_FAST_TASK_INSTRUCTION,
  INTERNAL_REASONING_EFFICIENCY_INSTRUCTION,
} from '@shared/aiPromptInstructions';
import {
  findMissingStaticHtmlElementIds,
  hasInvalidInlineJavaScript,
  hasUnsafeHtmlElementDereferences,
} from '@shared/htmlElementReferences';
import {
  type LessonVisualType,
  MAX_VISUAL_LESSON_CHARS,
  NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT,
} from '@shared/lessonGenerationPolicy';
import {
  buildEmbeddedArtifactImagePrompt,
  buildLessonRasterImagePrompt,
  HTML_ARTIFACT_RENDER_RULES,
  type HtmlArtifactImageRequest,
  MERMAID_ARTIFACT_RENDER_RULES,
  normalizeHtmlArtifactImageRequests,
  SVG_ARTIFACT_RENDER_RULES,
} from '@shared/lessonVisualContracts';
import { generateText, jsonSchema, Output } from 'ai';

import {
  type GlobalModelConfig,
  resolveAiProviderForSlot,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
} from '../config/modelConfig.js';
import { createConfiguredTextModel } from './aiSdkTextModel.js';
import { runCodexAppServerTurn } from './codexAppServer.js';
import { imageClient } from './imageClient.js';
import { reviewLessonVisual } from './lessonGenerationVisualReview.js';
import { retryProviderCall } from './providerRetry.js';

export type { LessonVisualType } from '@shared/lessonGenerationPolicy';

export interface LessonVisualDraftPlan {
  altText: string;
  anchorHeading: string;
  complexity: 'complex' | 'moderate' | 'simple';
  concept: string;
  coverage: 'all_elements' | 'complete_synthesis' | 'none' | 'single_complex';
  coverageRationale: string;
  factualRequirements: string[];
  interactionLevel: 'high' | 'low' | 'none';
  pedagogicalGoal: string;
  reason: string;
  requiresDepiction: boolean;
  slotId: string;
  title: string;
  visualDirection: string;
  visualType: LessonVisualType;
}

export type LessonVisualRetryPlan = Pick<
  LessonVisualDraftPlan,
  | 'complexity'
  | 'concept'
  | 'coverage'
  | 'coverageRationale'
  | 'factualRequirements'
  | 'interactionLevel'
  | 'pedagogicalGoal'
  | 'reason'
  | 'requiresDepiction'
  | 'slotId'
  | 'visualDirection'
  | 'visualType'
>;

export interface RenderedLessonVisual {
  code: string;
  kind: 'html' | 'image' | 'mermaid' | 'svg';
  mediaType?: 'image/jpeg' | 'image/png' | 'image/webp';
}

type HtmlImageRequest = HtmlArtifactImageRequest;

interface RenderedArtifactDraft extends RenderedLessonVisual {
  imageRequests: HtmlImageRequest[];
}

export interface RenderLessonVisualInput {
  config: GlobalModelConfig;
  lessonMarkdown: string;
  plan: LessonVisualDraftPlan;
  sectionDescription: string;
  sectionTitle: string;
  signal: AbortSignal;
}

export type RenderLessonVisual = (
  input: RenderLessonVisualInput
) => Promise<RenderedLessonVisual | null>;

export interface StoredGeneratedVisual {
  altText: string;
  anchorHeading?: string;
  code: string;
  kind: 'html' | 'image' | 'mermaid' | 'svg';
  mediaType?: 'image/jpeg' | 'image/png' | 'image/webp';
  createdAt: string;
  id: string;
  title: string;
}

const hasFullHtmlDocument = (code: string): boolean =>
  /<!doctype|<html\b|<head\b|<body\b/iu.test(code);

export const isSafeGeneratedVisualCode = (
  kind: RenderedLessonVisual['kind'],
  code: string
): boolean => {
  const trimmed = code.trim();
  if (!trimmed || hasFullHtmlDocument(trimmed)) return false;
  if (kind === 'image') {
    return /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(trimmed);
  }
  if (kind === 'svg') {
    return (
      /^<svg\b[\s\S]*<\/svg>$/iu.test(trimmed) &&
      !/<script\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']https?:/iu.test(trimmed)
    );
  }
  if (kind === 'mermaid') {
    return /^(?:classDiagram|erDiagram)\b/u.test(trimmed);
  }
  return (
    /^\s*<style[\s>]/iu.test(trimmed) &&
    /<script[\s>]/iu.test(trimmed) &&
    !/<script[^>]+\bsrc\s*=|\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/iu.test(trimmed) &&
    !hasInvalidInlineJavaScript(trimmed) &&
    findMissingStaticHtmlElementIds(trimmed).length === 0 &&
    !hasUnsafeHtmlElementDereferences(trimmed)
  );
};

const ARTIFACT_RENDER_RESPONSE_SCHEMA = {
  name: 'durable_lesson_artifact',
  strict: true,
  schema: {
    additionalProperties: false,
    properties: {
      code: { type: 'string' },
      imageRequests: {
        items: {
          additionalProperties: false,
          properties: {
            alt: { type: 'string' },
            id: { type: 'string' },
            prompt: { type: 'string' },
          },
          required: ['id', 'prompt', 'alt'],
          type: 'object',
        },
        type: 'array',
      },
    },
    required: ['code', 'imageRequests'],
    type: 'object',
  },
} as const;

const visualKindForPlan = (plan: LessonVisualDraftPlan): RenderedLessonVisual['kind'] => {
  if (plan.visualType === 'illustrative_image') return 'image';
  if (plan.visualType === 'interactive_html' || plan.visualType === 'chart_html') return 'html';
  if (plan.visualType === 'structural_svg' || plan.visualType === 'flowchart_svg') return 'svg';
  return 'mermaid';
};

const formatRuleForPlan = (plan: LessonVisualDraftPlan): string => {
  if (plan.visualType === 'interactive_html' || plan.visualType === 'chart_html') {
    return `Restituisci un frammento HTML autosufficiente che inizi con <style>, includa <script>, non usi rete, script esterni o un documento HTML completo.
Se il widget richiede davvero un asset artistico, aggiungilo a imageRequests e usalo esclusivamente come <img src="{{GENERATED_IMAGE:id}}" alt="...">. Ogni placeholder deve avere esattamente una richiesta con lo stesso id e viceversa. Gli id iniziano con una lettera minuscola e contengono solo minuscole, numeri, trattini o underscore. Se non servono immagini, imageRequests deve essere vuoto.
${HTML_ARTIFACT_RENDER_RULES}`;
  }
  if (plan.visualType === 'structural_svg' || plan.visualType === 'flowchart_svg') {
    return `Restituisci un singolo elemento <svg> completo. imageRequests deve essere vuoto.
${SVG_ARTIFACT_RENDER_RULES}`;
  }
  const diagramType = plan.visualType === 'mermaid_class' ? 'classDiagram' : 'erDiagram';
  return `Restituisci soltanto codice Mermaid ${diagramType}. imageRequests deve essere vuoto.
${MERMAID_ARTIFACT_RENDER_RULES}`;
};

const buildArtifactRenderPrompt = (
  input: RenderLessonVisualInput,
  correction?: { feedback: string; previous: RenderedArtifactDraft }
): string => {
  const formatRule = formatRuleForPlan(input.plan);
  const correctionInstructions = correction
    ? `BOZZA DA REVISIONARE:\n${JSON.stringify({ code: correction.previous.code, imageRequests: correction.previous.imageRequests })}\n\n${correction.feedback}`
    : '';
  return `Genera il codice dell'esempio visuale pianificato per questa lezione.

Titolo lezione: ${input.sectionTitle}
Descrizione: ${input.sectionDescription}
Piano visuale: ${JSON.stringify(input.plan)}
Contenuto della lezione:
${input.lessonMarkdown.slice(0, MAX_VISUAL_LESSON_CHARS)}

${formatRule}
Ogni testo visibile deve usare la lingua della lezione. Il visuale deve rispettare i requisiti fattuali del piano e non aggiungere dettagli non supportati.
${NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT}
${correctionInstructions}
Restituisci soltanto il JSON richiesto.`;
};

const resolveImageModel = (input: RenderLessonVisualInput): string => {
  const provider = resolveAiProviderForSlot(input.config, 'image');
  if (provider === 'codex') return input.config.codexArtifactModel;
  if (provider === 'openai') return input.config.openAiImageModel;
  return input.config.imageModel;
};

const requestGeneratedImage = async (input: RenderLessonVisualInput, prompt: string) => {
  const provider = resolveAiProviderForSlot(input.config, 'image');
  return imageClient.generateImage({
    model: resolveImageModel(input),
    prompt,
    provider,
    signal: input.signal,
  });
};

const requestImageRender = async (
  input: RenderLessonVisualInput
): Promise<RenderedArtifactDraft> => {
  const result = await requestGeneratedImage(
    input,
    buildLessonRasterImagePrompt({
      concept: input.plan.concept,
      factualRequirements: input.plan.factualRequirements,
      lessonMarkdown: input.lessonMarkdown,
      pedagogicalGoal: input.plan.pedagogicalGoal,
      sectionDescription: input.sectionDescription,
      sectionTitle: input.sectionTitle,
      visualDirection: input.plan.visualDirection,
    })
  );
  return { code: result.dataUrl, imageRequests: [], kind: 'image', mediaType: result.mediaType };
};

const materializeHtmlImages = async (
  draft: RenderedArtifactDraft,
  input: RenderLessonVisualInput
): Promise<RenderedLessonVisual> => {
  if (draft.kind !== 'html') {
    return {
      code: draft.code,
      kind: draft.kind,
      ...(draft.mediaType ? { mediaType: draft.mediaType } : {}),
    };
  }
  if (draft.imageRequests.length === 0) return { code: draft.code, kind: 'html' };
  const generatedImages = await Promise.all(
    draft.imageRequests.map(async request => ({
      id: request.id,
      image: await requestGeneratedImage(
        input,
        buildEmbeddedArtifactImagePrompt(request, {
          concept: input.plan.concept,
          lessonMarkdown: input.lessonMarkdown,
          sectionDescription: input.sectionDescription,
          sectionTitle: input.sectionTitle,
        })
      ),
    }))
  );
  let code = draft.code;
  for (const generated of generatedImages) {
    code = code.split(`{{GENERATED_IMAGE:${generated.id}}}`).join(generated.image.dataUrl);
  }
  if (code.includes('{{GENERATED_IMAGE:')) {
    throw new Error('Un placeholder immagine dell artefatto non e stato risolto.');
  }
  return { code, kind: 'html' };
};

const requestArtifactRender = async (
  input: RenderLessonVisualInput,
  correction?: { feedback: string; preview?: string; previous: RenderedArtifactDraft }
): Promise<RenderedArtifactDraft> => {
  if (input.plan.visualType === 'illustrative_image') return requestImageRender(input);
  const slot =
    input.plan.visualType === 'interactive_html' || input.plan.visualType === 'chart_html'
      ? 'artifactInteractive'
      : 'artifact';
  const prompt = buildArtifactRenderPrompt(input, correction);
  const systemInstruction = correction
    ? INTERNAL_REASONING_EFFICIENCY_INSTRUCTION
    : INTERNAL_FAST_TASK_INSTRUCTION;
  return retryProviderCall(
    async () => {
      const provider = resolveAiProviderForSlot(input.config, slot);
      const modelConfig = resolveTextModelConfig(input.config, slot);
      if (provider === 'codex') {
        const response = await runCodexAppServerTurn({
          allowWebSearch: false,
          developerInstructions: `${systemInstruction}\nRender one safe pedagogical artifact from the supplied plan. Do not use tools or access local files.`,
          input: correction?.preview
            ? [
                { type: 'image', url: correction.preview },
                { text: prompt, type: 'text' },
              ]
            : [{ text: prompt, type: 'text' }],
          model: modelConfig.model,
          outputSchema: ARTIFACT_RENDER_RESPONSE_SCHEMA.schema,
          reasoningEffort: modelConfig.reasoningEffort,
          serviceTier: resolveCodexServiceTierForSlot(input.config, slot),
          signal: input.signal,
        });
        const parsed = JSON.parse(response) as { code: string; imageRequests: HtmlImageRequest[] };
        return {
          code: parsed.code,
          imageRequests: parsed.imageRequests,
          kind: visualKindForPlan(input.plan),
        };
      }

      const configured = createConfiguredTextModel(input.config, slot);
      const { output } = await generateText({
        abortSignal: input.signal,
        model: configured.model,
        output: Output.object({
          name: ARTIFACT_RENDER_RESPONSE_SCHEMA.name,
          schema: jsonSchema<{ code: string; imageRequests: HtmlImageRequest[] }>(
            ARTIFACT_RENDER_RESPONSE_SCHEMA.schema as unknown as Parameters<typeof jsonSchema>[0]
          ),
        }),
        ...(correction?.preview
          ? {
              messages: [
                {
                  content: [
                    { image: correction.preview, type: 'image' as const },
                    { text: prompt, type: 'text' as const },
                  ],
                  role: 'user' as const,
                },
              ],
            }
          : { prompt }),
        providerOptions: configured.providerOptions,
        system: systemInstruction,
      });
      return {
        code: output.code,
        imageRequests: output.imageRequests,
        kind: visualKindForPlan(input.plan),
      };
    },
    { delay: 500, retries: 1, signal: input.signal }
  );
};

const normalizeArtifactDraft = (draft: RenderedArtifactDraft): RenderedArtifactDraft | null => {
  if (!isSafeGeneratedVisualCode(draft.kind, draft.code)) return null;
  if (draft.kind !== 'html') return draft.imageRequests.length === 0 ? draft : null;
  const normalized = normalizeHtmlArtifactImageRequests(draft.imageRequests, draft.code);
  return normalized ? { ...draft, imageRequests: normalized } : null;
};

const buildReviewFeedback = (kind: RenderedArtifactDraft['kind'], issues: string[]): string => {
  if (kind !== 'svg') {
    return 'Verifica questa bozza HTML come software didattico. Controlla che venga eseguita senza errori, che ogni controllo produca davvero il cambiamento dichiarato e che la grafica sia generata da regole o algoritmi verificabili. Se un asset artistico non puo essere prodotto dignitosamente dal codice, usa imageRequests. Mantieni una corrispondenza esatta tra imageRequests e placeholder {{GENERATED_IMAGE:id}} e correggi qualunque discrepanza tra etichette e risultato.';
  }
  const issueList = issues.map(issue => `- ${issue}`).join('\n');
  return `Questa e la versione renderizzata della bozza SVG. Correggi problemi visivi reali di leggibilita, sovrapposizione, spaziatura, contrasto e bordi, mantenendo contenuto e intento pedagogico. Il linter e euristico: usalo come indizio, non come verita assoluta.\n\n${issueList}`;
};

export const renderLessonVisual: RenderLessonVisual = async input => {
  input.signal.throwIfAborted();
  let rawDraft = await requestArtifactRender(input);
  let draft = normalizeArtifactDraft(rawDraft);
  if (!draft) {
    rawDraft = await requestArtifactRender(input, {
      feedback:
        'La bozza non e valida: correggi struttura, JavaScript, riferimenti DOM e corrispondenza tra imageRequests e placeholder. Restituisci una sostituzione completa.',
      previous: rawDraft,
    });
    draft = normalizeArtifactDraft(rawDraft);
  }
  if (!draft) return null;
  if (input.config.artifactVisualReviewEnabled) {
    draft = await reviewLessonVisual({
      maxRounds: input.config.artifactVisualReviewMaxRounds,
      requestRevision: async ({ issues, preview, visual }) => {
        input.signal.throwIfAborted();
        const revision = await requestArtifactRender(input, {
          feedback: buildReviewFeedback(visual.kind, issues),
          ...(preview ? { preview } : {}),
          previous: visual,
        });
        return normalizeArtifactDraft(revision);
      },
      visual: draft,
    });
  }
  return materializeHtmlImages(draft, input);
};

export const toVisualRetryPlan = (plan: LessonVisualDraftPlan): LessonVisualRetryPlan => ({
  complexity: plan.complexity,
  concept: plan.concept,
  coverage: plan.coverage,
  coverageRationale: plan.coverageRationale,
  factualRequirements: plan.factualRequirements,
  interactionLevel: plan.interactionLevel,
  pedagogicalGoal: plan.pedagogicalGoal,
  reason: plan.reason,
  requiresDepiction: plan.requiresDepiction,
  slotId: plan.slotId,
  visualDirection: plan.visualDirection,
  visualType: plan.visualType,
});
