import { arrayBeatCopy as copy } from './array-algorithm.copy.it';
import { type ArraySpec, arrayTrace } from './arrayAlgorithm';
import { formatOperand } from './chart';

/** The cue and its spoken values come from the same trace the renderer uses. */
export function planArrayBeats(spec: ArraySpec) {
  return arrayTrace(spec).flatMap((event, index, events) => {
    const [left, right] = event.focus.map(id => formatOperand(spec.input[id]));
    const values = (ids: number[]) => ids.map(id => formatOperand(spec.input[id])).join(', ');
    const target = spec.target === undefined ? '' : formatOperand(spec.target);
    let sentence: string;
    let targets = event.focus;
    switch (event.kind) {
      case 'compare':
        sentence = copy.compare(left, right ?? target);
        break;
      case 'swap':
        sentence = copy.swap(right, left);
        break;
      case 'pass-end':
      case 'no-swap-pass':
        targets = event.confirmed;
        sentence = copy.checked(values(targets));
        break;
      case 'done':
        if (index === 0 || events[index - 1].kind === 'no-swap-pass') return [];
        targets = event.order;
        sentence = copy.done(values(targets));
        break;
      case 'found':
        sentence = copy.found(target);
        break;
      case 'not-found':
        targets = event.order;
        sentence = copy.missing(target);
        break;
      default:
        return [];
    }
    return [{ event: event.aliases[0], sentence, targets: targets.map(String) }];
  });
}
