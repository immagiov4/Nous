import type {
  LearningPlan,
  LearningSection,
  LessonGeneratedVisual,
  LessonLearningAid,
  QuizQuestion,
  ResearchCoursePlan,
  ResearchLessonDossier,
  ResearchLessonPlan,
  ResearchSourceReference,
  SyllabusItem,
  UserProfile,
} from '../../types.ts';
import { timestampIso } from '../../utils/time.ts';
import { groupSectionsIntoModules } from '../learning/groupSectionsIntoModules.ts';
import {
  MEDIUM_REASONING_CONFIG,
  MODEL_REASONING,
  MODEL_RESEARCH_DOSSIER,
  MODEL_RESEARCH_PLANNER,
  teacherInstruction,
} from './config.ts';
import { generateLessonLearningAids } from './learningAids.ts';
import { appendGeneratedVisualExample } from './lessonImages.ts';
import { generateStandaloneLessonQuiz } from './lessonMarkdownQuality/index.ts';
import { buildUserGenerationNotesBlock } from './prompts.ts';
import { callOpenRouter, parseCleanJson, retryWithBackoff, sanitizeTitle } from './shared.ts';

const MIN_RESEARCH_LESSONS = 8;
const MAX_RESEARCH_LESSONS = 24;
const DEFAULT_RESEARCH_LANGUAGE = 'Italiano';
const SOURCE_LIST_LIMIT = 8;

interface ResearchLessonDraft {
  description?: string;
  guidingQuestions?: unknown[];
  keyConcepts?: unknown[];
  miniLab?: string;
  prerequisites?: unknown[];
  simplificationRisks?: unknown[];
  sourceHints?: unknown[];
  title?: string;
}

interface ResearchModuleDraft {
  description?: string;
  lessons?: ResearchLessonDraft[];
  title?: string;
}

interface ResearchCoursePlanDraft {
  lessonCountReason?: string;
  modules?: ResearchModuleDraft[];
  summary?: string;
  title?: string;
}

interface ResearchLessonDossierDraft {
  avoidOversimplifying?: unknown[];
  controversies?: unknown[];
  difficultSteps?: unknown[];
  factualSummary?: string;
  keyExamples?: unknown[];
  recentDevelopments?: unknown[];
  sources?: unknown[];
}

interface ResearchCourseGenerationResult {
  researchCoursePlan: ResearchCoursePlan;
  syllabus: SyllabusItem[];
}

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const asStringArray = (value: unknown, limit = 8): string[] =>
  Array.isArray(value) ? value.map(asString).filter(Boolean).slice(0, limit) : [];

const normalizeSourceReferences = (value: unknown): ResearchSourceReference[] =>
  Array.isArray(value)
    ? value
        .map((source): ResearchSourceReference | null => {
          if (typeof source === 'string') {
            return { title: source.trim() };
          }

          if (!source || typeof source !== 'object') {
            return null;
          }

          const record = source as Record<string, unknown>;
          const title = asString(record.title) || asString(record.name) || asString(record.url);
          const url = asString(record.url) || undefined;
          const note = asString(record.note) || asString(record.description) || undefined;

          return title || url ? { title: title || url || 'Fonte', url, note } : null;
        })
        .filter((source): source is ResearchSourceReference => Boolean(source))
        .slice(0, SOURCE_LIST_LIMIT)
    : [];

const normalizeLessonCount = (count: number): number =>
  Math.max(MIN_RESEARCH_LESSONS, Math.min(MAX_RESEARCH_LESSONS, count));

const buildContextPrompt = (lesson: ResearchLessonPlan): string => {
  const lines = [
    `Scopo: ${lesson.description}`,
    lesson.keyConcepts.length ? `Concetti chiave: ${lesson.keyConcepts.join(', ')}` : '',
    lesson.guidingQuestions.length ? `Domande guida: ${lesson.guidingQuestions.join(' | ')}` : '',
    lesson.miniLab ? `Mini-laboratorio: ${lesson.miniLab}` : '',
    lesson.simplificationRisks.length
      ? `Non semplificare troppo: ${lesson.simplificationRisks.join(' | ')}`
      : '',
  ];

  return lines.filter(Boolean).join('\n');
};

