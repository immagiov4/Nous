import { SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES } from '@shared/sourceArchiveSelectors';
import { generateText, jsonSchema, Output } from 'ai';

import {
  type AiProvider,
  type GlobalModelConfig,
  getResolvedModelConfigForProvider,
  type ModelProviderOverrides,
  resolveAiProviderForSlot,
} from '../config/modelConfig.js';
import { ProjectRevisionConflictError } from '../projects/projectRevision.js';
import { getProjectStore } from '../projects/projectStore.js';
import { SourceArchiveAccess } from '../projects/sourceArchiveAccess.js';
import type { ProjectStore } from '../projects/types.js';
import { isRecord } from '../utils/validation.js';
import { createConfiguredTextModel } from './aiSdkTextModel.js';
import { runCodexAppServerTurn } from './codexAppServer.js';
import { type GenerationJob, TransientGenerationJobError } from './generationJobs.js';

interface LessonGenerationPayload {
  aiProvider?: AiProvider;
  aiProviderOverrides?: ModelProviderOverrides;
  forceRegenerate?: boolean;
  projectId: string;
  sectionId: string;
}

interface LessonGenerationDraft {
  contentBlocks: Array<
    | { markdown: string; type: 'markdown' }
    | {
        quiz: {
          correctIndex: number;
          exerciseType: string;
          options: string[];
          question: string;
        };
        type: 'inline-quiz';
      }
  >;
}

interface LessonGenerationInput {
  config: GlobalModelConfig;
  description: string;
  generationNotes?: string;
  previousLessonTitles: string[];
  sectionTitle: string;
  signal: AbortSignal;
  sourceContext: string;
}

type GenerateLesson = (input: LessonGenerationInput) => Promise<LessonGenerationDraft>;

const LESSON_JOB_RESPONSE_SCHEMA = {
  name: 'durable_lesson_generation',
  strict: true,
  schema: {
    additionalProperties: false,
    properties: {
      contentBlocks: {
        items: {
          anyOf: [
            {
              additionalProperties: false,
              properties: {
                markdown: { type: 'string' },
                type: { const: 'markdown', type: 'string' },
              },
              required: ['type', 'markdown'],
              type: 'object',
            },
            {
              additionalProperties: false,
              properties: {
                quiz: {
                  additionalProperties: false,
                  properties: {
                    correctIndex: { maximum: 3, minimum: 0, type: 'integer' },
                    exerciseType: { type: 'string' },
                    options: {
                      items: { type: 'string' },
                      maxItems: 4,
                      minItems: 4,
                      type: 'array',
                    },
                    question: { type: 'string' },
                  },
                  required: ['exerciseType', 'question', 'options', 'correctIndex'],
                  type: 'object',
                },
                type: { const: 'inline-quiz', type: 'string' },
              },
              required: ['type', 'quiz'],
              type: 'object',
            },
          ],
        },
        minItems: 2,
        type: 'array',
      },
    },
    required: ['contentBlocks'],
    type: 'object',
  },
} as const;

const parsePayload = (value: unknown): LessonGenerationPayload => {
  if (
    !isRecord(value) ||
    typeof value.projectId !== 'string' ||
    typeof value.sectionId !== 'string'
  ) {
    throw new Error('Invalid lesson generation payload.');
  }
  return value as unknown as LessonGenerationPayload;
};

const findSection = (
  project: Awaited<ReturnType<ProjectStore['loadProject']>>,
  sectionId: string
) => {
  const modules = project?.learningPlan?.modules;
  if (!Array.isArray(modules)) return null;
  for (const module of modules) {
    const section = module.children?.find(
      child => child.id === sectionId && child.kind !== 'exercise'
    );
    if (section && isRecord(section)) return section;
  }
  return null;
};

