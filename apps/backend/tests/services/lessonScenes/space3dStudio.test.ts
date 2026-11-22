import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import { checkStudioLayout } from '@shared/lessonStudios/layoutValidation';
import { buildSpace3d } from '@shared/lessonStudios/space3d';
import { checkSpace3dSpec, Space3dSpecSchema } from '@shared/lessonStudios/space3dSpec';
import { enclosingBoxes } from '@shared/lessonStudios/vectorBounds';
import { VectorNode } from '@shared/lessonStudios/vectorScene';
import { CylinderGeometry, Mesh, MeshBasicMaterial, type Texture, Vector3 } from 'three';
import { expect, test } from 'vitest';
import {
  checkStudioCandidate,
  decodeGeometryStudioDraft,
  studioFallback,
} from '../../../src/services/lessonScenes/lessonStudioSelection';

const gold = {
  'cx-01-sparse-voxel-octree': {
    title: 'Sparse voxel octree',
    layers: ['shape', 'voxel-grid', 'octree', 'ray'],
    shape: 'bunny-like blob',
    n: 16,
    maxDepth: 4,
    wire: true,
    ray: {
      origin: [-1, -0.1, 0.09],
      direction: [1, 0.045, 0.045],
    },
    beats: [
      {
        at: 'b1',
        label: 'Solido nel cubo',
        show: ['shape'],
        camera: 'iso',
      },
      {
        at: 'b2',
        label: 'Una griglia uniforme',
        show: ['voxel-grid'],
      },
      {
        at: 'b3',
        label: 'Otto figli',
        show: ['octree'],
        depth: 1,
      },
      {
        at: 'b4',
        label: 'Si divide dove serve',
        depth: 2,
      },
      {
        at: 'b5',
        label: 'Figli più piccoli',
        depth: 3,
      },
      {
        at: 'b6',
        label: 'Il vuoto resta grande',
        depth: 4,
      },
      {
        at: 'b7',
        label: 'Ingresso del raggio',
        show: ['octree', 'ray'],
        focus: 'ray',
        progress: 0,
      },
      {
        at: 'b8',
        label: 'Discesa nei figli',
        progress: 0.17,
      },
      {
        at: 'b9',
        label: 'Salto del vuoto',
        progress: 0.35,
      },
      {
        at: 'b10',
        label: 'Incontra i voxel',
        progress: 0.39,
      },
      {
        at: 'b11',
        label: 'Visita completata',
        progress: 1,
      },
    ],
  },
  'cx-02-voxelizzazione': {
    title: 'Voxelizzare un triangolo',
    layers: ['triangle-voxelize'],
    triangles: [
      [
        [-0.42, -0.32, 0],
        [0.41, -0.24, 0.18],
        [-0.16, 0.38, -0.16],
      ],
    ],
    n: 11,
    mode: 'conservative',
    beats: [
      {
        at: 'b1',
        label: 'Riquadro dei candidati',
        camera: 'iso',
        progress: 0,
      },
      {
        at: 'b2',
        label: 'Primo gruppo di celle',
        progress: 0.2,
      },
      {
        at: 'b3',
        label: 'Test di intersezione',
        progress: 0.42,
      },
      {
        at: 'b4',
        label: 'Anche un bordo conta',
        progress: 0.67,
      },
      {
        at: 'b5',
        label: 'Superficie in voxel',
        progress: 1,
      },
      {
        at: 'b6',
        label: 'Proiezione dominante',
        project: true,
        camera: 'front',
      },
    ],
  },
  'cx-03-pipeline-grafica': {
    title: 'Dal triangolo al pixel',
    layers: ['pipeline'],
    triangles: [
      [
        [-0.41, -0.32, 0.31],
        [0.29, -0.23, 0.32],
        [-0.13, 0.33, 0.32],
      ],
      [
        [-0.48, 0.03, -0.32],
        [0.4, -0.29, -0.32],
        [0.27, 0.45, -0.32],
      ],
    ],
    beats: [
      {
        at: 'b1',
        label: 'Spazio del modello',
        phase: 'model',
        camera: 'iso',
      },
      {
        at: 'b2',
        label: 'Spazio della camera',
        phase: 'view',
        camera: 'front',
      },
      {
        at: 'b3',
        label: 'Coordinate clip',
        phase: 'clip',
      },
      {
        at: 'b4',
        label: 'Divisione per w',
        phase: 'divide',
      },
      {
        at: 'b5',
        label: 'Centri dei pixel',
        phase: 'raster',
        progress: 1,
      },
      {
        at: 'b6',
        label: 'Test di profondità',
        phase: 'depth',
      },
    ],
  },
  'cx-05-rotazioni-3d': {
    title: 'Ruotare un oggetto: l’ordine conta',
    layers: ['rotation'],
    turns: [
      ['y', 90],
      ['x', 90],
    ],
    beats: [
      {
        at: 'b1',
        label: 'Stessa posa iniziale',
        rotation: 'order',
        progress: 0,
      },
      {
        at: 'b2',
        label: 'Prima rotazione',
        progress: 0.5,
      },
      {
        at: 'b3',
        label: 'L’ordine cambia la posa',
        progress: 1,
      },
      {
        at: 'b4',
        label: 'Tre assi distinti',
        rotation: 'lock',
        orientation: [0, 0, 0],
      },
      {
        at: 'b5',
        label: 'Blocco cardanico',
        orientation: [0, 90, 0],
      },
      {
        at: 'b6',
        label: 'Arco più breve',
        rotation: 'slerp',
        orientation: [35, -10, 75],
      },
    ],
  },
  'cx-06-ray-casting': {
    title: 'Il ray casting di una scena',
    layers: ['raycast'],
    raycast: {
      grid: 24,
      rows: 16,
      ground: -0.38,
      light: [-0.72, 0.79, 0.58],
      objects: [
        {
          kind: 'sphere',
          at: [-0.05, -0.09, 0.06],
          radius: 0.29,
        },
        {
          kind: 'box',
          at: [0.48, -0.13, -0.3],
          size: 0.5,
        },
      ],
      explain: true,
    },
    beats: [
      {
        at: 'b1',
        cast: 'primary',
        pixel: [15, 5],
      },
      {
        at: 'b2',
        cast: 'hit',
      },
      {
        at: 'b3',
        cast: 'shadow',
        pixel: [20, 11],
      },
      {
        at: 'b4',
        cast: 'shadow',
        pixel: [3, 13],
      },
      {
        at: 'b5',
        cast: 'shade',
        pixel: [12, 5],
      },
      {
        at: 'b6',
        cast: 'scan',
      },
    ],
  },
  'g-02-cono-cilindro': {
    title: 'Perché il cono è un terzo del cilindro',
    layers: ['slice-stack'],
    slices: {
      radius: 1,
      height: 1.7724538509055159,
      n: 7,
    },
    beats: [
      {
        at: 'b1',
        sliceView: 'dissect',
      },
      {
        at: 'b2',
        sliceView: 'superpose',
      },
      {
        at: 'b3',
        sliceView: 'reassemble',
      },
      {
        at: 'b4',
        sliceView: 'cavalieri',
      },
      {
        at: 'b5',
        sliceView: 'conclusion',
      },
    ],
  },
  'g-03-sezioni-cubo': {
    title: 'Tagliare un cubo con un piano',
    layers: ['plane-section'],
    beats: [
      {
        section: {
          normal: [0.45, 0.6, 0.7],
          offset: 0.2,
        },
      },
      {
        at: 'b1',
        label: 'Taglio dritto: un quadrato',
        section: 'square',
      },
      {
        at: 'b2',
        label: "Taglio d'angolo: un triangolo",
        section: 'triangle',
      },
      {
        at: 'b3',
        label: 'Taglio dal centro: un esagono',
        section: 'hexagon',
      },
      {
        at: 'b4',
        label: 'Taglio storto: un trapezio',
        section: 'trapezoid',
      },
    ],
  },
} as const;

