// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';

import {
  getAppLocale,
  initializeDocumentLanguage,
  resolveAppLocale,
  translateUiMessage,
} from '../../i18n/uiMessages.ts';

describe('automatic UI localization', () => {
  test('uses the first supported browser language and normalizes regional tags', () => {
    expect(resolveAppLocale(['fr-FR', 'it-IT', 'en-US'])).toBe('it');
    expect(resolveAppLocale(['en-GB', 'it-IT'])).toBe('en');
  });

  test('falls back to English for unsupported or missing browser languages', () => {
    expect(resolveAppLocale(['fr-FR', 'de-DE'])).toBe('en');
    expect(resolveAppLocale([])).toBe('en');
  });

  test('uses navigator.language when the language list is unavailable', () => {
    Object.defineProperties(window.navigator, {
      language: { configurable: true, value: 'it-IT' },
      languages: { configurable: true, value: undefined },
    });

    expect(getAppLocale()).toBe('it');
  });

  test('translates known UI messages and interpolates variables', () => {
    expect(translateUiMessage('Caricamento...', undefined, 'en')).toBe('Loading...');
    expect(
      translateUiMessage(
        'Eliminare "{projectTitle}" dalla libreria server?',
        { projectTitle: 'Reti' },
        'en'
      )
    ).toBe('Delete "Reti" from the server library?');
    expect(
      translateUiMessage(
        'Eliminare "{projectTitle}" dalla libreria server?',
        { projectTitle: 'Reti' },
        'it'
      )
    ).toBe('Eliminare "Reti" dalla libreria server?');
  });

  test('keeps the document language aligned with the detected UI locale', () => {
    expect(initializeDocumentLanguage(['en-GB'])).toBe('en');
    expect(document.documentElement.lang).toBe('en');

    expect(initializeDocumentLanguage(['it-CH'])).toBe('it');
    expect(document.documentElement.lang).toBe('it');
  });
});
