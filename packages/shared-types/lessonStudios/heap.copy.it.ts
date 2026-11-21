import type { HeapSpec } from './heap';

export const heapCopy = {
  title: 'Heap sort',
  buildTitle: 'Costruzione di un max-heap',
  settled: 'Al suo posto',
  tree: 'Albero',
  heap: 'Albero (max-heap)',
  array: 'Lista',
  start: 'Ogni nodo è un elemento della lista',
  sift: 'Il figlio più grande sale',
  heapified: 'Il più grande è in cima',
  extract: 'Il massimo va in fondo',
  restore: "Si rimette in ordine l'albero",
  done: 'Lista ordinata',
} as const;

export const heapTitle = (operation: HeapSpec['operation']) =>
  operation === 'build' ? heapCopy.buildTitle : heapCopy.title;
