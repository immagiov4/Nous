// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { useWorkspaceReaderState } from '../../../hooks/workspace/useWorkspaceReaderState.ts';
import { buildTestLesson } from '../../helpers/learningPlan.ts';

vi.mock('../../../hooks/reader/useReaderChrome.ts', () => ({ useReaderChrome: () => ({}) }));
vi.mock('../../../hooks/reader/useReaderContext.ts', () => ({ useReaderContext: () => ({}) }));

vi.mock('../../../hooks/reader/useTtsPlayer.ts', () => ({
  useTtsPlayer: () => ({ audioState: {}, chunkTexts: [] }),
}));
vi.mock('../../../hooks/reader/useTtsTextPicker.ts', () => ({ useTtsTextPicker: () => ({}) }));
const quiz = [{ question: 'Choose', options: ['A', 'B', 'C', 'D'], correctIndex: 1 }];

describe('persisted inline quiz state', () => {
  test.each([
    { legacyQuiz: undefined },
    { legacyQuiz: [{ ...quiz[0], options: ['A', 'B'] }] },
    { legacyQuiz: [{ ...quiz[0], options: ['A', 'B', 'C', 'D', 'Stale option'] }] },
  ])('answers the inline questions when the legacy quiz differs: $legacyQuiz', ({ legacyQuiz }) => {
    let saved = buildTestLesson({
      quiz: legacyQuiz,
      contentBlocks: [
        { type: 'markdown', markdown: 'Text' },
        { type: 'inline-quiz', quiz: quiz[0] },
        { type: 'inline-quiz', quiz: quiz[0] },
      ],
    });
    const persist = vi.fn();
    const useReader = () => {
      const [lesson, setLesson] = useState(saved);
      return useWorkspaceReaderState({
        activeSection: lesson,
        activeSectionId: lesson.id,
        documentAssets: null,
        learningPlan: null,
        quiz: lesson.quiz ?? [],
        sectionContent: 'Text',
        syllabus: [],
        onQuizStateChange: (id, quizState) => {
          persist(id, quizState);
          saved = { ...lesson, quizState };
          setLesson(saved);
        },
      });
    };
    const reader = renderHook(useReader);
    act(() => reader.result.current.handleSelectQuizAnswer(0, 4));
    expect(persist).not.toHaveBeenCalled();
    act(() => reader.result.current.handleSelectQuizAnswer(0, 3));
    expect(reader.result.current.quizAnswers).toEqual([3, -1]);
    act(() => reader.result.current.handleSelectQuizAnswer(1, 1));
    expect(persist).toHaveBeenLastCalledWith(saved.id, { answers: [3, 1], isSubmitted: false });
    act(() => reader.result.current.setIsQuizSubmitted(true));
    reader.unmount();
    const reopened = renderHook(useReader);
    expect(reopened.result.current.quizAnswers).toEqual([3, 1]);
    expect(reopened.result.current.isQuizSubmitted).toBe(true);
    reopened.unmount();
  });

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
