import { Series } from 'remotion';
import { LandingProductVideoFrame } from './LandingProductComposition.tsx';
import { DEMO_FPS, DEMO_STAGE_CONFIG } from './landingDemoTimeline.ts';

export interface LandingProductJourneyProps extends Record<string, unknown> {
  readonly isCompact: boolean;
  readonly locale?: 'en' | 'it';
}

export default function LandingProductJourney({ isCompact, locale }: LandingProductJourneyProps) {
  return (
    <Series>
      {DEMO_STAGE_CONFIG.map(({ durationInFrames, stage }) => (
        <Series.Sequence key={stage} durationInFrames={durationInFrames} premountFor={DEMO_FPS}>
          <LandingProductVideoFrame isCompact={isCompact} locale={locale} stage={stage} />
        </Series.Sequence>
      ))}
    </Series>
  );
}
