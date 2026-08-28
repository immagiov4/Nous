import { describe, expect, test } from 'vitest';
import type { LearningPlan, ProjectSnapshot } from '../../../types.ts';
import {
  buildGeneratedVisualLearningArtifactPayload,
  collectLearningArtifactPayloads,
  filterLearningArtifactPayloads,
  replaceGeneratedVisualPreservingId,
} from '../../../utils/learning/artifacts.ts';
import { buildTestLearningPlan, buildTestLesson } from '../../helpers/learningPlan.ts';

const buildSnapshot = (learningPlan: LearningPlan): ProjectSnapshot => ({
  id: 'project-1',
  version: '4.1',
  sourceKind: 'document',
  state: 'READING',
  source: null,
  learningPlan,
  isLearnMode: false,
  userProfile: null,
  syllabus: [],
  activeSectionId: 'lesson-1',
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-01T09:00:00.000Z',
  lastOpenedAt: '2026-05-01T09:00:00.000Z',
  documentAssets: {
    kind: 'pdf',
    parsedAt: '2026-05-01T09:00:00.000Z',
    imageCount: 2,
    usedImages: [
      {
        id: 'pdf-img-2',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,two',
        caption: 'Grafico delle dipendenze funzionali',
        textBefore: 'Prima del grafico',
        textCurrent: 'Dipendenze funzionali e chiavi candidate',
        textAfter: 'Dopo il grafico',
        sourceOrder: 2,
        pageNumber: 8,
      },
      {
        id: 'pdf-img-1',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,one',
        caption: 'Schema entita relazione',
        textBefore: 'Prima dello schema',
        textCurrent: 'Entita relazione',
        textAfter: 'Dopo lo schema',
        sourceOrder: 1,
        pageNumber: 4,
      },
    ],
  },
});

