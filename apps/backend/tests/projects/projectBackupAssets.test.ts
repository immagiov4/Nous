import { createHash } from 'node:crypto';

import {
  isProjectAssetId,
  isValidProjectAssetRef,
  normalizeProjectAssetMediaType,
  validateProjectAssetHtmlReferences,
} from '@shared/projectAsset';
import {
  buildImportedProjectAssetIdentity,
  collectProjectAssetReferences,
  InvalidProjectBackupAssetError,
  remapProjectAssetReferences,
} from '@shared/projectBackupAssets';
import { describe, expect, test } from 'vitest';

const imageRef = {
  byteSize: 3,
  hash: 'b'.repeat(64),
  id: 'a'.repeat(64),
  mediaType: 'image/png',
};
const embeddedRef = {
  byteSize: 4,
  hash: 'd'.repeat(64),
  id: 'c'.repeat(64),
  mediaType: 'image/webp',
};

const projectWithAssets = () => ({
  documentAssets: {
    kind: 'pdf',
    usedImages: [{ asset: embeddedRef, id: 'pdf-image' }],
  },
  learningPlan: {
    modules: [
      {
        children: [
          {
            generatedVisuals: [
              { render: { asset: imageRef, kind: 'image' } },
              {
                render: {
                  code: `<img src="{{PROJECT_ASSET:${embeddedRef.id}}}"><img src="{{PROJECT_ASSET:${embeddedRef.id}}}">`,
                  embeddedAssets: [embeddedRef],
                  kind: 'html',
                },
              },
              { render: { code: '<svg />', kind: 'svg' } },
            ],
          },
        ],
      },
    ],
    sections: [
      {
        generatedVisuals: [
          {
            render: {
              code: `<img src="{{PROJECT_ASSET:${embeddedRef.id}}}">`,
              embeddedAssets: [embeddedRef],
              kind: 'html',
            },
          },
        ],
      },
    ],
  },
});

const projectWithArtifactAnnotations = () => ({
  documentAssets: {
    usedImages: [{ id: 'image-1' }],
  },
  id: 'source-project',
  learningPlan: {
    modules: [
      {
        children: [
          {
            id: 'lesson-1',
            generatedVisuals: [{ id: 'visual-1' }],
            imageRefs: [{ assetId: 'image-1' }],
            annotations: [
              {
                anchor: { kind: 'lesson' },
                artifactRefs: [
                  {
                    artifactId: 'source-project:lesson-1:generated-visual:visual-1',
                    kind: 'generated-visual',
                    title: 'Generated visual',
                  },
                  {
                    artifactId: 'source-project:lesson-1:pdf-image:image-1',
                    kind: 'pdf-image',
                    title: 'PDF image',
                  },
                  {
                    artifactId: 'source-project:lesson-1:future-asset:asset-1',
                    kind: 'future-asset',
                    title: 'Future asset',
                  },
                  {
                    artifactId: 'source-project:lesson-2:generated-visual:visual-2',
                    kind: 'generated-visual',
                    title: 'Visual from another lesson',
                  },
                  {
                    artifactId: 'source-project-foreign:lesson-1:generated-visual:foreign-1',
                    kind: 'generated-visual',
                    title: 'Foreign project with shared prefix',
                  },
                  {
                    artifactId: 'source:lesson-1:pdf-image:foreign-2',
                    kind: 'pdf-image',
                    title: 'Foreign project that prefixes the source',
                  },
                  {
                    artifactId: 'removed-project:lesson-2:future-asset:foreign-3',
                    kind: 'future-asset',
                    title: 'Artifact from a removed project',
                  },
                ],
                id: 'annotation-1',
                note: 'Keep this note exactly as written.',
              },
            ],
          },
          { generatedVisuals: [{ id: 'visual-2' }], id: 'lesson-2' },
        ],
      },
    ],
  },
});