const buildMappedSourceContext = (
  project: NonNullable<Awaited<ReturnType<ProjectStore['loadProject']>>>,
  section: Record<string, unknown>
): string => {
  if (!isRecord(project.documentIndex) || !Array.isArray(project.documentIndex.chunks)) return '';
  const primaryChunkIds = Array.isArray(section.primaryChunkIds)
    ? section.primaryChunkIds.filter((id): id is string => typeof id === 'string')
    : [];
  const referencedChunkIds = Array.isArray(section.sourceReferences)
    ? section.sourceReferences.flatMap(reference =>
        isRecord(reference) && Array.isArray(reference.chunkIds)
          ? reference.chunkIds.filter((id): id is string => typeof id === 'string')
          : []
      )
    : [];
  const selectedIds = new Set([...primaryChunkIds, ...referencedChunkIds]);
  return project.documentIndex.chunks
    .filter(chunk => isRecord(chunk) && selectedIds.has(String(chunk.id)))
    .map(chunk => (isRecord(chunk) && typeof chunk.text === 'string' ? chunk.text.trim() : ''))
    .filter(Boolean)
    .join('\n\n');
};

const buildArchiveSourceContext = async (
  store: ProjectStore,
  userId: string,
  projectId: string,
  section: Record<string, unknown>
): Promise<string> => {
  const selectors = Array.isArray(section.sourceArchiveSelectors)
    ? section.sourceArchiveSelectors.filter(
        (selector): selector is { kind: 'directory' | 'file'; path: string } =>
          isRecord(selector) &&
          (selector.kind === 'directory' || selector.kind === 'file') &&
          typeof selector.path === 'string'
      )
    : [];
  if (selectors.length === 0) return '';
  const index = await store.loadProjectSourceArchiveIndex(userId, projectId);
  if (!index) throw new Error('Source archive not found for lesson generation.');
  const access = new SourceArchiveAccess({
    index: { entries: index.entries },
    maxContextBytes: SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES,
    readByteRange: (path, start, endExclusive) =>
      store
        .loadProjectSourceArchiveEntryRange(
          userId,
          projectId,
          path,
          index.version,
          start,
          endExclusive
        )
        .then(bytes => {
          if (!bytes) throw new Error('Source archive entry is missing.');
          return bytes;
        }),
    readBytes: path =>
      store.loadProjectSourceArchiveEntry(userId, projectId, path, index.version).then(bytes => {
        if (!bytes) throw new Error('Source archive entry is missing.');
        return bytes;
      }),
  });
  const files = await access.resolveSelectors(selectors);
  return files.map(file => `FILE ${file.path}\n${file.text}`).join('\n\n---\n\n');
};

const buildPrompt = (
  input: Omit<LessonGenerationInput, 'config' | 'signal'>
): string => `Genera una lezione completa e autonoma in italiano.

Titolo: ${input.sectionTitle}
Descrizione: ${input.description}
Lezioni gia completate: ${input.previousLessonTitles.join(', ') || 'nessuna'}
${input.generationNotes ? `Indicazioni del docente: ${input.generationNotes}` : ''}
${input.sourceContext ? `Materiale sorgente vincolante:\n${input.sourceContext}` : ''}

Restituisci soltanto il JSON richiesto. Alterna blocchi Markdown ricchi e da una a tre pause attive. Ogni pausa deve verificare applicazione, confronto, inferenza o diagnosi, avere quattro opzioni distinte e comparire dopo il contenuto necessario per rispondere.`;

const generateLesson: GenerateLesson = async input => {
  const prompt = buildPrompt(input);
  if (resolveAiProviderForSlot(input.config, 'lesson') === 'codex') {
    const response = await runCodexAppServerTurn({
      developerInstructions:
        'Generate the requested lesson as structured JSON. Do not use tools or access files.',
      input: [{ text: prompt, type: 'text' }],
      model: input.config.codexLessonModel,
      outputSchema: LESSON_JOB_RESPONSE_SCHEMA,
      reasoningEffort: input.config.lessonReasoningEffort,
    });
    return JSON.parse(response) as LessonGenerationDraft;
  }

  const configured = createConfiguredTextModel(input.config, 'lesson');
  const { output } = await generateText({
    abortSignal: input.signal,
    model: configured.model,
    output: Output.object({
      name: LESSON_JOB_RESPONSE_SCHEMA.name,
      schema: jsonSchema<LessonGenerationDraft>(
        LESSON_JOB_RESPONSE_SCHEMA.schema as unknown as Parameters<typeof jsonSchema>[0]
      ),
    }),
    prompt,
    providerOptions: configured.providerOptions,
  });
  return output;
};

