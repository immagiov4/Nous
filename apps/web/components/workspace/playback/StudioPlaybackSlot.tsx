import { Maximize, Minimize } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';

/** Keep the studio DOM and its playback clock mounted during fullscreen transitions. */
function useStudioFullscreen(studioLayout: boolean) {
  const studioSlot = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const slot = studioSlot.current;
    const syncFullscreen = () => setFullscreen(document.fullscreenElement === slot);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);
  useEffect(() => {
    if (!fullscreen) return;
    const leaveExpandedView = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.fullscreenElement) return;
      event.preventDefault();
      event.stopPropagation();
      setFullscreen(false);
    };
    document.addEventListener('keydown', leaveExpandedView, true);
    return () => document.removeEventListener('keydown', leaveExpandedView, true);
  }, [fullscreen]);
  useEffect(() => {
    if (!studioLayout && document.fullscreenElement === studioSlot.current) {
      void document.exitFullscreen();
    }
  }, [studioLayout]);
  if (!studioLayout && fullscreen) setFullscreen(false);
  const toggleFullscreen = async () => {
    const slot = studioSlot.current;
    if (!slot) return;
    if (fullscreen) {
      if (document.fullscreenElement === slot) await document.exitFullscreen();
      setFullscreen(false);
      return;
    }
    if (document.fullscreenEnabled) {
      try {
        await slot.requestFullscreen();
        const orientation = window.screen.orientation;
        if (orientation && 'lock' in orientation && typeof orientation.lock === 'function') {
          await Promise.resolve(orientation.lock('landscape')).catch(() => {
            // Browsers can require the learner to rotate the device manually.
          });
        }
        return;
      } catch {
        // Keep an expanded view within the listening dialog if the browser denies fullscreen.
      }
    }
    setFullscreen(true);
  };
  return { studioSlot, fullscreen, toggleFullscreen };
}

export function StudioPlaybackSlot({
  studioLayout,
  children,
}: {
  studioLayout: boolean;
  children: ReactNode;
}) {
  const { studioSlot, fullscreen, toggleFullscreen } = useStudioFullscreen(studioLayout);
  return (
    <div ref={studioSlot} className="scene-fit" data-studio-fullscreen={fullscreen || undefined}>
      {children}
      {studioLayout ? (
        <>
          {fullscreen ? (
            <p className="studio-rotate-hint">{t('Ruota il telefono per la vista orizzontale.')}</p>
          ) : null}
          <button
            type="button"
            className="studio-fullscreen-button"
            aria-label={t(fullscreen ? 'Esci da schermo intero' : 'Schermo intero')}
            onClick={() => void toggleFullscreen()}
          >
            {fullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
          </button>
        </>
      ) : null}
    </div>
  );
}