describe('project backup asset references', () => {
  test('shares one asset identity, reference, media type, and HTML placeholder contract', () => {
    expect(isProjectAssetId(imageRef.id)).toBe(true);
    expect(isProjectAssetId('../asset')).toBe(false);
    expect(isValidProjectAssetRef(imageRef)).toBe(true);
    expect(isValidProjectAssetRef({ ...imageRef, mediaType: '; charset=binary' })).toBe(false);
    expect(normalizeProjectAssetMediaType('IMAGE/PNG; charset=binary')).toBe('image/png');

    expect(
      validateProjectAssetHtmlReferences(`<img src="{{PROJECT_ASSET:${imageRef.id}}}">`, [imageRef])
    ).toMatchObject({ valid: true });
    expect(validateProjectAssetHtmlReferences('<p>No asset</p>', [imageRef])).toEqual({
      reason: 'placeholder-invalid',
      valid: false,
    });
    expect(
      validateProjectAssetHtmlReferences(`<img src="{{PROJECT_ASSET:${imageRef.id}}}">`, [
        { ...imageRef, hash: 'invalid' },
      ])
    ).toEqual({ reason: 'asset-reference-invalid', valid: false });
    expect(
      validateProjectAssetHtmlReferences(`<img src="{{PROJECT_ASSET:${imageRef.id}}}">`, [
        imageRef,
        { ...imageRef, byteSize: imageRef.byteSize + 1 },
      ])
    ).toEqual({ reason: 'asset-reference-invalid', valid: false });
  });

  test('collects generated, embedded HTML, and structured PDF assets once in stable order', () => {
    expect(collectProjectAssetReferences(projectWithAssets())).toEqual([imageRef, embeddedRef]);
  });

  test('returns no references for a project without a learning plan', () => {
    expect(collectProjectAssetReferences({ id: 'project-without-plan' })).toEqual([]);
  });

  test('remaps structured references and every exact HTML placeholder without changing inline visuals', () => {
    const nextImageId = 'e'.repeat(64);
    const nextEmbeddedId = 'f'.repeat(64);
    const remapped = remapProjectAssetReferences(
      projectWithAssets(),
      new Map([
        [imageRef.id, nextImageId],
        [embeddedRef.id, nextEmbeddedId],
      ])
    ) as ReturnType<typeof projectWithAssets>;

    const visuals = remapped.learningPlan.modules[0]?.children[0]?.generatedVisuals ?? [];
    expect(visuals[0]?.render).toMatchObject({ asset: { id: nextImageId }, kind: 'image' });
    expect(visuals[1]?.render).toMatchObject({
      embeddedAssets: [{ id: nextEmbeddedId }],
      kind: 'html',
    });
    expect((visuals[1]?.render as { code: string }).code).toBe(
      `<img src="{{PROJECT_ASSET:${nextEmbeddedId}}}"><img src="{{PROJECT_ASSET:${nextEmbeddedId}}}">`
    );
    expect(visuals[2]?.render).toEqual({ code: '<svg />', kind: 'svg' });
    expect(remapped.documentAssets.usedImages[0]?.asset.id).toBe(nextEmbeddedId);
    expect(
      projectWithAssets().learningPlan.modules[0]?.children[0]?.generatedVisuals[0]
    ).toMatchObject({ render: { asset: { id: imageRef.id } } });
  });

  test('remaps annotation artifact references when a project is imported under a new ID', () => {
    const source = projectWithArtifactAnnotations();
    const remapped = remapProjectAssetReferences(
      source,
      new Map(),
      'imported-project'
    ) as ReturnType<typeof projectWithArtifactAnnotations>;

    expect(remapped.id).toBe('imported-project');
    expect(remapped.learningPlan.modules[0]?.children[0]?.annotations[0]).toEqual({
      anchor: { kind: 'lesson' },
      artifactRefs: [
        {
          artifactId: 'imported-project:lesson-1:generated-visual:visual-1',
          kind: 'generated-visual',
          title: 'Generated visual',
        },
        {
          artifactId: 'imported-project:lesson-1:pdf-image:image-1',
          kind: 'pdf-image',
          title: 'PDF image',
        },
        {
          artifactId: 'source-project:lesson-1:future-asset:asset-1',
          kind: 'future-asset',
          title: 'Future asset',
        },
        {
          artifactId: 'imported-project:lesson-2:generated-visual:visual-2',
          kind: 'generated-visual',
          title: 'Visual from another lesson',
        },
        {
          artifactId: 'source-project-foreign:lesson-1:generated-visual:foreign-1',
          kind: 'generated-visual',
          title: 'Foreign project with shared prefix',
        },
        {
          artifactId: 'source:lesson-1:pdf-image:foreign-2',
          kind: 'pdf-image',
          title: 'Foreign project that prefixes the source',
        },
        {
          artifactId: 'removed-project:lesson-2:future-asset:foreign-3',
          kind: 'future-asset',
          title: 'Artifact from a removed project',
        },
      ],
      id: 'annotation-1',
      note: 'Keep this note exactly as written.',
    });
    expect(source).toEqual(projectWithArtifactAnnotations());
  });

  test('rejects a non-string target project ID with the backup validation error', () => {
    expect(() =>
      remapProjectAssetReferences(
        projectWithArtifactAnnotations(),
        new Map(),
        42 as unknown as string
      )
    ).toThrow(InvalidProjectBackupAssetError);

    expect(() =>
      remapProjectAssetReferences(projectWithArtifactAnnotations(), new Map(), ' imported-project ')
    ).toThrow(InvalidProjectBackupAssetError);
  });

  test('rejects ambiguous project and lesson scope IDs while allowing separators in artifact IDs', () => {
    const ambiguousProject = projectWithArtifactAnnotations();
    ambiguousProject.id = 'source:project';
    expect(() =>
      remapProjectAssetReferences(ambiguousProject, new Map(), 'imported-project')
    ).toThrow(InvalidProjectBackupAssetError);

    const ambiguousLesson = projectWithArtifactAnnotations();
    const lesson = ambiguousLesson.learningPlan.modules[0]?.children[0];
    if (lesson) lesson.id = 'lesson:1';
    expect(() =>
      remapProjectAssetReferences(ambiguousLesson, new Map(), 'imported-project')
    ).toThrow(InvalidProjectBackupAssetError);

    const source = projectWithArtifactAnnotations();
    const visual = source.learningPlan.modules[0]?.children[0]?.generatedVisuals[0];
    const artifactRef =
      source.learningPlan.modules[0]?.children[0]?.annotations[0]?.artifactRefs[0];
    if (visual && artifactRef) {
      visual.id = 'lesson-visual:run-id:slot-id';
      artifactRef.artifactId =
        'source-project:lesson-1:generated-visual:lesson-visual:run-id:slot-id';
    }
    const remapped = remapProjectAssetReferences(source, new Map(), 'imported-project');
    expect(
      remapped.learningPlan.modules[0]?.children[0]?.annotations[0]?.artifactRefs[0]?.artifactId
    ).toBe('imported-project:lesson-1:generated-visual:lesson-visual:run-id:slot-id');
  });

  test('remaps owned artifacts across many lessons without deriving namespaces from references', () => {
    const lessons = Array.from({ length: 48 }, (_, index) => ({
      annotations: [
        {
          artifactRefs: [
            {
              artifactId: `source-project:lesson-${index}:generated-visual:visual-${index}`,
              kind: 'generated-visual',
            },
          ],
        },
      ],
      generatedVisuals: [{ id: `visual-${index}` }],
      id: `lesson-${index}`,
    }));

    const remapped = remapProjectAssetReferences(
      { id: 'source-project', learningPlan: { sections: lessons } },
      new Map(),
      'imported-project'
    );

    expect(
      remapped.learningPlan.sections.map(
        lesson => lesson.annotations[0]?.artifactRefs[0]?.artifactId
      )
    ).toEqual(
      lessons.map((_, index) => `imported-project:lesson-${index}:generated-visual:visual-${index}`)
    );
  });

  test('rejects HTML whose declared assets and placeholders disagree', () => {
    const invalid = projectWithAssets();
    const visual = invalid.learningPlan.modules[0]?.children[0]?.generatedVisuals[1];
    if (visual?.render.kind === 'html') visual.render.code = '<p>No placeholder</p>';

    expect(() => collectProjectAssetReferences(invalid)).toThrow(
      'Project backup contains invalid asset references.'
    );
  });

  test('rejects malformed structured references instead of losing their assets', () => {
    const invalid = projectWithAssets();
    const visual = invalid.learningPlan.modules[0]?.children[0]?.generatedVisuals[0];
    if (visual?.render.kind === 'image') {
      visual.render.asset = { ...visual.render.asset, hash: 'invalid' };
    }

    expect(() => collectProjectAssetReferences(invalid)).toThrow(InvalidProjectBackupAssetError);
  });
});

describe('imported project asset identity', () => {
  test('is deterministic for one tenant and project and isolated across destinations', async () => {
    const input = {
      contentHash: imageRef.hash,
      projectId: 'project-1',
      sourceAssetId: imageRef.id,
      userId: '00000000-0000-4000-8000-000000000001',
    };
    const first = await buildImportedProjectAssetIdentity(input);
    const second = await buildImportedProjectAssetIdentity(input);
    const otherProject = await buildImportedProjectAssetIdentity({
      ...input,
      projectId: 'project-2',
    });
    const expectedId = createHash('sha256')
      .update(
        JSON.stringify([
          'project-asset-import-v1',
          input.userId,
          input.projectId,
          input.sourceAssetId,
          input.contentHash,
        ])
      )
      .digest('hex');

    expect(first).toEqual(second);
    expect(first.id).toBe(expectedId);
    expect(first.objectPath).toContain(`/archive/${expectedId}/${imageRef.hash}`);
    expect(otherProject.id).not.toBe(first.id);
  });
});