const cuesFor = (count: number) => Array.from({ length: count }, (_, index) => index * 2500);

function fixture(name: keyof typeof gold, viewport: { width: number; height: number }) {
  const spec = Space3dSpecSchema.parse(gold[name]);
  checkSpace3dSpec(spec);
  const root = new VectorNode('root', {}, viewport);
  const cues = cuesFor(spec.beats.length);
  root.data.durationMs = String(spec.beats.length * 2500);
  return { layout: buildSpace3d(spec, root, cues), cues: cues.map(cue => cue / 1000) };
}

const layoutCases = [
  ['current phone', readerStudioViewports.phone],
  ['current desktop', readerStudioViewports.desktop],
  ['wide phone', { width: 350, height: 178 }],
  ['wide desktop', { width: 650, height: 330 }],
  ['ray casting reference stage', { width: 1000, height: 508 }],
] as const;

test.each(
  Object.keys(gold) as (keyof typeof gold)[]
)('%s replays deterministically and gates labels at each viewport', name => {
  for (const [size, viewport] of layoutCases) {
    const { layout, cues } = fixture(name, viewport);
    const first = layout.inspect();
    const frames = cues.flatMap(time =>
      [time, time + 0.225, time + 0.6, time + 1.85].map(seconds => {
        layout.seek(seconds);
        const frame = layout.inspect();
        expect(frame.elements.some(mark => mark.mark)).toBe(true);
        return frame;
      })
    );
    layout.seek(0);
    expect(layout.inspect()).toEqual(first);
    if (size === 'ray casting reference stage') {
      const authoredLabels = gold[name].beats.flatMap(beat =>
        'label' in beat ? [beat.label] : []
      );
      if (authoredLabels.length)
        expect(
          frames.some(frame =>
            frame.labels.some(label => authoredLabels.some(authored => authored === label))
          )
        ).toBe(true);
    }
    const checks = checkStudioLayout({ stage: first.stage, frames });
    expect(checks, size).not.toContain('min-text');
    expect(frames.some(frame => JSON.stringify(frame) !== JSON.stringify(frames[0]))).toBe(true);
    layout.dispose();
  }
});

