import assert from 'node:assert/strict';
import { getResolvedGlobalModelConfig } from '../apps/backend/src/config/modelConfig.js';
import { closeManagedCodexAccountClient } from '../apps/backend/src/services/codexAppServer.js';
import {
  buildLessonEvidenceMaterials,
  resolveLessonEvidence,
} from '../apps/backend/src/services/lessonEvidence.js';
import {
  LESSON_EVIDENCE_REASONING_EFFORT,
  verifyLessonEvidence,
} from '../apps/backend/src/services/lessonEvidenceVerification.js';
import { LessonGenerationCorrectionError } from '../apps/backend/src/services/lessonGenerationCorrection.js';
import type { LessonGenerationInput } from '../apps/backend/src/services/lessonGenerationTypes.js';

import {
  type RunEvidenceRecorder,
  resolveRunEvidenceTextSlot,
  withRunCleanup,
  withRunEvidence,
} from './run-evidence.js';

const cases = [
  {
    name: 'valid-deduction',
    markdown:
      'La scheda di Lea non determina un numero unico. Per esempio, 1 e 2 sono entrambi interi positivi: soddisfano la stessa regola e producono lo stesso contenuto della scheda, pur essendo numeri diversi.',
    expected: 'supported',
  },
  {
    name: 'missing-external-premise',
    markdown: 'Il numero di Lea è esattamente 2.',
    expected: 'lesson_factual_support_failed',
  },
] as const;

const caseUsage = (evidence: RunEvidenceRecorder, name: string) =>
  evidence.manifest.aiUsage.filter(record => record.nodeInstanceId === name);

const verifyDraft = async (
  input: LessonGenerationInput,
  draft: Parameters<typeof verifyLessonEvidence>[1]
) => {
  try {
    await verifyLessonEvidence(input, draft);
    return { outcome: 'supported' };
  } catch (error) {
    if (!(error instanceof LessonGenerationCorrectionError)) throw error;
    return { outcome: error.code, feedback: error.feedback };
  }
};

const main = async () => {
  assert.equal(
    process.env.REAL_LESSON_QUALITY_TESTS,
    'I_ACCEPT_REAL_PROVIDER_COSTS',
    'Set REAL_LESSON_QUALITY_TESTS=I_ACCEPT_REAL_PROVIDER_COSTS to run paid model calls.'
  );
  process.env.CODEX_APP_SERVER_ENABLED = 'true';
  const input: LessonGenerationInput = {
    config: {
      ...(await getResolvedGlobalModelConfig()),
      aiProvider: 'codex',
      aiProviderOverrides: {},
      codexLessonModel: 'gpt-5.6-luna',
    },
    sectionTitle: 'Premesse e conclusioni',
    description:
      'Distinguere una deduzione valida da una conclusione che richiede informazioni aggiuntive.',
    sourceContext:
      'In questo esercizio un numero è ammissibile se e solo se è un intero positivo. Una scheda registra soltanto se il numero è ammissibile; non registra il numero. La scheda di Lea riporta «ammissibile».',
    imageCandidates: [],
    instructionPacks: [],
    language: 'Italiano',
    pedagogicalContext: '',
    previousLessonTitles: [],
    refreshResearch: false,
    researchContext: '',
    sources: [],
    signal: new AbortController().signal,
  };
  const verifyCase = (
    evidence: RunEvidenceRecorder,
    example: (typeof cases)[number],
    draft: Parameters<typeof verifyDraft>[1]
  ) =>
    withRunCleanup(
      () => verifyDraft(input, draft),
      () => evidence.writeJson(`${example.name}-usage.json`, caseUsage(evidence, example.name))
    );
  const runCases = async (evidence: RunEvidenceRecorder): Promise<void> => {
    console.log(`Lesson evidence quality: ${evidence.directory}`);

    const materials = buildLessonEvidenceMaterials(input);
    input.evidencePacket = resolveLessonEvidence(materials, {
      materials: materials.map(material => ({
        materialId: material.materialId,
        reason: 'Complete exercise premises.',
        overlaps: [],
        passages: [
          {
            firstUnit: 0,
            lastUnit: material.units.length - 1,
            claims: ['The admissibility rule and the information recorded by the card.'],
          },
        ],
      })),
    });
    const failures: string[] = [];
    for (const example of cases) {
      try {
        await evidence.measure({ name: example.name, kind: 'case' }, async () => {
          const draft = {
            contentBlocks: [{ type: 'markdown' as const, markdown: example.markdown }],
            generatedVisuals: [],
            imageRefs: [],
          };
          const result = await evidence.measure({ name: example.name, kind: 'call' }, () =>
            verifyCase(evidence, example, draft)
          );
          const usage = caseUsage(evidence, example.name);
          await evidence.writeJson(`${example.name}.json`, {
            expected: example.expected,
            sourceContext: input.sourceContext,
            evidence: input.evidencePacket,
            draft,
            result,
            usage,
          });
          console.log(`${example.name}: ${result.outcome}`);
          assert.equal(result.outcome, example.expected, 'Factual inference outcome mismatch.');
        });
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        failures.push(example.name);
      }
    }
    assert.deepEqual(failures, [], 'Factual inference evaluation failed.');
  };
  await withRunEvidence(
    {
      scenario: 'lesson-evidence-quality',
      captureModelExchanges: true,
      provider: 'codex',
      slots: {
        lessonVerification: resolveRunEvidenceTextSlot(
          input.config,
          'lesson',
          LESSON_EVIDENCE_REASONING_EFFORT
        ),
      },
    },
    evidence => withRunCleanup(() => runCases(evidence), closeManagedCodexAccountClient)
  );
};

await main();
