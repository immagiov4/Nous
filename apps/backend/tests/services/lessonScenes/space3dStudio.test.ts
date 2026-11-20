import { expect, test } from 'vitest';
import { VectorNode } from '@shared/lessonStudios/vectorScene';
import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import { checkStudioLayout } from '@shared/lessonStudios/layoutValidation';
import { buildSpace3d } from '@shared/lessonStudios/space3d';
import { checkSpace3dSpec, Space3dSpecSchema } from '@shared/lessonStudios/space3dSpec';

const gold = {
  "cx-01-sparse-voxel-octree": {
    "title": "Sparse voxel octree",
    "layers": [
      "shape",
      "voxel-grid",
      "octree",
      "ray"
    ],
    "shape": "bunny-like blob",
    "n": 16,
    "maxDepth": 4,
    "wire": true,
    "ray": {
      "origin": [
        -1,
        -0.1,
        0.09
      ],
      "direction": [
        1,
        0.045,
        0.045
      ]
    },
    "beats": [
      {
        "at": "b1",
        "label": "Solido nel cubo",
        "show": [
          "shape"
        ],
        "camera": "iso"
      },
      {
        "at": "b2",
        "label": "Una griglia uniforme",
        "show": [
          "voxel-grid"
        ]
      },
      {
        "at": "b3",
        "label": "Otto figli",
        "show": [
          "octree"
        ],
        "depth": 1
      },
      {
        "at": "b4",
        "label": "Si divide dove serve",
        "depth": 2
      },
      {
        "at": "b5",
        "label": "Figli più piccoli",
        "depth": 3
      },
      {
        "at": "b6",
        "label": "Il vuoto resta grande",
        "depth": 4
      },
      {
        "at": "b7",
        "label": "Ingresso del raggio",
        "show": [
          "octree",
          "ray"
        ],
        "focus": "ray",
        "progress": 0
      },
      {
        "at": "b8",
        "label": "Discesa nei figli",
        "progress": 0.17
      },
      {
        "at": "b9",
        "label": "Salto del vuoto",
        "progress": 0.35
      },
      {
        "at": "b10",
        "label": "Incontra i voxel",
        "progress": 0.39
      },
      {
        "at": "b11",
        "label": "Visita completata",
        "progress": 1
      }
    ]
  },
  "cx-02-voxelizzazione": {
    "title": "Voxelizzare un triangolo",
    "layers": [
      "triangle-voxelize"
    ],
    "triangles": [
      [
        [
          -0.42,
          -0.32,
          0
        ],
        [
          0.41,
          -0.24,
          0.18
        ],
        [
          -0.16,
          0.38,
          -0.16
        ]
      ]
    ],
    "n": 11,
    "mode": "conservative",
    "beats": [
      {
        "at": "b1",
        "label": "Riquadro dei candidati",
        "camera": "iso",
        "progress": 0
      },
      {
        "at": "b2",
        "label": "Primo gruppo di celle",
        "progress": 0.2
      },
      {
        "at": "b3",
        "label": "Test di intersezione",
        "progress": 0.42
      },
      {
        "at": "b4",
        "label": "Anche un bordo conta",
        "progress": 0.67
      },
      {
        "at": "b5",
        "label": "Superficie in voxel",
        "progress": 1
      },
      {
        "at": "b6",
        "label": "Proiezione dominante",
        "project": true,
        "camera": "front"
      }
    ]
  },
  "cx-03-pipeline-grafica": {
    "title": "Dal triangolo al pixel",
    "layers": [
      "pipeline"
    ],
    "triangles": [
      [
        [
          -0.41,
          -0.32,
          0.31
        ],
        [
          0.29,
          -0.23,
          0.32
        ],
        [
          -0.13,
          0.33,
          0.32
        ]
      ],
      [
        [
          -0.48,
          0.03,
          -0.32
        ],
        [
          0.4,
          -0.29,
          -0.32
        ],
        [
          0.27,
          0.45,
          -0.32
        ]
      ]
    ],
    "beats": [
      {
        "at": "b1",
        "label": "Spazio del modello",
        "phase": "model",
        "camera": "iso"
      },
      {
        "at": "b2",
        "label": "Spazio della camera",
        "phase": "view",
        "camera": "front"
      },
      {
        "at": "b3",
        "label": "Coordinate clip",
        "phase": "clip"
      },
      {
        "at": "b4",
        "label": "Divisione per w",
        "phase": "divide"
      },
      {
        "at": "b5",
        "label": "Centri dei pixel",
        "phase": "raster",
        "progress": 1
      },
      {
        "at": "b6",
        "label": "Test di profondità",
        "phase": "depth"
      }
    ]
  },
  "cx-05-rotazioni-3d": {
    "title": "Ruotare un oggetto: l’ordine conta",
    "layers": [
      "rotation"
    ],
    "turns": [
      [
        "y",
        90
      ],
      [
        "x",
        90
      ]
    ],
    "beats": [
      {
        "at": "b1",
        "label": "Stessa posa iniziale",
        "rotation": "order",
        "progress": 0
      },
      {
        "at": "b2",
        "label": "Prima rotazione",
        "progress": 0.5
      },
      {
        "at": "b3",
        "label": "L’ordine cambia la posa",
        "progress": 1
      },
      {
        "at": "b4",
        "label": "Tre assi distinti",
        "rotation": "lock",
        "orientation": [
          0,
          0,
          0
        ]
      },
      {
        "at": "b5",
        "label": "Blocco cardanico",
        "orientation": [
          0,
          90,
          0
        ]
      },
      {
        "at": "b6",
        "label": "Arco più breve",
        "rotation": "slerp",
        "orientation": [
          35,
          -10,
          75
        ]
      }
    ]
  },
  "cx-06-ray-casting": {
    "title": "Il ray casting di una scena",
    "layers": [
      "raycast"
    ],
    "raycast": {
      "grid": 24,
      "rows": 16,
      "ground": -0.38,
      "light": [
        -0.72,
        0.79,
        0.58
      ],
      "objects": [
        {
          "kind": "sphere",
          "at": [
            -0.05,
            -0.09,
            0.06
          ],
          "radius": 0.29
        },
        {
          "kind": "box",
          "at": [
            0.48,
            -0.13,
            -0.3
          ],
          "size": 0.5
        }
      ],
      "explain": true
    },
    "beats": [
      {
        "at": "b1",
        "cast": "primary",
        "pixel": [
          15,
          5
        ]
      },
      {
        "at": "b2",
        "cast": "hit"
      },
      {
        "at": "b3",
        "cast": "shadow",
        "pixel": [
          20,
          11
        ]
      },
      {
        "at": "b4",
        "cast": "shadow",
        "pixel": [
          3,
          13
        ]
      },
      {
        "at": "b5",
        "cast": "shade",
        "pixel": [
          12,
          5
        ]
      },
      {
        "at": "b6",
        "cast": "scan"
      }
    ]
  },
  "g-02-cono-cilindro": {
    "title": "Perché il cono è un terzo del cilindro",
    "layers": [
      "slice-stack"
    ],
    "slices": {
      "radius": 1,
      "height": 1.7724538509055159,
      "n": 7
    },
    "beats": [
      {
        "at": "b1",
        "sliceView": "dissect"
      },
      {
        "at": "b2",
        "sliceView": "superpose"
      },
      {
        "at": "b3",
        "sliceView": "reassemble"
      },
      {
        "at": "b4",
        "sliceView": "cavalieri"
      },
      {
        "at": "b5",
        "sliceView": "conclusion"
      }
    ]
  },
  "g-03-sezioni-cubo": {
    "title": "Tagliare un cubo con un piano",
    "layers": [
      "plane-section"
    ],
    "beats": [
      {
        "at": "b0",
        "section": {
          "normal": [
            0.45,
            0.6,
            0.7
          ],
          "offset": 0.2
        }
      },
      {
        "at": "b1",
        "label": "Taglio dritto: un quadrato",
        "section": "square"
      },
      {
        "at": "b2",
        "label": "Taglio d'angolo: un triangolo",
        "section": "triangle"
      },
      {
        "at": "b3",
        "label": "Taglio dal centro: un esagono",
        "section": "hexagon"
      },
      {
        "at": "b4",
        "label": "Taglio storto: un trapezio",
        "section": "trapezoid"
      }
    ]
  }
} as const;

