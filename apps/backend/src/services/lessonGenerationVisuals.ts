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
  LESSON_VISUAL_TYPES,
  type LessonVisualType,
  MAX_VISUAL_LESSON_CHARS,
  NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT,
} from '@shared/lessonGenerationPolicy';
import {
  buildEmbeddedArtifactImagePrompt,
  buildLessonRasterImagePrompt,
  buildLessonVisualPlannerRequest,
  getMarkdownHeadingTitles,
  HTML_ARTIFACT_RENDER_RULES,
  type HtmlArtifactImageRequest,
  LESSON_VISUAL_PLANNER_SYSTEM_PROMPT,
  MERMAID_ARTIFACT_RENDER_RULES,
  normalizeHtmlArtifactImageRequests,
  resolveLessonVisualAnchorHeading,
  SVG_ARTIFACT_RENDER_RULES,
} from '@shared/lessonVisualContracts';
import {
  buildProjectAssetPlaceholder,
  type ProjectAssetRef,
  type ProjectVisual,
  validateProjectAssetHtmlReferences,
} from '@shared/projectAsset';
import { APICallError, generateText, jsonSchema, NoObjectGeneratedError, Output } from 'ai';
import * as z from 'zod';

import { isRecord } from '../utils/validation.js';
import { createConfiguredTextModelFromResolution } from './aiSdkTextModel.js';
import { runCodexAppServerTurn } from './codexAppServer.js';
import { imageClient } from './imageClient.js';
import type { LessonVisualModelConfig } from './lessonVisualModelConfig.js';
import { openRouterModelSupportsImages } from './openRouterModelCapabilities.js';

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

export type LessonVisualRetryPlan = Omit<
  LessonVisualDraftPlan,
  'altText' | 'anchorHeading' | 'title'
> &
  Partial<Pick<LessonVisualDraftPlan, 'altText' | 'anchorHeading' | 'title'>>;

type HtmlImageRequest = HtmlArtifactImageRequest;

export interface RenderedArtifactDraft {
  code: string;
  imageRequests: HtmlImageRequest[];
  kind: 'html' | 'mermaid' | 'svg';
}

export interface GeneratedLessonVisualImage {
  bytes: Uint8Array;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
}

interface LessonVisualRenderInput {
  existingEmbeddedAssets?: readonly ProjectAssetRef[];
  lessonMarkdown: string;
  plan: LessonVisualRetryPlan;
  retryFeedback?: string;
  sectionDescription: string;
  sectionTitle: string;
  signal: AbortSignal;
}

export interface RenderResolvedLessonVisualInput extends LessonVisualRenderInput {
  config: LessonVisualModelConfig;
}

export interface GenerateEmbeddedLessonVisualImageInput extends RenderResolvedLessonVisualInput {
  request: HtmlArtifactImageRequest;
}

export interface ReviseLessonVisualArtifactInput extends RenderResolvedLessonVisualInput {
  issues: string[];
  preview?: string;
  visual: RenderedArtifactDraft;
}

export interface PlanLessonArtifactDraftInput {
  readonly config: LessonVisualModelConfig;
  readonly generationNotes?: string;
  readonly lessonMarkdown: string;
  readonly requestedVisualKind?: ProjectVisual['kind'];
  readonly retryFeedback?: string;
  readonly sectionDescription: string;
  readonly sectionTitle: string;
  readonly signal: AbortSignal;
  readonly slotId: string;
}

export const isInvalidLessonVisualStructuredOutput = (error: unknown): boolean =>
  error instanceof SyntaxError ||
  error instanceof z.ZodError ||
  NoObjectGeneratedError.isInstance(error);

const hasFullHtmlDocument = (code: string): boolean =>
  /<!doctype|<html\b|<head\b|<body\b/iu.test(code);

