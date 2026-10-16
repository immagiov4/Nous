import { expect, test } from 'vitest';

import { buildProjectMeta, normalizeProjectSnapshot } from '../../src/projects/projectMeta.js';

test('backend import normalization removes the duplicated legacy YouTube transcript fields', () => {
  const snapshot = normalizeProjectSnapshot(
    {
      id: 'legacy-video-project',
      researchDossiersBySectionId: {
        lesson: {
          sectionId: 'lesson',
          sources: [
            {
              title: 'Video legacy',
              youtubeTranscript: {
                ranges: [
                  { endSeconds: 3, startSeconds: 1 },
                  { endSeconds: 5, startSeconds: 2 },
                ],
                text: '[00:01-00:03] Primo cue\n[00:02-00:05] Cue sovrapposto',
              },
            },
          ],
        },
      },
    },
    true
  );

  expect(snapshot.researchDossiersBySectionId?.lesson).toMatchObject({
    sources: [
      {
        youtubeTranscript: {
          segments: [
            { endSeconds: 3, startSeconds: 1, text: 'Primo cue' },
            { endSeconds: 5, startSeconds: 2, text: 'Cue sovrapposto' },
          ],
        },
      },
    ],
  });
});

test.each([
  [1, '1 lezione'],
  [2, '2 lezioni'],
] as const)('keeps the server cover label grammatical for %i lessons', (count, expected) => {
  const snapshot = normalizeProjectSnapshot({
    id: 'counted-course',
    learningPlan: {
      title: 'Course',
      summary: '',
      modules: [
        {
          id: 'module',
          title: 'Module',
          children: Array.from({ length: count }, (_, index) => ({
            id: `lesson-${index}`,
            kind: 'lesson',
            title: `Lesson ${index}`,
            content: '',
            isCompleted: false,
          })),
        },
      ],
    },
  });
  expect(buildProjectMeta(snapshot).coverLabel).toBe(expected);
});