test('the cube section changes its label when the morph lands', () => {
  const { layout, cues } = fixture('g-03-sezioni-cubo', { width: 1000, height: 508 });
  layout.seek(cues[2] + 0.24);
  expect(layout.inspect().labels).not.toContain("Taglio d'angolo: un triangolo");
  layout.seek(cues[2] + 0.5);
  expect(layout.inspect().labels).toContain("Taglio d'angolo: un triangolo");
  layout.seek(cues[1] + 0.5, true);
  expect(layout.inspect().labels).toContain('Taglio dritto: un quadrato');
});

test('a narrated 3D draft reaches the reader gate and keeps the catalog fallback', async () => {
  const phrases = [
    'Il piano taglia il cubo in un quadrato.',
    'Il piano attraversa un angolo del cubo.',
  ];
  const scene = decodeGeometryStudioDraft(
    {
      type: 'geometry',
      geometryStudio: {
        id: 'space-3d',
        spec: {
          title: 'Sezioni del cubo',
          layers: ['plane-section'],
          beats: [
            { at: 'b1', section: 'square', label: 'Taglio dritto: un quadrato' },
            { at: 'b2', section: 'triangle', label: "Taglio d'angolo: un triangolo" },
          ],
        },
      },
    },
    phrases.join(' '),
    phrases
  );
  if (!scene) throw new Error('Expected a valid geometry draft');
  expect(scene.studioCues.map(cue => cue.anchor)).toEqual(phrases);
  expect(await checkStudioCandidate(scene)).toContain('min-gap');
  expect(studioFallback(scene.geometryStudio.id)).toEqual('concepts');
});

test('switching to a solid hides all ray casting marks at the narration cue', () => {
  const casting = gold['cx-06-ray-casting'];
  const spec = Space3dSpecSchema.parse({
    ...casting,
    layers: ['raycast', 'solid'],
    solid: { kind: 'cube', side: 1 },
    beats: [{ cast: 'primary', show: ['raycast'] }, { show: ['solid'] }],
  });
  const root = new VectorNode('root', {}, { width: 1000, height: 508 });
  root.data.durationMs = '5000';
  const layout = buildSpace3d(spec, root, [0, 2500]);
  layout.seek(0.7);
  const cameraGuide = enclosingBoxes(root).find(
    ({ element }) =>
      element.tag === 'path' &&
      element.attrs['data-clearance-ignore'] === '' &&
      element.attrs.visibility === 'visible'
  );
  expect(cameraGuide).toBeDefined();
  layout.seek(2.5, true);
  expect(enclosingBoxes(root).some(({ element }) => element === cameraGuide?.element)).toBe(false);
  layout.dispose();
});

