import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeVoiceProfileId } from '../voiceProfile.ts';

test('normalizeVoiceProfileId aligns legacy voice labels to the backend-supported profile id', () => {
  assert.equal(normalizeVoiceProfileId('mario'), 'mario');
  assert.equal(normalizeVoiceProfileId('Marco'), 'mario');
  assert.equal(normalizeVoiceProfileId('Giulia'), 'mario');
  assert.equal(normalizeVoiceProfileId(undefined), 'mario');
});
