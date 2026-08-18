// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import GenerationProgress from '../../../components/shared/GenerationProgress.tsx';

describe('GenerationProgress', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('shows validated progress without exposing the raw model stream', () => {
    render(
      <GenerationProgress
        progress={{
          operation: 'lesson',
          sections: ['Introduzione', 'Applicazioni'],
          stage: 'drafting',
          startedAt: Date.now(),
          stepOffset: 4,
          subject: 'Come funziona la memoria',
        }}
      />
    );

    expect(screen.getByRole('heading', { name: 'Come funziona la memoria' })).toBeInTheDocument();
    expect(screen.getByText('5. Introduzione')).toBeInTheDocument();
    const currentStep = screen.getByText('6. Applicazioni').closest('div');
    expect(currentStep).toHaveClass('generation-progress-step-current');
    expect(currentStep?.querySelectorAll('p')).toHaveLength(1);
    expect(screen.getByText(/^(Stesura|Drafting)$/)).toBeInTheDocument();
    expect(screen.queryByText(/reasoning/i)).not.toBeInTheDocument();
  });

  test('fades older rows after the three-step window starts rotating', () => {
    render(
      <GenerationProgress
        progress={{
          operation: 'lesson',
          sections: ['Passaggio 4', 'Passaggio 5', 'Passaggio 6'],
          stage: 'drafting',
          startedAt: Date.now(),
          stepOffset: 3,
          subject: 'Memoria',
        }}
      />
    );

    expect(screen.getByText('4. Passaggio 4').closest('div')).toHaveStyle({ opacity: '0.7' });
    expect(screen.getByText('6. Passaggio 6').closest('div')).toHaveStyle({ opacity: '1' });
  });

  test('labels course generation as a course instead of a lesson', () => {
    render(
      <GenerationProgress
        progress={{
          operation: 'plan',
          sections: ['Indice del corso', 'Verifica della struttura'],
          stage: 'structure',
          startedAt: Date.now(),
          stepOffset: 0,
          subject: 'Architettura dei game engine',
        }}
      />
    );

    expect(screen.getByRole('heading', { name: /Corso in preparazione/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Lezione in cottura/i })).not.toBeInTheDocument();
  });

  test('keeps elapsed time tied to the generation when the view remounts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T10:01:05Z'));
    const progress = {
      operation: 'lesson' as const,
      sections: ['Passaggio corrente.'],
      stage: 'drafting' as const,
      startedAt: new Date('2026-07-11T10:00:00Z').getTime(),
      stepOffset: 0,
      subject: 'Memoria',
    };
    const firstRender = render(<GenerationProgress progress={progress} />);

    expect(screen.getByText(/1:05$/)).toBeInTheDocument();
    firstRender.unmount();
    vi.setSystemTime(new Date('2026-07-11T10:01:12Z'));
    render(<GenerationProgress progress={progress} />);

    expect(screen.getByText(/1:12$/)).toBeInTheDocument();
  });

  test('shows an authoritative retry without presenting a recoverable attempt as an error', () => {
    render(
      <GenerationProgress
        elapsedSecondsOverride={65}
        progress={{
          attempt: 2,
          failure: { code: 'lesson_provider_secret_failure', kind: 'operational' },
          operation: 'lesson',
          retrying: true,
          sections: ['Ricerco le fonti.'],
          stage: 'structure',
          startedAt: Date.now(),
          stepOffset: 0,
          subject: 'Memoria',
        }}
      />
    );

    expect(screen.getByText(/(Nuovo tentativo in corso|Starting another attempt)/i)).toHaveTextContent(
      /(?:Tentativo|Attempt) 2/
    );
    expect(screen.queryByText(/(non è riuscito|failed|Riprovo automaticamente|Retrying automatically)/i)).not.toBeInTheDocument();
    expect(screen.getByText(/1:05$/)).toBeInTheDocument();
    expect(screen.queryByText(/lesson_provider_secret_failure/i)).not.toBeInTheDocument();
  });

  test('renders a three-point progress window without clipping rows in the component', () => {
    render(
      <GenerationProgress
        progress={{
          operation: 'lesson',
          sections: ['Passaggio 3', 'Passaggio 4', 'Passaggio 5'],
          stage: 'drafting',
          startedAt: Date.now(),
          stepOffset: 2,
          subject: 'Memoria',
        }}
      />
    );

    expect(screen.getByText('3. Passaggio 3').closest('div')).not.toHaveClass('hidden');
    expect(screen.getByText('5. Passaggio 5').closest('div')).toHaveClass(
      'generation-progress-step-current'
    );
  });
});