test('disposing a ray casting layout releases its ground texture once', () => {
  const { layout } = fixture('cx-06-ray-casting', readerStudioViewports.desktop);
  const groundTextures = new Set<Texture>();
  layout.mesh.scene.traverse(node => {
    if (node instanceof Mesh && node.material instanceof MeshBasicMaterial && node.material.map)
      groundTextures.add(node.material.map);
  });
  expect(groundTextures.size).toBe(1);
  let released = 0;
  for (const texture of groundTextures)
    texture.addEventListener('dispose', () => {
      released++;
    });
  layout.dispose();
  expect(released).toBe(1);
});

test('space 3D uses shared phrase ids and rejects collinear triangle coordinates', () => {
  expect(
    Space3dSpecSchema.safeParse({
      title: 'Sezioni del cubo',
      layers: ['plane-section'],
      beats: [{ at: 'b01', section: 'square' }],
    }).success
  ).toBe(false);
  const triangles = Space3dSpecSchema.parse({
    title: 'Voxelizzazione',
    layers: ['triangle-voxelize'],
    triangles: [
      [
        [0.1, 0.1, 0.1],
        [0.2, 0.3, 0.1],
        [0.3, 0.5, 0.1],
      ],
    ],
    beats: [{ at: 'b1', progress: 1 }],
  });
  expect(() => checkSpace3dSpec(triangles)).toThrow('Triangle vertices must span an area');
});
test('slice-stack playback uses the selected slice and the partition count', () => {
  const shape = (n: number) => {
    const spec = Space3dSpecSchema.parse({
      title: 'Sezioni del cono',
      layers: ['slice-stack'],
      slices: { radius: 1, height: 2, n },
      beats: [
        { sliceView: 'slices', slice: 0 },
        { sliceView: 'slices', slice: 3 },
      ],
    });
    const root = new VectorNode('root', {}, { width: 1280, height: 650 });
    root.data.durationMs = '5000';
    return buildSpace3d(spec, root, [0, 2500]);
  };
  const four = shape(4);
  const eight = shape(8);
  four.seek(0, true);
  eight.seek(0, true);
  const first = four.inspect().elements.filter(element => element.mark);
  expect(eight.inspect().elements.filter(element => element.mark)).not.toEqual(first);
  four.seek(2.5, true);
  expect(four.inspect().elements.filter(element => element.mark)).not.toEqual(first);
  four.dispose();
  eight.dispose();
});

test('a close-up cannot target a layer that the next beat hides', () => {
  const spec = Space3dSpecSchema.parse({
    title: 'Sezioni del cubo',
    layers: ['solid', 'plane-section'],
    solid: { kind: 'cube', side: 1 },
    beats: [{ show: ['plane-section'], camera: 'close-on:plane-section' }, { show: ['solid'] }],
  });
  expect(() => checkSpace3dSpec(spec)).toThrow('The close-up layer must be visible');
});

test('the camera glides between close-ups even when the outgoing layer hides', () => {
  const spec = Space3dSpecSchema.parse({
    title: 'Close-ups of a ray and a solid',
    layers: ['solid', 'octree', 'ray'],
    solid: { kind: 'cube', side: 1 },
    shape: 'sphere',
    ray: { origin: [-1, 0, 0], direction: [1, 0, 0] },
    beats: [
      { focus: 'solid', camera: 'close-on:ray' },
      { show: ['solid'], camera: 'close-on:solid' },
    ],
  });
  checkSpace3dSpec(spec);
  const root = new VectorNode('root', {}, readerStudioViewports.desktop);
  root.data.durationMs = '5000';
  const layout = buildSpace3d(spec, root, [0, 2500]);
  const { camera } = layout.mesh;

  // Both beats use the solid's orbit at the same distance. Its final target is the origin.
  layout.seek(3);
  const distance = camera.position.length();
  const lookAt = () =>
    camera.position
      .clone()
      .addScaledVector(camera.getWorldDirection(camera.position.clone()), distance);

  const finish = lookAt();
  layout.seek(2.5 - 0.001);
  const start = lookAt();
  expect(start.distanceTo(finish)).toBeGreaterThan(0.1);

  layout.seek(2.5);
  expect(lookAt().distanceTo(start)).toBeCloseTo(0);
  layout.seek(2.625);
  expect(lookAt().distanceTo(start.clone().lerp(finish, 0.0625))).toBeCloseTo(0);
  layout.seek(2.75);
  expect(lookAt().distanceTo(start.clone().lerp(finish, 0.5))).toBeCloseTo(0);
  layout.seek(2.875);
  expect(lookAt().distanceTo(start.clone().lerp(finish, 0.9375))).toBeCloseTo(0);
  layout.seek(2.5, true);
  expect(lookAt().distanceTo(finish)).toBeCloseTo(0);
  layout.dispose();
});

