import * as z from 'zod';

export const HEAP_MAX_BEATS = 24;

export const HeapSpecSchema = z.object({
  input: z.array(z.number()).min(1).max(10),
  beats: z.array(z.object({ event: z.string() })).max(HEAP_MAX_BEATS),
});
export type HeapSpec = z.infer<typeof HeapSpecSchema>;

export function checkHeapBeats({ input, beats }: HeapSpec) {
  const trace = heapTrace(input);
  let last = -1;
  for (const { event } of beats) {
    const index = trace.findIndex(step => step.event === event && step.largerChild === undefined);
    if (index <= last) throw new Error('Heap cue must name a computed event in order: ' + event);
    last = index;
  }
}

type Step = {
  event: string;
  order: number[];
  focus: number[];
  size: number;
  largerChild?: number;
  extracted?: number;
};

export function heapTrace(input: number[]) {
  const order = input.map((_, index) => index);
  const steps: Step[] = [{ event: 'start', order: [...order], focus: [], size: order.length }];
  let sifts = 0;
  let comparisons = 0;
  function swap(parent: number, child: number) {
    [order[parent], order[child]] = [order[child], order[parent]];
  }
  function sift(parent: number, size: number) {
    while (parent * 2 + 1 < size) {
      const left = parent * 2 + 1;
      const right = left + 1;
      const larger = right < size && input[order[right]] > input[order[left]] ? right : left;
      steps.push({
        event: 'compare#' + ++comparisons,
        order: [...order],
        size,
        focus: order.slice(left, Math.min(right + 1, size)).concat(order[parent]),
        largerChild: order[larger],
      });
      if (input[order[parent]] >= input[order[larger]]) break;
      const focus = [order[parent], order[larger]];
      swap(parent, larger);
      steps.push({ event: 'sift#' + ++sifts, order: [...order], focus, size });
      parent = larger;
    }
  }
  for (let parent = Math.floor(order.length / 2) - 1; parent >= 0; parent--)
    sift(parent, order.length);
  steps.push({ event: 'heapified', order: [...order], focus: [order[0]], size: order.length });
  for (let last = order.length - 1; last >= 0; last--) {
    const focus = [...new Set([order[0], order[last]])];
    swap(0, last);
    steps.push({
      event: 'extract#' + (order.length - last),
      order: [...order],
      focus,
      size: last,
      extracted: order[last],
    });
    if (last) sift(0, last);
  }
  steps.push({ event: 'done', order: [...order], focus: [...order], size: 0 });
  return steps;
}
