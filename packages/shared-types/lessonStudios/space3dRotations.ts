import { copy, rotationOrder } from "./space3dCopy.it";
import {
  BoxGeometry, ConeGeometry, CylinderGeometry, Euler, Mesh, Quaternion, TorusGeometry, Vector3,
} from "three";
import type { Group } from "three";
import { Group as Pivot } from "three";
import { DIM } from "./motion";
import { derived } from "./chart";
import { lit } from "./space3dDraw";
import type { Palette } from "./space3dDraw";
import type { Beat, Spec } from "./space3dSpec";

const x = new Vector3(1, 0, 0), y = new Vector3(0, 1, 0), z = new Vector3(0, 0, 1);
const axes = { x, y, z };
const radians = Math.PI / 180;
const neutral = [0, 0, 0] as const;

export function sequenceQuaternion(turns: NonNullable<Spec["turns"]>, progress: number) {
  const orient = new Quaternion();
  turns.forEach(([axis, degrees], index) => {
    const fraction = Math.min(1, Math.max(0, progress * turns.length - index));
    orient.premultiply(new Quaternion().setFromAxisAngle(axes[axis], degrees * radians * fraction));
  });
  return orient;
}

function eulerQuaternion([a, b, c]: readonly [number, number, number]) {
  return new Quaternion().setFromEuler(new Euler(a * radians, b * radians, c * radians, "XYZ"));
}

export function gimbalAxes([a, b]: readonly [number, number, number]) {
  const outer = new Quaternion().setFromAxisAngle(x, a * radians);
  const middle = outer.clone().multiply(new Quaternion().setFromAxisAngle(y, b * radians));
  return [x.clone(), y.clone().applyQuaternion(outer), z.clone().applyQuaternion(middle)] as const;
}

function aircraft(group: Group, colors: Palette) {
  const nose = new Mesh(new ConeGeometry(0.097, 0.24, 24), lit(colors.accent));
  const fuselage = new Mesh(new CylinderGeometry(0.057, 0.075, 0.4, 24), lit(colors.accent));
  const wing = new Mesh(new BoxGeometry(0.46, 0.035, 0.15), lit(colors.far));
  const tail = new Mesh(new BoxGeometry(0.15, 0.12, 0.09), lit(colors.far));
  const port = new Mesh(new BoxGeometry(0.09, 0.055, 0.14), lit(colors.near));
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 0.22;
  fuselage.rotation.x = Math.PI / 2;
  fuselage.position.z = -0.09;
  wing.position.z = -0.025;
  tail.position.set(0, 0.065, -0.26);
  port.position.set(-0.21, 0, -0.02);
  group.add(nose, fuselage, wing, tail, port);
}