const normalizeResearchCoursePlan = (
  draft: ResearchCoursePlanDraft,
  profile: UserProfile
): ResearchCourseGenerationResult => {
  const modules = Array.isArray(draft.modules) ? draft.modules : [];
  const plannedLessonCount = modules.reduce(
    (count, module) => count + (Array.isArray(module.lessons) ? module.lessons.length : 0),
    0
  );
  const lessonLimit = normalizeLessonCount(plannedLessonCount);
  const lessons: ResearchLessonPlan[] = [];
  const syllabus: SyllabusItem[] = [];

  modules.forEach((module, moduleIndex) => {
    if (!Array.isArray(module.lessons) || module.lessons.length === 0) {
      return;
    }

    const moduleId = `mod-${moduleIndex + 1}`;
    const moduleTitle = sanitizeTitle(asString(module.title) || `Modulo ${moduleIndex + 1}`);
    const children: SyllabusItem[] = [];

    module.lessons.forEach((lesson, lessonIndex) => {
      if (lessons.length >= lessonLimit) {
        return;
      }

      const title = sanitizeTitle(asString(lesson.title) || `Lezione ${lessons.length + 1}`);
      const normalizedLesson: ResearchLessonPlan = {
        id: `${moduleId}-lesson-${lessonIndex + 1}`,
        title,
        description: asString(lesson.description) || `Studiare ${title}.`,
        moduleId,
        moduleTitle,
        prerequisites: asStringArray(lesson.prerequisites),
        keyConcepts: asStringArray(lesson.keyConcepts, 12),
        guidingQuestions: asStringArray(lesson.guidingQuestions),
        miniLab: asString(lesson.miniLab),
        simplificationRisks: asStringArray(lesson.simplificationRisks),
        sourceHints: normalizeSourceReferences(lesson.sourceHints),
      };

      lessons.push(normalizedLesson);
      children.push({
        id: normalizedLesson.id,
        title: normalizedLesson.title,
        description: normalizedLesson.description,
        type: 'lesson',
        status: 'pending',
        contextPrompt: buildContextPrompt(normalizedLesson),
      });
    });

    if (children.length) {
      syllabus.push({
        id: moduleId,
        title: moduleTitle,
        description: asString(module.description),
        type: 'module',
        status: 'ready',
        children,
      });
    }
  });

  if (lessons.length === 0) {
    throw new Error('Research planner did not return usable lessons.');
  }

  const fallbackTitle = profile.topic || 'Percorso di ricerca';
  return {
    researchCoursePlan: {
      generatedAt: timestampIso(),
      lessonCountReason: asString(draft.lessonCountReason),
      title: sanitizeTitle(asString(draft.title) || fallbackTitle),
      summary: asString(draft.summary) || profile.context || profile.goals,
      lessons,
    },
    syllabus,
  };
};

export const buildLearningPlanFromResearchCourse = (
  profile: UserProfile,
  researchCoursePlan: ResearchCoursePlan,
  syllabus: SyllabusItem[]
): LearningPlan => {
  const sections: LearningSection[] = syllabus.flatMap(module =>
    (module.children || []).map(lesson => ({
      id: lesson.id,
      title: lesson.title,
      description: lesson.description,
      isCompleted: false,
      type: 'core' as const,
      parentId: module.id,
      moduleTitle: module.title,
      contextPrompt: lesson.contextPrompt,
    }))
  );

  return {
    title: researchCoursePlan.title || profile.topic,
    summary: researchCoursePlan.summary || profile.context,
    modules: groupSectionsIntoModules(sections),
    applicationExercisePlanningStatus: 'not-run',
  };
};

const buildCoursePlanResearchPrompt = (profile: UserProfile): string => {
  const topic = profile.topic || 'General knowledge';
  const language = profile.language || DEFAULT_RESEARCH_LANGUAGE;
  return `Ricerca approfondita sull'argomento: "${topic}".

Per chi: livello ${profile.experienceLevel || 'intermedio'}, stile di apprendimento ${profile.learningStyle || 'pratico'}, obiettivo "${profile.goals || "comprendere l'argomento"}", background "${profile.context || 'studente generico'}".

Cosa includere nel brief (in prosa, ${language}):
- Mappa del campo: concetti fondamentali, idee intermedie, sottoargomenti avanzati.
- Misconcezioni comuni e punti che NON vanno semplificati.
- Ordine di progressione consigliato (cosa dipende da cosa).
- Fonti autorevoli con URL: documentazione ufficiale, libri di riferimento, paper, tutorial riconosciuti.
- Esempi concreti, mini-progetti o esercizi pratici utili.
- Sezione dedicata "Sviluppi recenti": cosa è cambiato negli ultimi 12-24 mesi su questo argomento (nuove versioni, paper, scoperte, dibattiti, deprecazioni, best practice attuali). Devi cercare attivamente sul web per questa sezione: il tuo training cutoff può non includerli, quindi affidati alle fonti web più aggiornate. Indica le date delle informazioni.

Vincoli:
- Cerca informazioni reali sul topic, incluse fonti recenti. NON parlare di pianificazione di corsi o di metodologia.
- Scrivi prosa lineare con citazioni inline (URL). Niente JSON, niente markdown headers, niente intestazioni "ROLE:" o "STUDENT:".
- Lingua: ${language}.`;
};

