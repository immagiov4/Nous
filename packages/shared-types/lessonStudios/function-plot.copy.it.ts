export const functionPlotCopy = {
  vertex: 'Vertice',
  zero: 'Zero',
  intercept: 'Intercetta y',
} as const;
export const titles = {
  linear: 'Funzione lineare',
  quadratic: 'Parabola',
  sine: 'Sinusoide',
  exponential: 'Funzione esponenziale',
};
export const formulaWords = {
  value: 'y = ',
  square: 'x²',
  x: 'x',
  sine: ' sin(',
  close: ')',
  product: ' · ',
  exponent: 'ˣ',
  subtraction: '−',
  addition: '+',
  y: 'y',
} as const;

export const plotBeatCopy = {
  example: 'Prendiamo un esempio.',
  initial: (title: string, parameters: string) => `${title} con ${parameters}.`,
  change: (parameters: string) => `Il grafico cambia con ${parameters}.`,
  parameter: (name: string, value: string) => `${name} vale ${value}`,
};
