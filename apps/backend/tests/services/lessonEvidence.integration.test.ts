import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  buildLessonEvidenceMaterials,
  resolveLessonEvidence,
} from '../../src/services/lessonEvidence.js';
import { selectLessonEvidence } from '../../src/services/lessonEvidenceModel.js';
import { verifyLessonEvidence } from '../../src/services/lessonEvidenceVerification.js';
import {
  generateLessonContent,
  generateResearchSummary,
  reviewLessonContentDraftStrict,
} from '../../src/services/lessonGenerationModel.js';
import { buildResearchDossier } from '../../src/services/lessonGenerationResearch.js';
import type { LessonGenerationInput } from '../../src/services/lessonGenerationTypes.js';
import { resolveLessonVisualModelConfig } from '../../src/services/lessonVisualModelConfig.js';
import { createLessonNormalizationStage } from '../../src/workflows/lessonGenerationNormalizationStage.js';
import { createLessonPersistenceStage } from '../../src/workflows/lessonGenerationPersistence.js';
import { createLessonGenerationStageServices } from '../../src/workflows/lessonGenerationStageServices.js';
import {
  LessonDraftStateSchema,
  LessonGenerationWorkflowResultSchema,
  LessonResearchStateSchema,
  LessonReviewedStateSchema,
  LessonSourcesStateSchema,
} from '../../src/workflows/lessonGenerationWorkflowContract.js';
import { InMemoryProjectStore } from '../helpers/inMemoryProjectStore.js';
import {
  evidenceLesson,
  evidencePrimaryContext,
  evidenceResearch,
  evidenceSources,
} from './lessonEvidence.fixture.js';

const { runCodexAppServerTurn } = vi.hoisted(() => ({ runCodexAppServerTurn: vi.fn() }));
vi.mock('../../src/services/codexAppServer.js', () => ({ runCodexAppServerTurn }));

const evidenceSelection = {
  materials: [
    {
      materialId: 'primary',
      reason: 'Definizioni e condizione dell’orologio scalare richieste dalla lezione.',
      passages: [
        {
          firstUnit: 0,
          lastUnit: 3,
          claims: [
            'Ordine locale, invio/ricezione e transitività definiscono la precedenza causale.',
            'Concorrenza non equivale a simultaneità.',
            'La condizione degli orologi scalari non è invertibile.',
          ],
        },
      ],
      overlaps: [],
    },
    {
      materialId: 'research',
      reason: 'Sintesi già documentata negli appunti e negli esempi originali.',
      passages: [],
      overlaps: [],
    },
    {
      materialId: 'source-0',
      reason: 'Identità degli appunti conservata nel materiale primario.',
      passages: [],
      overlaps: [],
    },
    {
      materialId: 'source-1',
      reason:
        'Le definizioni ripetono gli appunti; i dettagli degli algoritmi non servono agli obiettivi.',
      passages: [],
      overlaps: [
        {
          firstUnit: 1,
          lastUnit: 4,
          retainedMaterialId: 'primary',
          retainedFirstUnit: 0,
          retainedLastUnit: 3,
          reason: 'Stesse definizioni, stessa qualificazione della condizione scalare.',
        },
      ],
    },
    {
      materialId: 'source-2',
      reason: 'Dimostrazione osservabile della catena P-Q-R e del ruolo del ritardo.',
      passages: [
        {
          firstUnit: 1,
          lastUnit: 3,
          claims: [
            'La domanda di P precede causalmente la risposta ricevuta da R.',
            'Cambiare il ritardo della dimostrazione non elimina la dipendenza.',
          ],
        },
      ],
      overlaps: [],
    },
    {
      materialId: 'source-3',
      reason: 'Ripasso delle definizioni già conservate.',
      passages: [],
      overlaps: [
        {
          firstUnit: 1,
          lastUnit: 2,
          retainedMaterialId: 'primary',
          retainedFirstUnit: 0,
          retainedLastUnit: 3,
          reason: 'Ripete transitività e non invertibilità.',
        },
      ],
    },
    {
      materialId: 'source-4',
      reason: 'Storia degli strumenti priva di evidenze utili per la precedenza causale.',
      passages: [],
      overlaps: [],
    },
  ],
};

