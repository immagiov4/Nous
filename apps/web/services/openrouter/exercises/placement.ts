import type {
  LearningModule,
  LearningPlan,
  ResearchCoursePlan,
  ResearchDossiersBySectionId,
  UserProfile,
} from '../../../types.ts';
import { applyApplicationExercisePlacements } from '../../exercises/plan.ts';
import { MEDIUM_REASONING_CONFIG, MODEL_REASONING, teacherInstruction } from '../config.ts';
import { callOpenRouter, parseCleanJson } from '../shared.ts';

interface ExercisePlacementDraft {
  assessedObjective?: unknown;
  description?: unknown;
  moduleId?: unknown;
  title?: unknown;
}

interface ExercisePlacementResponseDraft {
  placements?: unknown;
  rationale?: unknown;
}

export interface GenerateApplicationExercisePlacementsArgs {
  courseIntent?: string;
  learningPlan: LearningPlan;
  profile: UserProfile | null;
  researchCoursePlan?: ResearchCoursePlan | null;
  researchDossiersBySectionId?: ResearchDossiersBySectionId;
  onReasoningUpdate?: (reasoning: string) => void;
  onStatusUpdate?: (status: string) => void;
  retryDelayMs?: number;
}

export interface GenerateApplicationExercisePlacementsResult {
  plan: LearningPlan;
  placedCount: number;
}

const PLACEMENT_MAX_ATTEMPTS = 3;
const PLACEMENT_INITIAL_RETRY_DELAY_MS = 1000;
const PLACEMENT_RETRY_BACKOFF_MULTIPLIER = 1.5;
const MAX_LESSON_DESCRIPTION_CHARS = 180;
const MAX_DOSSIER_EXAMPLES = 3;
const EXERCISE_PLACEMENT_RESPONSE_SCHEMA = {
  name: 'exercise_placements',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      rationale: { type: 'string' },
      placements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            moduleId: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            assessedObjective: { type: 'string' },
          },
          required: ['moduleId', 'title', 'description', 'assessedObjective'],
        },
      },
    },
    required: ['rationale', 'placements'],
  },
} as const;

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const buildProfileBlock = (profile: UserProfile | null): string =>
  profile
    ? [
        `Topic: ${profile.topic}`,
        `Livello: ${profile.experienceLevel}`,
        `Stile: ${profile.learningStyle}`,
        `Obiettivi: ${profile.goals}`,
        `Contesto: ${profile.context}`,
        `Lingua: ${profile.language}`,
      ].join('\n')
    : 'Profilo utente non disponibile. Usa lingua e tono del piano.';

