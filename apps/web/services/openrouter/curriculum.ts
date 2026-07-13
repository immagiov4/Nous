import { MEDIUM_REASONING_CONFIG } from './config.ts';
import {
  buildUserGenerationNotesBlock,
  CURRICULUM_PROPEDEUTIC_ORDER_RULES,
  LESSON_SCOPE_RULES,
  LESSON_SHARED_WRITING_RULES,
} from './prompts.ts';
import {
  callOpenRouter,
  cleanJson,
  type LearnLessonContext,
  type LessonBlueprint,
  MODEL_FLASH,
  MODEL_REASONING,
  type ModuleBlueprint,
  retryWithBackoff,
  type SyllabusItem,
  sanitizeTitle,
  type UserProfile,
} from './shared.ts';

export { CURRICULUM_PROPEDEUTIC_ORDER_RULES };

const CURRICULUM_RESPONSE_SCHEMA = {
  name: 'curriculum',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      modules: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            lessons: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  contextPrompt: { type: 'string' },
                },
                required: ['title', 'description', 'contextPrompt'],
              },
            },
          },
          required: ['title', 'description', 'lessons'],
        },
      },
    },
    required: ['modules'],
  },
} as const;
const CURRICULUM_REVIEW_RESPONSE_SCHEMA = {
  name: 'curriculum_review',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { valid: { type: 'boolean' } },
    required: ['valid'],
  },
} as const;

const runArchitect = async (
  profile: UserProfile,
  onReasoningUpdate?: (reasoning: string) => void
): Promise<ModuleBlueprint[]> => {
  const prompt = `ROLE: Curriculum Architect & Researcher.
TOPIC: ${profile.topic || 'General Knowledge'} (${profile.experienceLevel || 'Intermediate'})
CONTEXT: ${profile.context || 'General Learner'}
LANG: ${profile.language || 'Italian'}

TASK: Design a comprehensive 4-7 Module curriculum. Each module MUST contain 3-5 specific lessons.
OUTPUT: JSON Only.

RULES:
- Titles MUST be short (max 6 words).
- No "Introduction to..." boilerplate.
- Structure logically: Foundations -> Core Mechanics -> Advanced Patterns -> Mastery.
- Enforce prerequisite order across the whole curriculum:
${CURRICULUM_PROPEDEUTIC_ORDER_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n')}
- Each lesson must focus on one core concept.
- For each lesson, provide a specific contextPrompt for the writer.

Return JSON with this structure:
{
  "modules": [
    {
      "title": "Module Title",
      "description": "Module description",
      "lessons": [
        {
          "title": "Lesson Title",
          "description": "Lesson description",
          "contextPrompt": "Specific instruction for the writer"
        }
      ]
    }
  ]
}`;

  const response = await callOpenRouter({
    model: MODEL_REASONING,
    reasoning: MEDIUM_REASONING_CONFIG,
    onReasoningUpdate,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_schema', json_schema: CURRICULUM_RESPONSE_SCHEMA },
  });

  const data = JSON.parse(cleanJson(response || '{}')) as { modules?: ModuleBlueprint[] };
  return data.modules || [];
};

const runCritic = async (modules: ModuleBlueprint[]): Promise<boolean> => {
  if (modules.length === 0) {
    return false;
  }

  const checkPrompt = `Analyze these module titles.
1. Are they coherent?
2. Do they look like raw prompts?
3. Are they too long?

Return TRUE only if they are high quality titles.

Titles: ${JSON.stringify(modules.map(module => module.title))}

Return JSON: { "valid": true } or { "valid": false }`;

  const response = await callOpenRouter({
    model: MODEL_FLASH,
    reasoning: MEDIUM_REASONING_CONFIG,
    messages: [{ role: 'user', content: checkPrompt }],
    response_format: { type: 'json_schema', json_schema: CURRICULUM_REVIEW_RESPONSE_SCHEMA },
  });

  const result = JSON.parse(cleanJson(response || '{}')) as { valid?: boolean };
  return result.valid === true;
};

export const generateFullCurriculum = async (
  profile: UserProfile,
  onStatusUpdate: (msg: string) => void,
  onStructureUpdate: (items: SyllabusItem[]) => void,
  onRevisionStart: () => void,
  onReasoningUpdate?: (reasoning: string) => void
): Promise<SyllabusItem[]> => {
  let modulesRaw: ModuleBlueprint[] = [];
  let attempts = 0;
  let validSkeleton = false;

  while (!validSkeleton && attempts < 3) {
    attempts += 1;
    onStatusUpdate(
      attempts > 1
        ? `Architect is redesigning (Attempt ${attempts})...`
        : 'Architect is designing the blueprint...'
    );

    try {
      modulesRaw = await runArchitect(profile, onReasoningUpdate);
      validSkeleton = await runCritic(modulesRaw);
    } catch (error) {
      console.error('Architect failed', error);
    }
  }

  onRevisionStart();

  const syllabus = modulesRaw.map((module, moduleIndex) => ({
    id: `mod-${moduleIndex}`,
    title: sanitizeTitle(module.title),
    description: module.description,
    type: 'module' as const,
    status: 'ready' as const,
    children:
      module.lessons?.map((lesson: LessonBlueprint, lessonIndex) => ({
        id: `mod-${moduleIndex}-lesson-${lessonIndex}`,
        title: sanitizeTitle(lesson.title),
        description: lesson.description,
        contextPrompt: lesson.contextPrompt,
        type: 'lesson' as const,
        status: 'pending' as const,
      })) || [],
  }));

  onStructureUpdate([...syllabus]);
  return syllabus;
};

