import { getMarkdownHeadings } from '@shared/lessonPdfImageSelection';
import { generateText, jsonSchema, Output } from 'ai';

import {
  type GlobalModelConfig,
  resolveAiProviderForSlot,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
} from '../config/modelConfig.js';
import { createConfiguredTextModel } from './aiSdkTextModel.js';
import { runCodexAppServerTurn } from './codexAppServer.js';

export type LessonLearningAidKind = 'analogy' | 'definition' | 'formula';

const LEARNING_AID_KINDS = new Set<LessonLearningAidKind>(['analogy', 'definition', 'formula']);

export interface LessonLearningAidDraft {
  anchorHeading: string | null;
  content: string;
  kind: LessonLearningAidKind;
  title: string;
}

export interface StoredLessonLearningAid {
  anchorHeading?: string;
  content: string;
  id: string;
  kind: LessonLearningAidKind;
  title: string;
}

const MAX_DEFINITION_COUNT = 2;
const MAX_OTHER_KIND_COUNT = 1;
const MAX_LEARNING_AID_COUNT = 4;
const MAX_LESSON_MARKDOWN_CHARS = 24_000;
const LEARNING_AIDS_SYSTEM_INSTRUCTION =
  'You are Lia, a rigorous tutor. Extract only short, verifiable learning aids from the supplied text. Respond only with a valid JSON object that follows the requested schema.';

const LEARNING_AIDS_RESPONSE_SCHEMA = {
  name: 'lesson_learning_aids',
  strict: true,
  schema: {
    additionalProperties: false,
    properties: {
      aids: {
        items: {
          additionalProperties: false,
          properties: {
            anchorHeading: { type: ['string', 'null'] },
            content: { type: 'string' },
            kind: { enum: ['definition', 'formula', 'analogy'], type: 'string' },
            title: { type: 'string' },
          },
          required: ['kind', 'title', 'content', 'anchorHeading'],
          type: 'object',
        },
        maxItems: MAX_LEARNING_AID_COUNT,
        type: 'array',
      },
    },
    required: ['aids'],
    type: 'object',
  },
} as const;

const slugifyAidTitle = (value: string): string => {
  const slug = value
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-');
  return slug.split('-').filter(Boolean).join('-') || 'untitled';
};

const buildStableAidId = (
  kind: LessonLearningAidKind,
  title: string,
  usedIds: Set<string>
): string => {
  const baseId = `learning-aid-${kind}-${slugifyAidTitle(title)}`;
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
};

const normalizeLearningAidDraft = (
  value: unknown,
  headings: ReadonlySet<string>
): Omit<StoredLessonLearningAid, 'id'> | null => {
  if (!value || typeof value !== 'object') return null;
  const draft = value as Partial<LessonLearningAidDraft>;
  if (!draft.kind || !LEARNING_AID_KINDS.has(draft.kind)) return null;
  if (typeof draft.title !== 'string' || typeof draft.content !== 'string') return null;

  const title = draft.title.replaceAll(/\s+/gu, ' ').trim();
  const content = draft.content.replaceAll(/\s+/gu, ' ').trim();
  if (!title || !content) return null;

  const requestedAnchor =
    typeof draft.anchorHeading === 'string'
      ? draft.anchorHeading.replaceAll(/\s+/gu, ' ').trim()
      : '';
  const anchorHeading =
    requestedAnchor && headings.has(requestedAnchor) ? requestedAnchor : undefined;
  return {
    kind: draft.kind,
    title,
    content,
    ...(anchorHeading ? { anchorHeading } : {}),
  };
};

export const normalizeLessonLearningAids = (
  drafts: unknown,
  contentMarkdown: string
): StoredLessonLearningAid[] => {
  const headings = new Set(getMarkdownHeadings(contentMarkdown));
  const counts = new Map<LessonLearningAidKind, number>();
  const seen = new Set<string>();
  const usedIds = new Set<string>();
  const normalized: StoredLessonLearningAid[] = [];

  for (const value of Array.isArray(drafts) ? drafts : []) {
    const draft = normalizeLearningAidDraft(value, headings);
    if (!draft) continue;
    const dedupeKey = `${draft.kind}:${draft.title.toLocaleLowerCase()}`;
    const kindLimit = draft.kind === 'definition' ? MAX_DEFINITION_COUNT : MAX_OTHER_KIND_COUNT;
    if (seen.has(dedupeKey) || (counts.get(draft.kind) || 0) >= kindLimit) continue;

    normalized.push({
      ...draft,
      id: buildStableAidId(draft.kind, draft.title, usedIds),
    });
    seen.add(dedupeKey);
    counts.set(draft.kind, (counts.get(draft.kind) || 0) + 1);
    if (normalized.length >= MAX_LEARNING_AID_COUNT) break;
  }

  return normalized;
};