const generationInput = (): LessonGenerationInput => ({
  config: {
    ...getGlobalModelConfig(),
    aiProvider: 'codex',
    aiProviderOverrides: {},
    codexLessonModel: 'gpt-5.6-luna',
  },
  description:
    'Ricostruire una catena causale da ordine locale e messaggi. Distinguere concorrenza da simultaneità e riconoscere il limite degli orologi scalari.',
  imageCandidates: [],
  instructionPacks: [],
  language: 'Italiano',
  pedagogicalContext:
    'Prima esposizione alla precedenza causale. Spiega una definizione prima di usarla; ogni alternativa del quiz deve essere risolvibile dal testo precedente.',
  previousLessonTitles: ['Processi e messaggi'],
  refreshResearch: false,
  researchContext: '',
  sectionTitle: 'Precedenza causale e orologi scalari',
  signal: new AbortController().signal,
  sourceContext: evidencePrimaryContext,
  sources: structuredClone(evidenceSources),
});

const reference = { materialId: 'primary', firstUnit: 0, lastUnit: 3 };
const demoReference = { materialId: 'source-2', firstUnit: 1, lastUnit: 3 };
const factualReport = (supported: boolean) => ({
  blocks: [
    {
      blockIndex: 0,
      noFactualClaimsReason: '',
      assessments: [
        {
          claim: 'Ordine locale, messaggi e transitività sostengono la catena P-Q-R.',
          status: 'supported',
          evidence: [reference, demoReference],
          explanation: 'Gli appunti definiscono la relazione e la dimostrazione mostra la catena.',
        },
      ],
    },
    {
      blockIndex: 1,
      noFactualClaimsReason: '',
      assessments: [
        {
          claim: 'La clip mostra la catena e la variazione del ritardo.',
          status: 'supported',
          evidence: [demoReference],
          explanation: 'Intervallo interamente nei segmenti originali 1-3.',
        },
      ],
    },
    {
      blockIndex: 2,
      noFactualClaimsReason: '',
      assessments: [
        {
          claim:
            'La condizione scalare non è invertibile; concorrenza non equivale a simultaneità.',
          status: supported ? 'supported' : 'unsupported',
          evidence: [reference],
          explanation: supported
            ? 'Entrambe le qualificazioni sono esplicite negli appunti.'
            : 'Manca il passaggio che documenta il limite degli orologi scalari.',
        },
      ],
    },
    {
      blockIndex: 3,
      noFactualClaimsReason: '',
      assessments: [
        {
          claim: 'Il quiz e la sua spiegazione applicano il limite degli orologi scalari.',
          status: supported ? 'supported' : 'unsupported',
          evidence: [reference],
          explanation:
            'Le alternative sono giudicate rispetto alla condizione e alla distinzione dalla simultaneità.',
        },
      ],
    },
  ],
});

const mockModels = () => {
  runCodexAppServerTurn.mockReset();
  runCodexAppServerTurn.mockImplementation(async request => {
    const properties = request.outputSchema.properties;
    if (properties.factualSummary) return JSON.stringify(evidenceResearch);
    if (properties.materials) return JSON.stringify(evidenceSelection);
    if (properties.verificationReport)
      return JSON.stringify({
        ...evidenceLesson,
        lessonIntegrity: {
          topic: {
            preserved: true,
            evidence: 'Precedenza causale e limite degli orologi scalari.',
          },
          objectives: {
            preserved: true,
            evidence: 'Definizione, catena e distinzione richieste sono presenti.',
          },
        },
        verificationReport: properties.verificationReport.items.properties.checkId.enum.map(
          (checkId: string) => ({
            checkId,
            status: 'pass',
            evidence:
              'Le definizioni precedono la catena e tutte le alternative del quiz sono giudicabili dal paragrafo sugli orologi.',
            action: 'Preserve supported content.',
          })
        ),
      });
    if (properties.blocks) {
      const reviewed = JSON.parse(request.input[0].text);
      const primary = reviewed.evidence.find(
        (passage: { materialId: string }) => passage.materialId === 'primary'
      );
      const report = factualReport(
        primary.units.some(
          (unit: { text: string }) => unit.text === `${evidencePrimaryContext.split('\n')[3]}\n`
        )
      );
      for (const block of report.blocks) {
        block.assessments = block.assessments.map(assessment => ({
          ...assessment,
          evidence: assessment.evidence.map(citation =>
            citation.materialId === 'primary'
              ? { ...citation, lastUnit: primary.lastUnit }
              : citation
          ),
        }));
      }
      return JSON.stringify(report);
    }
    return JSON.stringify(evidenceLesson);
  });
};