const buildCoursePlanStructuringPrompt = (
  profile: UserProfile,
  researchBrief: string
): string => `ROLE: Curriculum architect for Nous Reader.

You receive a research brief from a separate web-research model. Turn it into a structured course plan.

STUDENT PROFILE:
- Topic: ${profile.topic || 'General knowledge'}
- Level: ${profile.experienceLevel || 'Intermediate'}
- Learning style: ${profile.learningStyle || 'Practical'}
- Goals: ${profile.goals || 'Understand the topic'}
- Context: ${profile.context || 'General learner'}
- Language: ${profile.language || DEFAULT_RESEARCH_LANGUAGE}

RESEARCH BRIEF:
${researchBrief}

COURSE SIZE RULE:
- Narrow/practical query: 8-12 lessons.
- Medium topic: 12-16 lessons.
- Wide discipline-level topic: 16-24 lessons.
- Choose the count from the topic complexity and student goals.

PRODUCT RULES:
- Nous Reader teaches whole subjects step by step, not isolated facts.
- Favor ADHD-friendly progression: small coherent lessons, explicit prerequisites, practical pauses.
- Keep breadth broad enough to orient the learner, but do not produce an encyclopedia.
- Use the research brief as the source of truth. Do not invent sources that are not in the brief.
- Output JSON only. No prose around it.

Return this JSON shape:
{
  "title": "Course title",
  "summary": "Short course summary",
  "lessonCountReason": "Why this course has this number of lessons",
  "modules": [
    {
      "title": "Module title",
      "description": "Module purpose",
      "lessons": [
        {
          "title": "Lesson title",
          "description": "Lesson goal",
          "prerequisites": ["..."],
          "keyConcepts": ["..."],
          "guidingQuestions": ["..."],
          "miniLab": "Small applied exercise",
          "sourceHints": [{"title": "Source title", "url": "https://...", "note": "Why useful"}],
          "simplificationRisks": ["What not to flatten"]
        }
      ]
    }
  ]
}`;

export const generateResearchCoursePlan = async (
  profile: UserProfile,
  onStatusUpdate: (message: string) => void,
  onStructureUpdate: (items: SyllabusItem[]) => void,
  onReasoningUpdate?: (reasoning: string) => void
): Promise<ResearchCourseGenerationResult> => {
  onStatusUpdate('Ricerca delle fonti...');

  const researchBrief = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_RESEARCH_PLANNER,
        modelSlot: 'research',
        messages: [{ role: 'user', content: buildCoursePlanResearchPrompt(profile) }],
      }),
    2,
    1000
  );

  onStatusUpdate('Strutturazione del corso...');

  const structuredResponse = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_REASONING,
        reasoning: MEDIUM_REASONING_CONFIG,
        onReasoningUpdate,
        messages: [
          {
            role: 'user',
            content: buildCoursePlanStructuringPrompt(profile, researchBrief || ''),
          },
        ],
        response_format: { type: 'json_object' },
      }),
    2,
    1000
  );

  const result = normalizeResearchCoursePlan(
    parseCleanJson<ResearchCoursePlanDraft>(structuredResponse || '{}'),
    profile
  );
  onStructureUpdate(result.syllabus);
  return result;
};

const findResearchLesson = (
  researchCoursePlan: ResearchCoursePlan | null,
  sectionId: string
): ResearchLessonPlan | null =>
  researchCoursePlan?.lessons.find(lesson => lesson.id === sectionId) || null;

const buildSourceHintBlock = (lesson: ResearchLessonPlan | null): string =>
  lesson?.sourceHints.length
    ? lesson.sourceHints
        .map(source => `- ${source.title}${source.url ? ` (${source.url})` : ''}`)
        .join('\n')
    : 'No source hints stored in the course plan.';

