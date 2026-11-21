// Lab gold annotations with the image bytes supplied separately by the asset owner.
export const imageAnnotateGold = [
  {
    title: 'La prospettiva centrale',
    alt: 'Foto di un viale piastrellato. Le rette lungo il viale convergono in un punto. Le file trasversali delle piastrelle appaiono più vicine verso il fondo.',
    image: {
      title: 'One point perspective.jpg',
      author: 'Laitche',
      credit: 'Own work',
      license: 'Public domain',
      licenseUrl: '',
      source: 'https://commons.wikimedia.org/wiki/File:One_point_perspective.jpg',
      width: 2234,
      height: 1604,
    },
    beats: [
      {
        at: 'b1',
      },
      {
        at: 'b2',
        label: 'Un solo punto di fuga',
        region: {
          x: 0,
          y: 0.36,
          w: 1,
          h: 0.64,
        },
        showOverlay: true,
      },
      {
        at: 'b3',
        label: 'File via via più fitte',
        region: {
          x: 0.344,
          y: 0.606,
          w: 0.242,
          h: 0.18,
        },
      },
    ],
    overlay: {
      type: 'vanishing-lines',
      point: [0.458, 0.591],
      from: [
        [0.019, 0.997],
        [0.865, 0.997],
        [0.166, 0.739],
        [0.797, 0.945],
      ],
    },
  },
  {
    title: 'La mitosi',
    alt: 'Schema italiano della divisione cellulare: cromosomi duplicati, allineamento al centro, separazione verso i poli e due cellule figlie.',
    image: {
      title: 'Eventi principali della mitosi.svg',
      author: 'Mysid, tradotto da Bukkia',
      credit:
        'Vectorized in CorelDraw by Mysid from https://www.ncbi.nlm.nih.gov/About/primer/genetics_cell.html',
      license: 'Public domain',
      licenseUrl: '',
      source: 'https://commons.wikimedia.org/wiki/File:Eventi_principali_della_mitosi.svg',
      width: 1023,
      height: 372,
    },
    beats: [
      {
        at: 'b1',
        label: 'I cromosomi si sono copiati',
        region: {
          x: 0.205,
          y: 0.05,
          w: 0.18,
          h: 0.9,
        },
      },
      {
        at: 'b2',
        label: 'Si allineano al centro',
        region: {
          x: 0.423,
          y: 0.065,
          w: 0.175,
          h: 0.825,
        },
      },
      {
        at: 'b3',
        label: 'Le copie si separano',
        region: {
          x: 0.623,
          y: 0.065,
          w: 0.18,
          h: 0.835,
        },
      },
      {
        at: 'b4',
        label: 'Nascono due cellule uguali',
        region: {
          x: 0.838,
          y: 0.005,
          w: 0.16,
          h: 0.99,
        },
      },
    ],
  },
  {
    title: 'Il ciclo dell’acqua',
    alt: 'Schema USGS del ciclo idrologico. Le frecce collegano evaporazione dal mare, condensazione in quota, precipitazione e ritorno per acque superficiali e sotterranee.',
    image: {
      title: 'Watercycleitalianhigh.jpg',
      author:
        'USGS Georgia Water Science Center Illustration by John M. Evans, Howard Perlman, USGS Italian translation by Maurizio Polemio (CNR-IRPI, Italia)',
      credit: 'http://ga.water.usgs.gov/edu/watercycleitalianhi.html',
      license: 'Public domain',
      licenseUrl: '',
      source: 'https://commons.wikimedia.org/wiki/File:Watercycleitalianhigh.jpg',
      width: 756,
      height: 526,
    },
    beats: [
      {
        at: 'b1',
        label: 'Dal mare all’aria',
        region: {
          x: 0.69,
          y: 0.31,
          w: 0.265,
          h: 0.38,
        },
      },
      {
        at: 'b2',
        label: 'Si formano le nuvole',
        region: {
          x: 0.695,
          y: 0.135,
          w: 0.29,
          h: 0.23,
        },
      },
      {
        at: 'b3',
        label: 'Pioggia e neve',
        region: {
          x: 0.018,
          y: 0.2,
          w: 0.36,
          h: 0.31,
        },
      },
      {
        at: 'b4',
        label: 'Ritorno verso il mare',
        region: {
          x: 0.017,
          y: 0.57,
          w: 0.61,
          h: 0.39,
        },
      },
    ],
  },
];
