import { buildPdfTextIndex } from '@shared/pdfTextIndex';
import { formatPdfTranscriptionMarker, TRANSCRIBED_SOURCE_RULE } from '@shared/pdfTranscription';
import { expect, test, vi } from 'vitest';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  buildLessonEvidenceMaterials,
  readStoredTranscribedSources,
  resolveLessonEvidence,
  serializeLessonEvidence,
} from '../../src/services/lessonEvidence.js';
import { verifyLessonEvidence } from '../../src/services/lessonEvidenceVerification.js';
import { buildLessonGenerationPrompt } from '../../src/services/lessonGenerationPrompt.js';
import {
  buildArchiveSourceContext,
  buildMappedSourceContext,
} from '../../src/services/lessonGenerationSources.js';
import type { LessonGenerationInput } from '../../src/services/lessonGenerationTypes.js';
import { readLessonPrimarySources } from '../../src/services/lessonPrimarySourceContext.js';
import { buildSha256HexDigest } from '../../src/utils/hash.js';
import { CourseDocumentIndexSchema } from '../../src/workflows/courseGenerationWorkflowContract.js';
import { canonicalJson } from '../../src/workflows/schemaFingerprint.js';
import recording from '../fixtures/pdf-transcription-response.json';

const provider = vi.hoisted(() => ({ generateStructuredOutput: vi.fn() }));
vi.mock('../../src/services/structuredGeneration.js', () => provider);

// Inject one arrow slip into a recorded response to exercise downstream correction provenance.
const recordedTranscription = recording.response.markdown.replace(
  '\\Rightarrow',
  '\\Leftrightarrow'
);

test('retains page provenance through indexing, source selection, lesson/quiz instructions and factual approval of an evident correction', async () => {
  const page = {
    pageNumber: 7,
    text: `${formatPdfTranscriptionMarker(7)}\n\n${recordedTranscription}`,
    provenance: {
      kind: 'vision-transcription' as const,
      pageNumber: 7,
      model: 'recorded',
      provider: 'recorded',
    },
  };
  const documentIndex = buildPdfTextIndex(
    page.text,
    'synthetic',
    'Synthetic notes',
    [page],
    'notes'
  );
  const durableIndex = CourseDocumentIndexSchema.parse(documentIndex);
  expect(durableIndex.chunks[0].text).toContain(formatPdfTranscriptionMarker(7));
  expect(documentIndex.chunks.every(chunk => chunk.transcribedPages?.includes(7))).toBe(true);
  const sourceContext = buildMappedSourceContext({ documentIndex: durableIndex } as never, {});
  expect(sourceContext).toContain('transcribedPages');
  const input: LessonGenerationInput = {
    config: getGlobalModelConfig(),
    description: 'Prove the forward implication.',
    imageCandidates: [],
    instructionPacks: [],
    language: 'English',
    pedagogicalContext: '',
    previousLessonTitles: [],
    refreshResearch: false,
    researchContext: '',
    sectionTitle: 'One-way proof',
    signal: new AbortController().signal,
    sourceContext,
    sources: [],
  };
  const materials = buildLessonEvidenceMaterials(input);
  input.evidencePacket = resolveLessonEvidence(materials, {
    materials: [
      {
        materialId: 'primary',
        reason: 'One-way proof',
        passages: [
          {
            firstUnit: 0,
            lastUnit: materials[0].units.length - 1,
            claims: ['A number greater than one has square greater than one.'],
          },
        ],
        overlaps: [],
      },
    ],
  });
  expect(
    readStoredTranscribedSources(serializeLessonEvidence(input, input.evidencePacket))[0]
      .transcribedPages
  ).toEqual([7]);
  const prompt = buildLessonGenerationPrompt(input);
  expect(prompt).toContain(TRANSCRIBED_SOURCE_RULE);
  expect(prompt).toContain('transcribedPages');
  expect(prompt).toContain('Leftrightarrow');
  const draft = {
    contentBlocks: [
      {
        type: 'markdown' as const,
        markdown: String.raw`If $x>1$, then $x^2>x>1$, so $x>1 \Rightarrow x^2>1$. This proof establishes one direction.`,
      },
    ],
    generatedVisuals: [],
    imageRefs: [],
  };
  const blockId = `${buildSha256HexDigest(Buffer.from(canonicalJson(draft.contentBlocks[0])))}:0`;
  provider.generateStructuredOutput.mockResolvedValue({
    blocks: [
      {
        blockId,
        assessments: [
          {
            claim: 'A number greater than one has square greater than one.',
            status: 'supported',
            evidence: [
              { materialId: 'primary', firstUnit: 0, lastUnit: materials[0].units.length - 1 },
            ],
            explanation:
              'The one-way derivation supports implication; the equivalence is an evident transcription error.',
          },
        ],
        noFactualClaimsReason: '',
      },
    ],
  });
  await expect(verifyLessonEvidence(input, draft)).resolves.toBeUndefined();
  const request = provider.generateStructuredOutput.mock.calls.at(-1)?.[0];
  expect(request.system).toContain(TRANSCRIBED_SOURCE_RULE);
  const evidence = JSON.parse(request.prompt).evidence;
  expect(evidence[0].primarySources[0].source.transcribedPages).toEqual([7]);
  expect(evidence[0].units.map((unit: { text: string }) => unit.text).join('')).toContain(
    'Leftrightarrow'
  );
});

test('archive evidence keeps clean and transcribed page identities separate after storage', async () => {
  const first = 'Digital exam page.\n\n';
  const text = `${first}Machine transcription with a slip.`;
  const content = Buffer.from(text);
  const pdfPages = [
    { pageNumber: 1, startByte: 0, endByte: Buffer.byteLength(first) },
    {
      pageNumber: 2,
      startByte: Buffer.byteLength(first),
      endByte: content.length,
      provenance: {
        kind: 'vision-transcription' as const,
        pageNumber: 2,
        model: 'recorded',
        provider: 'recorded',
      },
    },
  ];
  const store = {
    loadProjectSourceArchiveIndex: async () => ({
      entries: [
        {
          kind: 'file',
          path: 'mixed.pdf',
          contentKind: 'text',
          byteSize: content.length,
          hash: 'a'.repeat(64),
          pdfPages,
        },
      ],
      version: {
        sourceId: 'archive',
        sourceHash: 'b'.repeat(64),
        representationHash: 'c'.repeat(64),
      },
    }),
    loadProjectSourceArchiveEntry: async () => content,
  };
  const context = await buildArchiveSourceContext(store as never, 'user', 'project', {
    sourceArchiveSelectors: [{ kind: 'file', path: 'mixed.pdf' }],
  });
  const parts = readLessonPrimarySources(context);
  expect(parts?.map(part => part.source)).toEqual([
    { title: 'mixed.pdf', path: 'mixed.pdf', sourceId: 'archive', pageStart: 1, pageEnd: 1 },
    {
      title: 'mixed.pdf',
      path: 'mixed.pdf',
      sourceId: 'archive',
      pageStart: 2,
      pageEnd: 2,
      transcribedPages: [2],
    },
  ]);
  expect(parts?.[1].text).toContain('Machine transcription with a slip.');
});
