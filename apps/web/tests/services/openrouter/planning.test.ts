import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  injectImagePlaceholders,
  insertGeneratedVisualExamplePlaceholder,
} from '../../../services/openrouter/lessonImages.ts';
import {
  buildAdaptivePlanGuidance,
  buildLessonVerificationPrompt,
  buildPdfChunkUsageDebugPayload,
  collapseRedundantParagraphs,
  dedupeLearningPlanSections,
  estimateRelevantPdfImagePages,
  estimateTargetQuizCount,
  LESSON_RESPONSE_SCHEMA,
  LESSON_SCOPE_RULES,
  PLAN_PROPEDEUTIC_ORDER_RULES,
  resolvePlanningSourceProfileFromSeed,
} from '../../../services/openrouter/planning.ts';
import type { PdfTextIndex } from '../../../types.ts';

test('resolvePlanningSourceProfileFromSeed keeps short PDFs compact and allows a single lesson', () => {
  const profile = resolvePlanningSourceProfileFromSeed({
    kind: 'pdf',
    pageCount: 5,
  });

  assert.equal(profile.sizeTier, 'tiny');
  assert.equal(profile.allowSingleLesson, true);
  assert.equal(profile.summaryLessonOptional, true);
  assert.deepEqual(profile.moduleCount, { min: 1, max: 2 });
  assert.deepEqual(profile.lessonCount, { min: 1, max: 3 });
});

test('buildAdaptivePlanGuidance tells the planner to merge overlaps on compact sources', () => {
  const guidance = buildAdaptivePlanGuidance(
    resolvePlanningSourceProfileFromSeed({
      kind: 'pdf',
      pageCount: 8,
    })
  );

  assert.match(guidance, /anche una sola lezione/i);
  assert.match(guidance, /sintesi finale e opzionale/i);
  assert.match(guidance, /fondile invece di tenerle separate/i);
});

test('buildAdaptivePlanGuidance asks large PDFs to cover most substantive pages with soft page spans', () => {
  const guidance = buildAdaptivePlanGuidance(
    resolvePlanningSourceProfileFromSeed({
      kind: 'pdf',
      pageCount: 240,
    })
  );

  assert.match(guidance, /copra quasi tutto il contenuto sostanziale del libro/i);
  assert.match(guidance, /buchi di copertura/i);
  assert.match(guidance, /10-30 pagine sostantive/i);
});

test('dedupeLearningPlanSections merges overlapping adjacent lessons for compact sources', () => {
  const deduped = dedupeLearningPlanSections(
    [
      {
        id: 'section-1',
        moduleTitle: 'Fondamenti quantistici',
        title: 'Effetto fotoelettrico',
        description:
          'Spiega il fenomeno fotoelettrico, la soglia di frequenza e il legame tra energia del fotone ed emissione elettronica.',
        type: 'core',
        isCompleted: false,
      },
      {
        id: 'section-2',
        moduleTitle: 'Fondamenti quantistici',
        title: 'Fenomeno fotoelettrico',
        description:
          'Descrive lo stesso meccanismo di emissione elettronica, la soglia di frequenza e la relazione tra energia del fotone e elettroni emessi.',
        type: 'core',
        isCompleted: false,
      },
      {
        id: 'section-3',
        moduleTitle: 'Fondamenti quantistici',
        title: 'Interpretazione di Einstein',
        description:
          'Collega il fenomeno all ipotesi dei quanti di luce e mostra perche il modello ondulatorio classico non basta.',
        type: 'core',
        isCompleted: false,
      },
    ],
    { sizeTier: 'small' }
  );

  assert.equal(deduped.length, 2);
  assert.match(deduped[0]?.title || '', /fotoelettric/i);
  assert.equal(deduped[1]?.title, 'Interpretazione di Einstein');
});

