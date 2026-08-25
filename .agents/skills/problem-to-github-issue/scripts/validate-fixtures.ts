type SourceKind =
  | 'verified'
  | 'diagnostic-limit'
  | 'hypothesis'
  | 'option'
  | 'decision'
  | 'unknown';

type Placement =
  | 'desiredOutcome'
  | 'observedEvidence'
  | 'hypotheses'
  | 'unknownsAndDecisionsNeeded'
  | 'acceptanceCriteria';

interface SourceStatement {
  id: string;
  text: string;
  kind: SourceKind;
  approved?: boolean;
  blocking?: boolean;
}

interface AgentBrief {
  category?: string[];
  summary: string[];
  currentBehavior?: string[];
  desiredBehavior: string[];
  contracts?: string[];
  acceptanceCriteria: string[];
  outOfScope?: string[];
  dependencies?: string[];
  verification?: string[];
}

interface ContractFixture {
  name: string;
  targetLanguage: string;
  readyForAgent: boolean;
  sources: SourceStatement[];
  draftBody: string;
  agentBrief?: AgentBrief;
  expectedErrors: string[];
}

const PLACEMENTS: Placement[] = [
  'desiredOutcome',
  'observedEvidence',
  'hypotheses',
  'unknownsAndDecisionsNeeded',
  'acceptanceCriteria',
];

const SECTION_HEADINGS: Record<Placement, string> = {
  desiredOutcome: 'Desired outcome',
  observedEvidence: 'Observed evidence',
  hypotheses: 'Hypotheses',
  unknownsAndDecisionsNeeded: 'Unknowns and decisions needed',
  acceptanceCriteria: 'Acceptance criteria',
};

const REQUIRED_AGENT_BRIEF_FIELDS: (keyof AgentBrief)[] = [
  'summary',
  'desiredBehavior',
  'acceptanceCriteria',
];

const AGENT_BRIEF_FIELDS: (keyof AgentBrief)[] = [
  'category',
  'summary',
  'currentBehavior',
  'desiredBehavior',
  'contracts',
  'acceptanceCriteria',
  'outOfScope',
  'dependencies',
  'verification',
];

const allowedPlacements = (source: SourceStatement): Placement[] => {
  switch (source.kind) {
    case 'verified':
    case 'diagnostic-limit':
      return ['observedEvidence'];
    case 'hypothesis':
      return ['hypotheses'];
    case 'option':
      return source.approved
        ? ['desiredOutcome', 'acceptanceCriteria']
        : ['unknownsAndDecisionsNeeded'];
    case 'decision':
      return ['desiredOutcome', 'acceptanceCriteria'];
    case 'unknown':
      return ['unknownsAndDecisionsNeeded'];
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

const validateFixture = (fixture: ContractFixture): string[] => {
  const errors: string[] = [];
  const placementsById = new Map<string, Placement[]>();
  const sections = readSections(fixture.draftBody);

  if (fixture.targetLanguage !== 'en') errors.push(`target-language:${fixture.targetLanguage}`);

  for (const source of fixture.sources) {
    for (const placement of PLACEMENTS) {
      const section = sections.get(SECTION_HEADINGS[placement]);
      if (!section?.includes(source.text)) continue;

      const existing = placementsById.get(source.id) ?? [];
      existing.push(placement);
      placementsById.set(source.id, existing);

      if (!allowedPlacements(source).includes(placement)) {
        errors.push(`misplaced:${source.id}:${placement}`);
      }
    }
  }

  for (const source of fixture.sources) {
    const placements = placementsById.get(source.id) ?? [];
    if (placements.length === 0) errors.push(`unplaced:${source.id}`);
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

  if (fixture.readyForAgent) {
    if (!fixture.agentBrief) {
      errors.push('missing-agent-brief');
    } else {
      for (const field of REQUIRED_AGENT_BRIEF_FIELDS) {
        if (!fixture.agentBrief[field]) errors.push(`missing-agent-brief:${field}`);
      }
      for (const field of AGENT_BRIEF_FIELDS) {
        if (fixture.agentBrief[field]?.length === 0) errors.push(`empty-agent-brief:${field}`);
      }
    }
  } else if (fixture.agentBrief) {
    errors.push('unexpected-agent-brief');
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
