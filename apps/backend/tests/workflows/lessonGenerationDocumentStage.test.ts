import type { ProjectAssetRef } from '@shared/projectAsset';
import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import {
  extractStoredPdfImageAssets,
  type LessonPdfImageAsset,
} from '../../src/services/lessonGenerationSources.js';
import { resolveLessonVisualModelConfig } from '../../src/services/lessonVisualModelConfig.js';
import { buildSha256HexDigest } from '../../src/utils/hash.js';
import { snapshotImmutableJson } from '../../src/workflows/jsonSnapshot.js';
import {
  buildLessonGenerationSourceFingerprint,
  buildLessonGenerationTargetFingerprint,
} from '../../src/workflows/lessonGenerationAuthority.js';
import { createLessonDocumentSourceStage } from '../../src/workflows/lessonGenerationDocumentStage.js';
import { LessonCoverageStateSchema } from '../../src/workflows/lessonGenerationWorkflowContract.js';
import type { WorkflowProviderEffectExecutor } from '../../src/workflows/types.js';
import { InMemoryProjectStore } from '../helpers/inMemoryProjectStore.js';

const project: ProjectSnapshot = {
  createdAt: '2026-07-29T20:00:00.000Z',
  id: 'project-1',
  lastOpenedAt: '2026-07-29T20:00:00.000Z',
  learningPlan: {
    modules: [
      {
        children: [
          {
            description: 'Una lezione sui messaggi.',
            id: 'lesson-1',
            kind: 'lesson',
            title: 'Comunicazioni a messaggi',
          },
        ],
        id: 'module-1',
        title: 'Modulo',
      },
    ],
  },
  sourceKind: 'document',
  updatedAt: '2026-07-29T20:00:00.000Z',
  version: '4.1',
};

const modelConfig = getGlobalModelConfig();
const config = {
  maxAttempts: 3,
  models: modelConfig,
  timeoutMs: 90_000,
  visual: resolveLessonVisualModelConfig(modelConfig),
};

const input = LessonCoverageStateSchema.parse({
  documentSourceHash: 'a'.repeat(64),
  existingDossierJson: null,
  existingSources: [],
  lessonInputData: {
    description: 'Una lezione sui messaggi.',
    imageCandidates: [],
    instructionPacks: [],
    language: 'Italiano',
    pedagogicalContext: '',
    previousLessonTitles: [],
    sectionTitle: 'Comunicazioni a messaggi',
    sourceContext: 'Contenuto originale',
  },
  originalSources: [],
  request: {
    forceRegenerate: true,
    projectId: 'project-1',
    sectionId: 'lesson-1',
    userId: 'user-1',
  },
  requiresCoverageAssessment: false,
  sourceFingerprint: buildLessonGenerationSourceFingerprint(project, 'lesson-1'),
  stage: 'coverage',
  targetFingerprint: buildLessonGenerationTargetFingerprint(project, 'lesson-1'),
  warnings: [],
  youtubePlanning: { courseTitle: 'Corso', keyConcepts: [] },
});

const extractedImage: LessonPdfImageAsset = {
  dataUrl: 'data:image/png;base64,aW1hZ2U=',
  id: 'pdf-img-1',
  intrinsicHeight: 600,
  intrinsicWidth: 800,
  mimeType: 'image/png',
  pageNumber: 4,
  sizeBytes: 5,
  sourceOrder: 1,
  textAfter: 'Il messaggio viene ricevuto.',
  textBefore: 'Il messaggio viene inviato.',
};

const storedAsset: ProjectAssetRef = {
  byteSize: 5,
  hash: 'b'.repeat(64),
  id: 'c'.repeat(64),
  mediaType: 'image/png',
};

const withStoredPdfSourceVersion = (
  snapshot: ProjectSnapshot,
  sourceHash: string
): ProjectSnapshot => {
  const file = {
    data: '',
    mimeType: 'application/pdf',
    name: 'stable-source.pdf',
    sourceId: 'stable-source',
  };
  return {
    ...structuredClone(snapshot),
    source: {
      file,
      kind: 'pdf',
      ref: {
        byteSize: 100,
        hash: sourceHash,
        id: 'stable-source',
        mimeType: file.mimeType,
        name: file.name,
        objectPath: `users/user-1/projects/project-1/stable-source/${sourceHash}/original`,
      },
      sources: [
        {
          file,
          hash: sourceHash,
          id: 'stable-source',
          kind: 'pdf',
          name: file.name,
          outline: [],
          outlineOrigin: 'none',
          position: 0,
          status: 'ready',
        },
      ],
    },
  };
};

const immediateProviderEffect: WorkflowProviderEffectExecutor = {
  run: async ({ operation, outputSchema }) => outputSchema.parse(await operation()),
};

const createMemoryProviderEffect = () => {
  const results = new Map<string, unknown>();
  const keys: string[] = [];
  const executor: WorkflowProviderEffectExecutor = {
    run: async ({ key, operation, outputSchema }) => {
      keys.push(key);
      const existing = results.get(key);
      if (existing !== undefined) return outputSchema.parse(existing);
      const output = snapshotImmutableJson(outputSchema.parse(await operation()));
      results.set(key, output);
      return outputSchema.parse(output);
    },
  };
  return { executor, keys, results };
};

