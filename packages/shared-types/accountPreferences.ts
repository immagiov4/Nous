import * as z from 'zod';

export const LEGACY_ACCOUNT_INTERFACE_LOCALE = 'it';

export const AccountPreferencesSchema = z
  .object({
    interfaceLocale: z.enum(['it', 'en']).nullable(),
    contentLanguage: z.string().trim().min(1).nullable(),
    teachingPreferences: z.string().trim(),
  })
  .strict();

export type AccountPreferences = z.infer<typeof AccountPreferencesSchema>;

export const EMPTY_ACCOUNT_PREFERENCES: AccountPreferences = {
  interfaceLocale: null,
  contentLanguage: null,
  teachingPreferences: '',
};

export const CoursePreferenceDefaultsSchema = z.object({
  language: z.string().min(1),
  teachingPreferences: z.string(),
});

export type CoursePreferenceDefaults = z.infer<typeof CoursePreferenceDefaultsSchema>;

export const resolveAiLanguage = (
  preferences: AccountPreferences,
  interfaceLocale: 'en' | 'it'
): string =>
  preferences.contentLanguage ??
  ((preferences.interfaceLocale ?? interfaceLocale) === 'it' ? 'Italiano' : 'English');

export const resolveCoursePreferenceDefaults = (
  preferences: AccountPreferences,
  interfaceLocale: 'en' | 'it'
): CoursePreferenceDefaults => ({
  language: resolveAiLanguage(preferences, interfaceLocale),
  teachingPreferences: preferences.teachingPreferences,
});
