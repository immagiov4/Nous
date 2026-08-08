import assert from 'node:assert/strict';
import { formatYouTubeTranscript, parseYouTubeTranscript } from '@shared/youtubeTranscript';
import { test } from 'vitest';

test('keeps typed transcript segments as the single canonical representation', () => {
  const transcript = parseYouTubeTranscript({
    segments: [
      { endSeconds: 3, startSeconds: 1, text: 'Primo cue' },
      { endSeconds: 5, startSeconds: 2, text: 'Cue sovrapposto' },
    ],
  });

  assert.deepEqual(transcript, {
    segments: [
      { endSeconds: 3, startSeconds: 1, text: 'Primo cue' },
      { endSeconds: 5, startSeconds: 2, text: 'Cue sovrapposto' },
    ],
  });
  assert.equal(Object.hasOwn(transcript ?? {}, 'text'), false);
  assert.equal(Object.hasOwn(transcript ?? {}, 'ranges'), false);
  assert.equal(
    formatYouTubeTranscript(transcript?.segments ?? []),
    '[00:01-00:03] Primo cue\n[00:02-00:05] Cue sovrapposto'
  );
});

test('normalizes the parallel text and ranges from legacy archives at the input boundary', () => {
  const transcript = parseYouTubeTranscript({
    ranges: [
      { endSeconds: 3, startSeconds: 1 },
      { endSeconds: 5, startSeconds: 2 },
    ],
    text: '[00:01-00:03] Primo cue\n[00:02-00:05] Cue sovrapposto',
  });

  assert.deepEqual(transcript, {
    segments: [
      { endSeconds: 3, startSeconds: 1, text: 'Primo cue' },
      { endSeconds: 5, startSeconds: 2, text: 'Cue sovrapposto' },
    ],
  });
});

test('keeps every legacy interval when old text and range counts do not match', () => {
  const transcript = parseYouTubeTranscript({
    ranges: [
      { endSeconds: 3, startSeconds: 1 },
      { endSeconds: 5, startSeconds: 2 },
    ],
    text: '[00:01-00:03] Unico testo disponibile',
  });

  assert.deepEqual(transcript, {
    segments: [
      { endSeconds: 3, startSeconds: 1, text: 'Unico testo disponibile' },
      { endSeconds: 5, startSeconds: 2, text: '' },
    ],
  });
});

test('rejects incomplete transcript segments instead of persisting invalid clip bounds', () => {
  assert.equal(
    parseYouTubeTranscript({
      segments: [{ endSeconds: 1, startSeconds: 2, text: 'Intervallo impossibile' }],
    }),
    null
  );
});
