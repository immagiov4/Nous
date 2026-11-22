type Evaluate = (x: number, params: Record<string, number>) => number;
type Interval = readonly [number, number];
type Bounds = (x: Interval, params: Record<string, number>) => Interval;
type Expression = { evaluate: Evaluate; bounds: Bounds };
const functions = { sin: Math.sin, cos: Math.cos, exp: Math.exp, sqrt: Math.sqrt, abs: Math.abs };
const operators = {
  '+': (a: number, b: number) => a + b,
  '-': (a: number, b: number) => a - b,
  '*': (a: number, b: number) => a * b,
  '/': (a: number, b: number) => a / b,
  '^': (a: number, b: number) => a ** b,
};
type Operator = keyof typeof operators;
const precedence = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 4 };

const unbounded: Interval = [-Infinity, Infinity];
const boundsOf = (values: number[]): Interval => [Math.min(...values), Math.max(...values)];

function operatorBounds(operator: Operator, [a, b]: Interval, [c, d]: Interval): Interval {
  switch (operator) {
    case '+':
      return [a + c, b + d];
    case '-':
      return [a - d, b - c];
    case '*':
      return boundsOf([a * c, a * d, b * c, b * d]);
    case '/':
      return c <= 0 && d >= 0 ? unbounded : boundsOf([a / c, a / d, b / c, b / d]);
    case '^': {
      if (c !== d || !Number.isSafeInteger(c) || c < 0) return unbounded;
      const ends = [a ** c, b ** c];
      if (c > 0 && a <= 0 && b >= 0) ends.push(0);
      return boundsOf(ends);
    }
  }
}

function functionBounds(name: keyof typeof functions, [lo, hi]: Interval): Interval {
  const evaluate = functions[name];
  if (name === 'sin' || name === 'cos') {
    const start = evaluate(lo);
    const span = hi - lo;
    return [Math.max(-1, start - span), Math.min(1, start + span)];
  }
  const ends = [evaluate(lo), evaluate(hi)];
  if (name === 'abs' && lo <= 0 && hi >= 0) ends.push(0);
  return boundsOf(ends);
}

export function compile(expression: string, parameters: readonly string[]) {
  const source = expression.replaceAll('−', '-').replaceAll('×', '*').replaceAll('÷', '/');
  const tokens =
    source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[a-z][\w]*|[()+*/^-]/giu) ?? [];
  if (tokens.join('') !== source.replaceAll(/\s+/gu, '') || tokens.length > 128)
    throw new Error('Invalid curve expression');
  let cursor = 0;
  const phases: Bounds[] = [];
  function group(): Expression {
    const expression = parse(1);
    if (tokens[cursor++] !== ')') throw new Error('Unclosed curve expression');
    return expression;
  }

  function operand(): Expression {
    const token = tokens[cursor++];
    if (token === '-' || token === '+') {
      const operand = parse(3);
      if (token === '+') return operand;
      return {
        evaluate: (x, params) => -operand.evaluate(x, params),
        bounds: (x, params) => {
          const [lo, hi] = operand.bounds(x, params);
          return [-hi, -lo];
        },
      };
    }
    if (token === '(') return group();
    if (Object.hasOwn(functions, token) && tokens[cursor] === '(') {
      const name = token as keyof typeof functions;
      const apply = functions[name];
      cursor++;
      const operand = group();
      if (name === 'sin' || name === 'cos') phases.push(operand.bounds);
      return {
        evaluate: (x, params) => apply(operand.evaluate(x, params)),
        bounds: (x, params) => functionBounds(name, operand.bounds(x, params)),
      };
    }
    if (token === 'x') return { evaluate: x => x, bounds: x => x };
    if (parameters.includes(token))
      return {
        evaluate: (_, params) => params[token],
        bounds: (_, params) => [params[token], params[token]],
      };
    if (token && Number.isFinite(Number(token))) {
      const value = Number(token);
      return { evaluate: () => value, bounds: () => [value, value] };
    }
    throw new Error('Invalid curve operand: ' + token);
  }

  function parse(minimum: number): Expression {
    let left = operand();
    while (Object.hasOwn(precedence, tokens[cursor])) {
      const operator = tokens[cursor] as Operator;
      const strength = precedence[operator];
      if (strength < minimum) break;
      cursor++;
      const right = parse(strength + (operator === '^' ? 0 : 1));
      const previous = left;
      left = {
        evaluate: (x, params) =>
          operators[operator](previous.evaluate(x, params), right.evaluate(x, params)),
        bounds: (x, params) =>
          operatorBounds(operator, previous.bounds(x, params), right.bounds(x, params)),
      };
    }
    return left;
  }
  const { evaluate } = parse(1);
  if (cursor !== tokens.length) throw new Error('Unexpected curve token');
  return Object.assign(evaluate, {
    phaseResolved(domain: number[], params: Record<string, number>, maxRadians: number) {
      // A bound over each whole interval detects cycles even when all endpoints coincide.
      return phases.every(bounds =>
        domain.slice(1).every((right, index) => {
          const [lo, hi] = bounds([domain[index], right], params);
          return hi - lo <= maxRadians;
        })
      );
    },
  });
}

