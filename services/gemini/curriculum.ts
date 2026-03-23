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

  const prompt = `ROLE: World-Class Technical Author & Professor.
TONE: Authoritative, "No BS", Charismatic, Narrative-driven.

LESSON: "${lessonTitle}" (Module: "${moduleTitle}")
DESCRIPTION: "${currentLessonDescription}"

STUDENT: ${resolvedProfile.context || 'General Learner'}
LEVEL: ${resolvedProfile.experienceLevel || 'Intermediate'}
LANG: ${resolvedProfile.language || 'Italian'}

TECHNICAL CONTEXT: "${contextPrompt || 'Explain this clearly.'}"

PAST TOPICS (already covered): ${pastContext || 'None - this is the first lesson'}
FUTURE TOPICS (coming next): ${futureContext || 'End of curriculum'}

CRITICAL WRITING RULES:
1. Explain the connection between distinct layers when relevant.
2. Start with a paradox or a bold statement. Never say "Welcome".
3. Do not use Mermaid diagrams.
4. Use realistic, detailed examples.
5. Write a comprehensive, deep-dive lesson.
6. Structure:
   - The Concept
   - The Architecture
   - The Implementation
   - The Trap
7. ${continuityRule}

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
