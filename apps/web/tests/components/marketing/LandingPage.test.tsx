// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import LandingPage from '../../../components/marketing/LandingPage.tsx';
import { WaitlistRequestError } from '../../../services/marketing/waitlist.ts';

vi.mock('../../../components/marketing/LandingProductDemo.tsx', () => ({
  default: ({ activeStage }: { activeStage?: string }) => (
    <div data-testid="landing-product-video">{activeStage}</div>
  ),
}));

test('presents the course transformation and keeps tester login secondary', async () => {
  const user = userEvent.setup();

  render(<LandingPage loginPanel={<p>Area tester</p>} />);

  expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  expect(screen.queryByText(/interfaccia reale/i)).toBeNull();
  expect(screen.queryByText(/sviluppo visibile/i)).toBeNull();
  expect(screen.queryByText('Area tester')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Accedi' }));

  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByText('Area tester')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Chiudi accesso' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('connects the scroll journey to the Remotion product sequence', () => {
  render(<LandingPage loginPanel={<p>Area tester</p>} />);

  expect(screen.getByTestId('landing-product-video')).toHaveTextContent('plan');
  expect(document.querySelectorAll('[data-journey-step]')).toHaveLength(4);
});

test('submits the waitlist form and confirms the request', async () => {
  const user = userEvent.setup();
  const onJoinWaitlist = vi.fn(async () => undefined);

  render(<LandingPage loginPanel={<p>Area tester</p>} onJoinWaitlist={onJoinWaitlist} />);

  const emailField = screen.getByLabelText('Email per la waitlist');
  await user.type(emailField, 'student@example.com');
  await user.click(
    within(emailField.closest('form') as HTMLFormElement).getByRole('button', {
      name: 'Richiedi accesso',
    })
  );

  expect(onJoinWaitlist).toHaveBeenCalledWith('student@example.com');
  expect(
    await screen.findByText('Sei nella lista. Ti scriveremo quando si libera un posto.')
  ).toBeInTheDocument();
});

test('shows a stable waitlist error without leaking internal details', async () => {
  const user = userEvent.setup();
  const onJoinWaitlist = vi.fn(async () => {
    throw new WaitlistRequestError('unavailable');
  });

  render(<LandingPage loginPanel={<p>Area tester</p>} onJoinWaitlist={onJoinWaitlist} />);

  const emailField = screen.getByLabelText('Email per la waitlist');
  await user.type(emailField, 'student@example.com');
  await user.click(
    within(emailField.closest('form') as HTMLFormElement).getByRole('button', {
      name: 'Richiedi accesso',
    })
  );

  expect(
    await screen.findByText('La richiesta non è disponibile in questo momento. Riprova più tardi.')
  ).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent('connection details');
});