describe('learning artifacts', () => {
  test('buildGeneratedVisualLearningArtifactPayload creates a render payload for generated drafts', () => {
    const payload = buildGeneratedVisualLearningArtifactPayload({
      lesson: {
        id: 'lesson-1',
        title: 'Comunicazione di massa',
        description: 'Modelli comunicativi',
        isCompleted: false,
        type: 'core',
        content: 'Emittente, messaggio, ricevente e feedback.',
      },
      projectId: 'project-1',
      projectTitle: 'Sociologia',
      visual: {
        id: 'visual-draft',
        title: 'circuito_comunicativo',
        kind: 'svg',
        code: '<svg viewBox="0 0 680 120"></svg>',
        createdAt: '2026-05-05T10:00:00.000Z',
      },
    });

    expect(payload.summary).toMatchObject({
      id: 'project-1:lesson-1:generated-visual:visual-draft',
      kind: 'generated-visual',
      lessonId: 'lesson-1',
      previewMode: 'thumbnail',
      projectId: 'project-1',
      title: 'circuito comunicativo',
    });
    expect(payload).toMatchObject({
      visual: expect.objectContaining({ id: 'visual-draft' }),
    });
  });

  test('indexes generated image alt text and labels the artifact as an image', () => {
    const payload = buildGeneratedVisualLearningArtifactPayload({
      lesson: {
        id: 'lesson-1',
        title: 'Anatomia della foglia',
        description: 'Strati e tessuti vegetali',
        isCompleted: false,
        type: 'core',
        content: 'Epidermide, mesofillo e nervature.',
      },
      projectId: 'project-1',
      projectTitle: 'Botanica',
      visual: {
        altText: 'Sezione trasversale di una foglia con i tessuti visibili',
        code: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
        createdAt: '2026-07-10T00:00:00.000Z',
        id: 'visual-image-1',
        kind: 'image',
        mediaType: 'image/png',
        title: 'sezione_foglia',
      },
    });

    expect(payload.summary).toMatchObject({
      previewMode: 'thumbnail',
      sourceLabel: 'Immagine',
    });
    expect(payload.searchText).toContain(
      'Sezione trasversale di una foglia con i tessuti visibili'
    );
  });
  test('normalizes generated visuals and PDF images into stable render payloads', () => {
    const snapshot = buildSnapshot(
      buildTestLearningPlan(
        [
          buildTestLesson({
            id: 'lesson-1',
            title: 'Modello relazionale',
            description: 'Relazioni e vincoli',
            isCompleted: true,
            content:
              'Intro\n\n{{PDF_IMAGE:pdf-img-1|alt=Schema ER|caption=Schema ER}}\n\n{{VISUAL_EXAMPLE:visual-1|title=mappa_relazioni}}',
            imageRefs: [{ assetId: 'pdf-img-1', alt: 'Schema ER', caption: 'Schema ER' }],
            generatedVisuals: [
              {
                id: 'visual-1',
                title: 'mappa_relazioni',
                kind: 'svg',
                code: '<svg viewBox="0 0 680 120"></svg>',
                createdAt: '2026-05-01T10:00:00.000Z',
              },
            ],
          }),
          buildTestLesson({
            id: 'lesson-2',
            title: 'Normalizzazione',
            description: 'Dipendenze funzionali',
            content: 'Seconda lezione',
            imageRefs: [{ assetId: 'pdf-img-2', alt: 'Dipendenze funzionali' }],
            generatedVisuals: [
              {
                altText: 'Simulatore della chiusura degli attributi',
                createdAt: '2026-05-01T11:00:00.000Z',
                id: 'visual-2',
                render: {
                  code: '<style></style><div>Simulazione</div><script></script>',
                  embeddedAssets: [],
                  kind: 'html',
                },
                slotId: 'slot-2',
                title: 'simulatore_chiusura',
              },
            ],
          }),
        ],
        {
          title: 'Basi di dati',
          summary: 'Database relazionali',
        }
      )
    );

    const artifacts = collectLearningArtifactPayloads({
      projectTitle: 'Basi di dati',
      snapshot,
    });

    expect(artifacts.map(artifact => artifact.summary.id)).toEqual([
      'project-1:lesson-1:pdf-image:pdf-img-1',
      'project-1:lesson-1:generated-visual:visual-1',
      'project-1:lesson-2:pdf-image:pdf-img-2',
      'project-1:lesson-2:generated-visual:visual-2',
    ]);
    expect(artifacts[0]).toMatchObject({
      image: expect.objectContaining({ id: 'pdf-img-1' }),
      summary: {
        kind: 'pdf-image',
        lessonTitle: 'Modello relazionale',
        previewMode: 'thumbnail',
        title: 'Schema ER',
      },
    });
    expect(artifacts[1]).toMatchObject({
      summary: {
        kind: 'generated-visual',
        previewMode: 'thumbnail',
        title: 'mappa relazioni',
      },
      visual: expect.objectContaining({ id: 'visual-1' }),
    });
    expect(artifacts[3]).toMatchObject({
      summary: {
        kind: 'generated-visual',
        previewMode: 'chip-only',
        title: 'simulatore chiusura',
      },
    });
  });

  test('ignores malformed placeholder options when ordering artifacts', () => {
    const snapshot = buildSnapshot(
      buildTestLearningPlan([
        buildTestLesson({
          id: 'lesson-1',
          title: 'Modello relazionale',
          description: 'Relazioni e vincoli',
          content: '{{PDF_IMAGE:pdf-img-2|foo=bar}}\n\nTesto della lezione.',
          imageRefs: [
            { assetId: 'pdf-img-2', alt: 'Dipendenze funzionali' },
            { assetId: 'pdf-img-1', alt: 'Schema ER' },
          ],
        }),
      ])
    );

    const artifacts = collectLearningArtifactPayloads({ snapshot });

    expect(artifacts.map(artifact => artifact.summary.id)).toEqual([
      'project-1:lesson-1:pdf-image:pdf-img-1',
      'project-1:lesson-1:pdf-image:pdf-img-2',
    ]);
  });

  test('orders artifacts from placeholders with padded IDs', () => {
    const snapshot = buildSnapshot(
      buildTestLearningPlan([
        buildTestLesson({
          id: 'lesson-1',
          title: 'Modello relazionale',
          description: 'Relazioni e vincoli',
          content: '{{PDF_IMAGE: pdf-img-2 }}\n\nTesto della lezione.',
          imageRefs: [
            { assetId: 'pdf-img-1', alt: 'Schema ER' },
            { assetId: 'pdf-img-2', alt: 'Dipendenze funzionali' },
          ],
        }),
      ])
    );

    const artifacts = collectLearningArtifactPayloads({ snapshot });

    expect(artifacts.map(artifact => artifact.summary.id)).toEqual([
      'project-1:lesson-1:pdf-image:pdf-img-2',
      'project-1:lesson-1:pdf-image:pdf-img-1',
    ]);
  });

  test('filters artifacts by lesson and searchable visual or image context', () => {
    const snapshot = buildSnapshot(
      buildTestLearningPlan(
        [
          buildTestLesson({
            id: 'lesson-1',
            title: 'Modello relazionale',
            description: 'Relazioni e vincoli',
            isCompleted: true,
            content: 'Lezione su entita e relazioni',
            imageRefs: [{ assetId: 'pdf-img-1', alt: 'Schema ER', caption: 'Schema ER' }],
          }),
          buildTestLesson({
            id: 'lesson-2',
            title: 'Normalizzazione',
            description: 'Dipendenze funzionali',
            content: 'Lezione su chiavi candidate',
            generatedVisuals: [
              {
                id: 'visual-2',
                title: 'simulatore_chiusura',
                kind: 'html',
                code: '<style></style><div>Simulazione</div><script></script>',
                createdAt: '2026-05-01T11:00:00.000Z',
              },
            ],
          }),
        ],
        {
          title: 'Basi di dati',
          summary: 'Database relazionali',
        }
      )
    );

    const artifacts = collectLearningArtifactPayloads({
      projectTitle: 'Basi di dati',
      snapshot,
    });

    expect(
      filterLearningArtifactPayloads(artifacts, {
        lessonIds: ['lesson-2'],
        query: 'chiavi candidate',
      }).map(artifact => artifact.summary.title)
    ).toEqual(['simulatore chiusura']);
    expect(
      filterLearningArtifactPayloads(artifacts, {
        query: 'schema entita',
      }).map(artifact => artifact.summary.title)
    ).toEqual(['Schema ER']);
  });

  test('replaces a legacy generated visual while preserving its referenced id and slot', () => {
    const nextVisuals = replaceGeneratedVisualPreservingId({
      artifactId: 'project-1:lesson-1:generated-visual:visual-1',
      contentBlocks: [
        { markdown: 'Contenuto della lezione.', type: 'markdown' },
        { slotId: 'lesson-slot-1', type: 'generated-visual', visualId: 'visual-1' },
      ],
      replacementVisual: {
        altText: 'Nuova mappa persistente',
        createdAt: '2026-05-02T10:00:00.000Z',
        id: 'visual-draft-9',
        render: {
          code: '<svg data-new="true"></svg>',
          kind: 'svg',
        },
        slotId: 'artifact-draft',
        title: 'mappa_nuova',
      },
      visuals: [
        {
          id: 'visual-1',
          title: 'mappa_vecchia',
          kind: 'svg',
          code: '<svg data-old="true"></svg>',
          createdAt: '2026-05-01T10:00:00.000Z',
        },
        {
          id: 'visual-2',
          title: 'altra_mappa',
          kind: 'html',
          code: '<div>Non toccare</div>',
          createdAt: '2026-05-01T11:00:00.000Z',
        },
      ],
    });

    expect(nextVisuals).toEqual([
      expect.objectContaining({
        id: 'visual-1',
        title: 'mappa_nuova',
        render: { code: '<svg data-new="true"></svg>', kind: 'svg' },
        slotId: 'lesson-slot-1',
      }),
      expect.objectContaining({
        id: 'visual-2',
        title: 'altra_mappa',
      }),
    ]);
  });
});