const buildLessonPlanContextBlock = (
  lesson: LearningSection,
  moduleTitle: string,
  researchLesson: ResearchLessonPlan | null
): string => {
  if (lesson.contextPrompt?.trim()) {
    return lesson.contextPrompt;
  }

  if (researchLesson) {
    return buildContextPrompt(researchLesson);
  }

  return buildContextPrompt({
    id: lesson.id,
    title: lesson.title,
    description: lesson.description,
    moduleId: '',
    moduleTitle,
    prerequisites: [],
    keyConcepts: [],
    guidingQuestions: [],
    miniLab: '',
    simplificationRisks: [],
    sourceHints: [],
  });
};

const buildLessonDossierResearchPrompt = (args: {
  lesson: LearningSection;
  moduleTitle: string;
  profile: UserProfile | null;
  researchCoursePlan: ResearchCoursePlan | null;
  researchLesson: ResearchLessonPlan | null;
}): string => {
  const profile = args.profile;
  const language = profile?.language || DEFAULT_RESEARCH_LANGUAGE;
  const lessonTitle = args.lesson.title;
  const lessonGoal = args.lesson.description;
  const courseTitle = args.researchCoursePlan?.title || profile?.topic || '';
  const moduleTitle = args.moduleTitle || args.researchLesson?.moduleTitle || '';
  const planContext = buildLessonPlanContextBlock(
    args.lesson,
    args.moduleTitle,
    args.researchLesson
  );
  const sourceHints = buildSourceHintBlock(args.researchLesson);
  return `Ricerca approfondita su questa lezione specifica: "${lessonTitle}".

Obiettivo della lezione: ${lessonGoal}
${courseTitle ? `Corso di riferimento: ${courseTitle}` : ''}
${moduleTitle ? `Modulo: ${moduleTitle}` : ''}
Per chi: livello ${profile?.experienceLevel || 'intermedio'}, background "${profile?.context || 'studente generico'}".

Contesto del piano:
${planContext}

Fonti suggerite dal piano (puoi usarle o aggiungerne):
${sourceHints}

Cosa includere nel brief (in prosa, ${language}):
- Sintesi fattuale densa sul tema della lezione.
- Esempi concreti che illustrano le idee principali.
- Passaggi sottili che spesso vengono fraintesi.
- Aspetti che NON vanno semplificati.
- Punti su cui fonti autorevoli sono in disaccordo, se presenti.
- Sezione dedicata "Sviluppi recenti": novità degli ultimi 12-24 mesi specificamente rilevanti per QUESTA lezione (nuove versioni, paper, scoperte, cambi di best practice, deprecazioni). Cerca attivamente sul web — il tuo training cutoff può escluderli. Indica le date.
- Fonti autorevoli con URL, includendo fonti recenti per la sezione sviluppi.

Vincoli:
- Cerca informazioni reali sul topic della lezione, incluse fonti recenti. NON parlare di pedagogia o di come scrivere lezioni.
- Scrivi prosa lineare con citazioni inline (URL). Niente JSON, niente intestazioni "ROLE:" o "STUDENT:".
- Lingua: ${language}.`;
};

const buildLessonDossierStructuringPrompt = (args: {
  lesson: LearningSection;
  moduleTitle: string;
  profile: UserProfile | null;
  researchCoursePlan: ResearchCoursePlan | null;
  researchBrief: string;
}): string => {
  const profile = args.profile;
  return `ROLE: Dossier structurer for a learning app.

You receive a research brief from a separate web-research model. Turn it into a compact dossier for another pedagogical model.

COURSE: ${args.researchCoursePlan?.title || profile?.topic || 'Course'}
MODULE: ${args.moduleTitle}
LESSON: ${args.lesson.title}
LESSON GOAL: ${args.lesson.description}
LANGUAGE: ${profile?.language || DEFAULT_RESEARCH_LANGUAGE}

RESEARCH BRIEF:
${args.researchBrief}

RULES:
- Use the research brief as the source of truth. Do not invent sources or facts that are not in it.
- Output JSON only. No prose around it.

Return this JSON shape:
{
  "factualSummary": "Dense factual basis for the lesson",
  "keyExamples": ["Important examples"],
  "difficultSteps": ["Conceptual steps students may find hard"],
  "sources": [{"title": "Source title", "url": "https://...", "note": "What it supports"}],
  "avoidOversimplifying": ["What must stay precise"],
  "controversies": ["Differences between sources or disputed points, if any"],
  "recentDevelopments": ["Recent updates from the last 12-24 months relevant to this lesson, with dates if available. Pull only from the brief; if the brief has no recent info, return an empty array."]
}`;
};

