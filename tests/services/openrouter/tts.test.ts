import assert from 'node:assert/strict';
import { test } from 'vitest';
import { normalizeVoiceProfileId } from '../../../services/audio/voiceProfile.ts';

test('normalizeVoiceProfileId aligns legacy voice labels to the backend-supported profile id', () => {
  assert.equal(normalizeVoiceProfileId('mario'), 'mario');
  assert.equal(normalizeVoiceProfileId('Marco'), 'mario');
  assert.equal(normalizeVoiceProfileId('Giulia'), 'mario');
  assert.equal(normalizeVoiceProfileId(undefined), 'mario');
});
