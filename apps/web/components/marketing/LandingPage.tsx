import { ArrowRight, Check, Menu, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import LandingProductDemo from './LandingProductDemo.tsx';
import './marketing.css';
import WaitlistForm from './WaitlistForm.tsx';

interface LandingPageProps {
  loginPanel: ReactNode;
  onJoinWaitlist?: (email: string) => Promise<void>;
}

export default function LandingPage({ loginPanel, onJoinWaitlist }: LandingPageProps) {
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

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
          <button type="button" onClick={() => scrollToSection('prodotto')}>
            {t('Come funziona')}
          </button>
          <button type="button" onClick={() => scrollToSection('prodotto')}>
            {t('Il prodotto')}
          </button>
          <button className="marketing-login-button" type="button" onClick={openLogin}>
            {t('Accedi')}
          </button>
          <button
            className="marketing-header-cta"
            type="button"
            onClick={() => scrollToSection('waitlist')}
          >
            {t('Richiedi accesso')}
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
          <p className="marketing-eyebrow">{t('DAL TUO MATERIALE A UN CORSO CONTINUO')}</p>
          <h1>{t('Un argomento intero. Un passo alla volta.')}</h1>
          <p className="marketing-hero-description">
            {t(
              'Carica il materiale che devi padroneggiare. Nous prepara il piano, genera lezioni ordinate con audio e domande, e alla sessione successiva riapre il punto esatto.'
            )}
          </p>
          <ul className="marketing-hero-proof">
            <li>
              <Check aria-hidden="true" /> {t('Un piano prima della generazione')}
            </li>
            <li>
              <Check aria-hidden="true" /> {t('Una lezione alla volta')}
            </li>
            <li>
              <Check aria-hidden="true" /> {t('Contesto e progressi che restano')}
            </li>
          </ul>
        </div>

        <div className="marketing-hero-access" id="waitlist">
          <div>
            <p className="marketing-eyebrow">{t('ACCESSO ANTICIPATO')}</p>
            <h2>{t('Prova Nous sul tuo corso.')}</h2>
            <p className="marketing-access-description">
              {t(
                'Stiamo aprendo Nous a piccoli gruppi per osservare come viene usato su corsi veri.'
              )}
            </p>
          </div>
          <div>
            <WaitlistForm onJoinWaitlist={onJoinWaitlist} />
            <p className="marketing-form-note">
              {t('Preview a inviti. Niente rumore, solo aggiornamenti utili.')}
            </p>
          </div>
        </div>
      </section>

      <section className="marketing-product-section" id="prodotto">
        <div className="marketing-product-heading">
          <h2>{t('Il prossimo passo è già pronto.')}</h2>
          <p>
            {t(
              'Apri la libreria, segui la costruzione del corso e continua dalla lezione che stavi studiando.'
            )}
          </p>
        </div>
        <LandingProductDemo />
      </section>

      <section className="marketing-section marketing-difference" id="perche-nous">
        <div className="marketing-difference-statement">
          <p className="marketing-eyebrow">{t('LA DIFFERENZA È LA CONTINUITÀ')}</p>
          <h2>{t('Una risposta non è un percorso.')}</h2>
          <p className="marketing-section-description">
            {t(
              'La domanda singola è utile. Per padroneggiare un soggetto servono anche ordine, memoria e una direzione che sopravviva alla sessione.'
            )}
          </p>
        </div>

        <table className="marketing-comparison">
          <caption className="marketing-visually-hidden">
            {t('Confronto tra chat AI e Nous')}
          </caption>
          <thead>
            <tr className="marketing-comparison-header">
              <th scope="col">{t('Chat AI')}</th>
              <th scope="col">Nous</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{t('Una risposta isolata')}</td>
              <td>{t('La lezione giusta dentro un piano')}</td>
            </tr>
            <tr>
              <td>{t('Il contesto resta nella conversazione')}</td>
              <td>{t('Fonti, note e progressi restano nel corso')}</td>
            </tr>
            <tr>
              <td>{t('Decidi ogni volta cosa chiedere')}</td>
              <td>{t('Riapri e trovi già il prossimo passo')}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="marketing-final-cta">
        <p className="marketing-eyebrow">{t('ACCESSO ANTICIPATO')}</p>
        <h2>{t('Dai una direzione al tuo materiale.')}</h2>
        <p>{t('Richiedi l’accesso alla preview. Se sei già tester, usa Accedi.')}</p>
        <a className="marketing-primary-button" href="#waitlist">
          {t('Richiedi accesso')}
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
        <nav aria-label={t('Link nel footer')}>
          <a href="#prodotto">{t('Demo')}</a>
          <a href="#prodotto">{t('Come funziona')}</a>
          <button type="button" onClick={openLogin}>
            {t('Accesso tester')}
          </button>
        </nav>
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
