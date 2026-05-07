import type {
  LearningArtifactRenderPayload,
  LearningSection,
  LessonGeneratedVisual,
  ProjectId,
} from '../../types.ts';
import { createEntityId } from '../../utils/ids.ts';
import { buildGeneratedVisualLearningArtifactPayload } from '../../utils/learning/artifacts.ts';
import { generateLessonVisualExample } from './visualExamples.ts';

interface GenerateLessonArtifactDraftInput {
  contextAfter?: string;
  contextBefore?: string;
  generationNotes?: string;
  lesson: LearningSection;
  projectId: ProjectId;
  projectTitle: string;
  prompt: string;
  selectedText?: string;
}

export interface GeneratedLessonArtifactDraft {
  artifactId: string;
  payload: LearningArtifactRenderPayload & { visual: LessonGeneratedVisual };
  visual: LessonGeneratedVisual;
}

const VISUAL_DRAFT_ID_PREFIX = 'visual-draft';

const createVisualDraftId = () =>
  createEntityId({ fallbackPrefix: VISUAL_DRAFT_ID_PREFIX, uuidPrefix: VISUAL_DRAFT_ID_PREFIX });

const buildDraftLessonMarkdown = ({
  contextAfter,
  contextBefore,
  lesson,
  prompt,
  selectedText,
}: Pick<
  GenerateLessonArtifactDraftInput,
  'contextAfter' | 'contextBefore' | 'lesson' | 'prompt' | 'selectedText'
>): string =>
  [
    `Richiesta visuale dell'utente:\n${prompt.trim()}`,
    selectedText?.trim() ? `Passaggio selezionato:\n${selectedText.trim()}` : undefined,
    contextBefore?.trim() ? `Contesto precedente:\n${contextBefore.trim()}` : undefined,
    lesson.content?.trim() ? `Lezione:\n${lesson.content.trim()}` : undefined,
    contextAfter?.trim() ? `Contesto successivo:\n${contextAfter.trim()}` : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');

export const generateLessonArtifactDraft = async ({
  contextAfter,
  contextBefore,
  generationNotes,
  lesson,
  projectId,
  projectTitle,
  prompt,
  selectedText,
}: GenerateLessonArtifactDraftInput): Promise<GeneratedLessonArtifactDraft | null> => {
  const lessonMarkdown = buildDraftLessonMarkdown({
    contextAfter,
    contextBefore,
    lesson,
    prompt,
    selectedText,
  });

  const result = await generateLessonVisualExample({
    generationNotes,
    hasPdfImages: false,
    lessonMarkdown,
    sectionDescription: `${lesson.description}\n\nRichiesta: ${prompt.trim()}`,
    sectionTitle: lesson.title,
  });

  if (!result) {
    return null;
  }

  const visual = {
    ...result.visual,
    anchorHeading: result.anchorHeading,
    id: createVisualDraftId(),
  };
  const payload = buildGeneratedVisualLearningArtifactPayload({
    lesson,
    projectId,
    projectTitle,
    visual,
  });

  return {
    artifactId: payload.summary.id,
    payload: payload as LearningArtifactRenderPayload & { visual: LessonGeneratedVisual },
    visual,
  };
};
