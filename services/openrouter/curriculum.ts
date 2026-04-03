import {
  MODEL_FLASH,
  MODEL_REASONING,
  callOpenRouter,
  cleanJson,
  sanitizeTitle,
  retryWithBackoff,
  type LearnLessonContext,
  type LessonBlueprint,
  type ModuleBlueprint,
  type SyllabusItem,
  type UserProfile,
} from './shared.ts';

export const CURRICULUM_PROPEDEUTIC_ORDER_RULES = [
  "L'indice del corso deve essere in ordine strettamente propedeutico: non mettere mai prima gli argomenti che dipendono da concetti spiegati dopo.",
  'I moduli devono procedere dalle fondamenta ai meccanismi centrali, poi alle applicazioni, e solo dopo ai casi avanzati.',
  'Dentro ogni modulo, ordina le lezioni dal semplice al complesso e dal generale allo specifico.',
  "Se una lezione richiede definizioni, lessico o prerequisiti, questi devono comparire prima nella sequenza del corso.",
] as const;

const runArchitect = async (profile: UserProfile): Promise<ModuleBlueprint[]> => {
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
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
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
    messages: [{ role: 'user', content: checkPrompt }],
    response_format: { type: 'json_object' },
  });

  const result = JSON.parse(cleanJson(response || '{}')) as { valid?: boolean };
  return result.valid === true;
};

export const generateFullCurriculum = async (
  profile: UserProfile,
  onStatusUpdate: (msg: string) => void,
  onStructureUpdate: (items: SyllabusItem[]) => void,
  onRevisionStart: () => void
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
      modulesRaw = await runArchitect(profile);
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
  onStatusUpdate: (status: string) => void
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

  onStatusUpdate('Generating comprehensive lesson...');

  const prompt = `ROLE: World-Class Technical Author & Professor with a gift for making difficult ideas feel clear.
TONE: Direct, rigorous, accessible, narrative-driven.

LESSON: "${lessonTitle}" (Module: "${moduleTitle}")
DESCRIPTION: "${currentLessonDescription}"

STUDENT: ${resolvedProfile.context || 'General Learner'}
LEVEL: ${resolvedProfile.experienceLevel || 'Intermediate'}
LANG: ${resolvedProfile.language || 'Italian'}

TECHNICAL CONTEXT: "${contextPrompt || 'Explain this clearly.'}"

PAST TOPICS (already covered): ${pastContext || 'None - this is the first lesson'}
FUTURE TOPICS (coming next): ${futureContext || 'End of curriculum'}

CRITICAL WRITING RULES:
1. Prefer accessible language by default: avoid unnecessary jargon and avoid sounding manualistic when a direct explanation works.
2. When you introduce technical terminology, connect it immediately to a plain-language meaning.
3. Do not use unexplained acronyms or abbreviations. On first mention, always expand them and make their meaning clear.
4. Avoid unnecessary foreign words. If a natural, clear equivalent exists in the lesson language, prefer that.
5. Simplify the exposition, not the substance: stay precise without dumbing the topic down.
6. Explain the connection between distinct layers when relevant.
7. Start with a paradox or a bold statement. Never say "Welcome".
8. Do not use Mermaid diagrams.
9. Use realistic, detailed examples.
10. Write a comprehensive lesson, but keep it tightly scoped to the current lesson only.
11. Structure:
   - The Concept
   - The Architecture
   - The Implementation
   - The Trap
12. ${continuityRule}
13. Do not explain future lessons in detail. You may mention them briefly as forward references, but do not define, unpack, or teach their content here.
14. Do not add "deep-dive" sections just to make the lesson longer. If the current lesson's focus is complete, stop.
15. Every section must serve the current lesson. If one of the suggested headings adds no value, adapt or omit it.

FORMAT: Markdown.`;

  const response = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_REASONING,
        messages: [{ role: 'user', content: prompt }],
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
