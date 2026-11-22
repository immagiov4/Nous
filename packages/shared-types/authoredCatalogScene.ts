import {
  COMPACT_SCENE_LABEL_LIMIT,
  findLessonSceneProblems,
  LESSON_SCENE_LIMITS,
  type LessonScene,
  LessonSceneSchema,
} from './lessonSceneRegistry';

/** Build a catalog scene from the lesson text without a provider call. */
export function authoredCatalogScene(
  input: { sectionTitle: string; sectionDescription: string },
  phrases: readonly string[]
): LessonScene {
  const { minItems, items } = LESSON_SCENE_LIMITS;
  const excerpts = phrases.length === 1 ? splitCatalogText(phrases[0]) : phrases;
  const labels = excerpts.map(catalogExcerpt).filter(Boolean).slice(0, items);
  if (labels.length < minItems) {
    const context = splitCatalogText(`${input.sectionTitle} ${input.sectionDescription}`);
    labels.push(...context.map(catalogExcerpt).filter(Boolean));
  }
  // A passage made entirely of oversize tokens may have no displayable authored words.
  const genericLabels = ['Passaggio della lezione', 'Contenuto della narrazione'];
  labels.push(...genericLabels.slice(0, Math.max(0, minItems - labels.length)));
  const scene = LessonSceneSchema.parse({
    type: 'concepts',
    title: catalogExcerpt(input.sectionTitle),
    quote: '',
    body: '',
    note: '',
    items: labels.map(label => ({
      label,
      detail: '',
      icon: '',
    })),
    groups: [],
  });
  const problems = findLessonSceneProblems(scene);
  if (problems.length) throw new Error(`Invalid authored concepts scene: ${problems.join(' ')}`);
  return scene;
}

function splitCatalogText(text: string): string[] {
  const words = text.trim().split(/\s+/u);
  const middle = Math.floor(words.length / 2);
  return [words.slice(0, middle).join(' '), words.slice(middle).join(' ')];
}

function catalogExcerpt(text: string): string {
  const limit = COMPACT_SCENE_LABEL_LIMIT;
  const trimmed = text.trim();
  if (trimmed.length <= limit) return /[\p{L}\p{N}]/u.test(trimmed) ? trimmed : '';
  const prefix = trimmed.slice(0, limit - 1);
  const complete = /\s/u.test(trimmed[limit - 1]) ? prefix : prefix.replace(/\S+$/u, '');
  const words = complete.trimEnd();
  return /[\p{L}\p{N}]/u.test(words) ? `${words}…` : '';
}