export const isSafeGeneratedVisualCode = (
  kind: 'html' | 'image' | 'mermaid' | 'svg',
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

const ArtifactDraftPlanResponseSchema = z.object({
  alt_text: z.string(),
  anchor_heading: z.string().nullable(),
  complexity: z.enum(['simple', 'moderate', 'complex']),
  concept: z.string(),
  coverage: z.enum(['all_elements', 'single_complex', 'complete_synthesis', 'none']),
  coverage_rationale: z.string(),
  factual_requirements: z.array(z.string()),
  interaction_level: z.enum(['none', 'low', 'high']),
  pedagogical_goal: z.string(),
  reason: z.string(),
  requires_depiction: z.boolean(),
  title: z.string(),
  visual_direction: z.string(),
  visual_type: z.enum([...LESSON_VISUAL_TYPES, 'none']),
});

const ARTIFACT_DRAFT_PLAN_OUTPUT_INSTRUCTION = `Respond ONLY with JSON:
{
  "visual_type": "illustrative_image | flowchart_svg | structural_svg | interactive_html | chart_html | mermaid_erd | mermaid_class | none",
  "requires_depiction": true | false,
  "concept": "one sentence about the visual subject",
  "pedagogical_goal": "build_intuition | show_process | show_structure | enable_exploration | show_data",
  "anchor_heading": "exact lesson heading or null",
  "interaction_level": "none | low | high",
  "complexity": "simple | moderate | complex",
  "coverage": "all_elements | single_complex | complete_synthesis | none",
  "coverage_rationale": "short explanation",
  "factual_requirements": ["visual elements that must be correct and present"],
  "visual_direction": "composition and viewpoint useful for the pedagogical goal",
  "reason": "one sentence about the pedagogical value of the choice",
  "title": "short title in the lesson language",
  "alt_text": "short accessible description in the lesson language"
}`;

const artifactDraftPlanJsonSchema = (): Record<string, unknown> => {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(
    ArtifactDraftPlanResponseSchema
  ) as Record<string, unknown>;
  return schema;
};

const requestArtifactDraftPlan = async (input: PlanLessonArtifactDraftInput): Promise<unknown> => {
  const modelConfig = input.config.artifact;
  const basePrompt = buildLessonVisualPlannerRequest({
    generationNotes: input.generationNotes,
    hasPdfImages: false,
    lessonMarkdown: input.lessonMarkdown,
    sectionDescription: input.sectionDescription,
    sectionTitle: input.sectionTitle,
  });
  const prompt = [
    basePrompt,
    input.requestedVisualKind
      ? `Required rendering format: ${input.requestedVisualKind}. Keep this category.`
      : undefined,
    input.retryFeedback?.trim()
      ? `Required correction from the previous attempt:\n${input.retryFeedback.trim()}`
      : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');
  const system = `${LESSON_VISUAL_PLANNER_SYSTEM_PROMPT}\n\n${ARTIFACT_DRAFT_PLAN_OUTPUT_INSTRUCTION}\n\n${NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT}\n\n${INTERNAL_FAST_TASK_INSTRUCTION}`;
  const outputSchema = artifactDraftPlanJsonSchema();

  if (modelConfig.provider === 'codex') {
    const response = await runCodexAppServerTurn({
      allowWebSearch: false,
      developerInstructions: system,
      input: [{ text: prompt, type: 'text' }],
      model: modelConfig.model,
      outputSchema,
      reasoningEffort: modelConfig.reasoningEffort,
      serviceTier: modelConfig.serviceTier,
      signal: input.signal,
    });
    return JSON.parse(response);
  }

  const configured = createConfiguredTextModelFromResolution({
    model: modelConfig.model,
    provider: modelConfig.provider,
    reasoningEffort: modelConfig.reasoningEffort,
  });
  const { output } = await generateText({
    abortSignal: input.signal,
    maxRetries: 0,
    model: configured.model,
    output: Output.object({
      name: 'artifact_draft_plan',
      schema: jsonSchema(outputSchema as Parameters<typeof jsonSchema>[0]),
    }),
    prompt,
    providerOptions: configured.providerOptions,
    system,
  });
  return output;
};

const visualTypeForRequestedKind = (
  requestedKind: ProjectVisual['kind'] | undefined,
  proposedType: LessonVisualType,
  requiresDepiction: boolean
): LessonVisualType => {
  if (requestedKind === 'image') return 'illustrative_image';
  if (requestedKind === 'html') {
    return proposedType === 'interactive_html' || proposedType === 'chart_html'
      ? proposedType
      : 'interactive_html';
  }
  if (requestedKind === 'svg') {
    return proposedType === 'flowchart_svg' || proposedType === 'structural_svg'
      ? proposedType
      : 'structural_svg';
  }
  if (requestedKind === 'mermaid') {
    return proposedType === 'mermaid_erd' || proposedType === 'mermaid_class'
      ? proposedType
      : 'mermaid_class';
  }
  return requiresDepiction &&
    (proposedType === 'flowchart_svg' || proposedType === 'structural_svg')
    ? 'illustrative_image'
    : proposedType;
};

export const planLessonArtifactDraft = async (
  input: PlanLessonArtifactDraftInput
): Promise<LessonVisualRetryPlan | null> => {
  const response = ArtifactDraftPlanResponseSchema.parse(await requestArtifactDraftPlan(input));
  if (response.visual_type === 'none') return null;

  const concept = response.concept.trim() || input.sectionDescription.trim() || input.sectionTitle;
  const title = response.title.trim() || concept;
  const visualType = visualTypeForRequestedKind(
    input.requestedVisualKind,
    response.visual_type,
    response.requires_depiction
  );

  return {
    altText: response.alt_text.trim() || concept,
    anchorHeading: resolveLessonVisualAnchorHeading(
      response.anchor_heading,
      getMarkdownHeadingTitles(input.lessonMarkdown)
    ),
    complexity: response.complexity,
    concept,
    coverage: response.coverage,
    coverageRationale: response.coverage_rationale.trim(),
    factualRequirements: response.factual_requirements
      .map(requirement => requirement.trim())
      .filter(Boolean),
    interactionLevel: response.interaction_level,
    pedagogicalGoal: response.pedagogical_goal.trim(),
    reason: response.reason.trim(),
    requiresDepiction: response.requires_depiction,
    slotId: input.slotId,
    title,
    visualDirection: response.visual_direction.trim(),
    visualType,
  };
};

const visualKindForPlan = (plan: LessonVisualRetryPlan): RenderedArtifactDraft['kind'] => {
  if (plan.visualType === 'interactive_html' || plan.visualType === 'chart_html') return 'html';
  if (plan.visualType === 'structural_svg' || plan.visualType === 'flowchart_svg') return 'svg';
  return 'mermaid';
};

const formatRuleForPlan = (plan: LessonVisualRetryPlan): string => {
  if (plan.visualType === 'interactive_html' || plan.visualType === 'chart_html') {
    return `Return a self-contained HTML fragment that starts with <style>, includes <script>, and uses no network, external scripts, or complete HTML document.
If the widget genuinely requires an artistic asset, add it to imageRequests and use it only as <img src="{{GENERATED_IMAGE:id}}" alt="...">. Every placeholder must have exactly one request with the same id and vice versa. IDs must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, or underscores. If no images are needed, imageRequests must be empty.
${HTML_ARTIFACT_RENDER_RULES}`;
  }
  if (plan.visualType === 'structural_svg' || plan.visualType === 'flowchart_svg') {
    return `Return one complete <svg> element. imageRequests must be empty.
${SVG_ARTIFACT_RENDER_RULES}`;
  }
  const diagramType = plan.visualType === 'mermaid_class' ? 'classDiagram' : 'erDiagram';
  return `Return only Mermaid ${diagramType} code. imageRequests must be empty.
${MERMAID_ARTIFACT_RENDER_RULES}`;
};

const buildArtifactRenderPrompt = (
  input: RenderResolvedLessonVisualInput,
  correction?: { feedback: string; previous: RenderedArtifactDraft }
): string => {
  const formatRule = formatRuleForPlan(input.plan);
  const correctionInstructions = correction
    ? `DRAFT TO REVISE:\n${JSON.stringify({ code: correction.previous.code, imageRequests: correction.previous.imageRequests })}\n\n${correction.feedback}`
    : '';
  const retryInstructions = input.retryFeedback?.trim()
    ? `REQUIRED CORRECTION FROM THE PREVIOUS ATTEMPT:\n${input.retryFeedback.trim()}`
    : '';
  const retainedAssetInstruction = input.existingEmbeddedAssets?.length
    ? `You may keep only these already authorized asset references if they remain necessary: ${input.existingEmbeddedAssets
        .map(asset => buildProjectAssetPlaceholder(asset.id))
        .join(', ')}. Do not invent PROJECT_ASSET references. Use imageRequests for new assets.`
    : 'Do not use PROJECT_ASSET references. Use imageRequests for every new asset.';
  return `Generate the code for the visual example planned for this lesson.

Lesson title: ${input.sectionTitle}
Description: ${input.sectionDescription}
Visual plan: ${JSON.stringify(input.plan)}
Lesson content:
${input.lessonMarkdown.slice(0, MAX_VISUAL_LESSON_CHARS)}

${formatRule}
All visible text must use the lesson language. The visual must follow the plan's factual requirements and add no unsupported details.
${NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT}
${retainedAssetInstruction}
${retryInstructions}
${correctionInstructions}
Return only the requested JSON.`;
};

const requestGeneratedImage = async (input: RenderResolvedLessonVisualInput, prompt: string) => {
  return imageClient.generateImage({
    model: input.config.image.model,
    prompt,
    provider: input.config.image.provider,
    signal: input.signal,
  });
};

export const generateLessonVisualRaster = (
  input: RenderResolvedLessonVisualInput
): Promise<GeneratedLessonVisualImage> =>
  requestGeneratedImage(
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

export const generateEmbeddedLessonVisualImage = (
  input: GenerateEmbeddedLessonVisualImageInput
): Promise<GeneratedLessonVisualImage> =>
  requestGeneratedImage(
    input,
    buildEmbeddedArtifactImagePrompt(input.request, {
      concept: input.plan.concept,
      lessonMarkdown: input.lessonMarkdown,
      sectionDescription: input.sectionDescription,
      sectionTitle: input.sectionTitle,
    })
  );

const requestArtifactRender = async (
  input: RenderResolvedLessonVisualInput,
  correction?: { feedback: string; preview?: string; previous: RenderedArtifactDraft }
): Promise<RenderedArtifactDraft> => {
  const slot =
    input.plan.visualType === 'interactive_html' || input.plan.visualType === 'chart_html'
      ? 'artifactInteractive'
      : 'artifact';
  const prompt = buildArtifactRenderPrompt(input, correction);
  const systemInstruction =
    correction || input.retryFeedback?.trim()
      ? INTERNAL_REASONING_EFFICIENCY_INSTRUCTION
      : INTERNAL_FAST_TASK_INSTRUCTION;
  const modelConfig = input.config[slot];
  if (modelConfig.provider === 'codex') {
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
      serviceTier: modelConfig.serviceTier,
      signal: input.signal,
    });
    const parsed = JSON.parse(response) as { code: string; imageRequests: HtmlImageRequest[] };
    return {
      code: parsed.code,
      imageRequests: parsed.imageRequests,
      kind: visualKindForPlan(input.plan),
    };
  }

  const configured = createConfiguredTextModelFromResolution({
    model: modelConfig.model,
    provider: modelConfig.provider,
    reasoningEffort: modelConfig.reasoningEffort,
  });
  const request = (preview?: string) =>
    generateText({
      abortSignal: input.signal,
      maxRetries: 0,
      model: configured.model,
      output: Output.object({
        name: ARTIFACT_RENDER_RESPONSE_SCHEMA.name,
        schema: jsonSchema<{ code: string; imageRequests: HtmlImageRequest[] }>(
          ARTIFACT_RENDER_RESPONSE_SCHEMA.schema as unknown as Parameters<typeof jsonSchema>[0]
        ),
      }),
      ...(preview
        ? {
            messages: [
              {
                content: [
                  { image: preview, type: 'image' as const },
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
  const preview =
    correction?.preview &&
    (modelConfig.provider !== 'openrouter' ||
      (await openRouterModelSupportsImages(modelConfig.model)))
      ? correction.preview
      : undefined;
  let output: Awaited<ReturnType<typeof request>>['output'];
  try {
    ({ output } = await request(preview));
  } catch (error) {
    if (!preview || !isUnsupportedOpenRouterImageInput(error)) throw error;
    ({ output } = await request());
  }
  return {
    code: output.code,
    imageRequests: output.imageRequests,
    kind: visualKindForPlan(input.plan),
  };
};

const isUnsupportedOpenRouterImageInput = (error: unknown): boolean => {
  if (!APICallError.isInstance(error) || error.statusCode !== 404 || !isRecord(error.data)) {
    return false;
  }
  const providerError = error.data.error;
  return (
    isRecord(providerError) &&
    providerError.code === 404 &&
    providerError.message === 'No endpoints found that support image input'
  );
};

const normalizeArtifactDraft = (
  draft: RenderedArtifactDraft,
  existingEmbeddedAssets: readonly ProjectAssetRef[] = []
): RenderedArtifactDraft | null => {
  if (!isSafeGeneratedVisualCode(draft.kind, draft.code)) return null;
  if (draft.kind !== 'html') return draft.imageRequests.length === 0 ? draft : null;
  const normalized = normalizeHtmlArtifactImageRequests(draft.imageRequests, draft.code);
  if (!normalized) return null;
  const retainedAssets = existingEmbeddedAssets.filter(asset =>
    draft.code.includes(buildProjectAssetPlaceholder(asset.id))
  );
  return validateProjectAssetHtmlReferences(draft.code, retainedAssets).valid
    ? { ...draft, imageRequests: normalized }
    : null;
};

const buildReviewFeedback = (kind: RenderedArtifactDraft['kind'], issues: string[]): string => {
  if (kind !== 'svg') {
    return 'Review this HTML draft as educational software. Check that it runs without errors, every control produces its stated change, and the graphics come from verifiable rules or algorithms. If code cannot produce an artistic asset adequately, use imageRequests. Keep an exact correspondence between imageRequests and {{GENERATED_IMAGE:id}} placeholders, and correct every mismatch between labels and results.';
  }
  const issueList = issues.map(issue => `- ${issue}`).join('\n');
  return `This is the rendered version of the SVG draft. Correct real visual problems in readability, overlap, spacing, contrast, and edges while preserving content and pedagogical intent. The linter is heuristic. Use it as evidence, not as absolute truth.\n\n${issueList}`;
};

export const generateLessonVisualArtifact = async (
  input: RenderResolvedLessonVisualInput
): Promise<RenderedArtifactDraft | null> => {
  try {
    const draft = await requestArtifactRender(input);
    return normalizeArtifactDraft(draft, input.existingEmbeddedAssets);
  } catch (error) {
    input.signal.throwIfAborted();
    if (!isInvalidLessonVisualStructuredOutput(error)) throw error;
    return null;
  }
};

export const reviseLessonVisualArtifact = async (
  input: ReviseLessonVisualArtifactInput
): Promise<RenderedArtifactDraft | null> => {
  input.signal.throwIfAborted();
  const revision = await requestArtifactRender(input, {
    feedback: buildReviewFeedback(input.visual.kind, input.issues),
    ...(input.preview ? { preview: input.preview } : {}),
    previous: input.visual,
  });
  return normalizeArtifactDraft(revision, input.existingEmbeddedAssets);
};

export const toVisualRetryPlan = (plan: LessonVisualDraftPlan): LessonVisualRetryPlan => ({
  altText: plan.altText,
  anchorHeading: plan.anchorHeading,
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
  title: plan.title,
  visualDirection: plan.visualDirection,
  visualType: plan.visualType,
});