const toContent = (draft: LessonGenerationDraft): string =>
  draft.contentBlocks
    .filter(
      (
        block
      ): block is Extract<LessonGenerationDraft['contentBlocks'][number], { type: 'markdown' }> =>
        block.type === 'markdown'
    )
    .map(block => block.markdown.trim())
    .filter(Boolean)
    .join('\n\n');

export const createLessonGenerationHandler =
  ({
    generate = generateLesson,
    getConfig = getResolvedModelConfigForProvider,
    store = getProjectStore(),
  }: {
    generate?: GenerateLesson;
    getConfig?: typeof getResolvedModelConfigForProvider;
    store?: ProjectStore;
  } = {}) =>
  async (job: GenerationJob, signal: AbortSignal): Promise<unknown> => {
    const payload = parsePayload(job.payload);
    const [project, projects] = await Promise.all([
      store.loadProject(job.userId, payload.projectId),
      store.listProjects(job.userId),
    ]);
    if (!project) throw new Error('Project not found for lesson generation.');
    const section = findSection(project, payload.sectionId);
    if (!section) throw new Error('Lesson not found for generation.');
    if (!payload.forceRegenerate && typeof section.content === 'string' && section.content.trim()) {
      return {
        alreadyCompleted: true,
        content: section.content,
        contentBlocks: Array.isArray(section.contentBlocks) ? section.contentBlocks : [],
        projectId: payload.projectId,
        quiz: Array.isArray(section.quiz) ? section.quiz : [],
        sectionId: payload.sectionId,
      };
    }

    const previousLessonTitles = (project.learningPlan?.modules ?? []).flatMap(module =>
      (module.children ?? []).flatMap(candidate =>
        candidate.isCompleted && typeof candidate.title === 'string' ? [candidate.title] : []
      )
    );
    const sourceContext =
      (await buildArchiveSourceContext(store, job.userId, payload.projectId, section)) ||
      buildMappedSourceContext(project, section);
    let draft: LessonGenerationDraft;
    try {
      draft = await generate({
        config: await getConfig(payload.aiProvider, payload.aiProviderOverrides),
        description: typeof section.description === 'string' ? section.description : '',
        generationNotes:
          typeof project.learningPlan?.generationNotes === 'string'
            ? project.learningPlan.generationNotes
            : undefined,
        previousLessonTitles,
        sectionTitle: typeof section.title === 'string' ? section.title : payload.sectionId,
        signal,
        sourceContext,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new TransientGenerationJobError('lesson_provider_failed');
    }
    const content = toContent(draft);
    if (!content) throw new Error('Generated lesson content is empty.');
    const quiz = draft.contentBlocks.flatMap(block =>
      block.type === 'inline-quiz' ? [block.quiz] : []
    );
    const meta = projects.find(candidate => candidate.id === payload.projectId);
    try {
      await store.patchProject(
        job.userId,
        payload.projectId,
        {
          activeSectionId: payload.sectionId,
          section: {
            content,
            contentBlocks: draft.contentBlocks,
            learningAids: [],
            quiz,
            sectionId: payload.sectionId,
          },
          state: 'reading',
        },
        { expectedRevision: meta?.revision }
      );
    } catch (error) {
      if (error instanceof ProjectRevisionConflictError) {
        throw new TransientGenerationJobError('project_revision_conflict');
      }
      throw error;
    }
    return {
      content,
      contentBlocks: draft.contentBlocks,
      projectId: payload.projectId,
      quiz,
      sectionId: payload.sectionId,
    };
  };

export const runLessonGenerationJob = createLessonGenerationHandler();
