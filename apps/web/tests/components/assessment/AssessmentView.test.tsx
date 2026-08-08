// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ComponentProps, createRef } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import AssessmentView from '../../../components/assessment/AssessmentView.tsx';

const buildProps = (
  overrides: Partial<ComponentProps<typeof AssessmentView>> = {}
): ComponentProps<typeof AssessmentView> => ({
  assessmentInputId: 'assessment-input',
  assessmentInputRef: createRef<HTMLInputElement>(),
  currentAssessmentInput: '',
  hasCourseProposal: false,
  isDarkMode: false,
  isLoading: false,
  loadingStatus: '',
  messages: [{ role: 'model', text: 'Qual è il tuo obiettivo?' }],
  messagesEndRef: createRef<HTMLDivElement>(),
  onBackToLibrary: vi.fn(),
  onCancelAssessment: vi.fn(),
  onConfirmGenerate: vi.fn(),
  onInputChange: vi.fn(),
  onSubmit: vi.fn(),
  ...overrides,
});

afterEach(cleanup);

describe('AssessmentView durable interview actions', () => {
  test('shows an explicit confirmation when a restored proposal is actionable', () => {
    const onConfirmGenerate = vi.fn();
    render(<AssessmentView {...buildProps({ hasCourseProposal: true, onConfirmGenerate })} />);

    expect(screen.getByText('Proposta pronta')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Sì, genera il corso' }));

    expect(onConfirmGenerate).toHaveBeenCalledOnce();
  });

  test('keeps navigation separate from deliberate interview cancellation', () => {
    const onBackToLibrary = vi.fn();
    const onCancelAssessment = vi.fn();
    render(<AssessmentView {...buildProps({ onBackToLibrary, onCancelAssessment })} />);

    expect(screen.getByText('Intervista in corso')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Sì, genera il corso' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Libreria' }));
    expect(onBackToLibrary).toHaveBeenCalledOnce();
    expect(onCancelAssessment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Annulla creazione corso' }));
    expect(onCancelAssessment).toHaveBeenCalledOnce();
  });
});
