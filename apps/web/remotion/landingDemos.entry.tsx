import { type AnyZodObject, Composition, registerRoot } from 'remotion';
import './landingDemos.fonts.css';
import './landingDemos.tailwind.generated.css';
import '../styles/app.css';
import '../components/marketing/marketing.css';
import {
  DEMO_HEIGHT,
  DEMO_MOBILE_HEIGHT,
  DEMO_MOBILE_WIDTH,
  DEMO_WIDTH,
  LandingProductVideoFrame,
  type LandingProductVideoFrameProps,
} from '../components/marketing/LandingProductComposition.tsx';
import { DEMO_FPS, DEMO_STAGE_CONFIG } from '../components/marketing/landingDemoTimeline.ts';

const LOCALES = ['it', 'en'] as const;

const LandingDemoCompositions = () => (
  <>
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
  </>
);

registerRoot(LandingDemoCompositions);