test.each([
  readerStudioViewports.desktopWide,
  readerStudioViewports.phone,
  readerStudioViewports.phoneFullscreen,
])('the canvas and SVG preserve a square at $width × $height CSS px', viewport => {
  const spec = Space3dSpecSchema.parse({
    title: 'Front view of a cube',
    layers: ['solid'],
    solid: { kind: 'cube', side: 1 },
    beats: [{ camera: 'front' }],
  });
  const root = new VectorNode('root', {}, viewport);
  root.data.durationMs = '2500';
  const layout = buildSpace3d(spec, root, [0]);
  const { camera, width, height } = layout.mesh;
  expect({ width, height }).toEqual(viewport);
  expect(root.children[0].attrs.viewBox).toBe(`0 0 ${width} ${height}`);
  expect(layout.inspect().stage).toEqual({ left: 0, top: 0, right: width, bottom: height });
  const first = new Vector3(0, 0, 0).project(camera);
  const right = new Vector3(0.25, 0, 0).project(camera);
  const top = new Vector3(0, 0.25, 0).project(camera);
  const xSpan = ((right.x - first.x) * width) / 2;
  const ySpan = ((top.y - first.y) * height) / 2;
  expect(xSpan).toBeGreaterThan(10);
  expect(xSpan).toBeCloseTo(ySpan, 8);
  const cube = layout.inspect().elements.find(element => element.mark)?.bounds;
  if (!cube) throw new Error('Expected the cube in the validated frame');
  expect(cube.right - cube.left).toBeCloseTo(cube.bottom - cube.top, 8);
  layout.dispose();
});

test('the cylinder drains smoothly to a smaller poured count and resets to empty', () => {
  const spec = Space3dSpecSchema.parse({
    title: 'Repeat the cone and cylinder comparison',
    layers: ['slice-stack'],
    slices: { radius: 1, height: 2, n: 4 },
    beats: [{ sliceView: 'pour', poured: 3 }, { poured: 2 }, { poured: 0 }],
  });
  const root = new VectorNode('root', {}, readerStudioViewports.desktop);
  root.data.durationMs = '7500';
  const layout = buildSpace3d(spec, root, [0, 2500, 5000]);
  const tank = layout.mesh.scene
    .getObjectsByProperty('type', 'Mesh')
    .find(
      node =>
        node instanceof Mesh &&
        node.position.x > 0 &&
        node.geometry instanceof CylinderGeometry &&
        node.geometry.parameters.height === 1
    );
  if (!tank) throw new Error('Expected the rendered cylinder liquid');

  layout.seek(2.49);
  const fullHeight = tank.scale.y;
  expect(fullHeight).toBeGreaterThan(0);
  layout.seek(2.5);
  expect(tank.scale.y).toBeCloseTo(fullHeight, 8);
  layout.seek(2.75);
  expect(tank.scale.y).toBeLessThan(fullHeight);
  expect(tank.scale.y).toBeGreaterThan((2 * fullHeight) / 3);
  layout.seek(3);
  expect(tank.scale.y).toBeCloseTo((2 * fullHeight) / 3, 8);
  layout.seek(5.25);
  expect(tank.visible).toBe(true);
  expect(tank.scale.y).toBeGreaterThan(0);
  expect(tank.scale.y).toBeLessThan((2 * fullHeight) / 3);
  layout.seek(5.5);
  expect(tank.scale.y).toBe(0);
  expect(tank.visible).toBe(false);
  layout.seek(5, true);
  expect(tank.visible).toBe(false);
  layout.seek(2.49);
  expect(tank.scale.y).toBeCloseTo(fullHeight, 8);
  layout.dispose();
});
