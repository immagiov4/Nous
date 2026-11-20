export const copy = {
  titles: {
    bubble: 'Bubble sort',
    insertion: 'Ordinamento per inserimento',
    selection: 'Ordinamento per selezione',
    'binary-search': 'Ricerca binaria',
  },
  settled: 'Già al suo posto',
  search: (value: string) => `Cerchiamo il ${value}`,
  comparisons: 'Confronti',
  swaps: 'Scambi',
  pass: 'Passaggio',
  nearby: 'Si confrontano due vicini',
  noSwap: 'Nessuno scambio: è ordinata',
  done: 'Lista ordinata',
  searchMarkers: ['inizio', 'metà', 'fine'],
} as const;
export const swap = (a: string, b: string) => `${a} e ${b} si scambiano`;
