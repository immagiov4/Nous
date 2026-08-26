import type {
  ApplicationExerciseNode,
  LearningPlan,
  LessonNode,
  PdfTextIndex,
  ResearchDossiersBySectionId,
  ResearchSourceReference,
  UserProfile,
} from '../../../types.ts';
import { flattenPathNodes } from '../../../utils/learning/pathNodes.ts';
import { readCompleteMarkdownPlaceholderRange } from '../../../utils/markdown/codeRanges.ts';
import { stripInlineQuizMarkers } from '../../../utils/reader/inlineQuiz.ts';
import { clipText } from '../../../utils/text.ts';
import { MEDIUM_REASONING_CONFIG, MODEL_REASONING, teacherInstruction } from '../config.ts';
import { callOpenRouter, parseCleanJson, retryWithBackoff } from '../shared.ts';

interface ExerciseBriefDraft {
  briefMarkdown?: unknown;
  groundingSources?: unknown;
  plannerNotes?: unknown;
}

export interface ExercisePrerequisiteGap {
  id: string;
  title: string;
}

export interface GenerateApplicationExerciseBriefArgs {
  documentIndex?: PdfTextIndex | null;
  exercise: ApplicationExerciseNode;
  learningPlan: LearningPlan;
  profile: UserProfile | null;
  researchDossiersBySectionId?: ResearchDossiersBySectionId;
  onReasoningUpdate?: (reasoning: string) => void;
  onStatusUpdate?: (status: string) => void;
}

export interface GenerateApplicationExerciseBriefResult {
  brief: string;
  groundingSources?: ResearchSourceReference[];
  plannerNotes?: string;
}

const MAX_FOCUS_LESSON_CHARS = 9000;
const MAX_PREREQUISITE_CHARS = 4000;
const MAX_SOURCE_CHARS = 12_000;
const MAX_GROUNDING_SOURCES = 6;
const EXERCISE_BRIEF_RESPONSE_SCHEMA = {
  name: 'exercise_brief',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      briefMarkdown: { type: 'string' },
      groundingSources: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['title', 'url', 'note'],
        },
      },
      plannerNotes: { type: 'string' },
    },
    required: ['briefMarkdown', 'groundingSources', 'plannerNotes'],
  },
} as const;
const VISUAL_PLACEHOLDER_REGEX = /\{\{(?:PDF_IMAGE|VISUAL_EXAMPLE):[^{}]+}}/g;

const stripVisualPlaceholders = (content: string): string =>
  content.replaceAll(VISUAL_PLACEHOLDER_REGEX, (placeholder, offset: number) =>
    readCompleteMarkdownPlaceholderRange(content, offset) ? '' : placeholder
  );

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const normalizeSources = (value: unknown): ResearchSourceReference[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const sources = value
    .map((source): ResearchSourceReference | null => {
      if (typeof source === 'string') {
        const title = source.trim();
        return title ? { title } : null;
      }
      if (!source || typeof source !== 'object') {
        return null;
      }

      const record = source as Record<string, unknown>;
      const title = asString(record.title) || asString(record.url);
      const url = asString(record.url) || undefined;
      const note = asString(record.note) || undefined;
      return title ? { title, url, note } : null;
    })
    .filter((source): source is ResearchSourceReference => Boolean(source))
    .slice(0, MAX_GROUNDING_SOURCES);

  return sources.length ? sources : undefined;
};

export const getExercisePrerequisiteGaps = (
  plan: LearningPlan | null,
  exerciseId: string
): ExercisePrerequisiteGap[] => {
  const nodes = flattenPathNodes(plan?.modules);
  const exerciseIndex = nodes.findIndex(node => node.kind === 'exercise' && node.id === exerciseId);
  if (exerciseIndex < 0) {
    return [];
  }

  return nodes
    .slice(0, exerciseIndex)
    .filter((node): node is LessonNode => node.kind === 'lesson')
    .filter(lesson => !lesson.content?.trim())
    .map(lesson => ({ id: lesson.id, title: lesson.title }));
};