describe('role-specific lesson evidence through the production Luna model path', () => {
  test('supports clips and citations across adjacent selections while rejecting omitted units', async () => {
    const input = generationInput();
    input.researchContext = JSON.stringify(evidenceResearch);
    const splitSelection = structuredClone(evidenceSelection);
    const video = splitSelection.materials.find(material => material.materialId === 'source-2');
    if (!video) throw new Error('Missing video fixture.');
    video.passages = [
      { firstUnit: 1, lastUnit: 1, claims: ['Catena causale.'] },
      { firstUnit: 2, lastUnit: 3, claims: ['Concorrenza e ritardo.'] },
    ];
    const selected = structuredClone(splitSelection);
    input.evidencePacket = resolveLessonEvidence(
      buildLessonEvidenceMaterials(input),
      splitSelection
    );
    expect(input.evidencePacket.selection).toEqual(selected);
    expect(
      input.evidencePacket.passages.find(passage => passage.materialId === 'source-2')
    ).toMatchObject({ firstUnit: 1, lastUnit: 3 });
    runCodexAppServerTurn.mockResolvedValue(JSON.stringify(factualReport(true)));
    await expect(verifyLessonEvidence(input, evidenceLesson)).resolves.toBeUndefined();
    video.passages[1].firstUnit = 3;
    input.evidencePacket = resolveLessonEvidence(
      buildLessonEvidenceMaterials(input),
      splitSelection
    );
    await expect(verifyLessonEvidence(input, evidenceLesson)).rejects.toMatchObject({
      code: 'lesson_clip_evidence_missing',
    });
  });
  test('accepts grounded distractor explanations but rejects a contradicted answer key', async () => {
    const input = generationInput();
    input.researchContext = JSON.stringify(evidenceResearch);
    input.evidencePacket = resolveLessonEvidence(
      buildLessonEvidenceMaterials(input),
      evidenceSelection
    );
    runCodexAppServerTurn.mockImplementation(async request => {
      const { draft } = JSON.parse(request.input[0].text);
      const quiz = draft.contentBlocks[3].quiz;
      const report = factualReport(true);
      const quizAssessment = report.blocks[3]?.assessments[0];
      if (!quizAssessment) throw new Error('Missing quiz assessment fixture.');
      quizAssessment.claim =
        'La risposta marcata e la spiegazione distinguono le alternative errate usando la condizione scalare.';
      quizAssessment.status = quiz.correctIndex === 0 ? 'supported' : 'contradicted';
      return JSON.stringify(report);
    });
    await expect(verifyLessonEvidence(input, evidenceLesson)).resolves.toBeUndefined();
    const wrongKey = structuredClone(evidenceLesson);
    const quizBlock = wrongKey.contentBlocks[3];
    if (quizBlock?.type !== 'inline-quiz') throw new Error('Missing quiz fixture.');
    quizBlock.quiz.correctIndex = 1;
    await expect(verifyLessonEvidence(input, wrongKey)).rejects.toMatchObject({
      code: 'lesson_factual_support_failed',
    });
  });
  test('accepts factual citations inside retained passages and rejects reversed or outside ranges', async () => {
    const input = generationInput();
    input.researchContext = JSON.stringify(evidenceResearch);
    input.evidencePacket = resolveLessonEvidence(
      buildLessonEvidenceMaterials(input),
      evidenceSelection
    );
    const report = factualReport(true);
    for (const block of report.blocks)
      for (const assessment of block.assessments)
        assessment.evidence = assessment.evidence.map(citation => ({
          ...citation,
          firstUnit: citation.lastUnit,
        }));
    runCodexAppServerTurn.mockResolvedValue(JSON.stringify(report));
    await expect(verifyLessonEvidence(input, evidenceLesson)).resolves.toBeUndefined();
    const citation = report.blocks[0]?.assessments[0]?.evidence[0];
    if (!citation) throw new Error('Missing factual citation fixture.');
    citation.firstUnit = citation.lastUnit + 1;
    runCodexAppServerTurn.mockResolvedValue(JSON.stringify(report));
    await expect(verifyLessonEvidence(input, evidenceLesson)).rejects.toMatchObject({
      code: 'lesson_factual_review_invalid',
    });
    citation.lastUnit = citation.firstUnit;
    runCodexAppServerTurn.mockResolvedValue(JSON.stringify(report));
    await expect(verifyLessonEvidence(input, evidenceLesson)).rejects.toMatchObject({
      code: 'lesson_factual_review_invalid',
    });
  });
  test.each([
    false,
    true,
  ])('measures complete prompt payloads with reused dossier=%s', async reuseDossier => {
    mockModels();
    const input = generationInput();
    input.researchContext = JSON.stringify({
      ...evidenceResearch,
      ...(reuseDossier ? { sources: input.sources } : {}),
    });
    const beforeDraft = await generateLessonContent(input);
    await reviewLessonContentDraftStrict({ draft: beforeDraft, generationInput: input });
    const before = runCodexAppServerTurn.mock.calls.map(([request]) => request);
    runCodexAppServerTurn.mockClear();
    input.evidencePacket = await selectLessonEvidence(input);
    const afterDraft = await generateLessonContent(input);
    await reviewLessonContentDraftStrict({ draft: afterDraft, generationInput: input });
    const after = runCodexAppServerTurn.mock.calls.map(([request]) => request);
    const fullCharacters = buildLessonEvidenceMaterials(input)
      .filter(material => material.kind !== 'research')
      .flatMap(material => material.units)
      .reduce((total, unit) => total + unit.text.length, 0);
    const retainedCharacters = input.evidencePacket.passages
      .flatMap(passage => passage.units)
      .reduce((total, unit) => total + unit.text.length, 0);
    expect(retainedCharacters).toBeLessThan(fullCharacters);
    expect(afterDraft).toEqual(beforeDraft);
    const directory = process.env.LESSON_EVIDENCE_MEASUREMENTS_DIR;
    if (directory) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `${reuseDossier ? 'reused' : 'fresh'}-dossier.json`),
        JSON.stringify(
          {
            model: input.config.codexLessonModel,
            fullCharacters,
            retainedCharacters,
            before: before.map((request, index) => ({
              stage: ['drafting', 'combined-review'][index],
              request,
            })),
            after: after.map((request, index) => ({
              stage: ['selection', 'drafting', 'pedagogical-review', 'factual-review'][index],
              request,
            })),
            selection: input.evidencePacket.selection,
            materials: buildLessonEvidenceMaterials(input),
          },
          null,
          2
        )
      );
    }
  });
  test('replays production stages through a durable result with complete archived evidence', async () => {
    mockModels();
    const input = generationInput();
    const store = new InMemoryProjectStore();
    const timestamp = '2026-09-12T18:00:00.000Z';
    const sourceFile = {
      name: 'Appunti del corso',
      mimeType: 'text/plain',
      data: Buffer.from(evidencePrimaryContext).toString('base64'),
      sourceId: 'course-notes',
    };
    await store.saveProject('user-1', {
      id: 'project-1',
      version: '4.1',
      createdAt: timestamp,
      updatedAt: timestamp,
      lastOpenedAt: timestamp,
      sourceKind: 'document',
      source: {
        kind: 'document',
        file: sourceFile,
        sources: [
          {
            id: 'course-notes',
            name: 'Appunti del corso',
            hash: 'a'.repeat(64),
            kind: 'text',
            outline: [],
            outlineOrigin: 'none',
            position: 0,
            status: 'ready',
            file: sourceFile,
          },
        ],
      },
      userProfile: { language: 'Italiano' },
      learningPlan: {
        title: 'Sistemi distribuiti',
        modules: [
          {
            id: 'module-1',
            title: 'Eventi',
            children: [
              {
                id: 'causality',
                kind: 'lesson',
                type: 'core',
                title: input.sectionTitle,
                description: input.description,
              },
            ],
          },
        ],
      },
    });
    const config = {
      maxAttempts: 3,
      timeoutMs: 90_000,
      models: input.config,
      visual: resolveLessonVisualModelConfig(input.config),
    };
    const context = <Input>(state: Input) => ({
      input: state,
      config,
      attemptNumber: 1,
      execution: { runId: 'evidence-run', nodeInstanceId: 'evidence-node' },
      idempotencyKey: 'evidence-key',
      retryFeedback: '',
      signal: input.signal,
    });
    const services = createLessonGenerationStageServices({
      generateAids: vi.fn(async () => []),
      generateContent: generateLessonContent,
      generateResearch: generateResearchSummary,
      selectEvidence: selectLessonEvidence,
      reviewContent: reviewLessonContentDraftStrict,
      loadProject: store.loadProject.bind(store),
      loadProjectWithRevision: store.loadProjectWithRevision.bind(store),
      store,
      resolveSourceMaterials: vi.fn(async () => ({
        sourceContext: evidencePrimaryContext,
        existingSources: [],
        existingDossier: null,
      })),
      selectCoverage: vi.fn(async () => ({ needsResearch: false, missingTopics: [] })),
      planYouTube: vi.fn(async () => ({
        specificQuery: 'precedenza causale',
        fallbackQuery: 'orologi logici',
        focusConcept: 'catena di messaggi',
      })),
      researchYouTube: vi.fn(async () => ({
        context: '',
        discoveredVideoCount: 4,
        rationale: 'Controlled retrieved lectures.',
        videoCandidates: evidenceSources.slice(1).map(source => ({
          title: source.title,
          url: source.url ?? '',
          segments: source.youtubeTranscript?.segments ?? [],
        })),
      })),
    });
    const prepared = await services.prepareLesson(
      context({
        userId: 'user-1',
        projectId: 'project-1',
        sectionId: 'causality',
        forceRegenerate: false,
      })
    );
    if (prepared.kind !== 'generate') throw new Error('Expected a new lesson.');
    const covered = await services.assessSourceCoverage(context(prepared.state));
    const staged = LessonSourcesStateSchema.parse({
      ...covered,
      stage: 'sources',
      documentAssetOwners: [],
      pdfImages: [],
    });
    const planned = await services.planYouTubeResearch(context(staged));
    const retrieved = await services.researchSpecificYouTube(context(planned));
    const finalized = await services.finalizeYouTubeResearch(context(retrieved));
    const researched = LessonResearchStateSchema.parse(
      await services.researchLesson({ ...context(finalized), selectEvidence: true })
    );
    const drafted = LessonDraftStateSchema.parse(await services.draftLesson(context(researched)));
    const reviewed = LessonReviewedStateSchema.parse(await services.reviewLesson(context(drafted)));
    const aided = await services.generateLearningAids(context(reviewed));
    const normalized = await createLessonNormalizationStage({ now: () => timestamp })(
      context({ lesson: aided, stage: 'visual-results' as const, visualResults: [] })
    );
    const persisted = await createLessonPersistenceStage({
      loadProject: store.loadProject.bind(store),
      now: () => timestamp,
    })(context(normalized));
    const result = LessonGenerationWorkflowResultSchema.parse(persisted.result);
    expect(result.researchDossier?.sources).toEqual(researched.lessonSources);
    expect(result.researchDossier?.evidencePacketJson).toBe(researched.evidencePacketJson);
    const archive = JSON.parse(result.researchDossier?.evidencePacketJson ?? '{}');
    expect(
      archive.materials
        .find((material: { materialId: string }) => material.materialId === 'source-4')
        .units.map((unit: { text: string }) => unit.text)
    ).toEqual(evidenceSources[4]?.youtubeTranscript?.segments.map(segment => segment.text));
    expect(result.contentBlocks).toEqual(evidenceLesson.contentBlocks);
  });
  test('research, selection, drafting, pedagogical review and final factual review preserve support and canonical sources', async () => {
    mockModels();
    const input = generationInput();
    const originals = structuredClone(input.sources);
    const research = await generateResearchSummary(input);
    input.researchContext = JSON.stringify({ ...research, sources: originals });
    input.evidencePacket = await selectLessonEvidence(input);
    const draft = await generateLessonContent(input);
    const verified = await reviewLessonContentDraftStrict({ draft, generationInput: input });
    expect(verified).toEqual(evidenceLesson);
    expect(runCodexAppServerTurn).toHaveBeenCalledTimes(5);
    for (const [request] of runCodexAppServerTurn.mock.calls)
      expect(request.model).toBe('gpt-5.6-luna');
    const selectorInput = JSON.parse(runCodexAppServerTurn.mock.calls[1]?.[0].input[0].text);
    expect(selectorInput.task).toMatchObject({
      title: input.sectionTitle,
      description: input.description,
      pedagogicalContext: input.pedagogicalContext,
      instructionPacks: input.instructionPacks,
    });
    expect(
      selectorInput.materials.find(
        (material: { materialId: string }) => material.materialId === 'source-4'
      ).units
    ).toHaveLength(6);
    const writerPrompt = runCodexAppServerTurn.mock.calls[2]?.[0].input[0].text;
    const pedagogicalPrompt = runCodexAppServerTurn.mock.calls[3]?.[0].input[0].text;
    const factualInput = JSON.parse(runCodexAppServerTurn.mock.calls[4]?.[0].input[0].text);
    const originalDemo = originals[2]?.youtubeTranscript?.segments.slice(1, 4);
    expect(
      factualInput.evidence.find(
        (passage: { materialId: string }) => passage.materialId === 'source-2'
      ).units
    ).toEqual(originalDemo);
    expect(factualInput.draft).toEqual(verified);
    expect(writerPrompt).not.toContain(originals[4]?.youtubeTranscript?.segments[0]?.text);
    expect(pedagogicalPrompt).not.toContain(originalDemo?.[0]?.text);
    expect(input.sources).toEqual(originals);
    const dossier = buildResearchDossier({
      contentBlocks: verified.contentBlocks,
      existingDossier: null,
      lessonSources: input.sources,
      researchSummary: research,
      sectionId: 'causality',
      sectionTitle: input.sectionTitle,
      youtubeOutcome: null,
    });
    expect(dossier.sources).toEqual(originals);
    expect(input.evidencePacket.passages.map(passage => passage.sourceIndex)).toEqual([
      undefined,
      2,
    ]);
  });

  test('rejects declared evidence loss on the final lesson instead of publishing a weaker factual result', async () => {
    mockModels();
    const input = generationInput();
    input.researchContext = JSON.stringify(evidenceResearch);
    const missingQualification = structuredClone(evidenceSelection);
    const primarySelection = missingQualification.materials.find(
      material => material.materialId === 'primary'
    );
    if (!primarySelection?.passages[0]) throw new Error('Missing primary selection fixture.');
    primarySelection.passages[0].lastUnit = 2;
    for (const material of missingQualification.materials) {
      for (const overlap of material.overlaps) overlap.retainedLastUnit = 2;
    }
    input.evidencePacket = resolveLessonEvidence(
      buildLessonEvidenceMaterials(input),
      missingQualification
    );
    await expect(
      reviewLessonContentDraftStrict({ draft: evidenceLesson, generationInput: input })
    ).rejects.toMatchObject({ code: 'lesson_factual_support_failed' });
    const factualInput = JSON.parse(runCodexAppServerTurn.mock.calls[1]?.[0].input[0].text);
    expect(factualInput.draft).toEqual(evidenceLesson);
  });
});
