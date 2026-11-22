export const arrayCopy = {
  titles: {
    bubble: 'Bubble sort',
    insertion: 'Ordinamento per inserimento',
    selection: 'Ordinamento per selezione',
    'binary-search': 'Ricerca binaria',
  },
  settled: 'Già al suo posto',
  search: (value: string) => `Cerchiamo il ${value}`,
  searchCompact: (value: string) => `Cerca ${value}`,
  comparisons: 'Confronti',
  swaps: 'Scambi',
  pass: 'Passaggio',
  nearby: 'Si confrontano due vicini',
  noSwap: 'Nessuno scambio: è ordinata',
  done: 'Lista ordinata',
  searchMarkers: ['inizio', 'metà', 'fine'],
} as const;
export const swap = (a: string, b: string) => `${a} e ${b} si scambiano`;

export const arrayBeatCopy = {
  example: (values: string) => `Per esempio, la lista è ${values}.`,
  exampleSearch: (values: string, target: string) =>
    `Per esempio, cerchiamo ${target} in ${values}.`,
  compare: (left: string, right: string) => `Confrontiamo ${left} e ${right}.`,
  swap: (left: string, right: string) => `${swap(left, right)}.`,
  checked: (values: string) => `Sono in posizione definitiva: ${values}.`,
  done: (values: string) => `La lista ordinata è ${values}.`,
  found: (target: string) => `Abbiamo trovato ${target}.`,
  missing: (target: string) => `${target} non compare nella lista.`,
};
