import { describe, expect, it } from 'vitest';
import {
  type DiscardedFinding,
  type InspectorFinding,
  inspect,
  type StepProbeFinding,
} from '../src/inspector/inspect';
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
async function check(
  evidence: unknown,
  screen = observation,
  probeFindings: StepProbeFinding[] = []
) {
  const discarded: DiscardedFinding[] = [];
  const findings = await inspect({
    observations: [screen],
    learner: { outcome: 'completed', turns: [], diary: [], friction: [], observations: [screen] },
    probeFindings,
    styleReference: [],
    taxonomy: '',
    taxonomyClasses: ['D01'],
    judge: { judge: async () => [candidate(evidence)] },
    discarded,
  });
  return { findings, discarded };
}
describe('DOM-grounded inspector', () => {
  it('discards geometric probe defects from an unstable capture', async () => {
    const result = await check(
      undefined,
      { ...observation, diagnostics: { capture: { unstable: true } } },
      [
        {
          stepIndex: 0,
          screenshotPath: 'step.png',
          taxonomyClass: 'D01',
          threshold: 0,
          signal: {
            kind: 'clipped-text',
            selector: '#accent',
            text: 'Qualita',
            scrollWidth: 100,
            clientWidth: 10,
          },
        },
      ]
    );
    expect(result.findings).toEqual([]);
    expect(result.discarded).toContainEqual(
      expect.objectContaining({ reason: 'The DOM and screenshot capture was unstable.' })
    );
  });
  it('discards a spelling correction identical to the quoted DOM text', async () => {
    const result = await check({
      kind: 'text',
      selector: '#accent',
      quote: 'Qualita',
      replacement: 'Qualita',
    });
    expect(result.findings).toEqual([]);
    expect(result.discarded).toEqual([
      expect.objectContaining({
        reason: 'The proposed correction is identical to the quoted text.',
      }),
    ]);
  });
  it.each([
    'creareuna lezione',
    'percondensazione',
  ])('discards misread text %s and preserves the reason', async quote => {
    const result = await check({
      kind: 'text',
      selector: '#copy',
      quote,
      replacement: 'creare una lezione per condensazione',
    });
    expect(result.findings).toEqual([]);
    expect(result.discarded).toEqual([
      expect.objectContaining({
        reason: 'Quoted text is absent from the captured element.',
        finding: candidate({
          kind: 'text',
          selector: '#copy',
          quote,
          replacement: 'creare una lezione per condensazione',
        }),
      }),
    ]);
  });
  it('keeps the real missing accent when the quotation exists', async () => {
    const evidence = {
      kind: 'text',
      selector: '#accent',
      quote: 'Qualita',
      replacement: 'Qualità',
    };
    expect((await check(evidence)).findings).toEqual([
      { ...candidate(evidence), actual: evidence.quote, expected: evidence.replacement },
    ]);
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
      { kind: 'text', selector: '#missing', quote: 'Qualita', replacement: 'Qualità' },
      { kind: 'text', selector: '#accent', quote: '', replacement: 'Qualità' },
    ]) {
      expect((await check(evidence)).findings).toEqual([]);
    }
    expect(
      (
        await check(
          { kind: 'text', selector: '#accent', quote: 'Qualita', replacement: 'Qualità' },
          { ...observation, diagnostics: { capture: { unstable: true } } }
        )
      ).findings
    ).toEqual([]);
  });
});
