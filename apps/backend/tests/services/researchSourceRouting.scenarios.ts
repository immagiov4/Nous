import type {
  ResearchSourceRoutingInput,
  ResearchSourceType,
} from '../../src/services/researchSourceRouting.js';

export const researchRoutingScenarios: Array<{
  name: string;
  level: ResearchSourceRoutingInput['level'];
  topic: string;
  learningContext: string;
  sourceContext: string;
  suppliedSourcesSufficient: boolean;
  selected: ResearchSourceType[];
  skipped: ResearchSourceType[];
}> = [
  {
    name: 'historical theory with sufficient academic material',
    level: 'lesson',
    topic: 'Condensation in Freud’s historical theory of dream-work',
    learningContext:
      'Explain only the historical theory in the supplied chapter. The objective is textual interpretation, with no modern clinical claims or applications.',
    sourceContext:
      'Academic source: Sigmund Freud, The Interpretation of Dreams, chapter VI, supplied in full for this focused lesson. Dream-work transforms latent thoughts into manifest content. Condensation combines several latent associations in one manifest element. The chapter supplies definitions, the Irma example and the distinction from displacement. The accompanying scholarly commentary defines each term, provides the historical setting and explains the example step by step. All facts and examples required by this lesson are covered.',
    selected: [],
    suppliedSourcesSufficient: true,
    skipped: ['web', 'youtube'],
  },
  {
    name: 'changing API requires current verification',
    level: 'lesson',
    topic: 'Migrating a React application to the currently supported React API',
    learningContext:
      'Verify the currently supported APIs, current deprecations and migration instructions. The learner requests a text-only API reference comparison, without video or implementation demonstrations.',
    sourceContext:
      'A supplied React 16 book describes class lifecycle methods, legacy context and ReactDOM.render. It does not cover releases after React 16.',
    selected: ['web'],
    suppliedSourcesSufficient: false,
    skipped: ['youtube'],
  },
  {
    name: 'algorithm movement benefits from video',
    level: 'lesson',
    topic: 'Binary search: how the candidate interval shrinks',
    learningContext:
      'The learner cannot follow static interval diagrams and explicitly asks for a narrated video showing pointer motion step by step in a sorted array. Teach only this common algorithm.',
    sourceContext:
      'Textbook pseudocode and invariant: if the target is present it lies in the current closed interval. Compare its midpoint and keep the possible half. The source contains only text and no animation.',
    selected: ['youtube'],
    suppliedSourcesSufficient: true,
    // The live evaluation requires video; a supplementary web lookup is unconstrained.
    skipped: [],
  },
  {
    name: 'narrow primary scientific evidence',
    level: 'lesson',
    topic: 'Interpreting the confidence interval in one supplied 2019 isotope measurement',
    learningContext:
      'Explain the stated result and uncertainty propagation for this exact historical experiment. The complete paper, methods and data table are supplied. No literature update, general demonstration or contemporary comparison is requested.',
    sourceContext:
      'The peer-reviewed paper reports a ratio of 0.7120 with standard uncertainty 0.0004. The methods define calibration, repeatability and independent error propagation. The supplementary table provides each replicate and the calibration reference. The authors state the assumptions and limitations. The lesson needs only the reported ratio, meaning of uncertainty and how the supplied components combine.',
    selected: [],
    suppliedSourcesSufficient: true,
    skipped: ['web', 'youtube'],
  },
  {
    name: 'contemporary practice with only available factual channels',
    level: 'course',
    topic: 'Current practices for operating a small web service in production',
    learningContext:
      'Build a course around current operational failure modes and current authoritative service documentation. Community case studies would be useful if that capability were available. Video demonstrations are unnecessary for this text-based incident analysis course.',
    sourceContext: '',
    selected: ['web'],
    suppliedSourcesSufficient: false,
    skipped: ['youtube'],
  },
];
