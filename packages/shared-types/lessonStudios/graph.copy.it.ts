export const graphCopy = {
  hud: {
    bfs: 'In attesa (coda)',
    dfs: 'In attesa (pila)',
    'topo-sort': 'Pronti a partire',
    dijkstra: 'Da esaminare',
    prim: 'Da collegare',
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

export const graphBeatCopy = {
  titles: {
    graph: 'Grafo',
    dijkstra: 'Dijkstra',
    bfs: 'Visita in ampiezza',
    dfs: 'Visita in profondità',
    'topo-sort': 'Ordinamento topologico',
    prim: 'Algoritmo di Prim',
  },
  example: (start: string, target: string, edges: string) =>
    `Per esempio, da ${start} a ${target}: ${edges}.`,
  treeExample: (edges: string) => `Per esempio, usiamo gli archi ${edges}.`,
  add: (from: string, to: string, weight: string) =>
    `Aggiungiamo l’arco da ${from} a ${to}, di peso ${weight}.`,
  start: (nodes: string) => `Partiamo da ${nodes}.`,
  chooseStart: (node: string) => `Scegliamo di partire da ${node}.`,
  visit: (node: string) => `Visitiamo ${node}.`,
  fixed: (node: string, distance: string) => `Fissiamo a ${distance} la distanza di ${node}.`,
  relax: (via: string, node: string, distance: string) => `${relax(via, node, distance)}.`,
  path: (nodes: string) => `${shortestPath(nodes)}.`,
  unreachable: (node: string) => `Il nodo ${node} non è raggiungibile.`,
  link: (from: string, to: string) => `${from} è collegato a ${to}.`,
  next: (from: string, to: string) => `Da ${from} si passa a ${to}.`,
};