export function rotationLesson(parent: Group, turns: NonNullable<Spec["turns"]>, colors: Palette) {
  const left = new Pivot(), right = new Pivot();
  parent.add(left, right);
  const objects = [left, right].map(pivot => {
    const body = new Pivot();
    pivot.add(body);
    aircraft(body, colors);
    return body;
  });
  const rings = [colors.near, colors.far, colors.accent].map((color, index) => {
    const mesh = new Mesh(new TorusGeometry(0.43 + 0.043 * (2 - index), 0.013, 8, 64), lit(color));
    mesh.material.depthWrite = false;
    left.add(mesh);
    return mesh;
  });
  const startGhost = new Pivot(), endGhost = new Pivot();
  for (const ghost of [startGhost, endGhost]) {
    left.add(ghost);
    aircraft(ghost, colors);
    ghost.traverse(node => {
      if (node instanceof Mesh) node.material.depthWrite = false;
    });
  }
  const reverse: typeof turns = [turns[1], turns[0]];
  const baseSpacing = 0.53;
  const label = ([first, second]: typeof turns) => rotationOrder(first[0].toUpperCase(), second[0].toUpperCase());
  const arrows = [label(turns), label(reverse)];
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;

  return (before: Beat, after: Beat, t: number, opacity: number) => {
    const from = before.rotation ?? "order", mode = after.rotation ?? "order";
    const strength = (view: string) => (from === view ? 1 - t : 0) + (mode === view ? t : 0);
    const comparison = strength("order");
    const lock = strength("lock");
    const slerp = strength("slerp");
    const fromAngles = before.orientation ?? neutral, toAngles = after.orientation ?? neutral;
    const fromPose = (sequence: typeof turns) => from === "order"
      ? sequenceQuaternion(sequence, before.progress ?? 0) : eulerQuaternion(fromAngles);
    const toPose = (sequence: typeof turns) => mode === "order"
      ? sequenceQuaternion(sequence, after.progress ?? 0) : eulerQuaternion(toAngles);

    for (const [index, body] of objects.entries()) {
      const sequence = index ? reverse : turns;
      body.scale.setScalar(1 + comparison * 0.19);
      if (from === "order" && mode === "order") {
        body.quaternion.copy(sequenceQuaternion(sequence, mix(before.progress ?? 0, after.progress ?? 0, t)));
      } else if (mode === "lock" && from === "lock") {
        body.quaternion.copy(eulerQuaternion([mix(fromAngles[0], toAngles[0], t),
          mix(fromAngles[1], toAngles[1], t), mix(fromAngles[2], toAngles[2], t)]));
      } else {
        body.quaternion.slerpQuaternions(fromPose(sequence), toPose(sequence), t);
      }
    }
    left.position.x = -baseSpacing * comparison;
    right.position.x = baseSpacing;
    right.visible = comparison > 0;
    right.traverse(node => {
      if (node instanceof Mesh) {
        node.material.opacity = comparison * opacity;
        node.material.depthWrite = comparison * opacity > 0.99;
      }
    });

    // The middle and inner axes follow the outer pivots of an intrinsic XYZ gimbal.
    const currentAngles = [
      mix(fromAngles[0], toAngles[0], t), mix(fromAngles[1], toAngles[1], t), mix(fromAngles[2], toAngles[2], t),
    ] as const;
    const ringAxes = gimbalAxes(currentAngles);
    rings.forEach((ring, index) => {
      ring.quaternion.setFromUnitVectors(z, ringAxes[index]);
      ring.visible = lock > 0;
      ring.material.opacity = lock * opacity;
    });
    for (const [index, ghost] of [startGhost, endGhost].entries()) {
      ghost.quaternion.copy(index ? toPose(turns) : fromPose(turns));
      ghost.visible = slerp > 0 && (index === 0 ? t > 0.05 : t < 0.95);
      ghost.traverse(node => {
        if (node instanceof Mesh) node.material.opacity = DIM * slerp * opacity;
      });
    }

    const overlap = Math.abs(ringAxes[0].dot(ringAxes[2]));
    const difference = objects[0].quaternion.angleTo(objects[1].quaternion) / radians;
    const rows = mode === "order"
      ? [[arrows[0], copy.leftOrder], [arrows[1], copy.rightOrder], [`${derived(difference)}°`, copy.orientationDelta]]
      : mode === "lock"
        ? [[`${derived(currentAngles[1])}°`, copy.yRing],
          [overlap > 1 - 1e-8 ? copy.axesAligned : copy.axesDistinct, copy.rotationAxes],
          [overlap > 1 - 1e-8 ? "2" : "3", copy.degreesOfFreedom]]
        : [[`${derived(100 * t)}%`, copy.slerp], [`${derived(fromPose(turns).angleTo(toPose(turns)) / radians)}°`, copy.shortestArc]];
    return { rows, target: new Vector3(left.position.x, 0.16, 0), labels: mode === "order" ? [
      { text: arrows[0], point: new Vector3(left.position.x, -0.46, 0) },
      { text: arrows[1], point: new Vector3(right.position.x, -0.46, 0) },
    ] : [] };
  };
}
