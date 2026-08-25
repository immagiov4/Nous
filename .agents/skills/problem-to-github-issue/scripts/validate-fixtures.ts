type SourceKind =
  | 'reported'
  | 'verified'
  | 'diagnostic-limit'
  | 'hypothesis'
  | 'option'
  | 'decision'
  | 'unknown';

type Placement =
  | 'problem'
  | 'desiredOutcome'
  | 'direction'
  | 'observedEvidence'
  | 'reproduction'
  | 'hypotheses'
  | 'observabilityGaps'
  | 'decisionsAlreadyMade'
  | 'unknownsAndDecisionsNeeded'
  | 'openQuestions'
  | 'acceptanceCriteria'
  | 'scope'
  | 'outOfScope'
  | 'verification'
  | 'dependencies'
  | 'invariant'
  | 'currentConstraint';

interface SourceStatement {
  id: string;
  text: string;
  kind: SourceKind;
  approved?: boolean;
  blocking?: boolean;
}

interface ContractFixture {
  name: string;
  readyForAgent: boolean;
  labels: string[];
  sources: SourceStatement[];
  draftBody: string;
  expectedErrors: string[];
}

const PLACEMENTS: Placement[] = [
  'problem',
  'desiredOutcome',
  'direction',
  'observedEvidence',
  'reproduction',
  'hypotheses',
  'observabilityGaps',
  'decisionsAlreadyMade',
  'unknownsAndDecisionsNeeded',
  'openQuestions',
  'acceptanceCriteria',
  'scope',
  'outOfScope',
  'verification',
  'dependencies',
  'invariant',
  'currentConstraint',
];

const SECTION_HEADINGS: Record<Placement, string> = {
  problem: 'Problem',
  desiredOutcome: 'Desired outcome',
  direction: 'Direction',
  observedEvidence: 'Observed evidence',
  reproduction: 'Reproduction',
  hypotheses: 'Hypotheses',
  observabilityGaps: 'Observability gaps',
  decisionsAlreadyMade: 'Decisions already made',
  unknownsAndDecisionsNeeded: 'Unknowns and decisions needed',
  openQuestions: 'Open questions',
  acceptanceCriteria: 'Acceptance criteria',
  scope: 'Scope',
  outOfScope: 'Out of scope',
  verification: 'Verification',
  dependencies: 'Dependencies',
  invariant: 'Invariant',
  currentConstraint: 'Current constraint',
};

const REQUIRED_AGENT_BRIEF_FIELDS = [
  { heading: 'Summary', key: 'summary' },
  { heading: 'Desired behavior', key: 'desiredBehavior' },
  { heading: 'Acceptance criteria', key: 'acceptanceCriteria' },
];

const AGENT_BRIEF_ALLOWED_KINDS: Record<string, SourceKind[]> = {
  Summary: ['reported', 'verified', 'diagnostic-limit', 'decision', 'option'],
  'Current behavior': ['verified', 'diagnostic-limit'],
  'Desired behavior': ['decision', 'option'],
  'Key contracts and decisions': ['decision', 'option'],
  'Acceptance criteria': ['decision', 'option'],
  'Out of scope': ['decision', 'option'],
  Dependencies: ['verified', 'decision'],
  Verification: ['decision', 'option'],
};

const AGENT_BRIEF_METADATA_FIELDS = new Set(['Category']);

const allowedPlacements = (source: SourceStatement): Placement[] => {
  switch (source.kind) {
    case 'reported':
      return ['problem'];
    case 'verified':
      return ['problem', 'observedEvidence', 'reproduction', 'dependencies'];
    case 'diagnostic-limit':
      return ['observedEvidence', 'observabilityGaps'];
    case 'hypothesis':
      return ['hypotheses'];
    case 'option':
      return source.approved
        ? [
            'desiredOutcome',
            'decisionsAlreadyMade',
            'acceptanceCriteria',
            'scope',
            'outOfScope',
            'verification',
            'dependencies',
            'invariant',
            'currentConstraint',
          ]
        : ['direction', 'unknownsAndDecisionsNeeded', 'openQuestions'];
    case 'decision':
      return [
        'desiredOutcome',
        'decisionsAlreadyMade',
        'acceptanceCriteria',
        'scope',
        'outOfScope',
        'verification',
        'dependencies',
        'invariant',
        'currentConstraint',
      ];
    case 'unknown':
      return ['unknownsAndDecisionsNeeded', 'openQuestions'];
  }
};

const readSections = (draftBody: string): Map<string, string> => {
  const sections = new Map<string, string>();
  let heading = '';

  for (const line of draftBody.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      heading = line.slice(3).trim();
      sections.set(heading, '');
      continue;
    }
    if (heading) sections.set(heading, `${sections.get(heading)}\n${line}`);
  }

  return sections;
};

