import { z } from "zod";
import { geometryBeatFields } from "./geometryStudioSpec";
import { Triangle, Vector3 } from "three";

const sectionPresets = ["square", "triangle", "hexagon", "trapezoid"] as const;
export const layerNames = ["shape", "voxel-grid", "octree", "ray", "triangle-voxelize", "pipeline",
  "solid", "slice-stack", "plane-section", "rotation", "raycast"] as const;
export const shapes = ["sphere", "torus", "box", "capsule", "bunny-like blob"] as const;
export const phases = ["model", "view", "clip", "divide", "raster", "depth"] as const;
const layer = z.enum(layerNames);
const camera = z.enum(["front", "iso", "top", ...layerNames.map(name => `close-on:${name}` as const)]);
const direction = z.tuple([z.number(), z.number(), z.number()]);
const vertex = z.tuple([z.number().min(-0.5).max(0.5), z.number().min(-0.5).max(0.5), z.number().min(-0.5).max(0.5)]);
const triangle = z.tuple([vertex, vertex, vertex]);
const dimension = z.number().min(0.1).max(100);
const dimensions = z.tuple([dimension, dimension, dimension]);
const angle = z.number().min(-180).max(180);
const angles = z.tuple([angle, angle, angle]);
const axis = z.enum(["x", "y", "z"]);
const turn = z.tuple([axis, angle]);
const coordinate = z.number().min(-1).max(1);
const point = z.tuple([coordinate, coordinate, coordinate]);
const raySize = z.number().min(0.05).max(0.5);
const section = z.union([z.enum(sectionPresets), z.strictObject({ normal: point, offset: coordinate })]);
const solid = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cube"), side: dimension }),
  z.strictObject({ kind: z.literal("prism"), size: dimensions }),
  z.strictObject({ kind: z.literal("pyramid"), size: dimensions }),
  z.strictObject({ kind: z.literal("cylinder"), radius: dimension, height: dimension }),
  z.strictObject({ kind: z.literal("cone"), radius: dimension, height: dimension }),
  z.strictObject({ kind: z.literal("sphere"), radius: dimension }),
]);

export const Space3dSpecSchema = z.strictObject({
  title: z.string().trim().min(1).max(72),
  layers: z.array(layer).min(1).max(layerNames.length),
  shape: z.enum(shapes).optional(),
  n: z.number().int().min(8).max(64).default(16),
  maxDepth: z.number().int().min(1).max(6).default(4),
  wire: z.boolean().default(false),
  ray: z.strictObject({ origin: direction, direction }).optional(),
  triangles: z.array(triangle).min(1).max(3).optional(),
  mode: z.enum(["conservative", "centre"]).default("conservative"),
  solid: solid.optional(),
  slices: z.strictObject({ radius: dimension, height: dimension, n: z.number().int().min(3).max(16) }).optional(),
  turns: z.tuple([turn, turn]).optional(),
  raycast: z.strictObject({
    objects: z.array(z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("sphere"), at: point, radius: raySize }),
      z.strictObject({ kind: z.literal("box"), at: point, size: raySize }),
    ])).min(2).max(4),
    light: point,
    explain: z.literal(true).optional(),
    grid: z.number().int().min(5).max(24),
    rows: z.number().int().min(5).max(24).optional(),
    ground: coordinate.optional(),
  }).optional(),
  beats: z.array(z.strictObject({
    ...geometryBeatFields,
    at: z.string().regex(/^b\d+$/u).optional(),
    show: z.array(layer).min(1).max(layerNames.length).optional(),
    focus: layer.optional(),
    camera: camera.optional(),
    depth: z.number().int().min(0).max(6).optional(),
    progress: z.number().min(0).max(1).optional(),
    project: z.boolean().optional(),
    phase: z.enum(phases).optional(),
    section: section.optional(),
    sliceView: z.enum(["solids", "slices", "bars", "pour", "dissect", "superpose", "reassemble", "cavalieri", "conclusion"]).optional(),
    slice: z.number().int().min(0).max(15).optional(),
    bars: z.union([z.literal(4), z.literal(8), z.literal(32)]).optional(),
    poured: z.number().int().min(0).max(3).optional(),
    rotation: z.enum(["order", "lock", "slerp"]).optional(),
    orientation: angles.optional(),
    cast: z.enum(["primary", "hit", "shadow", "shade", "scan"]).optional(),
    pixel: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
  })).min(1),
});

export type Spec = z.output<typeof Space3dSpecSchema>;
export type LayerName = typeof layerNames[number];
export type Beat = Spec["beats"][number];

export function checkSpace3dSpec(spec: Spec) {
  const layers = new Set(spec.layers);
  if (layers.size !== spec.layers.length) throw new Error("Choose each layer once");
  if (["shape", "voxel-grid", "octree"].some(name => layers.has(name as LayerName)) && !spec.shape) {
    throw new Error("Shape, voxel-grid and octree require a shape");
  }
  if (layers.has("ray") && (!layers.has("octree") || !spec.ray || new Vector3(...spec.ray.direction).lengthSq() === 0)) {
    throw new Error("A ray requires an octree, an origin and a nonzero direction");
  }
  if (layers.has("triangle-voxelize") && !spec.triangles) throw new Error("Voxelization requires 1–3 triangles");
  if (layers.has("pipeline") && spec.triangles?.length !== 2) throw new Error("The pipeline requires two triangles");
  if (layers.has("solid") && !spec.solid) throw new Error("A solid requires dimensions");
  if (layers.has("slice-stack") && !spec.slices) throw new Error("A slice stack requires a radius, height and slice count");
  if (layers.has("rotation") && (!spec.turns || spec.turns[0][0] === spec.turns[1][0])) {
    throw new Error("The rotation comparison requires two different axes");
  }
  if (layers.has("raycast") && !spec.raycast) throw new Error("Ray casting requires objects, a light and a pixel grid");
  for (const [a, b, c] of spec.triangles ?? []) {
    if (new Triangle(new Vector3(...a), new Vector3(...b), new Vector3(...c)).getArea() === 0) {
      throw new Error("Triangle vertices must span an area");
    }
  }

  let visible = spec.layers;
  for (const beat of spec.beats) {
    visible = beat.show ?? visible;
    if (new Set(visible).size !== visible.length) throw new Error("Choose each visible layer once");
    if ([...visible, beat.focus, beat.camera?.split(":")[1]].some(name => name && !layers.has(name as LayerName))) {
      throw new Error("Beat references a layer that was not declared");
    }
    if (beat.focus && !visible.includes(beat.focus)) throw new Error("The focused layer must be visible");
    if (visible.includes("ray") && !visible.includes("octree")) throw new Error("Viewing a ray requires a visible octree");
    if (beat.depth !== undefined && beat.depth > spec.maxDepth) throw new Error("Beat depth exceeds maxDepth");
    if (typeof beat.section === "object" && beat.section.normal.every(component => component === 0)) {
      throw new Error("A section plane requires a nonzero normal");
    }
    if (beat.slice !== undefined && (!spec.slices || beat.slice >= spec.slices.n)) throw new Error("Slice index is outside the stack");
    if (beat.pixel && (!spec.raycast || (beat.pixel[0] >= spec.raycast.grid || beat.pixel[1] >= (spec.raycast.rows ?? spec.raycast.grid)))) {
      throw new Error("Pixel index is outside the image grid");
    }
  }
}
