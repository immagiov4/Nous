import {
  ArrowDown,
  ArrowRight,
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
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import LandingProductDemo, { type DemoStage } from './LandingProductDemo.tsx';
import './marketing.css';
import WaitlistForm from './WaitlistForm.tsx';

interface LandingPageProps {
  loginPanel: ReactNode;
  onJoinWaitlist?: (email: string) => Promise<void>;
}

const JOURNEY_STAGES = ['plan', 'generation', 'lesson', 'plan'] as const satisfies DemoStage[];

export default function LandingPage({ loginPanel, onJoinWaitlist }: LandingPageProps) {
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [journeyStage, setJourneyStage] = useState<DemoStage>('plan');

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
    if (typeof IntersectionObserver === 'undefined') {
      return;
    }

    const journeySteps = document.querySelectorAll<HTMLElement>('[data-journey-stage]');
    const observer = new IntersectionObserver(
      entries => {
        const mostVisibleStep = entries
          .filter(entry => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
        const nextStage = mostVisibleStep?.target.getAttribute('data-journey-stage') as
          | DemoStage
          | undefined;

        if (nextStage) {
          setJourneyStage(current => (current === nextStage ? current : nextStage));
        }
      },
      { rootMargin: '-22% 0px -45%', threshold: [0.2, 0.45, 0.7] }
    );

    journeySteps.forEach(step => {
      observer.observe(step);
    });
    return () => observer.disconnect();
  }, []);

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
          <p className="marketing-hero-kicker">{t('IL CORSO CHE MANCAVA AI TUOI MATERIALI')}</p>
          <h1>{t('Un corso intero. Un passo alla volta.')}</h1>
          <p className="marketing-hero-hook">
            {t(
              'Le slide del professore sembrano sopravvissute a tre versioni di PowerPoint? Il libro spiega tutto, tranne quello che chiederà all’esame?'
            )}
          </p>
          <p className="marketing-hero-description">
            {t(
              'Metti insieme slide, dispense e libri. Nous li trasforma nel corso che avresti voluto ricevere: lezioni leggibili, domande, note e audio, sempre dal punto in cui eri rimasto.'
            )}
          </p>

          <div className="marketing-hero-access" id="waitlist">
            <p>{t('Richiedi l’accesso alla preview')}</p>
            <WaitlistForm onJoinWaitlist={onJoinWaitlist} />
            <small>{t('Sei già tester? Usa Accedi in alto.')}</small>
          </div>
        </div>

        <div
          className="marketing-material-scene"
          role="img"
          aria-label={t('Materiali di studio disordinati')}
        >
          <div className="marketing-material-sheet marketing-material-sheet-slide">
            <span>47 / 182</span>
            <strong>{t('Architetture di rete')}</strong>
            <p>VLAN · trunk · 802.1Q · forwarding</p>
            <i />
            <i />
            <i />
          </div>
          <div className="marketing-material-sheet marketing-material-sheet-notes">
            <FileText aria-hidden="true" />
            <span>{t('dispense_finale_v7.pdf')}</span>
            <p>{t('“Importante per l’esame”')}</p>
          </div>
          <div className="marketing-material-sheet marketing-material-sheet-book">
            <BookOpen aria-hidden="true" />
            <span>{t('Libro · 684 pagine')}</span>
          </div>
          <div className="marketing-material-path" aria-hidden="true">
            <ArrowDown />
          </div>
          <div className="marketing-course-result">
            <span>{t('Il tuo corso')}</span>
            <strong>{t('Reti e Internet')}</strong>
            <div>
              <i className="is-complete" />
              <i className="is-complete" />
              <i />
              <i />
              <i />
            </div>
            <small>{t('2 lezioni completate · riprendi dalla 3')}</small>
          </div>
        </div>
      </section>

      <section className="marketing-problem">
        <p>{t('Il materiale non dovrebbe essere un secondo esame.')}</p>
        <h2>
          {t(
            'Non sei tu che devi ricostruire il filo tra slide, libro, appunti e cinque chat diverse.'
          )}
        </h2>
      </section>

      <section className="marketing-journey" id="journey">
        <div className="marketing-journey-intro">
          <p>{t('Dal caos al corso')}</p>
          <h2>{t('Scorri. Guarda il materiale diventare studiabile.')}</h2>
        </div>

        <div className="marketing-journey-layout">
          <div className="marketing-journey-steps">
            <article data-journey-stage={JOURNEY_STAGES[0]}>
              <span>01</span>
              <h3>{t('Metti tutto sul tavolo.')}</h3>
              <p>
                {t(
                  'Il libro, le slide vecchie, le dispense del corso. Non devi scegliere una fonte perfetta: Nous parte da quello che devi davvero studiare.'
                )}
              </p>
            </article>
            <article data-journey-stage={JOURNEY_STAGES[1]}>
              <span>02</span>
              <h3>{t('Nous ricostruisce il filo.')}</h3>
              <p>
                {t(
                  'Prima crea il piano. Poi trasforma le fonti in moduli e lezioni che spiegano abbastanza da permetterti di orientarti nell’argomento.'
                )}
              </p>
            </article>
            <article data-journey-stage={JOURNEY_STAGES[2]}>
              <span>03</span>
              <h3>{t('Studi senza uscire dal contesto.')}</h3>
              <p>
                {t(
                  'Se un passaggio non è chiaro, chiedi lì. Puoi salvare una nota, ottenere un esempio visivo o aprire una sottolezione senza ricominciare da zero in un’altra chat.'
                )}
              </p>
            </article>
            <article data-journey-stage={JOURNEY_STAGES[3]}>
              <span>04</span>
              <h3>{t('Chiudi. Torna. Riparti da lì.')}</h3>
              <p>
                {t(
                  'Progressi, evidenziazioni, note e lezioni restano insieme. Dal computer o dal telefono, il prossimo passo è già pronto.'
                )}
              </p>
            </article>
          </div>

          <div className="marketing-journey-demo" id="prodotto">
            <LandingProductDemo activeStage={journeyStage} onStageChange={setJourneyStage} />
          </div>
        </div>
      </section>

      <section className="marketing-study-flow">
        <div className="marketing-study-flow-heading">
          <p>{t('Un solo posto per studiare')}</p>
          <h2>{t('Non devi più fare il regista del tuo studio.')}</h2>
        </div>

        <div className="marketing-study-flow-list">
          <article>
            <MessageCircle aria-hidden="true" />
            <h3>{t('Chiedi nel punto esatto')}</h3>
            <p>
              {t(
                'La risposta conosce la lezione e le fonti del corso. Niente copia e incolla, niente contesto da ricostruire.'
              )}
            </p>
          </article>
          <article>
            <NotebookPen aria-hidden="true" />
            <h3>{t('Trasforma i dubbi in materiale utile')}</h3>
            <p>
              {t(
                'Salva note ed esempi, oppure crea una sottolezione quando ti manca una base. Rimane tutto accanto a ciò che stavi leggendo.'
              )}
            </p>
          </article>
          <article>
            <Headphones aria-hidden="true" />
            <h3>{t('Leggi oppure ascolta')}</h3>
            <p>
              {t(
                'Usa il TTS, associa la musica con cui ti concentri e continua anche dal telefono, senza passarti file da un dispositivo all’altro.'
              )}
            </p>
          </article>
          <article>
            <Cloud aria-hidden="true" />
            <h3>{t('Ripassa ciò che conta davvero')}</h3>
            <p>
              {t(
                'Domande, attività, definizioni e parti evidenziate restano recuperabili quando arriva il momento di preparare l’esame.'
              )}
            </p>
          </article>
        </div>
      </section>

      <section className="marketing-founder-note">
        <p>{t('L’ho costruito perché mi serviva.')}</p>
        <blockquote>
          {t(
            'Volevo studiare seriamente senza spendere metà dell’energia a sistemare materiali, cambiare app e ricordarmi dove avevo lasciato ogni cosa. Nous nasce da quella frustrazione.'
          )}
        </blockquote>
      </section>

      <section className="marketing-final-cta">
        <h2>{t('Porta il materiale. Ritrova il corso.')}</h2>
        <p>{t('Richiedi l’accesso alla preview di Nous Reader.')}</p>
        <div className="marketing-final-actions">
          <a className="marketing-primary-button" href="#waitlist">
            {t('Richiedi accesso')}
            <ArrowRight aria-hidden="true" />
          </a>
          <button type="button" onClick={openLogin}>
            {t('Sei già tester? Accedi')}
          </button>
        </div>
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
          <a href="#journey">{t('Come funziona')}</a>
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
