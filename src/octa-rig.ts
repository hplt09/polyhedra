// Octa transformation rig — cycles smoothly between the rigid octahedron
// and a layered tower (two pyramid tips + frustums + counter-spinning discs
// + a tiny central core). A cosine bell curve drives the deploy amount so
// there's no flat pause at either extreme; yaw runs at a constant rate so
// the rig keeps spinning through the cycle's stillpoints.
//
// At rest the upper + lower square pyramids meet at the equator to form a
// single octahedron. As the deploy amount rises, the two halves separate
// vertically and the inner pieces (two octagonal frustums, two counter-
// spinning discs, a tiny central octa core) grow from zero scale to fill
// the gap.

import * as THREE from "three";

// ---------------------------------------------------------------------------
// Geometry helpers — module-private.
// ---------------------------------------------------------------------------
type Vec3 = readonly [number, number, number];

// Push one flat-shaded triangle (a→b→c CCW) into a positions + normals pair.
// The normal is computed from the cross product so callers don't have to
// pre-compute it; flat shading expects three identical per-vertex normals.
function pushFlatTri(pos: number[], nor: number[], a: Vec3, b: Vec3, c: Vec3) {
  const u = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const v = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const n = u.cross(v).normalize();
  pos.push(...a, ...b, ...c);
  for (let i = 0; i < 3; i++) nor.push(n.x, n.y, n.z);
}