const buildLearningAidsPrompt = (
  contentMarkdown: string,
  sectionDescription: string,
  sectionTitle: string
): string => `Analyze the following lesson and identify only contextual aids that genuinely reduce cognitive load.

TITLE: ${sectionTitle}
DESCRIPTION: ${sectionDescription}

CONSTRAINTS:
- Write in the same language as the lesson.
- Return at most two important definitions specific to the context.
- Add at most one formula and one analogy, and only when they are genuinely useful.
- Use a formula only for a mathematical expression with quantities or symbols and a relationship useful for reference and reuse. Prose relationships, conceptual equivalences, mnemonic rules, and phrases that use "=" as shorthand are definitions, not formulas.
- Keep the title and content compact, self-contained, and free of filler.
- The title is a label with at most four words and 32 characters. Choose the shortest recognizable name for the concept, never a descriptive sentence.
- Every definition must be understandable on its own for immediate recall. Use common words and do not introduce unexplained technical terms. If a term is indispensable, clarify it within the same definition.
- Do not duplicate equivalent phrases or concepts.
- Use anchorHeading only when it exactly matches an existing Markdown heading. Otherwise use null.
- Do not modify the Markdown or propose text to insert into it.
- If no aid adds value, return an empty aids array.

LESSON:
${contentMarkdown.slice(0, MAX_LESSON_MARKDOWN_CHARS)}`;

export interface GenerateLessonLearningAidsInput {
  config: GlobalModelConfig;
  contentMarkdown: string;
  sectionDescription: string;
  sectionTitle: string;
  signal: AbortSignal;
}

export type RequestLessonLearningAidDrafts = (
  input: GenerateLessonLearningAidsInput,
  prompt: string
) => Promise<LessonLearningAidDraft[]>;

const requestLessonLearningAidDrafts: RequestLessonLearningAidDrafts = async (input, prompt) => {
  if (resolveAiProviderForSlot(input.config, 'lesson') === 'codex') {
    const modelConfig = resolveTextModelConfig(input.config, 'lesson');
    const response = await runCodexAppServerTurn({
      allowWebSearch: false,
      developerInstructions: `${LEARNING_AIDS_SYSTEM_INSTRUCTION} Do not use tools or access local files.`,
      input: [{ text: prompt, type: 'text' }],
      model: modelConfig.model,
      outputSchema: LEARNING_AIDS_RESPONSE_SCHEMA.schema,
      reasoningEffort: modelConfig.reasoningEffort,
      serviceTier: resolveCodexServiceTierForSlot(input.config, 'lesson'),
      signal: input.signal,
    });
    return (JSON.parse(response) as { aids: LessonLearningAidDraft[] }).aids;
  }

  const configured = createConfiguredTextModel(input.config, 'lesson');
  const { output } = await generateText({
    abortSignal: input.signal,
    maxRetries: 0,
    model: configured.model,
    output: Output.object({
      name: LEARNING_AIDS_RESPONSE_SCHEMA.name,
      schema: jsonSchema<{ aids: LessonLearningAidDraft[] }>(
        LEARNING_AIDS_RESPONSE_SCHEMA.schema as unknown as Parameters<typeof jsonSchema>[0]
      ),
    }),
    prompt,
    providerOptions: configured.providerOptions,
    system: LEARNING_AIDS_SYSTEM_INSTRUCTION,
  });
  return output.aids;
};

export const createLessonLearningAidGenerator =
  (requestDrafts: RequestLessonLearningAidDrafts = requestLessonLearningAidDrafts) =>
  async (input: GenerateLessonLearningAidsInput): Promise<StoredLessonLearningAid[]> => {
    const prompt = buildLearningAidsPrompt(
      input.contentMarkdown,
      input.sectionDescription,
      input.sectionTitle
    );
    const drafts = await requestDrafts(input, prompt);
    return normalizeLessonLearningAids(drafts, input.contentMarkdown);
  };

export const generateLessonLearningAids = createLessonLearningAidGenerator();
