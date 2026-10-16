import { describe, expect, it } from 'vitest';
import { type DiscardedFinding, type InspectorFinding, inspect } from '../src/inspector/inspect';
import type { Observation } from '../src/operator/session';

// Synthetic captured DOM: no private course or run data.
const dom = {
  elements: [
    {
      selector: '#copy',
      text: ['creare una lezione per condensazione'],
      box: { left: 0, top: 0, right: 300, bottom: 100 },
      ancestors: [],
      overlay: false,
    },
    {
      selector: '#accent',
      text: ['Qualita'],
      box: { left: 0, top: 120, right: 100, bottom: 140 },
      ancestors: [],
      overlay: false,
    },
    {
      selector: '#dialog',
      text: ['Accedi'],
      box: { left: 0, top: 0, right: 200, bottom: 100 },
      ancestors: [],
      overlay: true,
    },
    {
      selector: '#menu',
      text: ['Corsi'],
      box: { left: 0, top: 0, right: 200, bottom: 100 },
      ancestors: [],
      overlay: true,
    },
    {
      selector: '#first',
      text: ['First'],
      box: { left: 10, top: 10, right: 100, bottom: 30 },
      ancestors: ['#dialog'],
      overlay: false,
    },
    {
      selector: '#second',
      text: ['Second'],
      box: { left: 20, top: 10, right: 100, bottom: 30 },
      ancestors: ['#dialog'],
      overlay: false,
    },
  ],
  overlaps: [
    {
      kind: 'overlap',
      a: '#copy',
      b: '#dialog',
      areaPx: 20000,
      covered: ['#copy'],
      onTop: '#dialog',
    },
    { kind: 'overlap', a: '#copy', b: '#menu', areaPx: 20000, covered: ['#copy'], onTop: '#menu' },
    {
      kind: 'overlap',
      a: '#first',
      b: '#second',
      areaPx: 1600,
      covered: ['#first'],
      onTop: '#second',
    },
  ],
};
const observation = {
  stepIndex: 0,
  url: 'https://example.test',
  screenshotPath: 'step.png',
  nodes: [],
  dom,
} as Observation;
function candidate(evidence: unknown): InspectorFinding {
  return {
    source: 'judge',
    taxonomyClass: 'D01',
    title: 'Claim',
    trigger: 'Open',
    expected: 'Readable',
    actual: 'Claimed defect',
    stepIndex: 0,
    screenshotPath: 'step.png',
    evidence,
  } as InspectorFinding;
}
async function check(evidence: unknown, screen = observation) {
  const discarded: DiscardedFinding[] = [];
  const findings = await inspect({
    observations: [screen],
    learner: { outcome: 'completed', turns: [], diary: [], friction: [], observations: [screen] },
    probeFindings: [],
    styleReference: [],
    taxonomy: '',
    taxonomyClasses: ['D01'],
    judge: { judge: async () => [candidate(evidence)] },
    discarded,
  });
  return { findings, discarded };
}
describe('DOM-grounded inspector', () => {
  it.each([
    'creareuna lezione',
    'percondensazione',
  ])('discards misread text %s and preserves the reason', async quote => {
    const result = await check({ kind: 'text', selector: '#copy', quote });
    expect(result.findings).toEqual([]);
    expect(result.discarded).toEqual([
      expect.objectContaining({
        reason: 'Quoted text is absent from the captured element.',
        finding: candidate({ kind: 'text', selector: '#copy', quote }),
      }),
    ]);
  });
  it('keeps the real missing accent when the quotation exists', async () => {
    const evidence = { kind: 'text', selector: '#accent', quote: 'Qualita' };
    expect((await check(evidence)).findings).toEqual([candidate(evidence)]);
  });
  it.each(['#dialog', '#menu'])('discards an intentional overlay %s', async selector => {
    const result = await check({ kind: 'overlap', selectors: ['#copy', selector] });
    expect(result.findings).toEqual([]);
    expect(result.discarded).toEqual([
      expect.objectContaining({
        reason: 'The captured overlay intentionally covers content outside itself.',
      }),
    ]);
  });
  it('keeps a measured collision inside a dialog', async () => {
    const evidence = { kind: 'overlap', selectors: ['#first', '#second'] };
    expect((await check(evidence)).findings).toEqual([candidate(evidence)]);
  });
  it('discards nonintersecting or unmeasured pairs', async () => {
    expect((await check({ kind: 'overlap', selectors: ['#accent', '#dialog'] })).findings).toEqual(
      []
    );
  });
  it('discards absent citations, unknown selectors and unstable captures', async () => {
    for (const evidence of [
      undefined,
      { kind: 'text', selector: '#missing', quote: 'Qualita' },
      { kind: 'text', selector: '#accent', quote: '' },
    ]) {
      expect((await check(evidence)).findings).toEqual([]);
    }
    expect(
      (
        await check(
          { kind: 'text', selector: '#accent', quote: 'Qualita' },
          { ...observation, diagnostics: { capture: { unstable: true } } }
        )
      ).findings
    ).toEqual([]);
  });
});
