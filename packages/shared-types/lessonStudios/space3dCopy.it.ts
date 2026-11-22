export const copy = {
  surface: 'Il bordo del solido',
  unitCube: 'Cubo unitario',
  gridCells: 'Celle della griglia',
  occupied: 'Voxel occupati',
  resolution: 'Risoluzione',
  treeNodes: "Cubi dell'octree",
  equivalent: 'Celle di una griglia piena',
  depth: 'Profondità',
  skip: 'Il raggio salta il vuoto',
  descend: 'Il raggio entra nei cubi più piccoli',
  hit: 'Trovata una cella piena',
  outside: 'Fuori dal cubo',
  rayNode: 'Nodo incontrato',
  visited: 'Nodi visitati',
  skipped: 'Nodi vuoti saltati',
  checked: 'Celle candidate verificate',
  dominant: 'Vista dal lato più ampio',
  center: 'Conta il centro',
  conservative: 'Basta toccarla',
  coverage: 'Quando una cella conta',
  modelCoords: 'Posizione nel modello',
  cameraCoords: 'Posizione vista dalla camera',
  clipCoords: 'Coordinate di ritaglio',
  cameraDepth: 'Profondità in spazio camera (w)',
  afterDivide: 'Dopo la divisione per w',
  divisor: 'Più è lontano, più si rimpicciolisce',
  insideTriangle: 'Pixel con il centro nel triangolo',
  knownDepth: 'Profondità già salvata',
  incomingDepth: 'Profondità del nuovo punto',
  keep: 'È davanti: si disegna',
  write: 'È davanti: si disegna',
  discard: 'È dietro: si scarta',
  testResult: 'Risultato',
  cameraImage: 'Cosa vede la camera',
  light: 'Luce',
  blocked: 'Qualcosa blocca la luce',
  camera: 'Camera',
  shadowed: 'Pixel all’ombra',
  lit: 'Pixel illuminato',
  samePixel: 'Questo pixel',
  primary: 'Raggio dalla camera',
  behind: 'Più indietro: non si vede',
  lightRay: 'Raggio verso la luce',
  normal: 'Perpendicolare alla superficie',
  theta: 'θ',
  solid: 'Solido',
  volume: 'Volume (unità³)',
  area: 'Superficie (unità²)',
  cutShape: 'La forma del taglio',
  sectionVertices: 'Lati del taglio',
  degenerated: 'Il piano tocca solo uno spigolo',
  cone: 'Cono',
  cylinder: 'Cilindro',
  sliceArea: 'Area della fetta',
  base: 'Base',
  height: 'Altezza',
  apex: 'Punta',
  pyramidRatio: 'La piramide è un terzo del prisma',
  coneRatio: 'Il cono è un terzo del cilindro',
  leftOrder: 'Ordine a sinistra',
  rightOrder: 'Ordine a destra',
  orientationDelta: 'Le due pose non coincidono',
  yRing: "L'anello Y ruota",
  axesAligned: 'Due anelli coincidono: si perde un movimento',
  axesDistinct: 'Tre anelli, tre movimenti',
  rotationAxes: 'Assi di rotazione',
  degreesOfFreedom: 'Movimenti possibili',
  slerp: 'Passaggio diretto tra due pose',
  shortestArc: 'La strada più corta',
} as const;
export const layerNames = {
  shape: 'Il solido',
  'voxel-grid': 'Griglia piena',
  octree: 'Octree',
  ray: 'Il percorso del raggio',
  'triangle-voxelize': 'Voxelizzazione',
  pipeline: 'Pipeline grafica',
  solid: 'Geometria solida',
  'slice-stack': 'Cono e cilindro',
  'plane-section': 'Sezioni del cubo',
  rotation: 'Rotazioni 3D',
  raycast: 'Ray casting',
};
export const shapeNames = {
  sphere: 'Sfera',
  torus: 'Toro',
  box: 'Parallelepipedo',
  capsule: 'Capsula',
  'bunny-like blob': 'Unione di tre sfere',
};
export const axisNames = ['X', 'Y', 'Z'];
export const sectionLabels = {
  square: 'Taglio dritto: un quadrato',
  triangle: "Taglio d'angolo: un triangolo",
  hexagon: 'Taglio dal centro: un esagono',
  trapezoid: 'Taglio storto: un trapezio',
} as const;
export const coordinateSeparator = ' · ';
export const emptyDepth = '—';
export const axis = (name: string) => 'Asse ' + name;
export const resolution = (cells: number) => cells + ' per lato';
export const cosine = (percent: number) => 'Luminosità ' + percent + '% (cos θ)';
export const areaComparison = (value: string) => 'Quadrato e cerchio: stessa area (' + value + ')';
export const slicePercent = (count: number, percent: string) =>
  'Con ' + count + ' fette: ' + percent + ' del rettangolo';
export const solidNames = {
  cube: 'Cubo',
  prism: 'Prisma triangolare',
  pyramid: 'Piramide retta',
  cylinder: 'Cilindro',
  cone: 'Cono',
  sphere: 'Sfera',
};
export const polygonNames: Record<number, string> = {
  3: 'Triangolo',
  4: 'Quadrilatero',
  5: 'Pentagono',
  6: 'Esagono',
};
export const rayNormal = 'n';
export const sliceDimensions = {
  height: 'h',
  radius: 'r',
  levels: ['', '= h/3', '= 2h/3', '= h'],
} as const;
export const rotationOrder = (first: string, second: string) =>
  'Prima ' + first + ', poi ' + second;