describe('durable lesson document stage', () => {
  test('passes detached PDF bytes and mapped pages to production extraction', async () => {
    const store = new InMemoryProjectStore();
    await store.saveProject('user-1', {
      ...project,
      documentIndex: {
        chunks: [
          {
            id: 'chunk-1',
            pageEnd: 4,
            pageStart: 3,
            text: 'Contenuto della lezione.',
          },
        ],
        kind: 'pdf-text-index',
      },
      learningPlan: {
        modules: [
          {
            children: [
              {
                description: 'Una lezione sui messaggi.',
                id: 'lesson-1',
                kind: 'lesson',
                primaryChunkIds: ['chunk-1'],
                title: 'Comunicazioni a messaggi',
              },
            ],
            id: 'module-1',
            title: 'Modulo',
          },
        ],
      },
      source: {
        file: {
          data: Buffer.from('pdf bytes for the durable workflow test').toString('base64'),
          mimeType: 'application/pdf',
          name: 'messaggi.pdf',
        },
        kind: 'pdf',
      },
    });
    const detachedProject = await store.loadProject('user-1', 'project-1');
    const section = detachedProject?.learningPlan?.modules?.[0]?.children?.[0];
    if (!detachedProject || !section) throw new Error('Missing detached PDF fixture.');
    const extractImages = vi.fn().mockResolvedValue({
      failedPages: [4],
      images: [
        {
          dataUrl: extractedImage.dataUrl,
          hash: '1234567890abcdef1234567890abcdef',
          id: 'raw-image',
          mimeType: 'image/png',
          pageNumber: 3,
          sizeBytes: 5,
          textAfter: extractedImage.textAfter,
          textBefore: extractedImage.textBefore,
        },
      ],
    });

    const images = await extractStoredPdfImageAssets({
      extractImages,
      project: detachedProject,
      section,
      signal: new AbortController().signal,
      store,
      userId: 'user-1',
    });

    expect(extractImages).toHaveBeenCalledWith(
      expect.stringMatching(/^data:application\/pdf;base64,/u),
      36,
      [3, 4],
      expect.any(AbortSignal)
    );
    expect(images).toEqual({
      assets: [
        expect.objectContaining({
          id: expect.stringMatching(/^pdf-img-[a-f0-9]{64}$/u),
          pageNumber: 3,
          sourceHash: buildSha256HexDigest(Buffer.from('pdf bytes for the durable workflow test')),
          sourceId: `source-${buildSha256HexDigest(
            Buffer.from('pdf bytes for the durable workflow test')
          ).slice(0, 24)}`,
        }),
      ],
      warnings: [
        expect.objectContaining({
          code: 'lesson_pdf_image_extraction_incomplete',
          pageNumber: 4,
          stage: 'sources',
        }),
      ],
    });
  });

  test('versions image metadata when a stored source is replaced', async () => {
    const extractVersion = async (sourceBytes: string) => {
      const store = new InMemoryProjectStore();
      const file = {
        data: Buffer.from(sourceBytes).toString('base64'),
        mimeType: 'application/pdf',
        name: 'stable-source.pdf',
      };
      await store.saveProject('user-1', {
        ...project,
        source: {
          file,
          kind: 'pdf',
          sources: [
            {
              file,
              hash: 'placeholder',
              id: 'stable-source',
              kind: 'pdf',
              name: file.name,
              outline: [],
              outlineOrigin: 'none',
              position: 0,
              status: 'ready',
            },
          ],
        },
      });
      const detachedProject = await store.loadProject('user-1', 'project-1');
      const section = detachedProject?.learningPlan?.modules?.[0]?.children?.[0];
      if (!detachedProject || !section) throw new Error('Missing revised source fixture.');
      return extractStoredPdfImageAssets({
        extractImages: vi.fn().mockResolvedValue({
          failedPages: [],
          images: [
            {
              dataUrl: extractedImage.dataUrl,
              hash: 'same-image-hash',
              id: 'raw-image',
              mimeType: 'image/png',
              pageNumber: 3,
              sizeBytes: 5,
              textAfter: extractedImage.textAfter,
              textBefore: extractedImage.textBefore,
            },
          ],
        }),
        project: detachedProject,
        section,
        signal: new AbortController().signal,
        store,
        userId: 'user-1',
      });
    };

    const original = await extractVersion('original PDF bytes');
    const revised = await extractVersion('revised PDF bytes');

    expect(original.assets[0]?.sourceId).toBe('stable-source');
    expect(revised.assets[0]?.sourceId).toBe('stable-source');
    expect(original.assets[0]?.sourceHash).not.toBe(revised.assets[0]?.sourceHash);
    expect(original.assets[0]?.id).not.toBe(revised.assets[0]?.id);
  });

  test('scopes mapped PDF pages to their source in multi-document courses', async () => {
    const store = new InMemoryProjectStore();
    await store.saveProject('user-1', {
      ...project,
      documentIndex: {
        chunks: [
          {
            id: 'source-a:chunk-1',
            pageEnd: 3,
            pageStart: 2,
            sourceId: 'source-a',
            text: 'Contenuto della fonte A.',
          },
          {
            id: 'source-b:chunk-1',
            pageEnd: 8,
            pageStart: 8,
            sourceId: 'source-b',
            text: 'Contenuto della fonte B.',
          },
        ],
        kind: 'pdf-text-index',
      },
      learningPlan: {
        modules: [
          {
            children: [
              {
                description: 'Una lezione basata su due fonti.',
                id: 'lesson-1',
                kind: 'lesson',
                sourceReferences: [
                  { chunkIds: ['source-a:chunk-1'], sourceId: 'source-a' },
                  { chunkIds: ['source-b:chunk-1'], sourceId: 'source-b' },
                ],
                title: 'Confronto tra fonti',
              },
            ],
            id: 'module-1',
            title: 'Modulo',
          },
        ],
      },
      source: {
        file: {
          data: Buffer.from('pdf bytes source A').toString('base64'),
          mimeType: 'application/pdf',
          name: 'source-a.pdf',
        },
        kind: 'pdf',
        sources: [
          {
            file: {
              data: Buffer.from('pdf bytes source A').toString('base64'),
              mimeType: 'application/pdf',
              name: 'source-a.pdf',
            },
            hash: 'a'.repeat(64),
            id: 'source-a',
            kind: 'pdf',
            name: 'source-a.pdf',
            outline: [],
            outlineOrigin: 'none',
            position: 0,
            status: 'ready',
          },
          {
            file: {
              data: Buffer.from('pdf bytes source B').toString('base64'),
              mimeType: 'application/pdf',
              name: 'source-b.pdf',
            },
            hash: 'b'.repeat(64),
            id: 'source-b',
            kind: 'pdf',
            name: 'source-b.pdf',
            outline: [],
            outlineOrigin: 'none',
            position: 1,
            status: 'ready',
          },
        ],
      },
    });
    const detachedProject = await store.loadProject('user-1', 'project-1');
    const section = detachedProject?.learningPlan?.modules?.[0]?.children?.[0];
    if (!detachedProject || !section) throw new Error('Missing multi-source PDF fixture.');
    const extractImages = vi.fn().mockResolvedValue({
      failedPages: [],
      images: [
        {
          dataUrl: extractedImage.dataUrl,
          hash: '1234567890abcdef1234567890abcdef',
          id: 'raw-image',
          mimeType: 'image/png',
          pageNumber: 3,
          sizeBytes: 5,
          textAfter: extractedImage.textAfter,
          textBefore: extractedImage.textBefore,
        },
      ],
    });

    const images = await extractStoredPdfImageAssets({
      extractImages,
      project: detachedProject,
      section,
      signal: new AbortController().signal,
      store,
      userId: 'user-1',
    });

    expect(extractImages).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^data:application\/pdf;base64,/u),
      36,
      [2, 3],
      expect.any(AbortSignal)
    );
    expect(extractImages).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^data:application\/pdf;base64,/u),
      36,
      [8],
      expect.any(AbortSignal)
    );
    expect(images.assets).toEqual([
      expect.objectContaining({ sourceId: 'source-a' }),
      expect.objectContaining({ sourceId: 'source-b' }),
    ]);
    expect(new Set(images.assets.map(image => image.id)).size).toBe(2);
  });

  test('rejects when every stored PDF source fails image extraction', async () => {
    const store = new InMemoryProjectStore();
    await store.saveProject('user-1', {
      ...project,
      source: {
        file: {
          data: Buffer.from('pdf bytes').toString('base64'),
          mimeType: 'application/pdf',
          name: 'messaggi.pdf',
        },
        kind: 'pdf',
      },
    });
    const detachedProject = await store.loadProject('user-1', 'project-1');
    const section = detachedProject?.learningPlan?.modules?.[0]?.children?.[0];
    if (!detachedProject || !section) throw new Error('Missing detached PDF fixture.');

    const failure = await extractStoredPdfImageAssets({
      extractImages: vi.fn().mockRejectedValue(new Error('parser unavailable')),
      project: detachedProject,
      section,
      signal: new AbortController().signal,
      store,
      userId: 'user-1',
    }).catch(error => error);

    expect(failure).toMatchObject({
      code: 'lesson_pdf_image_extraction_failed',
      name: 'LessonPdfImageExtractionError',
    });
  });

  test('stages PDF bytes and checkpoints only durable metadata', async () => {
    const captionImage = vi.fn().mockResolvedValue('Schema dei messaggi');
    const stage = vi.fn().mockResolvedValue(storedAsset);
    const providerEffect = createMemoryProviderEffect();
    const run = createLessonDocumentSourceStage({
      assets: { stage },
      captionImage,
      extractImages: vi.fn().mockResolvedValue({
        assets: [extractedImage],
        warnings: [
          {
            code: 'lesson_pdf_image_extraction_incomplete',
            pageNumber: 4,
            sourceId: 'source-1',
            stage: 'sources',
          },
        ],
      }),
      loadProject: vi.fn().mockResolvedValue(project),
    });

    const signal = new AbortController().signal;
    const output = await run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'root/stage-document-sources', runId: 'run-1' },
      idempotencyKey: 'stage-documents-key',
      input,
      providerEffect: providerEffect.executor,
      retryFeedback: '',
      signal,
    });

    expect(stage).toHaveBeenCalledWith({
      bytes: new Uint8Array(Buffer.from('image')),
      idempotencyKey: JSON.stringify([
        'lesson-pdf-image',
        'stage-documents-key',
        buildSha256HexDigest(Buffer.from('image')),
        'image/png',
      ]),
      mediaType: 'image/png',
      nodeInstanceId: 'root/stage-document-sources',
      projectId: 'project-1',
      runId: 'run-1',
      signal,
      userId: 'user-1',
    });
    expect(captionImage).toHaveBeenCalledOnce();
    expect(output.pdfImages).toEqual([
      expect.objectContaining({ asset: storedAsset, id: 'pdf-img-1', pageNumber: 4 }),
    ]);
    expect(output.documentAssetOwners).toEqual([
      { assetIds: [storedAsset.id], nodeInstanceId: 'root/stage-document-sources' },
    ]);
    expect(output.lessonInputData.imageCandidates).toEqual([
      expect.objectContaining({ id: 'pdf-img-1', sizeBytes: 5 }),
    ]);
    expect(output.warnings).toEqual([
      {
        code: 'lesson_pdf_image_extraction_incomplete',
        pageNumber: 4,
        sourceId: 'source-1',
        stage: 'sources',
      },
    ]);
    expect(JSON.stringify(output)).not.toContain('aW1hZ2U=');
    expect(JSON.stringify(output)).not.toContain('data:image');
    expect(providerEffect.keys).toEqual(['extract-images-assets-v2']);
    expect(JSON.stringify([...providerEffect.results.values()])).not.toContain('data:image');
  });

  test('reuses durable bytes without losing a second source association', async () => {
    const multiSourceProject = structuredClone(project);
    const lesson = multiSourceProject.learningPlan?.modules?.[0]?.children?.[0];
    if (!lesson) throw new Error('Missing test lesson.');
    lesson.sourceReferences = [{ sourceId: 'source-b' }];
    multiSourceProject.source = {
      kind: 'document',
      sources: [{ id: 'source-a' }, { id: 'source-b' }],
    };
    const imageAsset = {
      ...storedAsset,
      hash: buildSha256HexDigest(Buffer.from('image')),
    };
    multiSourceProject.documentAssets = {
      imageCount: 1,
      kind: 'pdf',
      usedImages: [
        {
          asset: imageAsset,
          id: 'pdf-img-existing-source-a',
          pageNumber: 4,
          sourceId: 'source-a',
          sourceOrder: 1,
          textAfter: '',
          textBefore: '',
        },
      ],
    };
    const scopedInput = LessonCoverageStateSchema.parse({
      ...input,
      sourceFingerprint: buildLessonGenerationSourceFingerprint(multiSourceProject, 'lesson-1'),
    });
    const stage = vi.fn().mockResolvedValue(imageAsset);
    const captionImage = vi.fn().mockResolvedValue('Immagine della fonte B');
    const run = createLessonDocumentSourceStage({
      assets: { stage },
      captionImage,
      extractImages: vi.fn().mockResolvedValue({
        assets: [
          {
            ...extractedImage,
            id: 'pdf-img-source-b',
            sourceId: 'source-b',
          },
        ],
        warnings: [],
      }),
      loadProject: vi.fn().mockResolvedValue(multiSourceProject),
    });

    const output = await run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'stage', runId: 'run-1' },
      idempotencyKey: 'reuse-key',
      input: scopedInput,
      providerEffect: immediateProviderEffect,
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    expect(stage).not.toHaveBeenCalled();
    expect(captionImage).toHaveBeenCalledOnce();
    expect(output.pdfImages).toEqual([
      expect.objectContaining({
        asset: imageAsset,
        id: 'pdf-img-source-b',
        sourceId: 'source-b',
      }),
    ]);
    expect(output.documentAssetOwners).toEqual([]);
  });

  test('stages shared bytes once while keeping metadata for both sources', async () => {
    const stage = vi.fn().mockResolvedValue(storedAsset);
    const captionImage = vi.fn().mockResolvedValue('Immagine condivisa');
    const run = createLessonDocumentSourceStage({
      assets: { stage },
      captionImage,
      extractImages: vi.fn().mockResolvedValue({
        assets: ['source-a', 'source-b'].map((sourceId, index) => ({
          ...extractedImage,
          id: `pdf-img-${sourceId}`,
          sourceId,
          sourceOrder: index + 1,
        })),
        warnings: [],
      }),
      loadProject: vi.fn().mockResolvedValue(project),
    });

    const output = await run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'stage', runId: 'run-1' },
      idempotencyKey: 'shared-bytes-key',
      input,
      providerEffect: immediateProviderEffect,
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    expect(stage).toHaveBeenCalledOnce();
    expect(captionImage).toHaveBeenCalledTimes(2);
    expect(output.pdfImages.map(image => image.sourceId)).toEqual(['source-a', 'source-b']);
    expect(output.documentAssetOwners).toEqual([
      { assetIds: [storedAsset.id], nodeInstanceId: 'stage' },
    ]);
  });

  test('refreshes metadata for a revised source while reusing durable bytes', async () => {
    const revisedProject = withStoredPdfSourceVersion(project, 'b'.repeat(64));
    const imageAsset = {
      ...storedAsset,
      hash: buildSha256HexDigest(Buffer.from('image')),
    };
    revisedProject.documentAssets = {
      imageCount: 1,
      kind: 'pdf',
      usedImages: [
        {
          asset: imageAsset,
          caption: 'Old caption',
          id: 'pdf-img-old-version',
          pageNumber: 2,
          sourceId: 'stable-source',
          sourceOrder: 1,
          textAfter: 'Old after',
          textBefore: 'Old before',
        },
      ],
    };
    const revisedInput = LessonCoverageStateSchema.parse({
      ...input,
      sourceFingerprint: buildLessonGenerationSourceFingerprint(revisedProject, 'lesson-1'),
    });
    const stage = vi.fn().mockResolvedValue(imageAsset);
    const captionImage = vi.fn().mockResolvedValue('New caption');
    const run = createLessonDocumentSourceStage({
      assets: { stage },
      captionImage,
      extractImages: vi.fn().mockResolvedValue({
        assets: [
          {
            ...extractedImage,
            id: 'pdf-img-new-version',
            pageNumber: 6,
            sourceHash: 'b'.repeat(64),
            sourceId: 'stable-source',
            textAfter: 'New after',
            textBefore: 'New before',
          },
        ],
        warnings: [],
      }),
      loadProject: vi.fn().mockResolvedValue(revisedProject),
    });

    const output = await run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'stage', runId: 'run-1' },
      idempotencyKey: 'revised-source-key',
      input: revisedInput,
      providerEffect: immediateProviderEffect,
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    expect(stage).not.toHaveBeenCalled();
    expect(captionImage).toHaveBeenCalledOnce();
    expect(output.pdfImages).toEqual([
      expect.objectContaining({
        asset: imageAsset,
        caption: 'New caption',
        id: 'pdf-img-new-version',
        pageNumber: 6,
        sourceHash: 'b'.repeat(64),
        sourceId: 'stable-source',
        textBefore: 'New before',
      }),
    ]);
    expect(output.documentAssetOwners).toEqual([]);
  });

  test('keeps fresh placement metadata for unchanged bytes in the same source version', async () => {
    const currentProject = withStoredPdfSourceVersion(project, 'b'.repeat(64));
    const imageAsset = {
      ...storedAsset,
      hash: buildSha256HexDigest(Buffer.from('image')),
    };
    currentProject.documentAssets = {
      imageCount: 1,
      kind: 'pdf',
      usedImages: [
        {
          asset: imageAsset,
          caption: 'Page 2 caption',
          id: 'pdf-img-same-version',
          pageNumber: 2,
          sourceHash: 'b'.repeat(64),
          sourceId: 'stable-source',
          sourceOrder: 1,
          textAfter: 'Page 2 after',
          textBefore: 'Page 2 before',
        },
      ],
    };
    const currentInput = LessonCoverageStateSchema.parse({
      ...input,
      sourceFingerprint: buildLessonGenerationSourceFingerprint(currentProject, 'lesson-1'),
    });
    const captionImage = vi.fn().mockResolvedValue('Page 8 caption');
    const run = createLessonDocumentSourceStage({
      assets: { stage: vi.fn() },
      captionImage,
      extractImages: vi.fn().mockResolvedValue({
        assets: [
          {
            ...extractedImage,
            id: 'pdf-img-same-version',
            pageNumber: 8,
            sourceHash: 'b'.repeat(64),
            sourceId: 'stable-source',
            textAfter: 'Page 8 after',
            textBefore: 'Page 8 before',
          },
        ],
        warnings: [],
      }),
      loadProject: vi.fn().mockResolvedValue(currentProject),
    });

    const output = await run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'stage', runId: 'run-1' },
      idempotencyKey: 'same-version-placement-key',
      input: currentInput,
      providerEffect: immediateProviderEffect,
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    expect(captionImage).toHaveBeenCalledOnce();
    expect(output.pdfImages).toEqual([
      expect.objectContaining({
        asset: imageAsset,
        caption: 'Page 8 caption',
        id: 'pdf-img-same-version',
        pageNumber: 8,
        textBefore: 'Page 8 before',
      }),
    ]);
  });

  test('excludes metadata for images removed from a revised source', async () => {
    const revisedProject = withStoredPdfSourceVersion(project, 'b'.repeat(64));
    revisedProject.documentAssets = {
      imageCount: 1,
      kind: 'pdf',
      usedImages: [
        {
          asset: storedAsset,
          caption: 'Removed image caption',
          id: 'pdf-img-removed-version',
          pageNumber: 2,
          sourceHash: 'a'.repeat(64),
          sourceId: 'stable-source',
          sourceOrder: 1,
          textAfter: 'Removed after',
          textBefore: 'Removed before',
        },
      ],
    };
    const revisedInput = LessonCoverageStateSchema.parse({
      ...input,
      sourceFingerprint: buildLessonGenerationSourceFingerprint(revisedProject, 'lesson-1'),
    });
    const stage = vi.fn();
    const captionImage = vi.fn();
    const run = createLessonDocumentSourceStage({
      assets: { stage },
      captionImage,
      extractImages: vi.fn().mockResolvedValue({ assets: [], warnings: [] }),
      loadProject: vi.fn().mockResolvedValue(revisedProject),
    });

    const output = await run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'stage', runId: 'run-1' },
      idempotencyKey: 'removed-source-image-key',
      input: revisedInput,
      providerEffect: immediateProviderEffect,
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    expect(stage).not.toHaveBeenCalled();
    expect(captionImage).not.toHaveBeenCalled();
    expect(output.pdfImages).toEqual([]);
    expect(output.lessonInputData.imageCandidates).toEqual([]);
  });

  test('excludes legacy filename associations outside current source authority', async () => {
    const revisedProject = withStoredPdfSourceVersion(project, 'b'.repeat(64));
    revisedProject.documentAssets = {
      imageCount: 1,
      kind: 'pdf',
      usedImages: [
        {
          asset: storedAsset,
          caption: 'Removed legacy caption',
          id: 'pdf-img-legacy-filename',
          pageNumber: 2,
          sourceId: 'stable-source.pdf',
          sourceOrder: 1,
          textAfter: 'Removed after',
          textBefore: 'Removed before',
        },
      ],
    };
    const revisedInput = LessonCoverageStateSchema.parse({
      ...input,
      sourceFingerprint: buildLessonGenerationSourceFingerprint(revisedProject, 'lesson-1'),
    });
    const run = createLessonDocumentSourceStage({
      assets: { stage: vi.fn() },
      captionImage: vi.fn(),
      extractImages: vi.fn().mockResolvedValue({ assets: [], warnings: [] }),
      loadProject: vi.fn().mockResolvedValue(revisedProject),
    });

    const output = await run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'stage', runId: 'run-1' },
      idempotencyKey: 'legacy-filename-image-key',
      input: revisedInput,
      providerEffect: immediateProviderEffect,
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    expect(output.pdfImages).toEqual([]);
    expect(output.lessonInputData.imageCandidates).toEqual([]);
  });

  test('excludes anonymous durable metadata after an authoritative source replacement', async () => {
    const revisedProject = withStoredPdfSourceVersion(project, 'b'.repeat(64));
    revisedProject.documentAssets = {
      imageCount: 1,
      kind: 'pdf',
      usedImages: [
        {
          asset: storedAsset,
          caption: 'Removed anonymous caption',
          id: 'pdf-img-anonymous-old-source',
          pageNumber: 2,
          sourceOrder: 1,
          textAfter: 'Removed after',
          textBefore: 'Removed before',
        },
      ],
    };
    const revisedInput = LessonCoverageStateSchema.parse({
      ...input,
      sourceFingerprint: buildLessonGenerationSourceFingerprint(revisedProject, 'lesson-1'),
    });
    const stage = vi.fn();
    const run = createLessonDocumentSourceStage({
      assets: { stage },
      captionImage: vi.fn(),
      extractImages: vi.fn().mockResolvedValue({ assets: [], warnings: [] }),
      loadProject: vi.fn().mockResolvedValue(revisedProject),
    });

    const output = await run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'stage', runId: 'run-1' },
      idempotencyKey: 'anonymous-replaced-image-key',
      input: revisedInput,
      providerEffect: immediateProviderEffect,
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    expect(stage).not.toHaveBeenCalled();
    expect(output.pdfImages).toEqual([]);
    expect(output.lessonInputData.imageCandidates).toEqual([]);
  });

  test('finishes one document source before captioning the next', async () => {
    let releaseSourceA: (() => void) | undefined;
    const sourceAReleased = new Promise<void>(resolve => {
      releaseSourceA = resolve;
    });
    const startedSources: Array<string | undefined> = [];
    const captionImage = vi
      .fn()
      .mockImplementation(async ({ image }: { image: LessonPdfImageAsset }) => {
        startedSources.push(image.sourceId);
        if (image.sourceId === 'source-a') await sourceAReleased;
        return `Caption ${image.sourceId}`;
      });
    const extracted = ['source-a', 'source-b'].flatMap((sourceId, sourceIndex) =>
      [0, 1].map(imageIndex => ({
        ...extractedImage,
        dataUrl: `data:image/png;base64,${Buffer.from(`${sourceId}-${imageIndex}`).toString('base64')}`,
        id: `pdf-img-${sourceId}-${imageIndex}`,
        sourceId,
        sourceOrder: sourceIndex * 2 + imageIndex + 1,
      }))
    );
    const run = createLessonDocumentSourceStage({
      assets: { stage: vi.fn().mockResolvedValue(storedAsset) },
      captionImage,
      extractImages: vi.fn().mockResolvedValue({ assets: extracted, warnings: [] }),
      loadProject: vi.fn().mockResolvedValue(project),
    });

    const output = run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'stage', runId: 'run-1' },
      idempotencyKey: 'caption-order-key',
      input,
      providerEffect: immediateProviderEffect,
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => expect(startedSources.length).toBeGreaterThanOrEqual(2));
    expect(startedSources).toEqual(['source-a', 'source-a']);
    releaseSourceA?.();
    await expect(output).resolves.toMatchObject({ stage: 'sources' });
    expect(startedSources).toEqual(['source-a', 'source-a', 'source-b', 'source-b']);
  });

  test('rejects a result prepared from stale source authority before extracting images', async () => {
    const changedProject = structuredClone(project);
    changedProject.source = { ref: { hash: 'd'.repeat(64) } };
    const extractImages = vi.fn();
    const run = createLessonDocumentSourceStage({
      assets: { stage: vi.fn() },
      captionImage: vi.fn().mockResolvedValue(null),
      extractImages,
      loadProject: vi.fn().mockResolvedValue(changedProject),
    });

    const failure = await run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'stage', runId: 'run-1' },
      idempotencyKey: 'key',
      input,
      providerEffect: immediateProviderEffect,
      retryFeedback: '',
      signal: new AbortController().signal,
    }).catch(error => error);

    expect(failure.failure).toEqual({
      code: 'lesson_source_authority_changed',
      kind: 'permanent',
      message: 'The lesson sources changed during generation.',
    });
    expect(extractImages).not.toHaveBeenCalled();
  });

  test('converts legacy PDF images and stages repeated bytes once', async () => {
    const legacyProject = structuredClone(project);
    legacyProject.documentAssets = {
      imageCount: 2,
      kind: 'pdf',
      usedImages: [
        {
          ...extractedImage,
          caption: 'Schema dei messaggi',
          id: 'legacy-image-a',
          sourceId: 'source-a',
        },
        { ...extractedImage, id: 'legacy-image-b', sourceId: 'source-b', sourceOrder: 2 },
      ],
    };
    const legacyInput = LessonCoverageStateSchema.parse({
      ...input,
      sourceFingerprint: buildLessonGenerationSourceFingerprint(legacyProject, 'lesson-1'),
    });
    const stage = vi.fn().mockResolvedValue(storedAsset);
    const run = createLessonDocumentSourceStage({
      assets: { stage },
      captionImage: vi.fn().mockResolvedValue(null),
      extractImages: vi.fn().mockResolvedValue({ assets: [], warnings: [] }),
      loadProject: vi.fn().mockResolvedValue(legacyProject),
    });

    const output = await run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'stage', runId: 'run-1' },
      idempotencyKey: 'legacy-key',
      input: legacyInput,
      providerEffect: immediateProviderEffect,
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    expect(stage).toHaveBeenCalledOnce();
    expect(output.pdfImages).toEqual([
      expect.objectContaining({ asset: storedAsset, id: 'legacy-image-a' }),
      expect.objectContaining({ asset: storedAsset, id: 'legacy-image-b' }),
    ]);
    expect(output.lessonInputData.imageCandidates).toEqual([
      expect.objectContaining({ id: 'legacy-image-a' }),
    ]);
    expect(JSON.stringify(output)).not.toContain('data:image');
  });

  test('prefers fresh versioned extraction over anonymous legacy metadata', async () => {
    const currentSourceHash = 'b'.repeat(64);
    const legacyProject = withStoredPdfSourceVersion(project, currentSourceHash);
    legacyProject.documentAssets = {
      imageCount: 1,
      kind: 'pdf',
      usedImages: [{ ...extractedImage, caption: 'Legacy caption', id: 'legacy-image' }],
    };
    const legacyInput = LessonCoverageStateSchema.parse({
      ...input,
      sourceFingerprint: buildLessonGenerationSourceFingerprint(legacyProject, 'lesson-1'),
    });
    const stage = vi.fn().mockResolvedValue(storedAsset);
    const run = createLessonDocumentSourceStage({
      assets: { stage },
      captionImage: vi.fn().mockResolvedValue('Fresh caption'),
      extractImages: vi.fn().mockResolvedValue({
        assets: [
          {
            ...extractedImage,
            id: 'fresh-image',
            sourceHash: currentSourceHash,
            sourceId: 'stable-source',
          },
        ],
        warnings: [],
      }),
      loadProject: vi.fn().mockResolvedValue(legacyProject),
    });

    const output = await run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'stage', runId: 'run-1' },
      idempotencyKey: 'legacy-refresh-key',
      input: legacyInput,
      providerEffect: immediateProviderEffect,
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    expect(stage).toHaveBeenCalledOnce();
    expect(output.pdfImages).toEqual([
      expect.objectContaining({
        caption: 'Fresh caption',
        id: 'fresh-image',
        sourceHash: currentSourceHash,
        sourceId: 'stable-source',
      }),
    ]);
  });

  test('reuses checkpointed extraction, captions and staged assets on retry', async () => {
    const captionImage = vi.fn().mockResolvedValue('Schema dei messaggi');
    const extractImages = vi.fn().mockResolvedValue({ assets: [extractedImage], warnings: [] });
    const stage = vi.fn().mockResolvedValue(storedAsset);
    const providerEffect = createMemoryProviderEffect();
    const run = createLessonDocumentSourceStage({
      assets: { stage },
      captionImage,
      extractImages,
      loadProject: vi.fn().mockResolvedValue(project),
    });
    const context = {
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'stage', runId: 'run-1' },
      idempotencyKey: 'retry-key',
      input,
      providerEffect: providerEffect.executor,
      retryFeedback: '',
      signal: new AbortController().signal,
    };

    await expect(run(context)).resolves.toMatchObject({ stage: 'sources' });
    await expect(run({ ...context, attemptNumber: 2 })).resolves.toMatchObject({
      stage: 'sources',
    });

    expect(extractImages).toHaveBeenCalledOnce();
    expect(captionImage).toHaveBeenCalledOnce();
    expect(stage).toHaveBeenCalledOnce();
    expect(providerEffect.keys).toEqual(['extract-images-assets-v2', 'extract-images-assets-v2']);
  });

  test('finishes asset staging before starting captions', async () => {
    let rejectSecondStage: ((reason?: unknown) => void) | undefined;
    const secondStage = new Promise<ProjectAssetRef>((_resolve, reject) => {
      rejectSecondStage = reject;
    });
    const secondImage = {
      ...extractedImage,
      dataUrl: 'data:image/png;base64,c2Vjb25kLWltYWdl',
      id: 'pdf-img-2',
      sourceOrder: 2,
    };
    const captionImage = vi.fn().mockResolvedValue('Caption');
    const extractImages = vi.fn().mockResolvedValue({
      assets: [extractedImage, secondImage],
      warnings: [],
    });
    const stage = vi
      .fn()
      .mockResolvedValueOnce(storedAsset)
      .mockReturnValueOnce(secondStage)
      .mockResolvedValue(storedAsset);
    const providerEffect = createMemoryProviderEffect();
    const run = createLessonDocumentSourceStage({
      assets: { stage },
      captionImage,
      extractImages,
      loadProject: vi.fn().mockResolvedValue(project),
    });
    const context = {
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'stage', runId: 'run-1' },
      idempotencyKey: 'staging-failure-key',
      input,
      providerEffect: providerEffect.executor,
      retryFeedback: '',
      signal: new AbortController().signal,
    };

    const firstAttempt = run(context);
    await vi.waitFor(() => expect(stage).toHaveBeenCalledTimes(2));
    expect(captionImage).not.toHaveBeenCalled();
    rejectSecondStage?.(new Error('asset storage unavailable'));
    await expect(firstAttempt).rejects.toThrow('asset storage unavailable');

    await expect(run({ ...context, attemptNumber: 2 })).resolves.toMatchObject({
      stage: 'sources',
    });
    expect(extractImages).toHaveBeenCalledTimes(2);
    expect(stage).toHaveBeenCalledTimes(4);
    expect(captionImage).toHaveBeenCalledTimes(2);
  });

  test('does not replay the pre-asset provider-effect payload under the durable schema', async () => {
    const providerEffect = createMemoryProviderEffect();
    providerEffect.results.set('extract-images', {
      assets: [extractedImage],
      warnings: [],
    });
    const extractImages = vi.fn().mockResolvedValue({ assets: [], warnings: [] });
    const run = createLessonDocumentSourceStage({
      assets: { stage: vi.fn() },
      captionImage: vi.fn(),
      extractImages,
      loadProject: vi.fn().mockResolvedValue(project),
    });

    await run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'stage', runId: 'run-1' },
      idempotencyKey: 'provider-payload-version-key',
      input,
      providerEffect: providerEffect.executor,
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    expect(extractImages).toHaveBeenCalledOnce();
    expect(providerEffect.keys).toEqual(['extract-images-assets-v2']);
  });

  test('ranks PDF images against mapped pages from their own source', async () => {
    const multiSourceProject = structuredClone(project);
    const lesson = multiSourceProject.learningPlan?.modules?.[0]?.children?.[0];
    if (!lesson) throw new Error('Missing test lesson.');
    lesson.sourceReferences = [
      { chunkIds: ['chunk-a'], sourceId: 'source-a' },
      { chunkIds: ['chunk-b'], sourceId: 'source-b' },
    ];
    multiSourceProject.documentIndex = {
      chunks: [
        { id: 'chunk-a', pageEnd: 2, pageStart: 2, sourceId: 'source-a', text: 'Fonte A' },
        { id: 'chunk-b', pageEnd: 8, pageStart: 8, sourceId: 'source-b', text: 'Fonte B' },
      ],
      kind: 'pdf-text-index',
    };
    multiSourceProject.source = {
      kind: 'document',
      sources: [{ id: 'source-a' }, { id: 'source-b' }, { id: 'source-c' }],
    };
    const sourceAAsset = { ...storedAsset, id: 'd'.repeat(64) };
    const wrongSourceAAsset = { ...storedAsset, id: 'e'.repeat(64) };
    const sourceBAsset = { ...storedAsset, id: 'f'.repeat(64) };
    const unselectedSourceAsset = { ...storedAsset, id: '1'.repeat(64) };
    multiSourceProject.documentAssets = {
      imageCount: 4,
      kind: 'pdf',
      usedImages: [
        {
          asset: sourceAAsset,
          caption: 'Figura generica',
          id: 'image-a-mapped',
          pageNumber: 2,
          sourceId: 'source-a',
          sourceOrder: 1,
          textAfter: '',
          textBefore: '',
        },
        {
          asset: wrongSourceAAsset,
          caption: 'Figura generica',
          id: 'image-a-unmapped',
          pageNumber: 7,
          sourceId: 'source-a',
          sourceOrder: 2,
          textAfter: '',
          textBefore: '',
        },
        {
          asset: sourceBAsset,
          caption: 'Figura generica',
          id: 'image-b-mapped',
          pageNumber: 8,
          sourceId: 'source-b',
          sourceOrder: 3,
          textAfter: '',
          textBefore: '',
        },
        {
          asset: unselectedSourceAsset,
          caption: 'Figura generica',
          id: 'image-c-unselected',
          pageNumber: 2,
          sourceId: 'source-c',
          sourceOrder: 4,
          textAfter: '',
          textBefore: '',
        },
      ],
    };
    const scopedInput = LessonCoverageStateSchema.parse({
      ...input,
      sourceFingerprint: buildLessonGenerationSourceFingerprint(multiSourceProject, 'lesson-1'),
    });
    const run = createLessonDocumentSourceStage({
      assets: { stage: vi.fn() },
      captionImage: vi.fn().mockResolvedValue(null),
      extractImages: vi.fn().mockResolvedValue({ assets: [], warnings: [] }),
      loadProject: vi.fn().mockResolvedValue(multiSourceProject),
    });

    const output = await run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'stage', runId: 'run-1' },
      idempotencyKey: 'scoped-key',
      input: scopedInput,
      providerEffect: immediateProviderEffect,
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    expect(output.pdfImages.map(image => image.id)).toEqual([
      'image-a-mapped',
      'image-a-unmapped',
      'image-b-mapped',
    ]);
    expect(output.lessonInputData.imageCandidates.map(image => image.id)).toEqual([
      'image-a-mapped',
      'image-b-mapped',
    ]);
  });

  test('does not mix anonymous legacy images across multiple document sources', async () => {
    const multiSourceProject = structuredClone(project);
    const lesson = multiSourceProject.learningPlan?.modules?.[0]?.children?.[0];
    if (!lesson) throw new Error('Missing test lesson.');
    lesson.sourceReferences = [{ sourceId: 'source-a' }];
    multiSourceProject.source = {
      kind: 'document',
      sources: [
        {
          file: { data: '', mimeType: 'application/pdf', name: 'a.pdf' },
          id: 'source-a',
        },
        {
          file: { data: '', mimeType: 'application/pdf', name: 'b.pdf' },
          id: 'source-b',
        },
      ],
    };
    multiSourceProject.documentAssets = {
      imageCount: 2,
      kind: 'pdf',
      usedImages: [
        {
          asset: { ...storedAsset, id: 'd'.repeat(64) },
          caption: 'Figura anonima A',
          id: 'legacy-image-a',
          pageNumber: 2,
          sourceOrder: 1,
          textAfter: '',
          textBefore: '',
        },
        {
          asset: { ...storedAsset, id: 'e'.repeat(64) },
          caption: 'Figura anonima B',
          id: 'legacy-image-b',
          pageNumber: 8,
          sourceOrder: 2,
          textAfter: '',
          textBefore: '',
        },
      ],
    };
    const scopedInput = LessonCoverageStateSchema.parse({
      ...input,
      sourceFingerprint: buildLessonGenerationSourceFingerprint(multiSourceProject, 'lesson-1'),
    });
    const run = createLessonDocumentSourceStage({
      assets: { stage: vi.fn() },
      captionImage: vi.fn().mockResolvedValue(null),
      extractImages: vi.fn().mockResolvedValue({ assets: [], warnings: [] }),
      loadProject: vi.fn().mockResolvedValue(multiSourceProject),
    });

    const output = await run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'stage', runId: 'run-1' },
      idempotencyKey: 'legacy-multi-source-key',
      input: scopedInput,
      providerEffect: immediateProviderEffect,
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    expect(output.pdfImages).toEqual([]);
    expect(output.lessonInputData.imageCandidates).toEqual([]);
  });
});
