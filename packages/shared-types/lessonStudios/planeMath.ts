type Evaluate = (x: number, params: Record<string, number>) => number;
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

export function compile(expression: string, parameters: readonly string[]): Evaluate {
  const source = expression
    .replaceAll('−', '-')
    .replaceAll('×', '*')
    .replaceAll('÷', '/')
    .replaceAll(/\s+/gu, '');
  const tokens =
    source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[a-z][\w]*|[()+*/^-]/giu) ?? [];
  if (tokens.join('') !== source || tokens.length > 128)
    throw new Error('Invalid curve expression');
  let cursor = 0;
  function operand(): Evaluate {
    const token = tokens[cursor++];
    if (token === '-' || token === '+') {
      const operand = parse(3);
      return (x, params) => (token === '-' ? -operand(x, params) : operand(x, params));
    }
    if (token === '(') {
      const expression = parse(1);
      if (tokens[cursor++] !== ')') throw new Error('Unclosed curve expression');
      return expression;
    }
    if (Object.hasOwn(functions, token) && tokens[cursor] === '(') {
      const apply = functions[token as keyof typeof functions];
      cursor++;
      const operand = parse(1);
      if (tokens[cursor++] !== ')') throw new Error('Unclosed function argument');
      return (x, params) => apply(operand(x, params));
    }
    if (token === 'x') return x => x;
    if (parameters.includes(token)) return (_, params) => params[token];
    if (token && Number.isFinite(Number(token))) return () => Number(token);
    throw new Error('Invalid curve operand: ' + token);
  }

  function parse(minimum: number): Evaluate {
    let left = operand();
    while (Object.hasOwn(precedence, tokens[cursor])) {
      const operator = tokens[cursor] as Operator;
      const strength = precedence[operator];
      if (strength < minimum) break;
      cursor++;
      const right = parse(strength + (operator === '^' ? 0 : 1));
      const previous = left;
      left = (x, params) => operators[operator](previous(x, params), right(x, params));
    }
    return left;
  }
  const evaluate = parse(1);
  if (cursor !== tokens.length) throw new Error('Unexpected curve token');
  return evaluate;
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
    if (Number.isFinite(a) && Number.isFinite(b) && a * b < 0) {
      const zero = bisectRoot(fn, left, right, Math.sign(a));
      // Opposite signs across a pole do not make it a root.
      if (Math.abs(fn(zero)) <= 1e-7 * Math.max(1, Math.min(Math.abs(a), Math.abs(b))))
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
    const mid = (lo + hi) / 2;
    if (Math.sign(fn(mid)) === leftSign) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function touchingRoots(fn: (x: number) => number, domain: number[]) {
  const zeros: number[] = [];
  for (const [i, at] of domain.slice(1, -1).entries()) {
    let lo = domain[i],
      hi = domain[i + 2];
    const center = fn(at),
      left = fn(lo),
      right = fn(hi);
    if (
      ![center, left, right].every(Number.isFinite) ||
      Math.sign(left) !== Math.sign(right) ||
      Math.abs(center) >= Math.min(Math.abs(left), Math.abs(right))
    )
      continue;
    // An even-multiplicity root touches zero without a sign change.
    for (let j = 0; j < 35; j++) {
      const a = mix(lo, hi, 1 / 3),
        b = mix(lo, hi, 2 / 3);
      if (Math.abs(fn(a)) < Math.abs(fn(b))) hi = b;
      else lo = a;
    }
    const zero = (lo + hi) / 2;
    if (Math.abs(fn(zero)) <= 1e-10 * Math.min(Math.abs(left), Math.abs(right))) zeros.push(zero);
  }
  return zeros;
}

export function roots(fn: (x: number) => number, domain: number[]) {
  if (domain.every(x => fn(x) === 0)) return [];
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