const cuesFor = (count: number) => Array.from({ length: count }, (_, index) => index * 2500);

function fixture(name: keyof typeof gold, size: keyof typeof readerStudioViewports) {
  const spec = Space3dSpecSchema.parse(gold[name]);
  checkSpace3dSpec(spec);
  const root = new VectorNode('root', {}, readerStudioViewports[size]);
  const cues = cuesFor(spec.beats.length);
  root.data.durationMs = String(spec.beats.length * 2500);
  return { layout: buildSpace3d(spec, root, cues), cues: cues.map(cue => cue / 1000) };
}

test.each(Object.keys(gold) as (keyof typeof gold)[])('%s fits both reader rectangles and rewinds', name => {
  for (const size of ['desktop', 'phone'] as const) {
    const { layout, cues } = fixture(name, size);
    const first = layout.inspect();
    const frames = cues.flatMap(time =>
      [time, time + 0.225, time + 0.6, time + 1.85].map(seconds => {
        layout.seek(seconds);
        const frame = layout.inspect();
        expect(frame.elements.some(mark => mark.mark)).toBe(true);
        return { elements: frame.elements };
      })
    );
    layout.seek(0);
    expect(layout.inspect()).toEqual(first);
    expect(checkStudioLayout({ stage: first.stage, frames })).toEqual([]);
    expect(frames.some(frame => JSON.stringify(frame) !== JSON.stringify(frames[0]))).toBe(true);
  }
});

test('the cube section changes its label when the morph lands', () => {
  const { layout, cues } = fixture('g-03-sezioni-cubo', 'phone');
  layout.seek(cues[2] + 0.24);
  expect(layout.inspect().labels).not.toContain("Taglio d'angolo: un triangolo");
  layout.seek(cues[2] + 0.5);
  expect(layout.inspect().labels).toContain("Taglio d'angolo: un triangolo");
  layout.seek(cues[1] + 0.5, true);
  expect(layout.inspect().labels).toContain('Taglio dritto: un quadrato');
});

