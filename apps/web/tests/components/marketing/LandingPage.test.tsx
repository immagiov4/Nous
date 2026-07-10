// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import LandingPage from '../../../components/marketing/LandingPage.tsx';
import { WaitlistRequestError } from '../../../services/marketing/waitlist.ts';

test('presents the course transformation and keeps tester login secondary', async () => {
  const user = userEvent.setup();

  render(<LandingPage loginPanel={<p>Area tester</p>} />);

  expect(
    screen.getByRole('heading', {
      level: 1,
      name: 'Impara un argomento intero, un passo alla volta.',
    })
  ).toBeInTheDocument();
  expect(
    screen.getByText('PDF, libri e ricerca diventano corsi leggibili, interrogabili e continui.')
  ).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Dal materiale a un percorso.' })).toBeInTheDocument();
  expect(screen.queryByText('Area tester')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Accedi' }));

  expect(screen.getByRole('dialog', { name: 'Accesso alla preview' })).toBeInTheDocument();
  expect(screen.getByText('Area tester')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Chiudi accesso' }));
  expect(screen.queryByRole('dialog', { name: 'Accesso alla preview' })).toBeNull();
});

test('submits the waitlist form and confirms the request', async () => {
  const user = userEvent.setup();
  const onJoinWaitlist = vi.fn(async () => undefined);

  render(<LandingPage loginPanel={<p>Area tester</p>} onJoinWaitlist={onJoinWaitlist} />);

  await user.type(screen.getByLabelText('Email per la waitlist'), 'student@example.com');
  await user.click(screen.getByRole('button', { name: 'Entra nella waitlist' }));

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

  await user.type(screen.getByLabelText('Email per la waitlist'), 'student@example.com');
  await user.click(screen.getByRole('button', { name: 'Entra nella waitlist' }));

  expect(
    await screen.findByText('La richiesta non è disponibile in questo momento. Riprova più tardi.')
  ).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent('connection details');
});
