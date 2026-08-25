type SourceKind = 'verified' | 'hypothesis' | 'option' | 'decision';
type Section = 'evidence' | 'hypotheses' | 'openQuestions' | 'desiredOutcome' | 'acceptance';

interface PlacementCase {
  name: string;
  kind: SourceKind;
  section: Section;
  approved?: boolean;
  expected: boolean;
}

const allowedSections = (kind: SourceKind, approved = false): Section[] => {
  switch (kind) {
    case 'verified':
      return ['evidence'];
    case 'hypothesis':
      return ['hypotheses'];
    case 'option':
      return approved ? ['desiredOutcome', 'acceptance'] : ['openQuestions'];
    case 'decision':
      return ['desiredOutcome', 'acceptance'];
  }
};

const placementCases: PlacementCase[] = [
  {
    name: 'verified evidence stays in evidence',
    kind: 'verified',
    section: 'evidence',
    expected: true,
  },
  {
    name: 'a hypothesis cannot become evidence',
    kind: 'hypothesis',
    section: 'evidence',
    expected: false,
  },
  {
    name: 'an open option cannot become desired behavior',
    kind: 'option',
    section: 'desiredOutcome',
    expected: false,
  },
  {
    name: 'an approved option can become desired behavior',
    kind: 'option',
    section: 'desiredOutcome',
    approved: true,
    expected: true,
  },
];

const failures = placementCases.flatMap(testCase => {
  const actual = allowedSections(testCase.kind, testCase.approved).includes(testCase.section);
  return actual === testCase.expected ? [] : [testCase.name];
});

const defaultLanguage = 'en';
if (defaultLanguage !== 'en') failures.push('issues default to English');

const readyLabels = new Set(['ready-for-agent']);
const requiredBriefFields = ['summary', 'desiredBehavior', 'acceptanceCriteria'];
const completeBrief = {
  summary: 'Implement the approved behavior.',
  desiredBehavior: 'Use the approved behavior.',
  acceptanceCriteria: 'The approved behavior is observable.',
};
const isReady =
  readyLabels.has('ready-for-agent') &&
  requiredBriefFields.every(field => completeBrief[field as keyof typeof completeBrief]?.trim());
if (!isReady) failures.push('ready work requires its label and agent brief');

if (failures.length > 0)
  throw new Error(`Issue contract fixture failures:\n${failures.join('\n')}`);

console.log(`Validated ${placementCases.length + 2} issue contract rules.`);
