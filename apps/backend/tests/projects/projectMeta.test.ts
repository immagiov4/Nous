import { expect, test } from 'vitest';

import { normalizeProjectSnapshot } from '../../src/projects/projectMeta.js';

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
