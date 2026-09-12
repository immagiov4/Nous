import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  buildLessonEvidenceMaterials,
  resolveLessonEvidence,
} from '../../src/services/lessonEvidence.js';
import { selectLessonEvidence } from '../../src/services/lessonEvidenceModel.js';
import {
  generateLessonContent,
  generateResearchSummary,
  reviewLessonContentDraftStrict,
} from '../../src/services/lessonGenerationModel.js';
import { buildResearchDossier } from '../../src/services/lessonGenerationResearch.js';
import type { LessonGenerationInput } from '../../src/services/lessonGenerationTypes.js';
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

const mockModels = (loseEvidence = false) => {
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
    if (properties.blocks) return JSON.stringify(factualReport(!loseEvidence));
    return JSON.stringify(evidenceLesson);
  });
};

describe('role-specific lesson evidence through the production Luna model path', () => {
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
    mockModels(true);
    const input = generationInput();
    input.researchContext = JSON.stringify(evidenceResearch);
    input.evidencePacket = resolveLessonEvidence(
      buildLessonEvidenceMaterials(input),
      evidenceSelection
    );
    await expect(
      reviewLessonContentDraftStrict({ draft: evidenceLesson, generationInput: input })
    ).rejects.toMatchObject({ code: 'lesson_factual_support_failed' });
    const factualInput = JSON.parse(runCodexAppServerTurn.mock.calls[1]?.[0].input[0].text);
    expect(factualInput.draft).toEqual(evidenceLesson);
  });
});
