import {
  ArrowDown,
  ArrowRight,
  BookOpenCheck,
  Check,
  Menu,
  MessageSquareText,
  Route,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import LandingReaderPreview from './LandingReaderPreview.tsx';
import './marketing.css';
import WaitlistForm from './WaitlistForm.tsx';

interface LandingPageProps {
  loginPanel: ReactNode;
  onJoinWaitlist?: (email: string) => Promise<void>;
}

const getTransformationSteps = () =>
  [
    {
      number: '01',
      title: t('Porta il materiale'),
      description: t('Aggiungi PDF e libri, oppure parti da una ricerca guidata.'),
    },
    {
      number: '02',
      title: t('Nous costruisce il percorso'),
      description: t('Le fonti diventano parti ordinate, leggibili e collegate tra loro.'),
    },
    {
      number: '03',
      title: t('Impara senza perdere il filo'),
      description: t('Leggi, fai domande, annota e riprendi sempre dal punto giusto.'),
    },
  ] as const;

const getProductPromises = () => [
  t('Un percorso, non una cartella di file.'),
  t('Risposte ancorate a ciò che stai studiando.'),
  t('Progressi e contesto che continuano tra una sessione e l’altra.'),
];

export default function LandingPage({ loginPanel, onJoinWaitlist }: LandingPageProps) {
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const transformationSteps = getTransformationSteps();
  const productPromises = getProductPromises();

  useEffect(() => {
    if (!isLoginOpen) {
      return;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsLoginOpen(false);
      }
    };

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [isLoginOpen]);

  const openLogin = () => {
    setIsMenuOpen(false);
    setIsLoginOpen(true);
  };

  const scrollToSection = (sectionId: string) => {
    setIsMenuOpen(false);
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <main className="marketing-page">
      <header className="marketing-header">
        <a
          className="marketing-brand"
          href="#inizio"
          aria-label={t('Nous Reader, torna all’inizio')}
        >
          <img src="/assets/logo.svg" alt="" />
          <span>Nous Reader</span>
        </a>

        <nav
          className={isMenuOpen ? 'marketing-nav is-open' : 'marketing-nav'}
          aria-label={t('Navigazione principale')}
        >
          <button type="button" onClick={() => scrollToSection('come-funziona')}>
            {t('Come funziona')}
          </button>
          <button type="button" onClick={() => scrollToSection('perche-nous')}>
            {t('Perché Nous')}
          </button>
          <button className="marketing-login-button" type="button" onClick={openLogin}>
            {t('Accedi')}
          </button>
          <button
            className="marketing-header-cta"
            type="button"
            onClick={() => scrollToSection('waitlist')}
          >
            {t('Inizia')}
          </button>
        </nav>

        <button
          className="marketing-menu-button"
          type="button"
          aria-label={isMenuOpen ? t('Chiudi menu') : t('Apri menu')}
          aria-expanded={isMenuOpen}
          onClick={() => setIsMenuOpen(current => !current)}
        >
          {isMenuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>
      </header>

      <section className="marketing-hero" id="inizio">
        <div className="marketing-hero-copy">
          <p className="marketing-eyebrow">{t('STUDIARE UN ARGOMENTO, DAVVERO')}</p>
          <h1>{t('Impara un argomento intero, un passo alla volta.')}</h1>
          <p className="marketing-hero-description">
            {t('PDF, libri e ricerca diventano corsi leggibili, interrogabili e continui.')}
          </p>
          <div id="waitlist">
            <WaitlistForm onJoinWaitlist={onJoinWaitlist} />
            <p className="marketing-form-note">
              {t('Preview a inviti. Niente rumore, solo aggiornamenti utili.')}
            </p>
          </div>
        </div>

        <div className="marketing-hero-preview">
          <LandingReaderPreview />
        </div>

        <a
          className="marketing-scroll-cue"
          href="#come-funziona"
          aria-label={t('Scopri come funziona')}
        >
          <ArrowDown aria-hidden="true" />
        </a>
      </section>

      <section className="marketing-value-strip" aria-label={t('I vantaggi di Nous')}>
        <div>
          <span>
            <BookOpenCheck aria-hidden="true" />
          </span>
          <p>
            <strong>{t('Corsi che capisci davvero')}</strong>
            {t('Trasforma qualsiasi testo complesso in lezioni chiare, passo dopo passo.')}
          </p>
        </div>
        <div>
          <span>
            <MessageSquareText aria-hidden="true" />
          </span>
          <p>
            <strong>{t('Interroga e verifica')}</strong>
            {t('Fai domande, ottieni spiegazioni e verifica la tua comprensione.')}
          </p>
        </div>
        <div>
          <span>
            <Route aria-hidden="true" />
          </span>
          <p>
            <strong>{t('Impara a modo tuo')}</strong>
            {t('Leggi, ascolta, evidenzia, visualizza. Rimani concentrato e fai progressi.')}
          </p>
        </div>
      </section>

      <section className="marketing-section marketing-how" id="come-funziona">
        <div className="marketing-section-heading">
          <p className="marketing-eyebrow">{t('COME FUNZIONA')}</p>
          <h2>{t('Dal materiale a un percorso.')}</h2>
          <p>{t('Nous mette ordine prima che tu debba farlo da solo.')}</p>
        </div>

        <ol className="marketing-step-list">
          {transformationSteps.map(step => (
            <li key={step.number}>
              <span>{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.description}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="marketing-section marketing-difference" id="perche-nous">
        <div className="marketing-difference-statement">
          <p className="marketing-eyebrow">{t('PERCHÉ NOUS')}</p>
          <h2>{t('Non un riassunto. Non una chat generica.')}</h2>
          <p>
            {t(
              'Nous è un ambiente di apprendimento: conserva la struttura del soggetto, il punto in cui sei e le domande che ti hanno fatto avanzare.'
            )}
          </p>
        </div>

        <ul className="marketing-promise-list">
          {productPromises.map(promise => (
            <li key={promise}>
              <Check aria-hidden="true" />
              <span>{promise}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="marketing-section marketing-audience">
        <div>
          <p className="marketing-eyebrow">{t('PER CHI VUOLE CAPIRE')}</p>
          <h2>{t('Quando il materiale è tanto, il percorso deve restare semplice.')}</h2>
        </div>
        <p>
          {t(
            'Per chi studia da fonti diverse, perde il filo tra una sessione e l’altra o ha bisogno di vedere un argomento diventare una sequenza affrontabile.'
          )}
        </p>
      </section>

      <section className="marketing-final-cta">
        <p className="marketing-eyebrow">{t('PREVIEW PRIVATA')}</p>
        <h2>{t('Porta un argomento. Noi gli diamo una direzione.')}</h2>
        <a className="marketing-primary-button" href="#waitlist">
          {t('Entra nella waitlist')}
          <ArrowRight aria-hidden="true" />
        </a>
      </section>

      <footer className="marketing-footer">
        <a
          className="marketing-brand"
          href="#inizio"
          aria-label={t('Nous Reader, torna all’inizio')}
        >
          <img src="/assets/logo.svg" alt="" />
          <span>Nous Reader</span>
        </a>
        <p>{t('Imparare un soggetto intero, senza perdere il filo.')}</p>
        <button type="button" onClick={openLogin}>
          {t('Accesso tester')}
        </button>
      </footer>

      {isLoginOpen ? (
        <div className="marketing-dialog-backdrop">
          <section
            className="marketing-login-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="preview-login-title"
          >
            <div className="marketing-dialog-heading">
              <div>
                <p className="marketing-eyebrow">{t('SOLO SU INVITO')}</p>
                <h2 id="preview-login-title">{t('Accesso alla preview')}</h2>
              </div>
              <button
                type="button"
                aria-label={t('Chiudi accesso')}
                onClick={() => setIsLoginOpen(false)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
            {loginPanel}
          </section>
        </div>
      ) : null}
    </main>
  );
}
