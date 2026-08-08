// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useInitialSectionAutoOpen } from '../../app/useInitialSectionAutoOpen.ts';
import { createProjectSourceFromFile } from '../../services/projects/projectSource.ts';
import { AppState, type FileData, type PdfTextIndex } from '../../types.ts';
import { buildTestLearningPlan, buildTestLesson } from '../helpers/learningPlan.ts';

const pdfFile: FileData = {
  data: 'ZmFrZQ==',
  mimeType: 'application/pdf',
  name: 'dispensa.pdf',
};

const readyIndex: PdfTextIndex = {
  chunks: [
    {
      endOffset: 9,
      headingPath: ['Introduzione'],
      id: 'chunk-001',
      sequence: 0,
      startOffset: 0,
      text: 'Contenuto',
    },
  ],
  kind: 'pdf-text-index',
  parsedAt: '2026-08-01T10:00:00.000Z',
  sourceHash: 'hash-1',
};

test('waits for authoritative PDF hydration before opening the initial empty section', async () => {
  const activeSection = buildTestLesson({
    id: 'lesson-1',
    primaryChunkIds: ['chunk-001'],
  });
  const learningPlan = buildTestLearningPlan([activeSection], {
    generationNotes: 'Mantieni il percorso essenziale.',
  });
  const openSection = vi.fn(async () => 'loaded');
  const source = createProjectSourceFromFile(pdfFile);

  const { rerender } = renderHook(
    ({ documentIndex }: { documentIndex: PdfTextIndex | null }) =>
      useInitialSectionAutoOpen({
        activeSection,
        currentProjectId: 'project-1',
        documentIndex,
        isBlocking: false,
        learningPlan,
        openSection,
        screenState: AppState.READING,
        source,
      }),
    { initialProps: { documentIndex: null as PdfTextIndex | null } }
  );

  expect(openSection).not.toHaveBeenCalled();

  rerender({ documentIndex: readyIndex });

  await waitFor(() => expect(openSection).toHaveBeenCalledOnce());
  expect(openSection).toHaveBeenCalledWith(activeSection);
});
