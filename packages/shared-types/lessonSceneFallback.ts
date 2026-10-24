import { LESSON_SCENE_LIMITS, type LessonScene } from './lessonScene';

/** A literal passage excerpt for unavailable or previously unsaved visuals. */
export const createPassageFallbackScene = (speech: string, heading = ''): LessonScene => {
  const source = speech.trim();
  if (!source) throw new Error('A passage visual requires non-empty speech.');
  const sentence = new Intl.Segmenter(undefined, { granularity: 'sentence' })
    .segment(source)
    [Symbol.iterator]()
    .next()
    .value?.segment.trim();
  return {
    type: 'quote',
    title: heading.trim().slice(0, LESSON_SCENE_LIMITS.text),
    body: '',
    note: '',
    items: [],
    groups: [],
    quote: (sentence ?? source).slice(0, LESSON_SCENE_LIMITS.text),
  };
};
