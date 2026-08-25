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

interface ContractFixture {
  name: string;
  targetLanguage: string;
  readyForAgent: boolean;
  sources: SourceStatement[];
  draftBody: string;
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

const REQUIRED_AGENT_BRIEF_FIELDS = [
  { heading: 'Summary', key: 'summary' },
  { heading: 'Desired behavior', key: 'desiredBehavior' },
  { heading: 'Acceptance criteria', key: 'acceptanceCriteria' },
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
  const sections = readSections(fixture.draftBody);

  if (fixture.targetLanguage !== 'en') errors.push(`target-language:${fixture.targetLanguage}`);

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
        }
      }
    }
  } else if (sections.has('Agent brief')) {
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
