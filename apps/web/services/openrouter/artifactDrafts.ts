import type {
  LearningArtifactRenderPayload,
  LearningArtifactSummary,
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
  mode?: 'new' | 'replacement-draft';
  projectId: ProjectId;
  projectTitle: string;
  prompt: string;
  rasterImageRequested?: boolean;
  revisionInstructions?: string;
  selectedText?: string;
  sourceArtifact?: LearningArtifactRenderPayload;
  sourceArtifactId?: string;
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
  mode,
  prompt,
  revisionInstructions,
  selectedText,
  sourceArtifact,
}: Pick<
  GenerateLessonArtifactDraftInput,
  | 'contextAfter'
  | 'contextBefore'
  | 'lesson'
  | 'mode'
  | 'prompt'
  | 'revisionInstructions'
  | 'selectedText'
  | 'sourceArtifact'
>): string =>
  [
    `Richiesta visuale dell'utente:\n${prompt.trim()}`,
    mode === 'replacement-draft'
      ? 'Modalita: crea una bozza modificata dell artefatto sorgente, non una variante indipendente.'
      : undefined,
    revisionInstructions?.trim()
      ? `Istruzioni di revisione obbligatorie:\n${revisionInstructions.trim()}`
      : undefined,
    sourceArtifact
      ? [
          'Artefatto sorgente da modificare:',
          `Titolo: ${sourceArtifact.summary.title}`,
          `Tipo: ${sourceArtifact.summary.kind}`,
          'visual' in sourceArtifact && sourceArtifact.visual.kind === 'image'
            ? `Descrizione attuale: ${sourceArtifact.visual.altText || sourceArtifact.visual.title}`
            : 'visual' in sourceArtifact
              ? `Codice attuale:\n${sourceArtifact.visual.code}`
              : undefined,
        ]
          .filter(Boolean)
          .join('\n')
      : undefined,
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
  mode = 'new',
  projectId,
  projectTitle,
  prompt,
  rasterImageRequested,
  revisionInstructions,
  selectedText,
  sourceArtifact,
  sourceArtifactId,
}: GenerateLessonArtifactDraftInput): Promise<GeneratedLessonArtifactDraft | null> => {
  const lessonMarkdown = buildDraftLessonMarkdown({
    contextAfter,
    contextBefore,
    lesson,
    mode,
    prompt,
    revisionInstructions,
    selectedText,
    sourceArtifact,
  });

  const result = await generateLessonVisualExample({
    generationNotes,
    hasPdfImages: false,
    lessonMarkdown,
    sectionDescription: `${lesson.description}\n\nRichiesta: ${prompt.trim()}`,
    sectionTitle: lesson.title,
    visualTypeHint: rasterImageRequested ? 'illustrative_image' : undefined,
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
  }) as LearningArtifactRenderPayload & {
    summary: LearningArtifactSummary & { kind: 'generated-visual' };
    visual: LessonGeneratedVisual;
  };
  const replacementOfArtifactId =
    mode === 'replacement-draft' ? sourceArtifactId || sourceArtifact?.summary.id : undefined;
  const renderPayload: LearningArtifactRenderPayload & { visual: LessonGeneratedVisual } =
    replacementOfArtifactId
      ? {
          ...payload,
          summary: {
            ...payload.summary,
            replacementOfArtifactId,
          },
          visual,
        }
      : payload;

  return {
    artifactId: renderPayload.summary.id,
    payload: renderPayload as LearningArtifactRenderPayload & { visual: LessonGeneratedVisual },
    visual,
  };
};