const getCurriculumContext = (
  syllabus: SyllabusItem[],
  currentModuleId: string,
  currentLessonId: string
): LearnLessonContext => {
  const pastTopics: string[] = [];
  const futureTopics: string[] = [];
  let foundCurrent = false;
  let currentLessonDescription = '';

  syllabus.forEach(module => {
    if (!module.children) {
      return;
    }

    if (module.id === currentModuleId) {
      module.children.forEach(lesson => {
        if (lesson.id === currentLessonId) {
          foundCurrent = true;
          currentLessonDescription = lesson.description;
        } else if (!foundCurrent) {
          pastTopics.push(`(Same Module) ${lesson.title}: ${lesson.description}`);
        } else {
          futureTopics.push(`(Same Module) ${lesson.title}`);
        }
      });
      return;
    }

    if (!foundCurrent) {
      pastTopics.push(`MODULE: ${module.title}`);
      return;
    }

    futureTopics.push(`MODULE: ${module.title}`);
  });

  return {
    pastContext: pastTopics.join('\n'),
    futureContext: futureTopics.join('\n'),
    currentLessonDescription,
  };
};

const getProfileFallback = (
  profile: UserProfile | null,
  lessonTitle: string,
  moduleTitle: string
): UserProfile => {
  if (profile) {
    return profile;
  }

  return {
    topic: moduleTitle || lessonTitle || 'General Knowledge',
    experienceLevel: 'Intermediate',
    learningStyle: 'Practical',
    goals: `Study ${lessonTitle || 'the requested lesson'}`,
    context: 'General learner without a stored profile.',
    language: 'Italian',
  };
};

export const generateLearnLessonContent = async (
  lessonTitle: string,
  moduleTitle: string,
  currentModuleId: string,
  currentLessonId: string,
  contextPrompt: string | undefined,
  profile: UserProfile | null,
  syllabus: SyllabusItem[],
  onStatusUpdate: (status: string) => void,
  generationNotes?: string,
  onReasoningUpdate?: (reasoning: string) => void
): Promise<string> => {
  const resolvedProfile = getProfileFallback(profile, lessonTitle, moduleTitle);
  const { pastContext, futureContext, currentLessonDescription } = getCurriculumContext(
    syllabus,
    currentModuleId,
    currentLessonId
  );
  const isFirstLesson = pastContext.trim().length === 0;
  const continuityRule = isFirstLesson
    ? "This is the first lesson. Do not mention previous lessons, prior chapters, or phrases like 'as we already saw'."
    : 'Only refer to previous lessons if they are present in PAST TOPICS. Do not invent prior material.';
  const scopeRule = LESSON_SCOPE_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n');

  onStatusUpdate('Generating comprehensive lesson...');

  const userNotesBlock = buildUserGenerationNotesBlock(generationNotes);

  const systemPrompt = `ROLE: World-Class Technical Author & Professor with a gift for making difficult ideas feel clear.
TONE: Direct, rigorous, accessible, narrative-driven.

CRITICAL WRITING RULES:
1. Scrivi una lezione esaustiva in Markdown ricco, ma ad alta densita informativa: niente riempitivo, niente ripetizioni decorative, niente giri larghi per dire poco.
2. Non ripetere il titolo della lezione come primo heading.
3. Organizza il testo con heading chiari, ma usa solo le sezioni che servono davvero a questa lezione. Non creare heading riempitivi.
4. Ogni sezione deve aggiungere informazione nuova. Non rispiegare la stessa definizione con semplici parafrasi.
5. Non usare diagrammi Mermaid.
6. Il corpo deve essere soprattutto prosa discorsiva. I bullet sono ammessi solo per checklist operative brevi, comandi, passaggi diagnostici o confronti dove migliorano davvero la leggibilita.
${LESSON_SHARED_WRITING_RULES}
19. ${continuityRule}
20. Do not explain future lessons in detail. You may mention them briefly as forward references, but do not define, unpack, or teach their content here.
21. Vincoli di focus della lezione:
${scopeRule}

FORMAT: Markdown.`;

  const userPrompt = `${userNotesBlock}
LESSON: "${lessonTitle}" (Module: "${moduleTitle}")
DESCRIPTION: "${currentLessonDescription}"

STUDENT: ${resolvedProfile.context || 'General Learner'}
LEVEL: ${resolvedProfile.experienceLevel || 'Intermediate'}
LANG: ${resolvedProfile.language || 'Italian'}

TECHNICAL CONTEXT: "${contextPrompt || 'Explain this clearly.'}"

PAST TOPICS (already covered): ${pastContext || 'None - this is the first lesson'}
FUTURE TOPICS (coming next): ${futureContext || 'End of curriculum'}`;

  const response = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_REASONING,
        reasoning: MEDIUM_REASONING_CONFIG,
        onReasoningUpdate,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    2,
    1000
  );

  return (response || '')
    .replace(/^Here is.*?:\s*/i, '')
    .replace(/^Certamente.*?:\s*/i, '')
    .replace(/```json/g, '')
    .trim();
};
