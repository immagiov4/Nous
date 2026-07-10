import { ArrowRight, BookOpenText, Highlighter, MessageCircle } from 'lucide-react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';

const COURSE_PARTS = [
  'Dal problema della comunicazione',
  'Come viaggiano i dati',
  'Dentro Internet',
] as const;

export default function LandingReaderPreview() {
  return (
    <section className="marketing-reader-frame" aria-label={t('Anteprima del lettore Nous')}>
      <header className="marketing-reader-toolbar">
        <div className="marketing-reader-traffic-lights" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <span>{t('Reti e Internet')}</span>
        <span>{t('Parte 1 di 12')}</span>
      </header>

      <div className="marketing-reader-layout">
        <aside className="marketing-reader-outline" aria-label={t('Indice del corso')}>
          <BookOpenText aria-hidden="true" size={18} strokeWidth={1.7} />
          <ol>
            {COURSE_PARTS.map((part, index) => (
              <li className={index === 0 ? 'is-current' : undefined} key={part}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                {t(part)}
              </li>
            ))}
          </ol>
        </aside>

        <article className="marketing-reader-page">
          <span className="marketing-reader-kicker">{t('PARTE 01 · FONDAMENTI')}</span>
          <h2>{t('Il problema della comunicazione')}</h2>
          <p>
            {t(
              'Una rete nasce da una domanda semplice: come facciamo a scambiare informazioni senza perdere il significato lungo il percorso?'
            )}
          </p>
          <p className="marketing-reader-highlight">
            {t('Il protocollo è un accordo: stabilisce forma, ordine e significato dei messaggi.')}
          </p>
          <fieldset className="marketing-reader-actions">
            <legend className="marketing-visually-hidden">{t('Strumenti di studio')}</legend>
            <button type="button">
              <Highlighter aria-hidden="true" size={15} />
              {t('Evidenzia')}
            </button>
            <button type="button">
              <MessageCircle aria-hidden="true" size={15} />
              {t('Chiedi a Nous')}
            </button>
          </fieldset>
          <button className="marketing-reader-next" type="button">
            {t('Continua')}
            <ArrowRight aria-hidden="true" size={16} />
          </button>
        </article>
      </div>
    </section>
  );
}
