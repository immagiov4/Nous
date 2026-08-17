import { describe, expect, test } from 'vitest';

import {
  buildLessonGenerationPrompt,
  buildLessonGenerationReferenceContext,
} from '../../src/services/lessonGenerationPrompt.js';
import type {
  LessonContentDraft,
  LessonGenerationInput,
} from '../../src/services/lessonGenerationTypes.js';
import { buildLessonVerificationPrompt } from '../../src/services/lessonGenerationVerification.js';

const input: Omit<LessonGenerationInput, 'config' | 'signal'> = {
  description: 'Capire come gli eventi diventano azioni di gioco.',
  generationNotes: 'Preferisci esempi concreti e un ritmo medio.',
  imageCandidates: [],
  instructionPacks: [],
  language: 'Italiano',
  pedagogicalContext: 'Studente con conoscenze di programmazione di base.',
  previousLessonTitles: ['Input fisico e semantica'],
  refreshResearch: false,
  researchContext: '',
  sectionTitle: 'Dall evento all azione',
  sourceContext: 'Un evento descrive la sorgente fisica; il mapping assegna un significato di gioco.',
  sources: [],
};

const plainDraft: LessonContentDraft = {
  contentBlocks: [
    {
      markdown: '# Dall evento all azione\n\nUn evento fisico viene interpretato dal mapping.',
      type: 'markdown',
    },
  ],
  generatedVisuals: [],
  imageRefs: [],
};

describe('lesson prompt architecture', () => {
  test('keeps reference context separate from writer instructions', () => {
    const reference = buildLessonGenerationReferenceContext(input);
    const writer = buildLessonGenerationPrompt(input);

    expect(reference).toContain('MATERIALE SORGENTE PRIMARIO');
    expect(reference).toContain('Preferisci esempi concreti');
    expect(reference).not.toContain('CONTRATTO DI SCRITTURA');
    expect(reference).not.toContain('PAUSE ATTIVE:');
    expect(writer).toContain('CONTRATTO DI SCRITTURA');
    expect(writer).toContain('PAUSE ATTIVE:');
  });

  test('does not copy the full writer contract into verification', () => {
    const verification = buildLessonVerificationPrompt(input, plainDraft);

    expect(verification).toContain('CHECKLIST OBBLIGATORIA');
    expect(verification).toContain('core.progression');
    expect(verification).not.toContain('CONTRATTO DI SCRITTURA');
    expect(verification).not.toContain('exerciseType deve appartenere a questo catalogo');
  });

  test('adds expensive structural checks only when the draft uses those features', () => {
    const verification = buildLessonVerificationPrompt(input, plainDraft);

    expect(verification).not.toContain('Ogni imageRef usa un assetId disponibile');
    expect(verification).not.toContain('Ogni piano visuale ha esattamente');
    expect(verification).not.toContain('Ogni clip YouTube usa un sourceIndex valido');
    expect(verification).not.toContain('Correggi delimitatori o graffe KaTeX');
    expect(verification).not.toContain('Codice, pseudocodice, comandi e output');

    const quizDraft: LessonContentDraft = {
      ...plainDraft,
      contentBlocks: [
        ...plainDraft.contentBlocks,
        {
          quiz: {
            correctIndex: 0,
            exerciseType: 'application-card',
            options: ['A', 'B', 'C', 'D'],
            question: 'Quale mapping useresti in un caso nuovo?',
          },
          type: 'inline-quiz',
        },
      ],
    };
    const quizVerification = buildLessonVerificationPrompt(input, quizDraft);

    expect(quizVerification).toContain('non deve poter essere risolta copiando');
  });
});