function flatGeometry(pos: number[], nor: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

// Square-base pyramid whose 4 base verts sit on the cardinal axes (matching
// the project octahedron's equatorial verts). tipY > baseY → tip up;
// reversing them flips winding so the lower octa half builds correctly.
function makePyramid(
  baseHalf: number,
  baseY: number,
  tipY: number,
): THREE.BufferGeometry {
  const tip: Vec3 = [0, tipY, 0];
  const base: Vec3[] = [
    [baseHalf, baseY, 0],
    [0, baseY, baseHalf],
    [-baseHalf, baseY, 0],
    [0, baseY, -baseHalf],
  ];
  const pointsUp = tipY > baseY;
  const pos: number[] = [];
  const nor: number[] = [];
  for (let i = 0; i < 4; i++) {
    const cur = base[i];
    const next = base[(i + 1) % 4];
    if (pointsUp) pushFlatTri(pos, nor, tip, cur, next);
    else pushFlatTri(pos, nor, tip, next, cur);
  }
  // Base cap — fan-triangulated, facing opposite the tip.
  if (pointsUp) {
    pushFlatTri(pos, nor, base[0], base[2], base[1]);
    pushFlatTri(pos, nor, base[0], base[3], base[2]);
  } else {
    pushFlatTri(pos, nor, base[0], base[1], base[2]);
    pushFlatTri(pos, nor, base[0], base[2], base[3]);
  }
  return flatGeometry(pos, nor);
}

// Regular polygonal frustum / disc. rTop=0 collapses the top to a point;
// rTop=rBot with a small |yTop-yBot| gives a flat plate. `twist` rotates
// the polygon around Y so adjacent layers can stagger.
function makeFrustum(
  rTop: number,
  rBot: number,
  yTop: number,
  yBot: number,
  sides: number,
  twist = 0,
): THREE.BufferGeometry {
  const top: Vec3[] = [];
  const bot: Vec3[] = [];
  for (let i = 0; i < sides; i++) {
    const ang = (i / sides) * Math.PI * 2 + twist;
    top.push([Math.cos(ang) * rTop, yTop, Math.sin(ang) * rTop]);
    bot.push([Math.cos(ang) * rBot, yBot, Math.sin(ang) * rBot]);
  }
  const pos: number[] = [];
  const nor: number[] = [];
  for (let i = 0; i < sides; i++) {
    const ni = (i + 1) % sides;
    pushFlatTri(pos, nor, top[i], bot[i], bot[ni]);
    pushFlatTri(pos, nor, top[i], bot[ni], top[ni]);
  }
  // End caps — fan-triangulated, skipped when the radius collapses to a point.
  const CAP_EPS = 0.001;
  for (let i = 1; i < sides - 1 && rTop > CAP_EPS; i++) {
    pushFlatTri(pos, nor, top[0], top[i], top[i + 1]);
  }
  for (let i = 1; i < sides - 1 && rBot > CAP_EPS; i++) {
    pushFlatTri(pos, nor, bot[0], bot[i + 1], bot[i]);
  }
  return flatGeometry(pos, nor);
}

// ---------------------------------------------------------------------------
// Rig factory.
// ---------------------------------------------------------------------------
type RigPart = {
  mesh: THREE.Mesh;
  restPos: THREE.Vector3;
  restScale: number;
  deployPos: THREE.Vector3;
  deployScale: number;
  // Local Y self-rotation multiplier on the accumulated yaw. World yaw of
  // the part is (group yaw rate) + (spinMult × yaw rate). Used to counter-
  // spin the discs against the group rotation.
  spinMult?: number;
};

export interface OctaRig {
  readonly group: THREE.Group;
  /** Advance one frame: increment timer, update deploy + yaw + per-part pose. */
  update(): void;
  /** Reset the deploy cycle to its rest state — call on octa re-selection. */
  resetCycle(): void;
}

export interface OctaRigOptions {
  /** Material for solid faces — shared with the project's hero material. */
  heroMat: THREE.Material;
  /** Material for the wireframe edges drawn over every part. */
  edgeMat: THREE.LineBasicMaterial;
  /** BufferGeometry for the central octahedron core (reused from the cache). */
  coreGeom: THREE.BufferGeometry;
  /** Frames per full deploy/fold cycle. */
  cycleFrames: number;
  /** Full revolutions per cycle — yaw rate = (2π × revs) / cycleFrames. */
  revsPerCycle: number;
  /** Fixed camera-side X tilt so the rig never gets viewed from below. */
  tiltX: number;
}

export function createOctaRig(opts: OctaRigOptions): OctaRig {
  const yawPerFrame = (Math.PI * 2 * opts.revsPerCycle) / opts.cycleFrames;
  let timer = 0;
  let yaw = 0;
  const group = new THREE.Group();
  group.visible = false;
  const parts: RigPart[] = [];

  function addPart(
    geom: THREE.BufferGeometry,
    restPos: Vec3,
    restScale: number,
    deployPos: Vec3,
    deployScale: number,
  ): RigPart {
    const mesh = new THREE.Mesh(geom, opts.heroMat);
    // Edges inherit the mesh transform — same wireframe highlight as the
    // project's hero edges.
    mesh.add(
      new THREE.LineSegments(new THREE.EdgesGeometry(geom), opts.edgeMat),
    );
    group.add(mesh);
    const part: RigPart = {
      mesh,
      restPos: new THREE.Vector3(...restPos),
      restScale,
      deployPos: new THREE.Vector3(...deployPos),
      deployScale,
    };
    parts.push(part);
    return part;
  }

  // Build the rig top → bottom. At rest only the two pyramids are visible —
  // together they form the octahedron silhouette. Every other part starts at
  // scale 0 and grows in as the deploy amount rises toward 1.
  addPart(makePyramid(1, 0, 1), [0, 0, 0], 1, [0, 1.55, 0], 0.55);
  addPart(makePyramid(1, 0, -1), [0, 0, 0], 1, [0, -1.55, 0], 0.55);
  // Upper / lower frustums — narrow→wide between the pyramid tip and disc.
  addPart(
    makeFrustum(0.35, 0.85, 0.22, -0.22, 8, Math.PI / 8),
    [0, 0, 0], 0, [0, 1, 0], 1,
  );
  addPart(
    makeFrustum(0.85, 0.35, 0.22, -0.22, 8, Math.PI / 8),
    [0, 0, 0], 0, [0, -1, 0], 1,
  );
  // Upper / lower discs — wide octagonal plates, thin profile. spinMult
  // counter-spins each disc against the group yaw at a different rate so
  // the two slice past each other like a kinetic sculpture.
  const discGeom = makeFrustum(1.2, 1.2, 0.08, -0.08, 8, 0);
  const upperDisc = addPart(discGeom, [0, 0, 0], 0, [0, 0.55, 0], 1);
  upperDisc.spinMult = -2.5; // world rate = +1 − 2.5 = −1.5 (counter)
  const lowerDisc = addPart(discGeom, [0, 0, 0], 0, [0, -0.55, 0], 1);
  lowerDisc.spinMult = 1.5; // world rate = +2.5 (faster, same direction)
  // Central core — the floating dot revealed between the parted halves.
  addPart(opts.coreGeom, [0, 0, 0], 0, [0, 0, 0], 0.22);

  // Cosine bell curve, 0 → 1 → 0 with no flat hold at either extreme.
  // Velocity tapers smoothly at the endpoints so the reversals don't snap.
  function deployAmount(): number {
    const phase = (timer % opts.cycleFrames) / opts.cycleFrames;
    return (1 - Math.cos(phase * Math.PI * 2)) / 2;
  }

  return {
    group,
    update() {
      timer = (timer + 1) % opts.cycleFrames;
      yaw += yawPerFrame;
      const deploy = deployAmount();
      group.rotation.y = yaw;
      group.rotation.x = opts.tiltX;
      for (const part of parts) {
        part.mesh.position.lerpVectors(part.restPos, part.deployPos, deploy);
        const s =
          part.restScale + (part.deployScale - part.restScale) * deploy;
        part.mesh.scale.setScalar(s);
        if (part.spinMult !== undefined) {
          part.mesh.rotation.y = yaw * part.spinMult;
        }
      }
    },
    resetCycle() {
      timer = 0;
    },
  };
}
