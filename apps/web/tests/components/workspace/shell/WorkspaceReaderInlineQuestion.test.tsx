// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import WorkspaceReaderInlineQuestion from '../../../../components/workspace/shell/WorkspaceReaderInlineQuestion.tsx';

test('keeps pointer and keyboard answer selection working through option labels', async () => {
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

  const firstOption = screen.getByRole('button', { name: /A Prima risposta/ });
  const optionLabel = within(firstOption).getByText('A');
  await user.tab();
  expect(firstOption).toHaveFocus();
  await user.keyboard(' ');
  expect(onSelectQuizAnswer).toHaveBeenCalledWith(0, 0);

  onSelectQuizAnswer.mockClear();
  await user.click(optionLabel);
  expect(onSelectQuizAnswer).toHaveBeenCalledWith(0, 0);
});

test('reveals the correct answer only after a selection and preserves the chosen answer', () => {
  const props = {
    isDarkMode: false,
    onSelectQuizAnswer: vi.fn(),
    question: {
      correctIndex: 1,
      exerciseType: 'prediction' as const,
      options: ['Raddoppia', 'Resta invariato', 'Si dimezza', 'Diventa nullo'],
      question: 'Come cambia il rapporto se numeratore e denominatore raddoppiano?',
    },
    questionIndex: 0,
  };
  const { rerender } = render(<WorkspaceReaderInlineQuestion {...props} selectedIndex={-1} />);

  expect(screen.getAllByRole('button')).toHaveLength(4);
  expect(screen.queryByText('Risposta corretta')).not.toBeInTheDocument();
  expect(screen.queryByText('La tua scelta')).not.toBeInTheDocument();

  rerender(<WorkspaceReaderInlineQuestion {...props} selectedIndex={0} />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.getByText('Raddoppia')).toBeInTheDocument();
  expect(screen.getByText('Resta invariato')).toBeInTheDocument();
  expect(screen.getByText('Risposta corretta')).toBeInTheDocument();

  rerender(<WorkspaceReaderInlineQuestion {...props} selectedIndex={1} />);
  expect(screen.getByText('Resta invariato')).toBeInTheDocument();
  expect(screen.queryByText('Raddoppia')).not.toBeInTheDocument();
  expect(screen.queryByText('Risposta corretta')).not.toBeInTheDocument();
});
