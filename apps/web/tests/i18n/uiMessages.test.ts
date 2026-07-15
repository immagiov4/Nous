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

  test('localizes the reader text-selection hint in English and Italian', () => {
    const message =
      'Seleziona un passaggio e fai click destro per chiedere spiegazioni, aggiungere una nota o creare una lezione di approfondimento.';

    expect(translateUiMessage(message, undefined, 'en')).toBe(
      'Select a passage and right-click to ask for an explanation, add a note, or create a follow-up lesson.'
    );
    expect(translateUiMessage(message, undefined, 'it')).toBe(message);
  });

  test('localizes the new-home course prompt templates', () => {
    const buildReviewPrompt = (locale: 'en' | 'it') =>
      `${translateUiMessage('Aiutami a ripassare il corso', undefined, locale)} ${translateUiMessage('nome del corso', undefined, locale)}${translateUiMessage(
        ', prestando particolare attenzione a ciò che ho annotato e sottolineato, ai diagrammi e agli artefatti generati.',
        undefined,
        locale
      )}`;
    const buildFlashcardPrompt = (locale: 'en' | 'it') =>
      `${translateUiMessage(
        'Crea delle flashcard di ripasso come artefatto HTML per il corso',
        undefined,
        locale
      )} ${translateUiMessage('nome del corso', undefined, locale)}${translateUiMessage(
        ', prestando particolare attenzione a ciò che ho annotato e sottolineato.',
        undefined,
        locale
      )}`;

    expect(buildReviewPrompt('en')).toBe(
      'Help me review the course: course name, paying particular attention to what I annotated and highlighted, as well as the diagrams and generated artifacts.'
    );
    expect(buildReviewPrompt('it')).toBe(
      'Aiutami a ripassare il corso nome del corso, prestando particolare attenzione a ciò che ho annotato e sottolineato, ai diagrammi e agli artefatti generati.'
    );
    expect(buildFlashcardPrompt('en')).toBe(
      'Create review flashcards as an HTML artifact for the course: course name, paying particular attention to what I annotated and highlighted.'
    );
    expect(translateUiMessage('Voglio che tu crei un corso su', undefined, 'en')).toBe(
      'I want you to create a course about'
    );
  });

  test('keeps the document language aligned with the detected UI locale', () => {
    expect(initializeDocumentLanguage(['en-GB'])).toBe('en');
    expect(document.documentElement.lang).toBe('en');

    expect(initializeDocumentLanguage(['it-CH'])).toBe('it');
    expect(document.documentElement.lang).toBe('it');
  });
});
