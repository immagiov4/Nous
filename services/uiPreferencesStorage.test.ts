import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseUiPreferences,
  readUiPreferences,
  writeUiPreferences,
  UI_PREFERENCES_KEY,
} from './uiPreferencesStorage.ts';

test('parseUiPreferences normalizes supported fields and ignores the rest', () => {
  const preferences = parseUiPreferences(
    JSON.stringify({
      isDarkMode: true,
      teleprompterSpeed: 88,
      preferredVoice: 'unknown',
      playbackRate: 1.25,
      preferredLessonModel: ' openai/gpt-5.4-mini ',
      preferredAssessmentModel: ' mistralai/mistral-small-2603 ',
      preferredContextModel: ' openai/gpt-5.4-nano ',
      ignored: 'value',
    })
  );

  assert.deepEqual(preferences, {
    isDarkMode: true,
    teleprompterSpeed: 88,
    preferredVoice: 'mario',
    playbackRate: 1.25,
    preferredLessonModel: 'openai/gpt-5.4-mini',
    preferredAssessmentModel: 'mistralai/mistral-small-2603',
    preferredContextModel: 'openai/gpt-5.4-nano',
  });
});

test('parseUiPreferences returns null for invalid payloads', () => {
  assert.equal(parseUiPreferences('{not-json'), null);
  assert.equal(parseUiPreferences(JSON.stringify({})), null);
});

test('readUiPreferences and writeUiPreferences use the shared storage key', () => {
  const storedValues = new Map<string, string>();
  const storage = {
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storedValues.set(key, value);
    },
  };

  writeUiPreferences(storage, {
    isDarkMode: false,
    teleprompterSpeed: 72,
    preferredVoice: 'mario',
    playbackRate: 1,
    preferredLessonModel: 'openai/gpt-5.4-mini',
    preferredAssessmentModel: 'mistralai/mistral-small-2603',
    preferredContextModel: 'openai/gpt-5.4-nano',
  });

  assert.equal(storedValues.has(UI_PREFERENCES_KEY), true);
  assert.deepEqual(readUiPreferences(storage), {
    isDarkMode: false,
    teleprompterSpeed: 72,
    preferredVoice: 'mario',
    playbackRate: 1,
    preferredLessonModel: 'openai/gpt-5.4-mini',
    preferredAssessmentModel: 'mistralai/mistral-small-2603',
    preferredContextModel: 'openai/gpt-5.4-nano',
  });
});
