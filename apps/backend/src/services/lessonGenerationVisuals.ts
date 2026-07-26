import { MAX_VISUAL_LESSON_CHARS } from '@shared/lessonGenerationPolicy';
import { generateText, jsonSchema, Output } from 'ai';

import {
  type GlobalModelConfig,
  resolveAiProviderForSlot,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
} from '../config/modelConfig.js';
import { createConfiguredTextModel } from './aiSdkTextModel.js';
import { runCodexAppServerTurn } from './codexAppServer.js';

export type LessonVisualType =
  | 'interactive_html'
  | 'mermaid_class'
  | 'mermaid_erd'
  | 'structural_svg';

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
  kind: 'html' | 'mermaid' | 'svg';
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
  kind: 'html' | 'mermaid' | 'svg';
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
    !/<script[^>]+\bsrc\s*=|\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/iu.test(trimmed)
  );
};

const ARTIFACT_RENDER_RESPONSE_SCHEMA = {
  name: 'durable_lesson_artifact',
  strict: true,
  schema: {
    additionalProperties: false,
    properties: { code: { type: 'string' } },
    required: ['code'],
    type: 'object',
  },
} as const;

const visualKindForPlan = (plan: LessonVisualDraftPlan): RenderedLessonVisual['kind'] => {
  if (plan.visualType === 'interactive_html') return 'html';
  if (plan.visualType === 'structural_svg') return 'svg';
  return 'mermaid';
};

const formatRuleForPlan = (plan: LessonVisualDraftPlan): string => {
  if (plan.visualType === 'interactive_html') {
    return 'Restituisci un frammento HTML autosufficiente che inizi con <style>, includa <script>, non usi rete, script esterni o un documento HTML completo.';
  }
  if (plan.visualType === 'structural_svg') {
    return 'Restituisci un singolo elemento <svg> completo, senza script, event handler o risorse di rete.';
  }
  const diagramType = plan.visualType === 'mermaid_class' ? 'classDiagram' : 'erDiagram';
  return `Restituisci soltanto codice Mermaid ${diagramType}.`;
};

const buildArtifactRenderPrompt = (
  input: RenderLessonVisualInput,
  invalidDraft?: string
): string => {
  const formatRule = formatRuleForPlan(input.plan);
  return `Genera il codice dell'esempio visuale pianificato per questa lezione.

Titolo lezione: ${input.sectionTitle}
Descrizione: ${input.sectionDescription}
Piano visuale: ${JSON.stringify(input.plan)}
Contenuto della lezione:
${input.lessonMarkdown.slice(0, MAX_VISUAL_LESSON_CHARS)}

${formatRule}
Ogni testo visibile deve usare la lingua della lezione. Il visuale deve rispettare i requisiti fattuali del piano e non aggiungere dettagli non supportati.
${invalidDraft ? `La bozza precedente non ha superato i controlli strutturali. Correggila integralmente:\n${invalidDraft}` : ''}
Restituisci soltanto il JSON richiesto.`;
};

const requestArtifactRender = async (
  input: RenderLessonVisualInput,
  invalidDraft?: string
): Promise<RenderedLessonVisual> => {
  const slot = input.plan.visualType === 'interactive_html' ? 'artifactInteractive' : 'artifact';
  const prompt = buildArtifactRenderPrompt(input, invalidDraft);
  const provider = resolveAiProviderForSlot(input.config, slot);
  const modelConfig = resolveTextModelConfig(input.config, slot);
  if (provider === 'codex') {
    const response = await runCodexAppServerTurn({
      allowWebSearch: false,
      developerInstructions:
        'Render one safe pedagogical artifact from the supplied plan. Do not use tools or access local files.',
      input: [{ text: prompt, type: 'text' }],
      model: modelConfig.model,
      outputSchema: ARTIFACT_RENDER_RESPONSE_SCHEMA.schema,
      reasoningEffort: modelConfig.reasoningEffort,
      serviceTier: resolveCodexServiceTierForSlot(input.config, slot),
      signal: input.signal,
    });
    const parsed = JSON.parse(response) as { code: string };
    return { code: parsed.code, kind: visualKindForPlan(input.plan) };
  }

  const configured = createConfiguredTextModel(input.config, slot);
  const { output } = await generateText({
    abortSignal: input.signal,
    model: configured.model,
    output: Output.object({
      name: ARTIFACT_RENDER_RESPONSE_SCHEMA.name,
      schema: jsonSchema<{ code: string }>(
        ARTIFACT_RENDER_RESPONSE_SCHEMA.schema as unknown as Parameters<typeof jsonSchema>[0]
      ),
    }),
    prompt,
    providerOptions: configured.providerOptions,
  });
  return { code: output.code, kind: visualKindForPlan(input.plan) };
};

export const renderLessonVisual: RenderLessonVisual = async input => {
  const reviewRounds = input.config.artifactVisualReviewEnabled
    ? input.config.artifactVisualReviewMaxRounds
    : 0;
  let invalidDraft: string | undefined;
  for (let round = 0; round <= reviewRounds; round += 1) {
    input.signal.throwIfAborted();
    const rendered = await requestArtifactRender(input, invalidDraft);
    if (isSafeGeneratedVisualCode(rendered.kind, rendered.code)) return rendered;
    invalidDraft = rendered.code;
  }
  return null;
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
