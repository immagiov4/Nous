// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react';
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
      name: 'Un corso intero. Un passo alla volta.',
    })
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      'Metti insieme slide, dispense e libri. Nous li trasforma nel corso che avresti voluto ricevere: lezioni leggibili, domande, note e audio, sempre dal punto in cui eri rimasto.'
    )
  ).toBeInTheDocument();
  expect(
    screen.getByRole('heading', { name: 'Scorri. Guarda il materiale diventare studiabile.' })
  ).toBeInTheDocument();
  expect(screen.getByText('L’ho costruito perché mi serviva.')).toBeInTheDocument();
  expect(screen.queryByText(/interfaccia reale/i)).toBeNull();
  expect(screen.queryByText(/sviluppo visibile/i)).toBeNull();
  expect(screen.queryByText('Area tester')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Accedi' }));

  expect(screen.getByRole('dialog', { name: 'Accesso alla preview' })).toBeInTheDocument();
  expect(screen.getByText('Area tester')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Chiudi accesso' }));
  expect(screen.queryByRole('dialog', { name: 'Accesso alla preview' })).toBeNull();
});

test('lets visitors inspect the real lesson generation and reader states', async () => {
  const user = userEvent.setup();

  render(<LandingPage loginPanel={<p>Area tester</p>} />);

  await user.click(screen.getByRole('tab', { name: 'Lezione' }));
  expect(
    screen.getByRole('heading', { name: 'Perché l’attenzione è limitata' })
  ).toBeInTheDocument();

  await user.click(screen.getByRole('tab', { name: 'Generazione' }));
  expect(screen.getByText('Sto preparando “Perché l’attenzione è limitata”')).toBeInTheDocument();

  await user.click(screen.getByRole('tab', { name: 'Piano' }));
  expect(screen.getByRole('region', { name: 'Libreria dei corsi' })).toBeInTheDocument();
  expect(screen.getByText('4 lezioni · 1 in corso')).toBeInTheDocument();

  await user.click(screen.getByRole('tab', { name: 'Lezione' }));
  expect(
    screen.getByRole('heading', { name: 'Perché l’attenzione è limitata' })
  ).toBeInTheDocument();
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
