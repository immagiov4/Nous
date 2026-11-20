import * as z from 'zod';

type Event = {
  kind: string;
  aliases: string[];
  order: number[];
  focus: number[];
  confirmed: number[];
  comparisons: number;
  swaps: number;
  pass: number;
  search?: { low: number; mid: number; high: number };
};

export const ArraySpecSchema = z.object({
  algorithm: z.enum(['bubble', 'insertion', 'selection', 'binary-search']),
  input: z.array(z.number()).min(1).max(10),
  target: z.number().optional(),
  callouts: z.array(z.object({ event: z.string().min(1).regex(/\S/u) })),
});

export type ArraySpec = z.infer<typeof ArraySpecSchema>;

type SortSteps = {
  order: number[];
  confirmed: Set<number>;
  compare: (left: number, right: number) => boolean;
  swap: (left: number, right: number) => void;
  pass: (noSwap?: boolean) => void;
  swapCount: () => number;
};

function bubble({ order, confirmed, compare, swap, pass, swapCount }: SortSteps) {
  for (let end = order.length - 1; end > 0; end--) {
    const previousSwaps = swapCount();
    for (let i = 0; i < end; i++) if (compare(i, i + 1)) swap(i, i + 1);
    confirmed.add(order[end]);
    const noSwap = previousSwaps === swapCount();
    if (noSwap) for (const id of order) confirmed.add(id);
    pass(noSwap);
    if (noSwap) break;
  }
}

function insertion({ order, confirmed, compare, swap, pass }: SortSteps) {
  for (let i = 1; i < order.length; i++) {
    for (let j = i; j > 0 && compare(j - 1, j); j--) swap(j - 1, j);
    for (const id of order.slice(0, i + 1)) confirmed.add(id);
    pass();
  }
}

function selection({ order, confirmed, compare, swap, pass }: SortSteps) {
  for (let i = 0; i < order.length - 1; i++) {
    let minimum = i;
    for (let j = i + 1; j < order.length; j++) if (compare(minimum, j)) minimum = j;
    if (minimum !== i) swap(i, minimum);
    confirmed.add(order[i]);
    pass();
  }
}

const sorts = { bubble, insertion, selection };

export function arrayTrace({ algorithm, input, target }: ArraySpec) {
  const order = input.map((_, index) => index);
  const confirmed = new Set<number>();
  const events: Event[] = [];
  let comparisons = 0;
  let swaps = 0;
  let passes = 0;
  let search: Event['search'];
  const emit = (kind: string, focus: number[] = [], aliases: string[] = []) =>
    events.push({
      kind,
      aliases,
      focus: focus.map(index => order[index]),
      order: [...order],
      confirmed: [...confirmed],
      comparisons,
      swaps,
      pass: passes + Number(!kind.endsWith('pass') && kind !== 'pass-end' && kind !== 'done'),
      search,
    });
  const compare = (left: number, right: number) => {
    emit('compare', [left, right], [`compare#${++comparisons}`]);
    return input[order[left]] > input[order[right]];
  };
  const swap = (left: number, right: number) => {
    [order[left], order[right]] = [order[right], order[left]];
    emit('swap', [left, right], [`swap#${++swaps}`]);
  };
  const pass = (noSwap = false) =>
    emit(
      noSwap ? 'no-swap-pass' : 'pass-end',
      [],
      [`pass-end#${++passes}`, ...(noSwap ? ['no-swap-pass'] : [])]
    );

  function searchForTarget() {
    if (target === undefined) throw new Error('Binary search requires target');
    if (input.some((value, index) => index > 0 && value < input[index - 1]))
      throw new Error('Binary search requires ascending input');
    let left = 0;
    let right = order.length - 1;
    while (left <= right) {
      const middle = Math.floor((left + right) / 2);
      search = { low: left, mid: middle, high: right };
      emit('compare', [middle], [`compare#${++comparisons}`]);
      if (input[middle] === target) {
        confirmed.add(order[middle]);
        emit('found', [middle], ['found', 'done']);
        return;
      }
      if (input[middle] < target) left = middle + 1;
      else right = middle - 1;
    }
    search = undefined;
    emit('not-found', [], ['not-found', 'done']);
  }

  if (algorithm === 'binary-search') {
    searchForTarget();
    return events;
  }
  sorts[algorithm]({ order, confirmed, compare, swap, pass, swapCount: () => swaps });
  for (const id of order) confirmed.add(id);
  emit('done', [], ['done']);
  return events;
}

export function calloutIndices(spec: ArraySpec, events = arrayTrace(spec)) {
  let previous = -1;
  return spec.callouts.map(({ event }) => {
    const index = events.findIndex(step => step.aliases.includes(event));
    if (index < 0) throw new Error(`Trace event does not occur: ${event}`);
    if (index <= previous) throw new Error(`Trace event out of order or duplicated: ${event}`);
    previous = index;
    return index;
  });
}
