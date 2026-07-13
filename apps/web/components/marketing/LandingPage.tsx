import {
  BookOpen,
  Cloud,
  FileText,
  Headphones,
  Menu,
  MessageCircle,
  NotebookPen,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import logoUrl from '../../assets/logo.svg';
import {
  MARKETING_JOURNEY_COPY,
  translateMarketingMessage as t,
} from '../../i18n/marketingMessages.ts';
import { subscribeToMediaQuery } from '../../utils/mediaQuery.ts';
import LandingProductDemo, { type DemoStage } from './LandingProductDemo.tsx';
import './marketing.css';
import WaitlistForm from './WaitlistForm.tsx';

interface LandingPageProps {
  loginPanel: ReactNode;
  onJoinWaitlist?: (email: string) => Promise<void>;
}

const JOURNEY_STAGES = ['plan', 'generation', 'lesson', 'library'] as const satisfies DemoStage[];
const MOBILE_JOURNEY_MEDIA_QUERY = '(max-width: 52rem)';
export default function LandingPage({ loginPanel, onJoinWaitlist }: LandingPageProps) {
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [activeJourneyStep, setActiveJourneyStep] = useState(0);
  const [isMobileJourney, setIsMobileJourney] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(MOBILE_JOURNEY_MEDIA_QUERY).matches
  );
  const journeyStage = JOURNEY_STAGES[activeJourneyStep];
  const mobileJourneyCopy = MARKETING_JOURNEY_COPY[activeJourneyStep];

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return;
    }

    const mediaQuery = window.matchMedia(MOBILE_JOURNEY_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsMobileJourney(current => (current === event.matches ? current : event.matches));
    };
    return subscribeToMediaQuery(mediaQuery, handleChange);
  }, []);

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

  useEffect(() => {
    if (isMobileJourney || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const journeySteps = document.querySelectorAll<HTMLElement>('[data-journey-step]');
    const visibilityByStep = new Map<HTMLElement, number>();
    journeySteps.forEach(step => {
      visibilityByStep.set(step, 0);
    });
    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          visibilityByStep.set(entry.target as HTMLElement, entry.intersectionRatio);
        });
        const mostVisibleStep = [...visibilityByStep.entries()].sort(
          (left, right) => right[1] - left[1]
        )[0];
        const nextStep = Number(mostVisibleStep?.[0].getAttribute('data-journey-step'));

        if (Number.isInteger(nextStep) && (mostVisibleStep?.[1] ?? 0) > 0) {
          setActiveJourneyStep(current => (current === nextStep ? current : nextStep));
        }
      },
      { rootMargin: '-22% 0px -45%', threshold: [0.2, 0.45, 0.7] }
    );

    journeySteps.forEach(step => {
      observer.observe(step);
    });
    return () => observer.disconnect();
  }, [isMobileJourney]);

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
          <img src={logoUrl} alt="" />
          <span>Nous Reader</span>
        </a>

        <nav
          className={isMenuOpen ? 'marketing-nav is-open' : 'marketing-nav'}
          aria-label={t('Navigazione principale')}
        >
          <button type="button" onClick={() => scrollToSection('journey')}>
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
          <h1>{t('Un corso intero. Un passo alla volta.')}</h1>
          <p className="marketing-hero-hook">
            {t(
              'Slide sopravvissute a tre versioni di PowerPoint? Un libro che spiega tutto, tranne quello che chiederà all’esame?'
            )}
          </p>
          <p className="marketing-hero-description">
            {t(
              'Carica un PDF o un archivio di materiali. Nous prepara lezioni, domande ed esercizi per te.'
            )}
          </p>

          <div className="marketing-hero-access" id="waitlist">
            <p>{t('Richiedi accesso all’anteprima')}</p>
            <WaitlistForm onJoinWaitlist={onJoinWaitlist} />
            <small>{t('Sei già tester? Usa Accedi in alto.')}</small>
          </div>

          <blockquote className="marketing-hero-quote">
            <p>“{t('Il materiale non dovrebbe essere un secondo esame.')}”</p>
            <cite>{t('— Giovanni, creatore di Nous')}</cite>
          </blockquote>
        </div>

        <div
          className="marketing-material-scene"
          role="img"
          aria-label={t('Materiali di studio disordinati')}
        >
          <div className="marketing-material-sheet marketing-material-sheet-slide">
            <span>47 / 182</span>
            <strong>{t('Psicologia cognitiva')}</strong>
            <p>{t('attenzione · memoria · apprendimento')}</p>
            <i />
            <i />
            <i />
          </div>
          <div className="marketing-material-sheet marketing-material-sheet-notes">
            <FileText aria-hidden="true" />
            <span>{t('psicologia_cognitiva.pdf')}</span>
            <p>{t('“Importante per l’esame”')}</p>
          </div>
          <div className="marketing-material-sheet marketing-material-sheet-book">
            <BookOpen aria-hidden="true" />
            <span>{t('Psicologia · 640 pagine')}</span>
          </div>
        </div>
      </section>

      <section className="marketing-journey" id="journey">
        <div className="marketing-journey-intro">
          <h2>{t('Finalmente il materiale diventa studiabile.')}</h2>
        </div>

        {isMobileJourney ? (
          <div className="marketing-journey-mobile">
            <article key={mobileJourneyCopy.number} className="marketing-journey-mobile-copy">
              <span>{mobileJourneyCopy.number}</span>
              <h3>{t(mobileJourneyCopy.title)}</h3>
              <p>{t(mobileJourneyCopy.description)}</p>
            </article>
            <div className="marketing-journey-mobile-demo" id="prodotto">
              <LandingProductDemo activeStage={journeyStage} />
            </div>
            <fieldset className="marketing-journey-mobile-controls">
              <legend className="marketing-visually-hidden">{t('Come funziona')}</legend>
              {MARKETING_JOURNEY_COPY.map((item, index) => (
                <button
                  key={item.number}
                  type="button"
                  aria-label={`${item.number} — ${t(item.title)}`}
                  aria-pressed={activeJourneyStep === index}
                  onClick={() => setActiveJourneyStep(index)}
                >
                  {item.number}
                </button>
              ))}
            </fieldset>
          </div>
        ) : (
          <div className="marketing-journey-layout">
            <div className="marketing-journey-steps">
              <article className={activeJourneyStep === 0 ? 'is-active' : ''} data-journey-step="0">
                <span>01</span>
                <h3>{t('Metti tutto sul tavolo.')}</h3>
                <p>
                  {t(
                    'Carica il PDF del corso oppure uno ZIP con più file. Nous parte dal materiale che devi davvero studiare.'
                  )}
                </p>
                <ul>
                  <li>
                    <FileText aria-hidden="true" /> {t('PDF, testi e archivi ZIP')}
                  </li>
                  <li>
                    <BookOpen aria-hidden="true" /> {t('Le fonti restano collegate al corso')}
                  </li>
                </ul>
              </article>
              <article className={activeJourneyStep === 1 ? 'is-active' : ''} data-journey-step="1">
                <span>02</span>
                <h3>{t('Nous ricostruisce il filo.')}</h3>
                <p>
                  {t(
                    'Prima prepara il piano. Poi genera una lezione alla volta, abbastanza chiara da farti orientare senza riscrivere il libro.'
                  )}
                </p>
                <ul>
                  <li>
                    <BookOpen aria-hidden="true" /> {t('Moduli, lezioni e attività')}
                  </li>
                  <li>
                    <Cloud aria-hidden="true" /> {t('Il progresso viene salvato')}
                  </li>
                </ul>
              </article>
              <article className={activeJourneyStep === 2 ? 'is-active' : ''} data-journey-step="2">
                <span>03</span>
                <h3>{t('Studi senza uscire dal contesto.')}</h3>
                <p>
                  {t(
                    'Se un passaggio non è chiaro, chiedi lì. La risposta conosce la lezione e le fonti: niente copia e incolla in un’altra chat.'
                  )}
                </p>
                <ul>
                  <li>
                    <MessageCircle aria-hidden="true" /> {t('Chiedi nel punto esatto')}
                  </li>
                  <li>
                    <NotebookPen aria-hidden="true" /> {t('Salva note, esempi e sottolezioni')}
                  </li>
                </ul>
              </article>
              <article className={activeJourneyStep === 3 ? 'is-active' : ''} data-journey-step="3">
                <span>04</span>
                <h3>{t('Chiudi. Torna. Riparti da lì.')}</h3>
                <p>
                  {t(
                    'Lezioni, evidenziazioni e note restano insieme. Puoi riprendere dal computer o dal telefono, leggendo oppure ascoltando.'
                  )}
                </p>
                <ul>
                  <li>
                    <Headphones aria-hidden="true" /> {t('Testo, audio e musica per concentrarti')}
                  </li>
                  <li>
                    <Cloud aria-hidden="true" /> {t('Tutto disponibile sui tuoi dispositivi')}
                  </li>
                </ul>
              </article>
            </div>

            <div className="marketing-journey-demo" id="prodotto">
              <LandingProductDemo activeStage={journeyStage} />
            </div>
          </div>
        )}
      </section>

      <div className="marketing-contact">
        <span>Nous Reader</span>
        <a href="mailto:brancaccio@proton.me">brancaccio@proton.me</a>
      </div>

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
                <h2 id="preview-login-title">{t('Accesso all’anteprima')}</h2>
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
