import assert from 'node:assert/strict';
import { test } from 'vitest';
import { normalizeVoiceProfileId } from '../../../services/audio/voiceProfile.ts';

test('normalizeVoiceProfileId keeps only voices supported by the active TTS model', () => {
  assert.equal(normalizeVoiceProfileId('Zephyr'), 'Zephyr');
  assert.equal(normalizeVoiceProfileId('Kore'), 'Kore');
  assert.equal(normalizeVoiceProfileId('Ara'), 'Zephyr');
  assert.equal(normalizeVoiceProfileId('coral'), 'Zephyr');
  assert.equal(normalizeVoiceProfileId(undefined), 'Zephyr');
});
