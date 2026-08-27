// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import WorkspaceReaderInlineQuestion from '../../../../components/workspace/shell/WorkspaceReaderInlineQuestion.tsx';

test('overlays option labels without changing keyboard answer selection', async () => {
  const user = userEvent.setup();
  const onSelectQuizAnswer = vi.fn();
  render(
    <WorkspaceReaderInlineQuestion
      isDarkMode={false}
      onSelectQuizAnswer={onSelectQuizAnswer}
      question={{
        correctIndex: 0,
        exerciseType: 'prediction',
        options: ['Prima risposta', 'Seconda risposta', 'Terza risposta', 'Quarta risposta'],
        question: 'Quale risposta scegli?',
      }}
      questionIndex={0}
      selectedIndex={-1}
    />
  );

  const firstOption = screen.getByRole('button', { name: /A\.Prima risposta/ });
  const optionLabel = firstOption.querySelector('span');
  expect(optionLabel).toHaveClass('absolute');
  if (!optionLabel) {
    throw new Error('Quiz option label is missing.');
  }
  await user.tab();
  expect(firstOption).toHaveFocus();
  await user.keyboard(' ');
  expect(onSelectQuizAnswer).toHaveBeenCalledWith(0, 0);

  onSelectQuizAnswer.mockClear();
  await user.click(optionLabel);
  expect(onSelectQuizAnswer).toHaveBeenCalledWith(0, 0);
});
