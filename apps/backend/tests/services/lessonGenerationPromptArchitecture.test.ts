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
  sourceContext:
    'Un evento descrive la sorgente fisica; il mapping assegna un significato di gioco.',
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
    expect(writer).toContain(reference);
    expect(writer).toContain('CONTRATTO DI SCRITTURA');
    expect(writer).toContain('PAUSE ATTIVE:');
  });

  test('does not copy the full writer contract into verification', () => {
    const verification = buildLessonVerificationPrompt(input, plainDraft);

    expect(verification).toContain('CHECKLIST OBBLIGATORIA');
    expect(verification).toContain('core.progression');
    expect(verification).toContain('VINCOLI DI FOCUS SEMPRE OBBLIGATORI');
    expect(verification).toContain('Non anticipare in dettaglio argomenti');
    expect(verification).toContain('Non simulare esempi visivi con ASCII art');
    expect(verification).not.toContain('CONTRATTO DI SCRITTURA');
    expect(verification).not.toContain('exerciseType deve appartenere a questo catalogo');
  });

  test('enables structural checks only from features present in the draft', () => {
    const plainVerification = buildLessonVerificationPrompt(input, plainDraft);

    expect(plainVerification).not.toContain('Ogni imageRef usa un assetId disponibile');
    expect(plainVerification).not.toContain('Ogni piano visuale ha esattamente');
    expect(plainVerification).not.toContain('Ogni clip YouTube usa un sourceIndex valido');
    expect(plainVerification).not.toContain('Correggi delimitatori o graffe KaTeX');
    expect(plainVerification).not.toContain('Codice, pseudocodice, comandi e output');

    const candidateOnlyInput: typeof input = {
      ...input,
      imageCandidates: [
        {
          id: 'candidate-1',
          sourceOrder: 0,
          visibleLabel: 'Schema disponibile',
        },
      ],
    };
    expect(buildLessonVerificationPrompt(candidateOnlyInput, plainDraft)).not.toContain(
      'Ogni imageRef usa un assetId disponibile'
    );

    const codePackOnlyInput: typeof input = { ...input, instructionPacks: ['code'] };
    expect(buildLessonVerificationPrompt(codePackOnlyInput, plainDraft)).not.toContain(
      'Codice, pseudocodice, comandi e output'
    );

    const currencyDraft: LessonContentDraft = {
      ...plainDraft,
      contentBlocks: [
        { markdown: 'Il prezzo del servizio e $12 al mese.', type: 'markdown' },
      ],
    };
    expect(buildLessonVerificationPrompt(input, currencyDraft)).not.toContain(
      'Correggi delimitatori o graffe KaTeX'
    );

    const imageDraft: LessonContentDraft = {
      ...plainDraft,
      imageRefs: [
        {
          alt: 'Schema del mapping',
          anchorHeading: 'Dall evento all azione',
          assetId: 'asset-1',
          caption: 'Dal segnale fisico all azione logica.',
        },
      ],
    };
    expect(buildLessonVerificationPrompt(input, imageDraft)).toContain(
      'Ogni imageRef usa un assetId disponibile'
    );

    const visualDraft: LessonContentDraft = {
      ...plainDraft,
      contentBlocks: [...plainDraft.contentBlocks, { slotId: 'visual-1', type: 'generated-visual' }],
      generatedVisuals: [
        {
          altText: 'Flusso dal dispositivo all azione',
          anchorHeading: 'Dall evento all azione',
          complexity: 'simple',
          concept: 'Mapping degli input',
          coverage: 'all_elements',
          coverageRationale: 'Mostra l intero flusso.',
          factualRequirements: ['Il dispositivo produce un evento', 'Il mapping assegna un azione'],
          interactionLevel: 'none',
          pedagogicalGoal: 'Rendere visibile la separazione tra evento e azione.',
          reason: 'La relazione e strutturale.',
          requiresDepiction: false,
          slotId: 'visual-1',
          title: 'Dal dispositivo all azione',
          visualDirection: 'Due box collegati da una freccia.',
          visualType: 'flowchart_svg',
        },
      ],
    };
    expect(buildLessonVerificationPrompt(input, visualDraft)).toContain(
      'Ogni piano visuale ha esattamente'
    );

    const youtubeDraft: LessonContentDraft = {
      ...plainDraft,
      contentBlocks: [
        ...plainDraft.contentBlocks,
        {
          clips: [{ endSeconds: 12, sourceIndex: 0, startSeconds: 4, title: 'Cambio di stato' }],
          type: 'youtube-clips',
        },
      ],
    };
    expect(buildLessonVerificationPrompt(input, youtubeDraft)).toContain(
      'Ogni clip YouTube usa un sourceIndex valido'
    );

    const mathDraft: LessonContentDraft = {
      ...plainDraft,
      contentBlocks: [
        { markdown: 'La relazione si esprime come $x + 1 = 2$.', type: 'markdown' },
      ],
    };
    expect(buildLessonVerificationPrompt(input, mathDraft)).toContain(
      'Correggi delimitatori o graffe KaTeX'
    );

    const codeDraft: LessonContentDraft = {
      ...plainDraft,
      contentBlocks: [
        {
          markdown: 'Esempio:\n```ts\nconst action = map(event);\n```',
          type: 'markdown',
        },
      ],
    };
    expect(buildLessonVerificationPrompt(input, codeDraft)).toContain(
      'Codice, pseudocodice, comandi e output'
    );

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
    expect(buildLessonVerificationPrompt(input, quizDraft)).toContain(
      'non deve poter essere risolta copiando'
    );
  });
});
