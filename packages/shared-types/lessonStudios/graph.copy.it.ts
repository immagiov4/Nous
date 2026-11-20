export const graphCopy = {
  hud: {
    bfs: 'In attesa (coda)',
    dfs: 'In attesa (pila)',
    'topo-sort': 'Pronti a partire',
    dijkstra: 'Da esaminare',
  },
  infinity: '∞',
  settled: 'Già fissati',
  order: 'Ordine',
  unreachable: 'Destinazione irraggiungibile',
  prevails: 'Questa prevale',
  next: 'Si sceglie il più vicino',
  separator: ', ',
  empty: '—',
} as const;
export const initial = (node: string) => "All'inizio solo " + node + ' vale 0';
export const fixed = (node: string) => 'La distanza di ' + node + ' è definitiva';
export const relax = (via: string, node: string, distance: string) =>
  'Passando da ' + via + ', ' + node + ' costa ' + distance;
export const shortestPath = (path: string) => 'Percorso più breve: ' + path;
