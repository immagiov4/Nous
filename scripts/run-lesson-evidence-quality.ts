import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGlobalModelConfig } from '../apps/backend/src/config/modelConfig.js';
import { closeManagedCodexAccountClient } from '../apps/backend/src/services/codexAppServer.js';
import {
  buildLessonEvidenceMaterials,
  resolveLessonEvidence,
} from '../apps/backend/src/services/lessonEvidence.js';
import { verifyLessonEvidence } from '../apps/backend/src/services/lessonEvidenceVerification.js';
import { LessonGenerationCorrectionError } from '../apps/backend/src/services/lessonGenerationCorrection.js';
import type { LessonGenerationInput } from '../apps/backend/src/services/lessonGenerationTypes.js';
import {
  runWithWorkflowAttemptMetering,
  type WorkflowAiUsageRecord,
} from '../apps/backend/src/workflows/workflowAiMetering.js';

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

const main = async () => {
  assert.equal(
    process.env.REAL_LESSON_QUALITY_TESTS,
    'I_ACCEPT_REAL_PROVIDER_COSTS',
    'Set REAL_LESSON_QUALITY_TESTS=I_ACCEPT_REAL_PROVIDER_COSTS to run paid model calls.'
  );
  const outputDirectory = await mkdtemp(join(tmpdir(), 'nous-evidence-quality-'));
  console.log(`Lesson evidence quality: ${outputDirectory}`);
  const input: LessonGenerationInput = {
    config: {
      ...getGlobalModelConfig(),
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
    const usage: WorkflowAiUsageRecord[] = [];
    const draft = {
      contentBlocks: [{ type: 'markdown' as const, markdown: example.markdown }],
      generatedVisuals: [],
      imageRefs: [],
    };
    const result = await runWithWorkflowAttemptMetering(
      {
        attemptNumber: 1,
        nodeInstanceId: example.name,
        runId: 'lesson-evidence-quality',
        record: async record => {
          usage.push(record);
          await writeFile(
            join(outputDirectory, `${example.name}-usage.json`),
            JSON.stringify(usage, null, 2)
          );
        },
      },
      async () => {
        try {
          await verifyLessonEvidence(input, draft);
          return { outcome: 'supported' };
        } catch (error) {
          if (!(error instanceof LessonGenerationCorrectionError)) throw error;
          return { outcome: error.code, feedback: error.feedback };
        }
      }
    );
    await writeFile(
      join(outputDirectory, `${example.name}.json`),
      JSON.stringify(
        {
          expected: example.expected,
          sourceContext: input.sourceContext,
          evidence: input.evidencePacket,
          draft,
          result,
          usage,
        },
        null,
        2
      )
    );
    console.log(`${example.name}: ${result.outcome}`);
    if (result.outcome !== example.expected) failures.push(example.name);
  }
  assert.deepEqual(failures, [], 'Factual inference evaluation failed.');
};

try {
  await main();
} finally {
  await closeManagedCodexAccountClient();
}
