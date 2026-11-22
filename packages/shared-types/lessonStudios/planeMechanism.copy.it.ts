import { formatOperand } from './chart';

const displayAmount = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 });
const amount = (value: number) => displayAmount.format(value);

export const planeMechanismCopy = {
  derivative: {
    title: 'Dalla secante alla tangente',
    curve: (x: number) =>
      `Cerchiamo la pendenza della curva nel punto di ascissa ${formatOperand(x)}.`,
    secant: (h: number, slope: number) =>
      `Con uno spostamento h di ${formatOperand(h)}, la secante ha pendenza ${amount(slope)}.`,
    tangent: (slope: number) => `Quando h tende a zero, la tangente ha pendenza ${amount(slope)}.`,
  },
  intersection: {
    title: 'Intersezione di due rette',
    line: (name: string, slope: number, intercept: number) =>
      `${name} ha pendenza ${formatOperand(slope)} e intercetta ${formatOperand(intercept)}.`,
    at: (x: number, y: number) =>
      `Le rette si incontrano nel punto di ascissa ${amount(x)} e ordinata ${amount(y)}.`,
    first: 'La prima retta',
    second: 'La seconda retta',
  },
  breakEven: {
    title: 'Punto di pareggio',
    costs: 'Costi',
    revenues: 'Ricavi',
    axes: ['Pezzi', 'Euro'] as const,
    costLine: (fixed: number, increment: number) =>
      `I costi partono da ${amount(fixed)} euro e crescono di ${amount(increment)} euro per pezzo.`,
    revenueLine: (price: number) => `Ogni pezzo venduto aggiunge ${amount(price)} euro ai ricavi.`,
    at: (quantity: number, money: number) =>
      `Il pareggio matematico è a circa ${amount(quantity)} pezzi, con ricavi e costi pari a circa ${amount(money)} euro.`,
  },
  market: {
    title: 'Equilibrio di domanda e offerta',
    demand: 'Domanda',
    supply: 'Offerta',
    axes: ['Quantità', 'Prezzo'] as const,
    demandLine: 'La domanda scende al crescere del prezzo.',
    supplyLine: 'L’offerta sale al crescere del prezzo.',
    shift: 'La domanda aumenta: a ogni prezzo corrisponde una quantità domandata più alta.',
    at: (quantity: number, price: number) =>
      `Domanda e offerta si incontrano alla quantità ${amount(quantity)} e al prezzo ${amount(price)}.`,
  },
  growth: {
    title: 'Interesse semplice e composto',
    simple: 'Semplice',
    compound: 'Composto',
    axes: ['Anni', 'Euro'] as const,
    simpleLine: (principal: number, rate: number) =>
      `L’interesse semplice applica ogni anno il ${formatOperand(rate)} per cento ai ${amount(principal)} euro iniziali.`,
    compoundLine: 'L’interesse composto applica lo stesso tasso al capitale aggiornato.',
    at: (years: number, simple: number, compound: number) =>
      `Dopo ${years} ${years === 1 ? 'anno' : 'anni'} sono circa ${amount(simple)} euro col semplice e ${amount(compound)} euro col composto.`,
  },
  example: 'Per esempio, usiamo questi valori illustrativi.',
};
