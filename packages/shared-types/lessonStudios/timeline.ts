import { easeCubicIn, easeCubicInOut, easeLinear, easePolyOut } from 'd3';
import { VectorNode } from './vectorScene';

const easings = {
  none: easeLinear,
  'power3.out': easePolyOut.exponent(4),
  'power2.in': easeCubicIn,
  'power2.inOut': easeCubicInOut,
};

export const motionEase = (ease: keyof typeof easings) => easings[ease];

type Value = number | string;
type Properties = {
  attr?: Record<string, Value>;
  opacity?: number;
  textContent?: string;
  value?: number;
  x?: number;
  y?: number;
};
type Timing = { duration?: number; ease?: keyof typeof easings };
type Keyframes =
  | (Properties & Timing)[]
  | {
      x?: number[];
      y?: number[];
      ease: keyof typeof easings;
    };
type Tween = Properties & Timing & { keyframes?: Keyframes };
type Target = VectorNode | { value: number };
type Channel = { initial: Value; write: (value: Value) => void };
type Change = {
  at: number;
  duration: number;
  ease: (progress: number) => number;
  values: Value[];
};

function coordinate(target: VectorNode, axis: 'x' | 'y'): Channel {
  return {
    initial: target[axis],
    write: value => {
      target[axis] = Number(value);
    },
  };
}

function channel(target: Target, field: string): Channel {
  if (!(target instanceof VectorNode)) {
    return {
      initial: target.value,
      write: value => {
        target.value = Number(value);
      },
    };
  }
  if (field === 'textContent') {
    return {
      initial: target.textContent ?? '',
      write: value => {
        target.textContent = String(value);
      },
    };
  }
  if (field === 'x' || field === 'y') return coordinate(target, field);
  if (field === 'opacity') {
    const initial = Number(target.opacity ?? target.attrs.opacity ?? 1);
    return {
      initial,
      write: value => {
        target.opacity = Number(value);
      },
    };
  }
  const attribute = field.slice('attr:'.length);
  const initial = target.attrs[attribute] ?? '';
  return {
    initial,
    write: value => {
      if (value === '') target.removeAttribute(attribute);
      else target.setAttribute(attribute, String(value));
    },
  };
}

function propertyEntries({ attr, opacity, textContent, value, x, y }: Properties) {
  return [
    ...Object.entries({ opacity, textContent, value, x, y }),
    ...Object.entries(attr ?? {}).map(([name, attrValue]) => [`attr:${name}`, attrValue] as const),
  ].filter((entry): entry is [string, Value] => entry[1] !== undefined);
}

export function setProperties(target: Target, properties: Properties) {
  for (const [field, value] of propertyEntries(properties)) channel(target, field).write(value);
}

function interpolation(start: Value, end: Value, progress: number): Value {
  if (progress >= 1) return end;
  if (typeof end !== 'number' || (typeof start !== 'number' && !Number.isFinite(Number(start))))
    return start;
  return Number(start) + (end - Number(start)) * progress;
}

function valueAt(change: Change, seconds: number): Value {
  if (change.duration === 0) return change.values.at(-1)!;
  const progress = change.ease(Math.min(1, Math.max(0, (seconds - change.at) / change.duration)));
  const position = progress * (change.values.length - 1);
  const left = Math.floor(position);
  return interpolation(
    change.values[left],
    change.values[left + 1] ?? change.values[left],
    position - left
  );
}

function seekChannel(channel: Channel, changes: Change[], seconds: number, reduced: boolean) {
  let index = changes.length - 1;
  while (index >= 0 && changes[index].at > seconds) index--;
  const change = changes[index];
  if (!change) channel.write(channel.initial);
  else channel.write(valueAt(change, reduced ? change.at + change.duration : seconds));
}

/** A paused timeline with no timers. Every property can be evaluated after an arbitrary seek. */
export class StudioTimeline {
  readonly cuts = new Set<number>();
  private readonly targets = new Map<
    Target,
    Map<string, { channel: Channel; changes: Change[] }>
  >();
  private compiled = false;

  private add(target: Target, field: string, change: Change) {
    const fields = this.targets.get(target) ?? new Map();
    this.targets.set(target, fields);
    const track = fields.get(field) ?? { channel: channel(target, field), changes: [] };
    track.changes.push(change);
    fields.set(field, track);
  }

  set(target: Target, properties: Properties, at: number) {
    this.to(target, properties, at);
  }

  to(target: Target | readonly Target[], tween: Tween, at: number) {
    const { keyframes, ease = 'none', duration = 0 } = tween;
    if (Array.isArray(keyframes)) {
      let time = at;
      for (const frame of keyframes) {
        this.to(target, frame, time);
        time += frame.duration ?? 0;
      }
      return;
    }
    this.cuts.add(at);
    this.cuts.add(at + duration);
    const targets = Array.isArray(target) ? target : [target];
    for (const element of targets) {
      for (const [field, value] of propertyEntries(tween)) {
        this.add(element, field, { at, duration, ease: motionEase(ease), values: [value] });
      }
      if (!keyframes) continue;
      for (const axis of ['x', 'y'] as const) {
        const values = keyframes[axis];
        if (!values) continue;
        this.add(element, axis, { at, duration, ease: motionEase(keyframes.ease), values });
      }
    }
  }

  private compile() {
    for (const fields of this.targets.values()) {
      for (const { channel, changes } of fields.values()) {
        changes.sort((a, b) => a.at - b.at);
        let previous: Change | undefined;
        for (const change of changes) {
          if (change.values.length === 1)
            change.values.unshift(previous ? valueAt(previous, change.at) : channel.initial);
          previous = change;
        }
      }
    }
    this.compiled = true;
  }

  seek(seconds: number, reduced = false) {
    if (!this.compiled) this.compile();
    for (const fields of this.targets.values()) {
      for (const { channel, changes } of fields.values()) {
        seekChannel(channel, changes, seconds, reduced);
      }
    }
  }
}