const readSubsections = (section: string): Map<string, string> => {
  const subsections = new Map<string, string>();
  let heading = '';

  for (const line of section.split(/\r?\n/)) {
    if (line.startsWith('### ')) {
      heading = line.slice(4).trim();
      subsections.set(heading, '');
      continue;
    }
    if (heading) subsections.set(heading, `${subsections.get(heading)}\n${line}`);
  }

  return subsections;
};

const validateFixture = (fixture: ContractFixture): string[] => {
  const errors: string[] = [];
  const placementsById = new Map<string, Placement[]>();
  const agentBriefSourceIds = new Set<string>();
  const sections = readSections(fixture.draftBody);

  for (const heading of sections.keys()) {
    if (heading !== 'Agent brief' && !Object.values(SECTION_HEADINGS).includes(heading)) {
      errors.push(`unknown-section:${heading}`);
    }
  }

  for (const placement of PLACEMENTS) {
    const section = sections.get(SECTION_HEADINGS[placement]);
    if (!section) continue;

    for (const line of section
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(Boolean)) {
      if (!line.startsWith('- ')) {
        errors.push(`unclassified:${placement}`);
        continue;
      }

      const statement = line.slice(2).trim();
      const source = fixture.sources.find(candidate => candidate.text === statement);
      if (!source) {
        errors.push(`unclassified:${placement}`);
        continue;
      }

      const existing = placementsById.get(source.id) ?? [];
      existing.push(placement);
      placementsById.set(source.id, existing);

      if (!allowedPlacements(source).includes(placement)) {
        errors.push(`misplaced:${source.id}:${placement}`);
      }
    }
  }

  if (fixture.readyForAgent) {
    if (!fixture.labels.includes('ready-for-agent')) errors.push('missing-ready-label');
    const agentBrief = sections.get('Agent brief');
    if (!agentBrief) {
      errors.push('missing-agent-brief');
    } else {
      const fields = readSubsections(agentBrief);
      for (const field of REQUIRED_AGENT_BRIEF_FIELDS) {
        if (!fields.has(field.heading)) errors.push(`missing-agent-brief:${field.key}`);
      }
      for (const [heading, content] of fields) {
        if (!content.trim()) {
          const field = REQUIRED_AGENT_BRIEF_FIELDS.find(
            candidate => candidate.heading === heading
          );
          errors.push(`empty-agent-brief:${field?.key ?? heading}`);
          continue;
        }

        const allowedKinds = AGENT_BRIEF_ALLOWED_KINDS[heading];
        if (!allowedKinds) {
          if (!AGENT_BRIEF_METADATA_FIELDS.has(heading)) {
            errors.push(`unknown-agent-brief-field:${heading}`);
          }
          continue;
        }

        for (const line of content
          .split(/\r?\n/)
          .map(value => value.trim())
          .filter(Boolean)) {
          const fieldKey =
            REQUIRED_AGENT_BRIEF_FIELDS.find(candidate => candidate.heading === heading)?.key ??
            heading;
          if (!line.startsWith('- ')) {
            errors.push(`unclassified-agent-brief:${fieldKey}`);
            continue;
          }

          const statement = line.slice(2).trim();
          const source = fixture.sources.find(candidate => candidate.text === statement);
          if (!source) {
            errors.push(`unclassified-agent-brief:${fieldKey}`);
            continue;
          }

          agentBriefSourceIds.add(source.id);
          const disallowedOption = source.kind === 'option' && !source.approved;
          if (!allowedKinds.includes(source.kind) || disallowedOption) {
            errors.push(`misplaced-agent-brief:${source.id}:${fieldKey}`);
          }
        }
      }
    }
  } else {
    if (fixture.labels.includes('ready-for-agent')) errors.push('unexpected-ready-label');
    if (sections.has('Agent brief')) errors.push('unexpected-agent-brief');
  }

  for (const source of fixture.sources) {
    const placements = placementsById.get(source.id) ?? [];
    if (placements.length === 0 && !agentBriefSourceIds.has(source.id)) {
      errors.push(`unplaced:${source.id}`);
    }
    if (placements.length > 1) errors.push(`duplicate-placement:${source.id}`);

    if (
      fixture.readyForAgent &&
      source.blocking &&
      (source.kind === 'option' || source.kind === 'unknown') &&
      !source.approved
    ) {
      errors.push(`open-decision-ready:${source.id}`);
    }
  }

  return errors.sort();
};

const fixturesUrl = new URL('../fixtures/contracts.json', import.meta.url);
const fixtures = (await Bun.file(fixturesUrl).json()) as ContractFixture[];
const failures: string[] = [];

for (const fixture of fixtures) {
  const actual = validateFixture(fixture);
  const expected = [...fixture.expectedErrors].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `${fixture.name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`
    );
  }
}

if (failures.length > 0) {
  throw new Error(`Issue contract fixture failures:\n${failures.join('\n')}`);
}

console.log(`Validated ${fixtures.length} issue contract fixtures.`);