const getFocusLessons = (plan: LearningPlan, exerciseId: string): LessonNode[] => {
  const nodes = flattenPathNodes(plan.modules);
  const exerciseIndex = nodes.findIndex(node => node.kind === 'exercise' && node.id === exerciseId);
  if (exerciseIndex < 0) {
    return [];
  }

  let previousExerciseIndex = -1;
  for (let index = exerciseIndex - 1; index >= 0; index -= 1) {
    if (nodes[index]?.kind === 'exercise') {
      previousExerciseIndex = index;
      break;
    }
  }
  const focusStartIndex = previousExerciseIndex < 0 ? 0 : previousExerciseIndex + 1;

  return nodes
    .slice(focusStartIndex, exerciseIndex)
    .filter((node): node is LessonNode => node.kind === 'lesson');
};

const stripGeneratedLessonPlaceholders = (content: string): string =>
  stripVisualPlaceholders(stripInlineQuizMarkers(content)).trim();

const formatFocusLessons = (lessons: LessonNode[]): string =>
  lessons
    .map(
      lesson =>
        `## ${lesson.title}\nDescrizione: ${lesson.description}\n\n${clipText(
          stripGeneratedLessonPlaceholders(lesson.content || ''),
          MAX_FOCUS_LESSON_CHARS,
          '[lezione troncata per budget]'
        )}`
    )
    .join('\n\n---\n\n');

const formatPrerequisiteLessons = (plan: LearningPlan, focusLessonIds: Set<string>): string => {
  const lines = flattenPathNodes(plan.modules)
    .filter((node): node is LessonNode => node.kind === 'lesson' && !focusLessonIds.has(node.id))
    .map(lesson => `- ${lesson.title}: ${lesson.description}`);

  return clipText(lines.join('\n'), MAX_PREREQUISITE_CHARS, '[prerequisiti troncati]');
};

const formatPdfSourceLayer = (
  lessons: LessonNode[],
  documentIndex: PdfTextIndex | null
): string => {
  if (!documentIndex) {
    return '';
  }

  const chunkIds = new Set(lessons.flatMap(lesson => lesson.primaryChunkIds || []));
  if (chunkIds.size === 0) {
    return '';
  }

  const chunks = documentIndex.chunks
    .filter(chunk => chunkIds.has(chunk.id))
    .sort((left, right) => left.sequence - right.sequence)
    .map(chunk => `### ${chunk.headingPath.join(' > ') || chunk.id}\n${chunk.text}`);

  return clipText(chunks.join('\n\n'), MAX_SOURCE_CHARS, '[fonti PDF troncate]');
};

