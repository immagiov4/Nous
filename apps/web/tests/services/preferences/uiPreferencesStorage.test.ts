import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  parseUiPreferences,
  readUiPreferences,
  UI_PREFERENCES_KEY,
  writeUiPreferences,
} from '../../../services/preferences/uiPreferencesStorage.ts';

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
      preferredTtsModel: ' openai/gpt-4o-mini-tts-2025-12-15 ',
      preferredTtsVoice: ' cloned-voice-id ',
      settingsPanelExpandedSections: ['course-notes', 'unknown'],
      ignored: 'value',
    })
  );

  assert.deepEqual(preferences, {
    isDarkMode: true,
    preferredVoice: 'Ara',
    playbackRate: 1.25,
    preferredTtsVoice: 'Ara',
    settingsPanelExpandedSections: ['course-notes'],
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
    preferredVoice: 'mario',
    playbackRate: 1,
    preferredTtsVoice: 'Ara',
    settingsPanelExpandedSections: ['course-notes'],
    lastAudioTab: 'voce',
  });

  assert.equal(storedValues.has(UI_PREFERENCES_KEY), true);
  assert.deepEqual(readUiPreferences(storage), {
    isDarkMode: false,
    lastAudioTab: 'voce',
    preferredVoice: 'Ara',
    playbackRate: 1,
    preferredTtsVoice: 'Ara',
    settingsPanelExpandedSections: ['course-notes'],
  });
});

test('readUiPreferences accepts the legacy Lumina storage key', () => {
  const storedValues = new Map<string, string>([
    [
      'lumina-ui-preferences',
      JSON.stringify({
        isDarkMode: true,
        preferredVoice: 'mario',
        playbackRate: 1.15,
      }),
    ],
  ]);
  const storage = {
    getItem: (key: string) => storedValues.get(key) ?? null,
  };

  assert.deepEqual(readUiPreferences(storage), {
    isDarkMode: true,
    preferredVoice: 'Ara',
    playbackRate: 1.15,
    preferredTtsVoice: 'Ara',
  });
});