export const generateResearchLessonDossier = async (args: {
  lesson: LearningSection;
  moduleTitle: string;
  profile: UserProfile | null;
  researchCoursePlan: ResearchCoursePlan | null;
  onStatusUpdate: (message: string) => void;
  onReasoningUpdate?: (reasoning: string) => void;
}): Promise<ResearchLessonDossier> => {
  const researchLesson = findResearchLesson(args.researchCoursePlan, args.lesson.id);
  args.onStatusUpdate('Raccolta fonti della lezione...');

  const researchBrief = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_RESEARCH_DOSSIER,
        modelSlot: 'research',
        messages: [
          {
            role: 'user',
            content: buildLessonDossierResearchPrompt({
              lesson: args.lesson,
              moduleTitle: args.moduleTitle,
              profile: args.profile,
              researchCoursePlan: args.researchCoursePlan,
              researchLesson,
            }),
          },
        ],
      }),
    2,
    1000
  );

  args.onStatusUpdate('Strutturazione del dossier...');

  const structuredResponse = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_REASONING,
        reasoning: MEDIUM_REASONING_CONFIG,
        onReasoningUpdate: args.onReasoningUpdate,
        messages: [
          {
            role: 'user',
            content: buildLessonDossierStructuringPrompt({
              lesson: args.lesson,
              moduleTitle: args.moduleTitle,
              profile: args.profile,
              researchCoursePlan: args.researchCoursePlan,
              researchBrief: researchBrief || '',
            }),
          },
        ],
        response_format: { type: 'json_object' },
      }),
    2,
    1000
  );

  const parsed = parseCleanJson<ResearchLessonDossierDraft>(structuredResponse || '{}');
  return {
    sectionId: args.lesson.id,
    title: args.lesson.title,
    generatedAt: timestampIso(),
    factualSummary: asString(parsed.factualSummary),
    keyExamples: asStringArray(parsed.keyExamples),
    difficultSteps: asStringArray(parsed.difficultSteps),
    avoidOversimplifying: asStringArray(parsed.avoidOversimplifying),
    controversies: asStringArray(parsed.controversies),
    recentDevelopments: asStringArray(parsed.recentDevelopments),
    sources: normalizeSourceReferences(parsed.sources),
  };
};

const formatResearchDossierForPrompt = (dossier: ResearchLessonDossier): string =>
  [
    `Factual summary:\n${dossier.factualSummary}`,
    dossier.keyExamples.length ? `Key examples:\n- ${dossier.keyExamples.join('\n- ')}` : '',
    dossier.difficultSteps.length
      ? `Difficult steps:\n- ${dossier.difficultSteps.join('\n- ')}`
      : '',
    dossier.avoidOversimplifying.length
      ? `Do not oversimplify:\n- ${dossier.avoidOversimplifying.join('\n- ')}`
      : '',
    dossier.controversies.length ? `Caveats:\n- ${dossier.controversies.join('\n- ')}` : '',
    dossier.recentDevelopments?.length
      ? `Sviluppi recenti (ultimi 12-24 mesi, da fonti web aggiornate):\n- ${dossier.recentDevelopments.join('\n- ')}`
      : '',
    dossier.sources.length
      ? `Sources:\n${dossier.sources
          .map(source => `- ${source.title}${source.url ? `: ${source.url}` : ''}`)
          .join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

const formatVisibleResearchSources = (dossier: ResearchLessonDossier): string => {
  if (!dossier.sources.length) {
    return '';
  }

  const sourceList = dossier.sources
    .slice(0, SOURCE_LIST_LIMIT)
    .map(source => `- ${source.url ? `[${source.title}](${source.url})` : source.title}`)
    .join('\n');

  return `\n\n## Fonti essenziali\n\n${sourceList}`;
};

