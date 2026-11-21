// Line breaks keep the generated callouts readable in the narrow reader.
const wrapped = {
  direction: 'Tutte\nvanno\nverso un\npunto',
  toward: 'Si\navvicina\nalla\nverticale',
  away: 'Si\nallontana\ndalla\nverticale',
  total: 'Non esce\npiù: si\nriflette\ntutto',
};
const oneLine = (caption: string) => caption.replaceAll('\n', ' ');

export const planeCopy = {
  axes: ['x', 'y'],
  tangent: 'Pendenza della tangente',
  slope: 'pendenza = ',
  area: 'Area ',
  intersection: 'Qui le due rette si incontrano',
  root: 'Zero',
  basis: 'Dove finiscono i e j',
  direction: oneLine(wrapped.direction),
  distance: 'Lontano sembrano più fitte',
  medium1: 'Mezzo 1',
  medium2: 'Mezzo 2',
  total: oneLine(wrapped.total),
  toward: oneLine(wrapped.toward),
  away: oneLine(wrapped.away),
} as const;

export const wrappedPlaneCallouts = new Map(
  Object.values(wrapped).map(text => [oneLine(text), text])
);

export const optics = {
  basisI: 'i′',
  basisJ: 'j′',
  index1: ' · n₁ = ',
  index2: ' · n₂ = ',
  angle1: 'θ₁ = ',
  angle2: 'θ₂ = ',
  angleUnit: '°',
  critical: 'Angolo critico ',
} as const;