test('dedupeLearningPlanSections stays conservative on larger sources', () => {
  const deduped = dedupeLearningPlanSections(
    [
      {
        id: 'section-1',
        moduleTitle: 'Fondamenti quantistici',
        title: 'Effetto fotoelettrico',
        description:
          'Spiega il fenomeno fotoelettrico, la soglia di frequenza e il legame tra energia del fotone ed emissione elettronica.',
        type: 'core',
        isCompleted: false,
      },
      {
        id: 'section-2',
        moduleTitle: 'Fondamenti quantistici',
        title: 'Fenomeno fotoelettrico',
        description:
          'Descrive lo stesso meccanismo di emissione elettronica, la soglia di frequenza e la relazione tra energia del fotone e elettroni emessi.',
        type: 'core',
        isCompleted: false,
      },
    ],
    { sizeTier: 'large' }
  );

  assert.equal(deduped.length, 2);
});

test('LESSON_RESPONSE_SCHEMA marks all image placement keys as required for strict json schema', () => {
  const imagePlacementSchema = (
    (LESSON_RESPONSE_SCHEMA.schema as { properties: Record<string, unknown> }).properties
      .imagePlacements as {
      items: {
        properties: Record<string, unknown>;
        required: string[];
      };
    }
  ).items;

  assert.deepEqual(imagePlacementSchema.required, ['assetId', 'alt', 'caption', 'anchorHeading']);
  assert.deepEqual(imagePlacementSchema.properties.caption, {
    type: ['string', 'null'],
  });
  assert.deepEqual(imagePlacementSchema.properties.anchorHeading, {
    type: ['string', 'null'],
  });
});

// These tests guard against accidental prompt modification. They are intentionally static.
describe('prompt invariants — intentional guardrails, not behavior tests', () => {
  test('LESSON_SCOPE_RULES prevent future-lesson spoilers and filler deep dives', () => {
    assert.ok(
      LESSON_SCOPE_RULES.some(rule =>
        rule.includes(
          'Non anticipare in dettaglio argomenti che verranno trattati in lezioni future'
        )
      )
    );
    assert.ok(
      LESSON_SCOPE_RULES.some(rule =>
        rule.includes('Non inserire sezioni di "analisi approfondita"')
      )
    );
    assert.ok(
      LESSON_SCOPE_RULES.some(rule =>
        rule.includes('Se la lezione ha gia esaurito il suo focus, chiudi con naturalezza')
      )
    );
  });

  test('PLAN_PROPEDEUTIC_ORDER_RULES enforce prerequisite ordering for modules and lessons', () => {
    assert.ok(
      PLAN_PROPEDEUTIC_ORDER_RULES.some(
        rule => rule.includes('moduli/capitoli') && rule.includes('lezioni interne')
      )
    );
    assert.ok(
      PLAN_PROPEDEUTIC_ORDER_RULES.some(rule =>
        rule.includes('Ogni modulo deve preparare il successivo')
      )
    );
    assert.ok(
      PLAN_PROPEDEUTIC_ORDER_RULES.some(
        rule => rule.includes('raffinamento') && rule.includes('riordinale')
      )
    );
    assert.ok(
      PLAN_PROPEDEUTIC_ORDER_RULES.some(
        rule => rule.includes('elementi invertiti') && rule.includes("correggi l'ordine")
      )
    );
  });
});

