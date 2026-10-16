import * as z from 'zod';
import type { CapturedDom } from '../probes/pageProbes';

const selector = z.string().min(1);
export const findingEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    selector,
    quote: z
      .string()
      .min(1)
      .refine(quote => quote.trim().length > 0),
  }),
  z.object({ kind: z.literal('overlap'), selectors: z.tuple([selector, selector]) }),
  z.object({ kind: z.literal('element'), selector }),
]);
export type FindingEvidence = z.infer<typeof findingEvidenceSchema>;

/** Verify citations against this capture, never against model prose or a later live page. */
export function groundingFailure(evidence: FindingEvidence, dom: CapturedDom): string | undefined {
  if (evidence.kind !== 'overlap') {
    const element = dom.elements.find(element => element.selector === evidence.selector);
    if (!element) return 'The cited element is absent from the captured DOM.';
    if (evidence.kind === 'text' && !element.text.some(run => run.includes(evidence.quote)))
      return 'Quoted text is absent from the captured element.';
    return;
  }
  return overlapFailure(evidence.selectors, dom);
}

function overlapFailure(selectors: [string, string], dom: CapturedDom): string | undefined {
  const [a, b] = selectors.map(selector =>
    dom.elements.find(element => element.selector === selector)
  );
  if (!a || !b || a === b) return 'The overlap requires two distinct captured elements.';
  const overlap = dom.overlaps.find(
    fact =>
      (fact.a === a.selector && fact.b === b.selector) ||
      (fact.a === b.selector && fact.b === a.selector)
  );
  if (!overlap || overlap.areaPx <= 0 || !overlap.onTop || overlap.covered.length !== 1)
    return 'The captured geometry and stacking do not establish the claimed collision.';
  const top = dom.elements.find(element => element.selector === overlap.onTop);
  if (!top) return 'The stacking element is absent from the captured DOM.';
  const topWithin = (element: typeof a) =>
    top.selector === element.selector || top.ancestors.includes(element.selector);
  if (!topWithin(a) && !topWithin(b)) return 'A third element covers the cited pair.';
  const covered = overlap.covered[0] === a.selector ? a : b;
  const intentional = dom.elements.some(
    element =>
      element.overlay &&
      topWithin(element) &&
      covered.selector !== element.selector &&
      !covered.ancestors.includes(element.selector)
  );
  if (intentional) return 'The captured overlay intentionally covers content outside itself.';
}