export const generateResearchLessonContent = async (args: {
  lessonTitle: string;
  moduleTitle: string;
  contextPrompt?: string;
  profile: UserProfile | null;
  syllabus: SyllabusItem[];
  researchDossier: ResearchLessonDossier;
  generationNotes?: string;
  onStatusUpdate: (status: string) => void;
  onReasoningUpdate?: (reasoning: string) => void;
}): Promise<{
  content: string;
  generatedVisuals: LessonGeneratedVisual[];
  learningAids: LessonLearningAid[];
  quiz: QuizQuestion[];
}> => {
  const profile = args.profile ?? {
    topic: args.moduleTitle || args.lessonTitle || 'General Knowledge',
    experienceLevel: 'Intermediate',
    learningStyle: 'Practical',
    goals: `Study ${args.lessonTitle}`,
    context: 'General learner without a stored profile.',
    language: DEFAULT_RESEARCH_LANGUAGE,
  };
  const userNotesBlock = buildUserGenerationNotesBlock(args.generationNotes);
  args.onStatusUpdate('Scrittura lezione da fonti...');

  const prompt = `${userNotesBlock}

LEZIONE: "${args.lessonTitle}" (Modulo: "${args.moduleTitle}")
STUDENTE: ${profile.context || 'Studente generico'}
LIVELLO: ${profile.experienceLevel || 'Intermediate'}
LINGUA: ${profile.language || DEFAULT_RESEARCH_LANGUAGE}

PIANO DELLA LEZIONE:
${args.contextPrompt || 'Spiega chiaramente questo argomento.'}

DOSSIER DI RICERCA (materiale sorgente):
${formatResearchDossierForPrompt(args.researchDossier)}

ISTRUZIONI:
- Usa il dossier come fonte dei contenuti, ma NON copiarlo o riassumerlo punto per punto: rielaboralo come prosa di lezione.
- Il dossier è materiale grezzo strutturato in liste: il tuo compito è trasformarlo in PROSA DISCORSIVA. Il fatto che il dossier sia in bullet non autorizza la lezione a esserlo.
- VINCOLO FORTE SULLA FORMA: il corpo della lezione deve essere paragrafi di prosa. I bullet sono ammessi solo in casi rari e davvero giustificati (un'enumerazione tassonomica corta, un comando con flag), non come modo di default per esporre concetti. Niente liste di "cosa significa", "cosa ottieni", "perché è utile". Quei contenuti vanno scritti come frasi piene dentro un paragrafo.
- Niente sezione "In sintesi" o riepiloghi finali a bullet: la lezione si chiude con un paragrafo conclusivo se serve.
- Limita le intestazioni \`##\`: una struttura con 8-12 sezioni numerate spezzetta troppo. Preferisci poche sezioni ampie con prosa continua.
- Mantieni il focus stretto su questa lezione.
- Non fingere che lo studente abbia un documento aperto.
- Non usare diagrammi Mermaid.
- Niente bibliografia lunga: una sezione "Fonti essenziali" breve in fondo basta.
- Se il dossier contiene "Sviluppi recenti", integra quei punti organicamente nel corpo della lezione (con date quando disponibili) dove sono pertinenti, invece di confinarli in una sezione separata. Non inventare aggiornamenti che non sono nel dossier.

FORMATO: Markdown.`;

  const response = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_REASONING,
        reasoning: MEDIUM_REASONING_CONFIG,
        onReasoningUpdate: args.onReasoningUpdate,
        temperature: 0.2,
        messages: [
          { role: 'system', content: teacherInstruction },
          { role: 'user', content: prompt },
        ],
      }),
    2,
    1000
  );

  const lessonContent = (response || '')
    .replace(/^Here is.*?:\s*/i, '')
    .replace(/^Certamente.*?:\s*/i, '')
    .replace(/```json/g, '')
    .trim();
  const sourceBlock = formatVisibleResearchSources(args.researchDossier);
  const contentWithSources =
    !sourceBlock || /##\s+Fonti essenziali/i.test(lessonContent)
      ? lessonContent
      : `${lessonContent}${sourceBlock}`;

  const [visualResult, learningAids] = await Promise.all([
    appendGeneratedVisualExample({
      contentMarkdown: contentWithSources,
      generationNotes: args.generationNotes,
      hasPdfImages: false,
      onStatusUpdate: args.onStatusUpdate,
      sectionDescription: args.contextPrompt || args.lessonTitle,
      sectionTitle: args.lessonTitle,
    }),
    generateLessonLearningAids({
      contentMarkdown: contentWithSources,
      sectionDescription: args.contextPrompt || args.lessonTitle,
      sectionTitle: args.lessonTitle,
    }),
  ]);

  args.onStatusUpdate('Generazione quiz...');
  let quiz: QuizQuestion[] = [];
  try {
    quiz = await generateStandaloneLessonQuiz({
      contentMarkdown: visualResult.content,
      sectionTitle: args.lessonTitle,
      language: profile.language,
    });
  } catch (error) {
    console.warn(
      '[Nous][ResearchLesson] Quiz generation failed, keeping lesson without quiz.',
      error
    );
  }

  return {
    content: visualResult.content,
    generatedVisuals: visualResult.generatedVisuals,
    learningAids,
    quiz,
  };
};