test('buildLessonVerificationPrompt requires valid KaTeX delimiters', () => {
  const prompt = buildLessonVerificationPrompt({
    sectionTitle: 'Illuminazione sferica',
    sectionDescription: 'Approssimazione con armoniche sferiche.',
    previousContext: 'Lezione precedente',
    sourceContext: 'Contesto',
    continuityRule: 'Non anticipare la prossima lezione.',
    scopeRule: '- Resta sul focus corrente.',
    targetQuizCount: 2,
    draft: {
      contentMarkdown: '## Formula\n\n$$f(\\omega) = a_0$$',
      quiz: [
        { question: 'Q1', options: ['A', 'B', 'C', 'D'], correctIndex: 0 },
        { question: 'Q2', options: ['A', 'B', 'C', 'D'], correctIndex: 0 },
      ],
      imagePlacements: [],
    },
    candidateImages: [],
  });

  assert.match(prompt, /KaTeX\/LaTeX/i);
  assert.match(prompt, /righe orfane con solo/i);
  assert.match(prompt, /non mischiare delimitatori diversi/i);
  assert.match(prompt, /non racchiudere mai l'intera consegna|testo normale/i);
  assert.match(prompt, /exerciseType/i);
  assert.match(prompt, /application-card/i);
});

test('collapseRedundantParagraphs removes nearby paraphrases of the same concept', () => {
  const content = `## Come leggere il Core

Nel Core del framework la struttura va letta come una gerarchia di risultati attesi, non come un elenco di compiti da spuntare. Le sottocategorie descrivono outcome specifici e non una sequenza operativa obbligatoria.

Nel Core non bisogna interpretare le sottocategorie come una checklist di attivita da eseguire in ordine. La logica corretta e quella di una gerarchia di outcome, cioe di risultati che l'organizzazione deve saper raggiungere.

La funzione piu utile di questa gerarchia e collegare obiettivi strategici e risultati osservabili senza imporre un unico metodo operativo.`;

  const collapsed = collapseRedundantParagraphs(content);

  assert.match(collapsed, /gerarchia di risultati attesi/i);
  assert.match(collapsed, /collegare obiettivi strategici/i);
  assert.doesNotMatch(collapsed, /checklist di attivita da eseguire in ordine/i);
  assert.equal(collapsed.split(/\n{2,}/).length, 3);
});

test('estimateTargetQuizCount scales pauses conservatively with lesson density', () => {
  const shortLesson = `## Concetto\n\nBreve spiegazione tecnica focalizzata su un solo punto.\n\nUna conseguenza pratica.`;
  const mediumLesson = `## Concetto\n\n${'Spiegazione tecnica mirata. '.repeat(80)}\n\n## Applicazione\n\n${'Caso d uso e implicazioni operative. '.repeat(60)}`;
  const longLesson = `## Parte 1\n\n${'Dettaglio tecnico e conseguenze operative. '.repeat(110)}\n\n## Parte 2\n\n${'Analisi di vincoli, errori tipici e mitigazioni. '.repeat(110)}\n\n## Parte 3\n\n${'Collegamento con processi, monitoraggio e recupero. '.repeat(110)}`;

  assert.equal(estimateTargetQuizCount(shortLesson), 1);
  assert.equal(estimateTargetQuizCount(mediumLesson), 2);
  assert.equal(estimateTargetQuizCount(longLesson), 3);
});

test('estimateRelevantPdfImagePages focuses extraction around the mapped chunk positions', () => {
  const documentIndex: PdfTextIndex = {
    kind: 'pdf-text-index',
    parsedAt: '2026-04-03T00:00:00.000Z',
    sourceHash: 'hash-1',
    chunks: [
      {
        id: 'chunk-001',
        text: 'Intro',
        headingPath: ['Intro'],
        sequence: 0,
        startOffset: 0,
        endOffset: 100,
      },
      {
        id: 'chunk-002',
        text: 'Middle',
        headingPath: ['Middle'],
        sequence: 1,
        startOffset: 100,
        endOffset: 200,
      },
      {
        id: 'chunk-003',
        text: 'Advanced',
        headingPath: ['Advanced'],
        sequence: 2,
        startOffset: 200,
        endOffset: 300,
      },
    ],
  };

  assert.deepEqual(
    estimateRelevantPdfImagePages(documentIndex, ['chunk-002'], 30),
    [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]
  );
  assert.deepEqual(
    estimateRelevantPdfImagePages(documentIndex, ['chunk-003'], 30),
    [19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]
  );
});

test('estimateRelevantPdfImagePages uses exact page text mapping when page offsets are available', () => {
  const documentIndex: PdfTextIndex = {
    kind: 'pdf-text-index',
    parsedAt: '2026-04-03T00:00:00.000Z',
    sourceHash: 'hash-1',
    chunks: [
      {
        id: 'chunk-001',
        text: 'Intro',
        headingPath: ['Intro'],
        sequence: 0,
        startOffset: 0,
        endOffset: 8,
      },
      {
        id: 'chunk-002',
        text: 'Decal systems',
        headingPath: ['Effects', 'Decal systems'],
        sequence: 1,
        startOffset: 10,
        endOffset: 29,
      },
      {
        id: 'chunk-003',
        text: 'Camera ambient occlusion',
        headingPath: ['Effects', 'Ambient occlusion'],
        sequence: 2,
        startOffset: 31,
        endOffset: 61,
      },
    ],
  };

  assert.deepEqual(
    estimateRelevantPdfImagePages(documentIndex, ['chunk-002'], 40, [
      { pageNumber: 10, text: 'Intro' },
      { pageNumber: 11, text: 'Decal systems' },
      { pageNumber: 12, text: 'Camera ambient occlusion' },
    ]),
    [9, 10, 11, 12, 13, 14]
  );
});

test('buildPdfChunkUsageDebugPayload reports exact prompt chunk ranges when page text is available', () => {
  const documentIndex: PdfTextIndex = {
    kind: 'pdf-text-index',
    parsedAt: '2026-04-03T00:00:00.000Z',
    sourceHash: 'hash-1',
    chunks: [
      {
        id: 'chunk-001',
        text: 'Intro',
        headingPath: ['Intro'],
        sequence: 0,
        startOffset: 0,
        endOffset: 100,
      },
      {
        id: 'chunk-002',
        text: 'Middle',
        headingPath: ['Chapter 1', 'Middle'],
        sequence: 1,
        startOffset: 100,
        endOffset: 200,
        pageStart: 10,
        pageEnd: 10,
      },
      {
        id: 'chunk-003',
        text: 'Advanced',
        headingPath: ['Chapter 2', 'Advanced'],
        sequence: 2,
        startOffset: 200,
        endOffset: 300,
        pageStart: 11,
        pageEnd: 11,
      },
      {
        id: 'chunk-004',
        text: 'Appendix',
        headingPath: ['Appendix'],
        sequence: 3,
        startOffset: 300,
        endOffset: 400,
        pageStart: 12,
        pageEnd: 12,
      },
    ],
  };

  const payload = buildPdfChunkUsageDebugPayload(
    'Pipeline di rendering',
    documentIndex,
    ['chunk-003'],
    40,
    [10, 11, 12, 13, 14],
    [
      { pageNumber: 10, text: 'Middle' },
      { pageNumber: 11, text: 'Advanced' },
      { pageNumber: 12, text: 'Appendix' },
    ]
  );

  assert.ok(payload);
  assert.equal(payload?.promptContextPageRange, 'pag. 10-12');
  assert.equal(payload?.targetedImagePages, 'pag. 10-14');
  assert.deepEqual(payload?.primaryChunkIds, ['chunk-003']);
  assert.equal(payload?.pageMappingMode, 'exact-from-page-text');
  assert.deepEqual(payload?.promptContextChunkIds, ['chunk-002', 'chunk-003', 'chunk-004']);
  assert.deepEqual(payload?.primaryChunks, [
    {
      id: 'chunk-003',
      sequence: 2,
      headingPath: 'Chapter 2 > Advanced',
      pageRange: 'pag. 11',
      pageRangeSource: 'exact',
    },
  ]);
});

test('buildLessonVerificationPrompt enforces final checks on image placement and caption association', () => {
  const prompt = buildLessonVerificationPrompt({
    sectionTitle: 'Decal e overlay',
    sectionDescription: 'Uso di decal, overlay e particelle',
    previousContext: 'Lezione precedente sul deferred rendering',
    sourceContext: 'Estratti sorgente sulle decal applicate alle superfici.',
    continuityRule: 'Non inventare continuita inesistenti.',
    scopeRule: '1. Resta sul focus della lezione.',
    targetQuizCount: 2,
    draft: {
      contentMarkdown: '## Decal\n\nTesto.',
      quiz: [
        { question: 'Q1', options: ['A', 'B', 'C', 'D'], correctIndex: 0 },
        { question: 'Q2', options: ['A', 'B', 'C', 'D'], correctIndex: 0 },
        { question: 'Q3', options: ['A', 'B', 'C', 'D'], correctIndex: 0 },
        { question: 'Q4', options: ['A', 'B', 'C', 'D'], correctIndex: 0 },
        { question: 'Q5', options: ['A', 'B', 'C', 'D'], correctIndex: 0 },
      ],
      imagePlacements: [
        {
          assetId: 'pdf-img-001',
          alt: 'Schema decal',
          caption: 'Decal sovrapposte',
          anchorHeading: 'Decal',
        },
      ],
    },
    candidateImages: [
      {
        assetId: 'pdf-img-001',
        pageNumber: 42,
        visibleLabel: 'Schema delle decal',
        caption: 'Figura sulle decal proiettate',
        sourceOrder: 1,
      },
    ],
  });

  assert.match(prompt, /verificatore finale/i);
  assert.match(prompt, /ESATTAMENTE 2 pause attive/i);
  assert.match(prompt, /Ogni immagine selezionata deve essere nel punto giusto della lezione/i);
  assert.match(prompt, /descrizione, caption, immagine e paragrafo vicino siano abbinati/i);
  assert.match(prompt, /collegamento bidirezionale con il testo vicino/i);
  assert.match(prompt, /Meglio meno immagini che immagini sbagliate/i);
  assert.doesNotMatch(prompt, /sourceContextCurrent/i);
  assert.doesNotMatch(prompt, /sourceContextBefore/i);
  assert.doesNotMatch(prompt, /sourceContextAfter/i);
});

test('injectImagePlaceholders places figures after the first local explanation block', () => {
  const content = [
    '## Compressione parallela',
    '',
    'Il paragrafo introduce cosa guardare nella figura: il segnale dry resta leggibile mentre il canale compresso aggiunge densita.',
    '',
    'Questo testo continua dopo la figura.',
  ].join('\n');

  const result = injectImagePlaceholders(content, [
    {
      assetId: 'pdf-img-001',
      alt: 'Schema della compressione parallela',
      caption: 'Percorso dry e compresso affiancati',
      anchorHeading: 'Compressione parallela',
    },
  ]);

  assert.match(
    result,
    /densita\.\n\n\{\{PDF_IMAGE:pdf-img-001\|alt=Schema della compressione parallela\|caption=Percorso dry e compresso affiancati\}\}\n\nQuesto testo continua/
  );
});

test('insertGeneratedVisualExamplePlaceholder places generated visuals near their anchor heading', () => {
  const content = [
    '## Concetto principale',
    '',
    'Introduzione generale.',
    '',
    '## Grafico dei costi',
    '',
    'Questo paragrafo introduce il confronto quantitativo che il grafico rende piu leggibile.',
    '',
    'Il testo prosegue con le implicazioni.',
  ].join('\n');

  const result = insertGeneratedVisualExamplePlaceholder(
    content,
    '\n\n{{VISUAL_EXAMPLE:visual-001|title=grafico_dei_costi}}',
    'Grafico dei costi'
  );

  assert.match(
    result,
    /piu leggibile\.\n\n\{\{VISUAL_EXAMPLE:visual-001\|title=grafico_dei_costi\}\}\n\nIl testo prosegue/
  );
  assert.doesNotMatch(result, /Il testo prosegue[\s\S]*VISUAL_EXAMPLE/);
});
