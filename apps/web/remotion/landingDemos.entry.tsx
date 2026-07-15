import { type AnyZodObject, Composition, Folder, registerRoot } from 'remotion';
import './landingDemos.fonts.css';
import './landingDemos.tailwind.generated.css';
import '../styles/app.css';
import '../components/marketing/marketing.css';
import {
  DEMO_MOBILE_HEIGHT,
  DEMO_MOBILE_WIDTH,
  LandingProductVideoFrame,
  type LandingProductVideoFrameProps,
} from '../components/marketing/LandingProductComposition.tsx';
import LandingProductJourney, {
  type LandingProductJourneyProps,
} from '../components/marketing/LandingProductJourney.tsx';
import {
  DEMO_FPS,
  DEMO_HEIGHT,
  DEMO_JOURNEY_DURATION_IN_FRAMES,
  DEMO_STAGE_CONFIG,
  DEMO_WIDTH,
} from '../components/marketing/landingDemoTimeline.ts';

const LOCALES = ['it', 'en'] as const;

const LandingDemoCompositions = () => (
  <>
    {LOCALES.map(locale => (
      <Composition<AnyZodObject, LandingProductJourneyProps>
        key={`journey-wide-${locale}`}
        id={`journey-wide-${locale}`}
        component={LandingProductJourney}
        durationInFrames={DEMO_JOURNEY_DURATION_IN_FRAMES}
        fps={DEMO_FPS}
        width={DEMO_WIDTH}
        height={DEMO_HEIGHT}
        defaultProps={{ locale, isCompact: false }}
      />
    ))}
    <Folder name="Stage-previews">
      {DEMO_STAGE_CONFIG.flatMap(({ stage, durationInFrames }) =>
        LOCALES.flatMap(locale => [
          <Composition<AnyZodObject, LandingProductVideoFrameProps>
            key={`${stage}-wide-${locale}`}
            id={`${stage}-wide-${locale}`}
            component={LandingProductVideoFrame}
            durationInFrames={durationInFrames}
            fps={DEMO_FPS}
            width={DEMO_WIDTH}
            height={DEMO_HEIGHT}
            defaultProps={{ stage, locale, isCompact: false }}
          />,
          <Composition<AnyZodObject, LandingProductVideoFrameProps>
            key={`${stage}-compact-${locale}`}
            id={`${stage}-compact-${locale}`}
            component={LandingProductVideoFrame}
            durationInFrames={durationInFrames}
            fps={DEMO_FPS}
            width={DEMO_MOBILE_WIDTH}
            height={DEMO_MOBILE_HEIGHT}
            defaultProps={{ stage, locale, isCompact: true }}
          />,
        ])
      )}
    </Folder>
  </>
);

registerRoot(LandingDemoCompositions);
