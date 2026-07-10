import { type FormEvent, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  joinWaitlist,
  type WaitlistErrorCode,
  WaitlistRequestError,
} from '../../services/marketing/waitlist.ts';

interface WaitlistFormProps {
  onJoinWaitlist?: (email: string) => Promise<void>;
}

type SubmissionStatus = 'idle' | 'submitting' | 'success' | 'error';

const getWaitlistErrorMessage = (errorCode: WaitlistErrorCode): string => {
  if (errorCode === 'invalid-email') {
    return t('Inserisci un indirizzo email valido.');
  }

  if (errorCode === 'rate-limited') {
    return t('Hai inviato troppe richieste. Riprova tra qualche minuto.');
  }

  return t('La richiesta non è disponibile in questo momento. Riprova più tardi.');
};

export default function WaitlistForm({ onJoinWaitlist = joinWaitlist }: WaitlistFormProps) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<SubmissionStatus>('idle');
  const [errorCode, setErrorCode] = useState<WaitlistErrorCode>('unavailable');

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus('submitting');

    try {
      await onJoinWaitlist(email);
      setStatus('success');
    } catch (error) {
      setErrorCode(error instanceof WaitlistRequestError ? error.code : 'unavailable');
      setStatus('error');
    }
  };

  if (status === 'success') {
    return (
      <output className="marketing-waitlist-success">
        {t('Sei nella lista. Ti scriveremo quando si libera un posto.')}
      </output>
    );
  }

  return (
    <form className="marketing-waitlist-form" onSubmit={handleSubmit}>
      <label className="marketing-email-field">
        <span className="marketing-visually-hidden">{t('Email per la waitlist')}</span>
        <input
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder={t('La tua email')}
          value={email}
          onChange={event => setEmail(event.target.value)}
          disabled={status === 'submitting'}
          required
        />
      </label>
      <button className="marketing-primary-button" type="submit" disabled={status === 'submitting'}>
        {status === 'submitting' ? t('Invio in corso…') : t('Richiedi accesso')}
      </button>
      {status === 'error' ? (
        <p className="marketing-waitlist-error" role="alert">
          {getWaitlistErrorMessage(errorCode)}
        </p>
      ) : null}
    </form>
  );
}
