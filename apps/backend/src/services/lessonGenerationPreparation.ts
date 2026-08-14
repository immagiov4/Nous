import { normalizeLessonInstructionPacks } from '@shared/lessonInstructionPacks';

import type { GlobalModelConfig } from '../config/modelConfig.js';
import type { ProjectSnapshot, ProjectStore } from '../projects/types.js';
import { isRecord } from '../utils/validation.js';
import { findResearchLesson } from './lessonGenerationResearch.js';
import {
  buildArchiveSourceContext,
  buildMappedSourceContext,
  buildStoredDocumentSourceContext,
  LessonSourceUnavailableError,
  parseResearchSource,
  type ResearchSource,
  readExistingDossier,
  readProjectLanguage,
} from './lessonGenerationSources.js';
import type { LessonGenerationInput } from './lessonGenerationTypes.js';

const findNestedRecordById = (values: unknown, id: string): Record<string, unknown> | null => {
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    if (!isRecord(value)) continue;
    if (value.id === id) return value;
    const child = findNestedRecordById(value.children, id);
    if (child) return child;
  }
  return null;
};

export const findLessonSection = (
  project: ProjectSnapshot,
  sectionId: string
): Record<string, unknown> | null => {
  const modules = project.learningPlan?.modules;
  if (!Array.isArray(modules)) return null;
  for (const module of modules) {
    const section = module.children?.find(
      child => child.id === sectionId && child.kind !== 'exercise'
    );
    if (section && isRecord(section)) return section;
  }
  return null;
};

export const buildLessonPedagogicalContext = (
  project: ProjectSnapshot,
  section: Record<string, unknown>
): string => {
  const parent =
    typeof section.parentId === 'string' ? findLessonSection(project, section.parentId) : null;
  const syllabusItem = findNestedRecordById(project.syllabus, String(section.id));
  const researchLesson = findResearchLesson(project, String(section.id));
  return [
    typeof section.contextPrompt === 'string' && section.contextPrompt.trim()
      ? `OBIETTIVO SPECIFICO DELLA LEZIONE:\n${section.contextPrompt.trim()}`
      : '',
    parent
      ? `CONTESTO DELLA LEZIONE PADRE:\n${JSON.stringify({
          content: typeof parent.content === 'string' ? parent.content : '',
          description: typeof parent.description === 'string' ? parent.description : '',
          title: typeof parent.title === 'string' ? parent.title : '',
        })}`
      : '',
    project.userProfile
      ? `PROFILO DIDATTICO DELL'UTENTE:\n${JSON.stringify(project.userProfile)}`
      : '',
    syllabusItem ? `VOCE DI SYLLABUS:\n${JSON.stringify(syllabusItem)}` : '',
    researchLesson ? `PIANO DI RICERCA DELLA LEZIONE:\n${JSON.stringify(researchLesson)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
};

export const readPreviousLessonTitles = (project: ProjectSnapshot): string[] =>
  (project.learningPlan?.modules ?? []).flatMap(module =>
    (module.children ?? []).flatMap(candidate =>
      candidate.isCompleted && typeof candidate.title === 'string' ? [candidate.title] : []
    )
  );

export const resolveLessonSourceMaterials = async ({
  project,
  projectId,
  section,
  sectionId,
  signal,
  store,
  userId,
}: {
  project: ProjectSnapshot;
  projectId: string;
  section: Record<string, unknown>;
  sectionId: string;
  signal: AbortSignal;
  store: ProjectStore;
  userId: string;
}) => {
  const archiveContext = await buildArchiveSourceContext(store, userId, projectId, section);
  let sourceContext = archiveContext || buildMappedSourceContext(project, section);
  if (!sourceContext && project.sourceKind === 'document') {
    sourceContext = await buildStoredDocumentSourceContext(
      store,
      userId,
      projectId,
      section,
      signal
    );
    if (!sourceContext) throw new LessonSourceUnavailableError();
  }
  const existingDossier = readExistingDossier(project, sectionId);
  const existingSources = Array.isArray(existingDossier?.sources)
    ? existingDossier.sources.flatMap(source => {
        const parsed = parseResearchSource(source);
        return parsed ? [parsed] : [];
      })
    : [];
  return { existingDossier, existingSources, sourceContext };
};

export const buildLessonGenerationInput = ({
  config,
  coverageGaps,
  project,
  refreshResearch = false,
  researchSources,
  section,
  sectionId,
  signal,
  sourceContext,
}: {
  config: GlobalModelConfig;
  coverageGaps?: string[];
  project: ProjectSnapshot;
  refreshResearch?: boolean;
  researchSources: ResearchSource[];
  section: Record<string, unknown>;
  sectionId: string;
  signal: AbortSignal;
  sourceContext: string;
}) => {
  const sectionDescription = typeof section.description === 'string' ? section.description : '';
  const sectionTitle = typeof section.title === 'string' ? section.title : sectionId;
  const generationInput: LessonGenerationInput = {
    config,
    coverageGaps,
    description: sectionDescription,
    generationNotes:
      typeof project.learningPlan?.generationNotes === 'string'
        ? project.learningPlan.generationNotes
        : undefined,
    imageCandidates: [],
    instructionPacks: Array.isArray(section.instructionPacks)
      ? normalizeLessonInstructionPacks(section.instructionPacks)
      : [],
    language: readProjectLanguage(project),
    pedagogicalContext: buildLessonPedagogicalContext(project, section),
    previousLessonTitles: readPreviousLessonTitles(project),
    refreshResearch,
    researchContext: '',
    sectionTitle,
    signal,
    sourceContext,
    sources: researchSources,
  };
  return { generationInput, sectionDescription, sectionTitle };
};
