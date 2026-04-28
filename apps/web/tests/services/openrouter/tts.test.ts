import assert from 'node:assert/strict';
import { test } from 'vitest';
import { normalizeVoiceProfileId } from '../../../services/audio/voiceProfile.ts';

test('normalizeVoiceProfileId keeps only OpenAI TTS voices supported by the reader', () => {
  assert.equal(normalizeVoiceProfileId('coral'), 'coral');
  assert.equal(normalizeVoiceProfileId('marin'), 'marin');
  assert.equal(normalizeVoiceProfileId('mario'), 'coral');
  assert.equal(normalizeVoiceProfileId('casual_male'), 'coral');
  assert.equal(normalizeVoiceProfileId(undefined), 'coral');
});