const PLOT_STEPS = 240;
export function sample([start, end]: [number, number]) {
  return Array.from({ length: PLOT_STEPS + 1 }, (_, i) => mix(start, end, i / PLOT_STEPS));
}
export const mix = (from: number, to: number, t: number) => from + (to - from) * t;

function crossingRoots(fn: (x: number) => number, domain: number[]) {
  const zeros: number[] = [];
  let left = domain[0];
  let a = fn(left);
  for (const right of domain.slice(1)) {
    const b = fn(right);
    if (a === 0) zeros.push(left);
    if (Number.isFinite(a) && Number.isFinite(b) && Math.sign(a) * Math.sign(b) < 0) {
      const zero = bisectRoot(fn, left, right, Math.sign(a));
      // Require convergence on the local function scale, even for very small jumps.
      if (zero !== undefined && Math.abs(fn(zero)) <= 1e-7 * Math.min(Math.abs(a), Math.abs(b)))
        zeros.push(zero);
    }
    left = right;
    a = b;
  }
  if (a === 0) zeros.push(left);
  return zeros;
}

function bisectRoot(fn: (x: number) => number, lo: number, hi: number, leftSign: number) {
  for (let i = 0; i < 40; i++) {
    const mid = mix(lo, hi, 0.5);
    const value = fn(mid);
    if (value === 0) return mid;
    if (!Number.isFinite(value)) return undefined;
    if (Math.sign(value) === leftSign) lo = mid;
    else hi = mid;
  }
  // Interpolate in the final bracket so a root near a sample is not rounded away.
  const a = Math.abs(fn(lo));
  const b = Math.abs(fn(hi));
  const scale = Math.max(a, b);
  const left = a / scale;
  const right = b / scale;
  return mix(lo, hi, left / (left + right));
}

function touchingRoot(fn: (x: number) => number, lo: number, hi: number) {
  const left = fn(lo);
  const right = fn(hi);
  if (!Number.isFinite(left) || !Number.isFinite(right) || Math.sign(left) !== Math.sign(right))
    return [];
  // An even-multiplicity root touches zero without a sign change.
  for (let i = 0; i < 35; i++) {
    const a = mix(lo, hi, 1 / 3),
      b = mix(lo, hi, 2 / 3);
    if (Math.abs(fn(a)) < Math.abs(fn(b))) hi = b;
    else lo = a;
  }
  const zero = mix(lo, hi, 0.5);
  return Math.abs(fn(zero)) <= 1e-10 * Math.min(Math.abs(left), Math.abs(right)) ? [zero] : [];
}

function touchingRoots(fn: (x: number) => number, domain: number[]) {
  const last = domain.length - 1;
  const zeros = touchingRoot(fn, domain[0], domain[1]);
  if (last > 1) zeros.push(...touchingRoot(fn, domain[last - 1], domain[last]));
  for (const [i, at] of domain.slice(1, -1).entries()) {
    const lo = domain[i],
      hi = domain[i + 2];
    if (Math.abs(fn(at)) < Math.min(Math.abs(fn(lo)), Math.abs(fn(hi))))
      zeros.push(...touchingRoot(fn, lo, hi));
  }
  return zeros;
}

export function roots(fn: (x: number) => number, domain: number[]) {
  if (domain.length < 2 || domain.every(x => fn(x) === 0)) return [];
  const resolution = (domain[1] - domain[0]) * 1e-5;
  const zeros = [...crossingRoots(fn, domain), ...touchingRoots(fn, domain)];
  zeros.sort((a, b) => a - b);
  return zeros.filter((zero, index) => index === 0 || zero - zeros[index - 1] > resolution);
}

export function snell(n1: number, n2: number, angle: number) {
  const degrees = 180 / Math.PI;
  const ratio = (n1 * Math.sin(angle / degrees)) / n2;
  return {
    refraction: ratio > 1 + Number.EPSILON ? null : Math.asin(Math.min(1, ratio)) * degrees,
    critical: n1 > n2 ? Math.asin(n2 / n1) * degrees : null,
  };
}
