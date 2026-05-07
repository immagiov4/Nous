import { describe, expect, test } from 'vitest';
import type { LearningPlan, ProjectSnapshot } from '../../../types.ts';
import {
  buildGeneratedVisualLearningArtifactPayload,
  collectLearningArtifactPayloads,
  filterLearningArtifactPayloads,
} from '../../../utils/learning/artifacts.ts';

const buildSnapshot = (learningPlan: LearningPlan): ProjectSnapshot => ({
  id: 'project-1',
  version: '4.1',
  sourceKind: 'document',
  state: 'READING',
  source: null,
  learningPlan,
  laboratory: null,
  isLearnMode: false,
  userProfile: null,
  syllabus: [],
  activeSectionId: 'lesson-1',
  activeLaboratoryExerciseId: null,
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

  test('normalizes generated visuals and PDF images into stable render payloads', () => {
    const snapshot = buildSnapshot({
      title: 'Basi di dati',
      summary: 'Database relazionali',
      sections: [
        {
          id: 'lesson-1',
          title: 'Modello relazionale',
          description: 'Relazioni e vincoli',
          isCompleted: true,
          type: 'core',
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
        },
        {
          id: 'lesson-2',
          title: 'Normalizzazione',
          description: 'Dipendenze funzionali',
          isCompleted: false,
          type: 'core',
          content: 'Seconda lezione',
          imageRefs: [{ assetId: 'pdf-img-2', alt: 'Dipendenze funzionali' }],
          generatedVisuals: [
            {
              id: 'visual-2',
              title: 'simulatore_chiusura',
              kind: 'html',
              code: '<style></style><div>Simulazione</div><script></script>',
              createdAt: '2026-05-01T11:00:00.000Z',
            },
          ],
        },
      ],
    });

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

  test('filters artifacts by lesson and searchable visual or image context', () => {
    const snapshot = buildSnapshot({
      title: 'Basi di dati',
      summary: 'Database relazionali',
      sections: [
        {
          id: 'lesson-1',
          title: 'Modello relazionale',
          description: 'Relazioni e vincoli',
          isCompleted: true,
          type: 'core',
          content: 'Lezione su entita e relazioni',
          imageRefs: [{ assetId: 'pdf-img-1', alt: 'Schema ER', caption: 'Schema ER' }],
        },
        {
          id: 'lesson-2',
          title: 'Normalizzazione',
          description: 'Dipendenze funzionali',
          isCompleted: false,
          type: 'core',
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
        },
      ],
    });

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
});
