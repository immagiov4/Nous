// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { useWorkspaceReaderState } from '../../../hooks/workspace/useWorkspaceReaderState.ts';
import { buildTestLesson } from '../../helpers/learningPlan.ts';

vi.mock('../../../hooks/reader/useReaderChrome.ts', () => ({ useReaderChrome: () => ({}) }));
vi.mock('../../../hooks/reader/useReaderContext.ts', () => ({ useReaderContext: () => ({}) }));
vi.mock('../../../hooks/reader/useReaderSpeech.ts', () => ({
  useReaderSpeechBlocks: () => ({ speechBlocks: [] }),
}));
vi.mock('../../../hooks/reader/useTtsPlayer.ts', () => ({
  useTtsPlayer: () => ({ audioState: {}, chunkTexts: [] }),
}));
vi.mock('../../../hooks/reader/useTtsTextPicker.ts', () => ({ useTtsTextPicker: () => ({}) }));
const quiz = [{ question: 'Choose', options: ['A', 'B', 'C', 'D'], correctIndex: 1 }];

describe('persisted inline quiz state', () => {
  test('restores selections and submission after navigation, generation elsewhere and reopening', () => {
    let saved = buildTestLesson({ quiz });
    const persist = vi.fn((_id, quizState) => {
      saved = { ...saved, quizState };
    });
    const useReader = ({ lessonId }: { lessonId: string }) => {
      const [lesson, setLesson] = useState(saved);
      return useWorkspaceReaderState({
        activeSection: lessonId === lesson.id ? lesson : buildTestLesson({ id: lessonId }),
        activeSectionId: lessonId,
        documentAssets: null,
        learningPlan: null,
        quiz: lessonId === lesson.id ? quiz : [],
        sectionContent: '',
        syllabus: [],
        onQuizStateChange: (id, quizState) => {
          persist(id, quizState);
          setLesson(saved);
        },
      });
    };
    const reader = renderHook(useReader, { initialProps: { lessonId: saved.id } });
    act(() => reader.result.current.handleSelectQuizAnswer(0, 1));
    expect(persist).toHaveBeenCalledWith(saved.id, { answers: [1], isSubmitted: false });
    act(() => reader.result.current.setIsQuizSubmitted(true));
    reader.rerender({ lessonId: 'ungenerated-lesson' });
    expect(reader.result.current.quizAnswers).toEqual([]);
    reader.rerender({ lessonId: saved.id });
    expect(reader.result.current.quizAnswers).toEqual([1]);
    expect(reader.result.current.isQuizSubmitted).toBe(true);
    reader.unmount();
    const reopened = renderHook(useReader, { initialProps: { lessonId: saved.id } });
    expect(reopened.result.current.quizAnswers).toEqual([1]);
    expect(reopened.result.current.isQuizSubmitted).toBe(true);
    reopened.unmount();
  });
});
