const digits = 'zero uno due tre quattro cinque sei sette otto nove'.split(' ');
const shortCardinals = [
  ...digits,
  ...'dieci undici dodici tredici quattordici quindici sedici diciassette diciotto diciannove'.split(
    ' '
  ),
];
const tens = 'venti trenta quaranta cinquanta sessanta settanta ottanta novanta'.split(' ');
const underHundred = new Map(shortCardinals.map((word, value) => [word, value]));
for (const [tensIndex, ten] of tens.entries()) {
  const base = (tensIndex + 2) * 10;
  underHundred.set(ten, base);
  for (const [unit, word] of digits.entries()) {
    if (!unit) continue;
    const prefix = unit === 1 || unit === 8 ? ten.slice(0, -1) : ten;
    underHundred.set(prefix + (unit === 3 ? 'tré' : word), base + unit);
    if (unit === 3) underHundred.set(prefix + word, base + unit);
  }
}
const small = `(?:${[...underHundred.keys()].sort((a, b) => b.length - a.length).join('|')})`;
const hundreds = `(?:(?:${digits.slice(2).join('|')})?cento?(?:${small})?)`;
const underThousand = `(?:${hundreds}|${small})`;
const thousands = `(?:mille(?:${underThousand})?|${underThousand}mila(?:${underThousand})?)`;
const cardinal = `(?:${thousands}|${underThousand})`;
export const italianStudioNumber = String.raw`(?:un\s+mezzo|${cardinal}(?:\s+virgola\s+(?:\d+|${cardinal})(?:\s+(?:${digits.join('|')}))*)?)`;

function readUnderThousand(word: string): number {
  const known = underHundred.get(word);
  if (known !== undefined) return known;
  const match = /^(.*)cent(o?)(.*)$/u.exec(word);
  if (!match || (!match[2] && !match[3].startsWith('ott'))) return NaN;
  const multiplier = match[1] ? digits.indexOf(match[1]) : 1;
  if (multiplier < 1) return NaN;
  const remainder = match[3]
    ? (underHundred.get(match[3]) ?? underHundred.get(match[2] + match[3]))
    : 0;
  return remainder === undefined ? NaN : multiplier * 100 + remainder;
}

function readCardinal(word: string): number {
  if (!word) return NaN;
  if (word.startsWith('mille')) {
    const tail = word.slice('mille'.length);
    return 1000 + (tail ? readUnderThousand(tail) : 0);
  }
  const parts = word.split('mila');
  if (parts.length !== 2) return readUnderThousand(word);
  const [prefix, tail] = parts;
  const thousandsCount = readUnderThousand(prefix);
  if (thousandsCount < 2) return NaN;
  return thousandsCount * 1000 + (tail ? readUnderThousand(tail) : 0);
}

export function readItalianStudioNumber(token: string): number {
  const normalized = token.toLowerCase().trim().replaceAll(/\s+/gu, ' ');
  if (normalized === 'un mezzo') return 0.5;
  const parts = normalized.split(' virgola ');
  const integer = readCardinal(parts[0]);
  if (parts.length === 1) return integer;
  if (parts.length !== 2 || !Number.isFinite(integer)) return NaN;
  const fraction = parts[1];
  if (/^\d+$/u.test(fraction)) return Number(`${integer}.${fraction}`);
  const words = fraction.split(' ');
  if (words.length === 1) {
    const value = readCardinal(words[0]);
    return Number.isFinite(value) ? Number(`${integer}.${value}`) : NaN;
  }
  const decimals = words.map(word => digits.indexOf(word));
  return decimals.every(digit => digit >= 0) ? Number(`${integer}.${decimals.join('')}`) : NaN;
}