const truncateLine = (value: string, maxChars: number): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1).trim()}…` : normalized;
};

const collectResearchExamples = (
  module: LearningModule,
  researchCoursePlan: ResearchCoursePlan | null | undefined,
  dossiers: ResearchDossiersBySectionId | undefined
): string[] => {
  const lessonIds = new Set(
    module.children.filter(child => child.kind === 'lesson').map(lesson => lesson.id)
  );
  const plannedExamples =
    researchCoursePlan?.lessons
      .filter(lesson => lessonIds.has(lesson.id))
      .flatMap(lesson => [lesson.miniLab, ...lesson.keyConcepts])
      .filter(Boolean) ?? [];
  const dossierExamples = Object.values(dossiers ?? {})
    .filter(dossier => lessonIds.has(dossier.sectionId))
    .flatMap(dossier => dossier.keyExamples);

  return [...plannedExamples, ...dossierExamples]
    .map(example => truncateLine(example, MAX_LESSON_DESCRIPTION_CHARS))
    .filter(Boolean)
    .slice(0, MAX_DOSSIER_EXAMPLES);
};

const buildModuleSummary = (
  module: LearningModule,
  researchCoursePlan: ResearchCoursePlan | null | undefined,
  dossiers: ResearchDossiersBySectionId | undefined
): string => {
  const lessonLines = module.children
    .filter(child => child.kind === 'lesson')
    .map(lesson => {
      const description = lesson.description
        ? ` — ${truncateLine(lesson.description, MAX_LESSON_DESCRIPTION_CHARS)}`
        : '';
      return `  - ${lesson.id}: ${lesson.title}${description}`;
    });
  const examples = collectResearchExamples(module, researchCoursePlan, dossiers);

  return [
    `MODULE ${module.id}: ${module.title}`,
    module.description ? `Scopo modulo: ${module.description}` : '',
    lessonLines.length ? `Lezioni:\n${lessonLines.join('\n')}` : 'Lezioni: nessuna',
    examples.length
      ? `Esempi/mini-lab gia emersi:\n${examples.map(item => `  - ${item}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
};

const buildPlacementPrompt = (args: GenerateApplicationExercisePlacementsArgs): string => {
  const moduleBlocks = args.learningPlan.modules.map(module =>
    buildModuleSummary(module, args.researchCoursePlan, args.researchDossiersBySectionId)
  );

  return `Devi scegliere dove inserire esercizi applicativi in un percorso Nous Reader.

REGOLA DI PRODOTTO:
- PDF-mode e corso senza PDF sono equivalenti: cambia solo la fonte, non la funzione.
- Un laboratorio NON e una lezione. Non scrivere la traccia completa ora.
- Questa passata decide solo posizione, titolo, descrizione e obiettivo valutato.
- Ogni esercizio deve verificare applicazione pratica, diagnosi, produzione o decisione operativa.
- Non usare template generici.
- Scegli solo i moduli dove un esercizio applicativo aggiunge davvero valore didattico.
- Un modulo introduttivo o molto teorico puo non avere esercizio.
- Al massimo un esercizio per modulo.
- Non fare web search e non introdurre argomenti fuori dal corso.

PROFILO STUDENTE:
${buildProfileBlock(args.profile)}

INTENTO CORSO:
${args.courseIntent?.trim() || args.learningPlan.summary || args.learningPlan.title}

PIANO:
${moduleBlocks.join('\n\n---\n\n')}

Rispondi solo con JSON:
{
  "rationale": "perche hai scelto queste posizioni",
  "placements": [
    {
      "moduleId": "id modulo esistente",
      "title": "titolo breve del laboratorio",
      "description": "cosa fara lo studente, senza traccia dettagliata",
      "assessedObjective": "obiettivo valutato in max 280 caratteri"
    }
  ]
}`;
};

const normalizePlacementResponse = (raw: string) => {
  const parsed = parseCleanJson<ExercisePlacementResponseDraft>(raw || '{}');
  const placements = Array.isArray(parsed.placements) ? parsed.placements : [];

  return {
    rationale: asString(parsed.rationale),
    placements: placements.map((placement): ExercisePlacementDraft => {
      const record = placement && typeof placement === 'object' ? placement : {};
      return {
        moduleId: (record as Record<string, unknown>).moduleId,
        title: (record as Record<string, unknown>).title,
        description: (record as Record<string, unknown>).description,
        assessedObjective: (record as Record<string, unknown>).assessedObjective,
      };
    }),
  };
};

const callPlacementModel = async (args: GenerateApplicationExercisePlacementsArgs) => {
  args.onStatusUpdate?.('Scelgo dove inserire gli esercizi…');
  const response = await callOpenRouter({
    model: MODEL_REASONING,
    modelSlot: 'lesson',
    reasoning: MEDIUM_REASONING_CONFIG,
    onReasoningUpdate: args.onReasoningUpdate,
    temperature: 0.2,
    messages: [
      { role: 'system', content: teacherInstruction },
      { role: 'user', content: buildPlacementPrompt(args) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: EXERCISE_PLACEMENT_RESPONSE_SCHEMA,
    },
  });

  args.onStatusUpdate?.('Verifico la pianificazione esercizi…');
  const normalized = normalizePlacementResponse(response);
  return applyApplicationExercisePlacements(
    args.learningPlan,
    normalized.placements.map(placement => ({
      moduleId: asString(placement.moduleId),
      title: asString(placement.title),
      description: asString(placement.description),
      assessedObjective: asString(placement.assessedObjective),
    })),
    normalized.rationale
  );
};

export const generateApplicationExercisePlacements = async (
  args: GenerateApplicationExercisePlacementsArgs
): Promise<GenerateApplicationExercisePlacementsResult> => {
  let attempt = 0;
  let delayMs = args.retryDelayMs ?? PLACEMENT_INITIAL_RETRY_DELAY_MS;
  let lastError: unknown = null;

  while (attempt < PLACEMENT_MAX_ATTEMPTS) {
    attempt += 1;
    try {
      return await callPlacementModel(args);
    } catch (error) {
      lastError = error;
      if (attempt >= PLACEMENT_MAX_ATTEMPTS) {
        break;
      }
      if (delayMs > 0) {
        await wait(delayMs);
      }
      delayMs *= PLACEMENT_RETRY_BACKOFF_MULTIPLIER;
    }
  }

  const error =
    lastError instanceof Error ? lastError : new Error('Pianificazione esercizi non riuscita.');
  throw Object.assign(error, { attempts: attempt });
};
