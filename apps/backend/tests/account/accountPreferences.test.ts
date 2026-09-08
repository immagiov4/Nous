import {
  AccountPreferencesSchema,
  EMPTY_ACCOUNT_PREFERENCES,
  resolveAiLanguage,
  resolveCoursePreferenceDefaults,
} from '@shared/accountPreferences.js';
import { describe, expect, test } from 'vitest';

describe('account preference defaults', () => {
  test.each([
    ['contentLanguage', 100],
    ['teachingPreferences', 4_000],
  ] as const)('bounds %s after trimming without truncating', (field, limit) => {
    const text = 'é'.repeat(limit);
    expect(
      AccountPreferencesSchema.parse({ ...EMPTY_ACCOUNT_PREFERENCES, [field]: ` ${text}\n` })[field]
    ).toBe(text);
    expect(
      AccountPreferencesSchema.safeParse({ ...EMPTY_ACCOUNT_PREFERENCES, [field]: `${text}x` })
        .success
    ).toBe(false);
  });

  test('counts UTF-16 code units consistently for supplementary Unicode characters', () => {
    const text = '🧠'.repeat(50);
    expect(
      AccountPreferencesSchema.parse({ ...EMPTY_ACCOUNT_PREFERENCES, contentLanguage: text })
        .contentLanguage
    ).toBe(text);
    expect(
      AccountPreferencesSchema.safeParse({
        ...EMPTY_ACCOUNT_PREFERENCES,
        contentLanguage: `${text}a`,
      }).success
    ).toBe(false);
  });

  test('follows the interface unless an independent AI language was saved', () => {
    expect(resolveAiLanguage(EMPTY_ACCOUNT_PREFERENCES, 'it')).toBe('Italiano');
    expect(resolveAiLanguage(EMPTY_ACCOUNT_PREFERENCES, 'en')).toBe('English');
    expect(resolveAiLanguage({ ...EMPTY_ACCOUNT_PREFERENCES, interfaceLocale: 'en' }, 'it')).toBe(
      'English'
    );
    expect(
      resolveAiLanguage(
        { ...EMPTY_ACCOUNT_PREFERENCES, interfaceLocale: 'en', contentLanguage: '日本語' },
        'it'
      )
    ).toBe('日本語');
  });

  test('creates independent new-course defaults preserving free-form teaching instructions', () => {
    const preferences = {
      ...EMPTY_ACCOUNT_PREFERENCES,
      teachingPreferences: 'One idea at a time. No timed tasks.',
    };
    const course = resolveCoursePreferenceDefaults(preferences, 'en');
    expect(course).toEqual({
      language: 'English',
      teachingPreferences: preferences.teachingPreferences,
    });
    course.language = 'Italiano';
    course.teachingPreferences = '';
    expect(preferences).toEqual({
      ...EMPTY_ACCOUNT_PREFERENCES,
      teachingPreferences: 'One idea at a time. No timed tasks.',
    });
  });

  test('accepts cleared preferences and rejects unrecognized fields or interface locales', () => {
    expect(AccountPreferencesSchema.parse(EMPTY_ACCOUNT_PREFERENCES)).toEqual(
      EMPTY_ACCOUNT_PREFERENCES
    );
    expect(
      AccountPreferencesSchema.safeParse({ ...EMPTY_ACCOUNT_PREFERENCES, interfaceLocale: 'fr' })
        .success
    ).toBe(false);
    expect(
      AccountPreferencesSchema.safeParse({ ...EMPTY_ACCOUNT_PREFERENCES, userId: 'someone-else' })
        .success
    ).toBe(false);
  });
});