const formatResearchSourceLayer = (
  lessons: LessonNode[],
  dossiers: ResearchDossiersBySectionId | undefined
): string => {
  const lessonIds = new Set(lessons.map(lesson => lesson.id));
  const blocks = Object.values(dossiers ?? {})
    .filter(dossier => lessonIds.has(dossier.sectionId))
    .map(dossier =>
      [
        `### ${dossier.title}`,
        dossier.factualSummary,
        dossier.keyExamples.length ? `Esempi:\n- ${dossier.keyExamples.join('\n- ')}` : '',
        dossier.difficultSteps.length
          ? `Passaggi difficili:\n- ${dossier.difficultSteps.join('\n- ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    );

  return clipText(blocks.join('\n\n'), MAX_SOURCE_CHARS, '[dossier troncati]');
};

const buildBriefPrompt = (args: GenerateApplicationExerciseBriefArgs): string => {
  const focusLessons = getFocusLessons(args.learningPlan, args.exercise.id);
  const focusLessonIds = new Set(focusLessons.map(lesson => lesson.id));
  const sourceLayer =
    formatPdfSourceLayer(focusLessons, args.documentIndex ?? null) ||
    formatResearchSourceLayer(focusLessons, args.researchDossiersBySectionId) ||
    'Nessuna fonte esterna disponibile: usa solo le lezioni generate.';

  return `Genera la consegna completa di un laboratorio applicativo Nous Reader.

REGOLA FONDAMENTALE:
- Questo NON e una lezione. Non spiegare il modulo come contenuto didattico.
- Scrivi la traccia piu breve che renda il compito autonomo, sicuro e valutabile. La complessita della traccia deve essere proporzionata a quella del compito: un esercizio semplice non va trasformato in un capitolato.
- Lo studente deve produrre qualcosa: diagnosi, mappa, checklist, procedura, configurazione ragionata, report o artefatto equivalente.
- Non introdurre concetti nuovi fuori dal corso; puoi usare esempi realistici solo per rendere il compito concreto.
- Se il task dipende da un messaggio, caso, dataset, configurazione, brano o altro oggetto da analizzare, fornisci tu nella traccia tutto il materiale necessario in forma compatta ma sufficiente.
- Non chiedere allo studente di cercare, scegliere o recuperare autonomamente il materiale di partenza: il laboratorio deve essere autosufficiente.
- Distingui cio che lo studente deve fare da eventuali dati di partenza, ma non imporre una sezione per ogni aspetto della traccia. Usa heading solo quando aiutano davvero a orientarsi.
- Dai i vincoli indispensabili per delimitare o rendere sicuro il lavoro; non aggiungere checklist, criteri di verifica dettagliati, conteggi, formati o passaggi intermedi se l'esercizio non li richiede davvero.
- Non anticipare la soluzione, la classificazione corretta, la procedura completa o le osservazioni che lo studente deve ricavare. Fornisci contesto sufficiente per iniziare, non una risposta guidata da ricopiare.
- Indica la consegna una sola volta, nel modo piu diretto possibile. Non aggiungere riepiloghi finali, rubriche rivolte allo studente o sezioni "Obiettivo".
- Lingua: ${args.profile?.language || 'Italiano'}.

ESERCIZIO PIANIFICATO:
Titolo: ${args.exercise.title}
Descrizione: ${args.exercise.description}
Criterio valutato interno: ${args.exercise.assessedObjective}

PROFILO:
${args.profile ? `${args.profile.context}\nScopi utente: ${args.profile.goals}\nLivello: ${args.profile.experienceLevel}` : 'Profilo non disponibile.'}

LEZIONI FOCUS:
${formatFocusLessons(focusLessons)}

PREREQUISITI DISPONIBILI SOLO COME CONTESTO:
${formatPrerequisiteLessons(args.learningPlan, focusLessonIds)}

FONTI DEL SEGMENTO:
${sourceLayer}

Rispondi solo con JSON:
{
  "briefMarkdown": "markdown della consegna, non della lezione",
  "groundingSources": [{"title": "fonte se usata", "url": "https://...", "note": "cosa supporta"}],
  "plannerNotes": "nota breve interna opzionale"
}`;
};

export const generateApplicationExerciseBrief = async (
  args: GenerateApplicationExerciseBriefArgs
): Promise<GenerateApplicationExerciseBriefResult> => {
  args.onStatusUpdate?.('Raccolgo il materiale…');

  const gaps = getExercisePrerequisiteGaps(args.learningPlan, args.exercise.id);
  if (gaps.length) {
    throw new Error('Genera prima le lezioni precedenti al laboratorio.');
  }

  args.onStatusUpdate?.('Genero la consegna…');
  const response = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_REASONING,
        modelSlot: 'lesson',
        reasoning: MEDIUM_REASONING_CONFIG,
        onReasoningUpdate: args.onReasoningUpdate,
        temperature: 0.25,
        messages: [
          { role: 'system', content: teacherInstruction },
          { role: 'user', content: buildBriefPrompt(args) },
        ],
        response_format: { type: 'json_schema', json_schema: EXERCISE_BRIEF_RESPONSE_SCHEMA },
      }),
    2,
    1000
  );

  args.onStatusUpdate?.('Verifico la traccia…');
  const parsed = parseCleanJson<ExerciseBriefDraft>(response || '{}');
  const brief = asString(parsed.briefMarkdown);
  if (!brief) {
    throw new Error('Il modello non ha restituito una traccia valida.');
  }

  return {
    brief,
    groundingSources: normalizeSources(parsed.groundingSources),
    plannerNotes: asString(parsed.plannerNotes) || undefined,
  };
};
