// Expected choices for the Commons selector verification. Negative cases require abstention.
export const commonsVisionGold = [
  {
    id: 'perspective',
    it: 'Prospettiva centrale',
    en: 'One point perspective',
    gold: 'One point perspective.jpg',
    phrases: [
      'Nella prospettiva centrale le linee parallele si incontrano in un solo punto di fuga.',
      'Le file trasversali delle piastrelle appaiono più vicine verso il fondo.',
    ],
  },
  {
    id: 'mitosis',
    it: 'Mitosi',
    en: 'Mitosis',
    gold: 'Eventi principali della mitosi.svg',
    phrases: [
      'I cromosomi duplicati si allineano al centro della cellula.',
      'Le due copie si separano e raggiungono poli opposti.',
      'Si formano due cellule figlie.',
    ],
  },
  {
    id: 'water-cycle',
    it: 'Ciclo dell’acqua',
    en: 'Water cycle',
    gold: 'Watercycleitalianhigh.jpg',
    phrases: [
      'Il Sole fa evaporare l’acqua dal mare.',
      'Il vapore condensa in nuvole e ricade come pioggia.',
      'Le acque superficiali e sotterranee ritornano verso il mare.',
    ],
  },
  {
    id: 'moon-map-negative',
    it: 'Superficie lunare',
    en: 'Lunar surface',
    only: 'surface',
    phrases: [
      'La Luna ha una metà illuminata dal Sole.',
      'Mentre orbita intorno alla Terra, la porzione illuminata che vediamo cambia.',
      'La figura deve mostrare come le posizioni relative spiegano le fasi lunari.',
    ],
  },
  {
    id: 'moon-eclipse-negative',
    it: 'Eclissi lunare',
    en: 'Lunar eclipse',
    only: 'eclipse',
    phrases: [
      'Le fasi della Luna dipendono da quanta parte della metà illuminata è visibile dalla Terra.',
      'La sequenza passa da Luna nuova al primo quarto e poi alla Luna piena.',
      'Le fasi non sono causate dall’ombra della Terra.',
    ],
  },
];
