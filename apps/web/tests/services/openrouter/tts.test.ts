import assert from 'node:assert/strict';
import { test } from 'vitest';
import { normalizeVoiceProfileId } from '../../../services/audio/voiceProfile.ts';

test('normalizeVoiceProfileId keeps only voices supported by the active TTS model', () => {
  assert.equal(normalizeVoiceProfileId('Ara'), 'Ara');
  assert.equal(normalizeVoiceProfileId('Eve'), 'Eve');
  assert.equal(normalizeVoiceProfileId('coral'), 'Ara');
  assert.equal(normalizeVoiceProfileId('casual_male'), 'Ara');
  assert.equal(normalizeVoiceProfileId(undefined), 'Ara');
});
