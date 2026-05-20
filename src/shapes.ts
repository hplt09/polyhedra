// Pure shape data + builders. No DOM / Three.js / state dependencies — this
// module only computes vertex/face lists. The visualiser consumes SHAPES,
// SPIN_PROFILES and the shape-name constants to drive rendering.

export const TETRA_SHAPE_NAME = "tetra";
export const STELLA_SHAPE_NAME = "stella";
export const GSTELLA_SHAPE_NAME = "gstella";
export const DODECA_SHAPE_NAME = "dodeca";

export type Face3 = { idx: number[]; n: [number, number, number] };
export type Polyhedron = {
  name: string;
  verts: [number, number, number][];
  faces: Face3[];
};

// Normalise vertices to the unit sphere and compute per-face outward
// normals + a CCW winding from the supplied raw vertex / face index lists.
export function makePolyhedron(
  name: string,
  rawVerts: [number, number, number][],
  faceIndices: number[][],
): Polyhedron {
  let maxNorm = 0;
  for (const v of rawVerts) {
    const r = Math.hypot(v[0], v[1], v[2]);
    if (r > maxNorm) maxNorm = r;
  }
  const verts: [number, number, number][] = rawVerts.map((v) => [
    v[0] / maxNorm,
    v[1] / maxNorm,
    v[2] / maxNorm,
  ]);
  const faces: Face3[] = faceIndices.map((rawIdx) => {
    const idx = [...rawIdx];
    let cx = 0,
      cy = 0,
      cz = 0;
    for (const i of idx) {
      cx += verts[i][0];
      cy += verts[i][1];
      cz += verts[i][2];
    }
    cx /= idx.length;
    cy /= idx.length;
    cz /= idx.length;
    const v0 = verts[idx[0]],
      v1 = verts[idx[1]],
      v2 = verts[idx[2]];
    const ax = v1[0] - v0[0],
      ay = v1[1] - v0[1],
      az = v1[2] - v0[2];
    const bx = v2[0] - v0[0],
      by = v2[1] - v0[1],
      bz = v2[2] - v0[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    if (nx * cx + ny * cy + nz * cz < 0) {
      idx.reverse();
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    return { idx, n: [nx, ny, nz] };
  });
  return { name, verts, faces };
}

const PHI = (1 + Math.sqrt(5)) / 2;

function ringVerts(
  n: number,
  radius: number,
  y: number,
  offsetTurns = 0,
): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + offsetTurns) / n) * Math.PI * 2;
    out.push([Math.cos(a) * radius, y, Math.sin(a) * radius]);
  }
  return out;
}

function makeBipyramid(
  name: string,
  n: number,
  height: number,
  radius = 1,
): Polyhedron {
  const verts: [number, number, number][] = [
    [0, height, 0],
    [0, -height, 0],
    ...ringVerts(n, radius, 0),
  ];
  const faces: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = 2 + i;
    const b = 2 + ((i + 1) % n);
    faces.push([0, a, b]);
    faces.push([1, b, a]);
  }
  return makePolyhedron(name, verts, faces);
}

function makeAntiprism(name: string, n: number, height: number): Polyhedron {
  const top = ringVerts(n, 1, height);
  const bot = ringVerts(n, 1, -height, 0.5);
  const faces: number[][] = [];
  faces.push(top.map((_, i) => i));
  faces.push(bot.map((_, i) => n + i).reverse());
  for (let i = 0; i < n; i++) {
    const ni = (i + 1) % n;
    faces.push([i, ni, n + i]);
    faces.push([ni, n + ni, n + i]);
  }
  return makePolyhedron(name, [...top, ...bot], faces);
}

// Shared base geometry for the regular dodecahedron — 20 vertices and the
// 12 face direction vectors (each pointing outward from the origin through a
// face centre). Used by both makeDodecahedron and makeGreatStellatedDodecahedron.
function dodecaBaseVerts(): [number, number, number][] {
  const IP = 1 / PHI;
  const verts: [number, number, number][] = [];
  for (const sx of [1, -1])
    for (const sy of [1, -1])
      for (const sz of [1, -1])
        verts.push([sx, sy, sz]);
  for (const a of [1, -1])
    for (const b of [1, -1]) {
      verts.push([0, a * PHI, b * IP]);
      verts.push([a * IP, 0, b * PHI]);
      verts.push([a * PHI, b * IP, 0]);
    }
  return verts;
}
function dodecaFaceDirs(): [number, number, number][] {
  const dirs: [number, number, number][] = [];
  for (const a of [1, -1])
    for (const b of [1, -1]) {
      dirs.push([0, a, b * PHI]);
      dirs.push([a, b * PHI, 0]);
      dirs.push([a * PHI, 0, b]);
    }
  return dirs;
}
// For a given face direction, pick the 5 base vertices nearest that face
// and return them sorted CCW around the face centre, along with the centre
// coordinates so callers can stack pyramids / extrude / etc.
function dodecaFacePentagon(
  verts: [number, number, number][],
  dir: [number, number, number],
): { sorted: number[]; cx: number; cy: number; cz: number } {
  const top5 = verts
    .map((v, idx) => ({
      idx,
      d: v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2],
    }))
    .sort((a, b) => b.d - a.d)
    .slice(0, 5)
    .map((x) => x.idx);
  const cx = top5.reduce((s, i) => s + verts[i][0], 0) / 5;
  const cy = top5.reduce((s, i) => s + verts[i][1], 0) / 5;
  const cz = top5.reduce((s, i) => s + verts[i][2], 0) / 5;
  // Build a tangent basis (u, v) on the face plane so we can compute each
  // vertex's angle around the centre for consistent CCW winding.
  let ux = Math.abs(dir[0]) < 0.9 ? 1 : 0;
  let uy = Math.abs(dir[0]) < 0.9 ? 0 : 1;
  let uz = 0;
  const dlen2 = dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2;
  const du = (dir[0] * ux + dir[1] * uy + dir[2] * uz) / dlen2;
  ux -= dir[0] * du;
  uy -= dir[1] * du;
  uz -= dir[2] * du;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  let vx = dir[1] * uz - dir[2] * uy;
  let vy = dir[2] * ux - dir[0] * uz;
  let vz = dir[0] * uy - dir[1] * ux;
  const vl = Math.hypot(vx, vy, vz);
  vx /= vl;
  vy /= vl;
  vz /= vl;
  const sorted = top5
    .map((i) => {
      const dx = verts[i][0] - cx;
      const dy = verts[i][1] - cy;
      const dz = verts[i][2] - cz;
      return {
        idx: i,
        angle: Math.atan2(
          dx * vx + dy * vy + dz * vz,
          dx * ux + dy * uy + dz * uz,
        ),
      };
    })
    .sort((a, b) => a.angle - b.angle)
    .map((x) => x.idx);
  return { sorted, cx, cy, cz };
}

function makeDodecahedron(): Polyhedron {
  const verts = dodecaBaseVerts();
  const faces = dodecaFaceDirs().map(
    (dir) => dodecaFacePentagon(verts, dir).sorted,
  );
  return makePolyhedron("dodeca", verts, faces);
}

// Spiky dodecahedron — visual stand-in for the great stellated dodecahedron.
// Each of the 12 pentagonal faces grows a pyramid outward along its normal,
// producing 12 sharp spikes around a small core. The mathematical GSD has
// self-intersecting pentagram faces that fan-triangulation can't represent;
// this construction matches the iconic silhouette while keeping every face
// strictly convex (a triangle).
function makeGreatStellatedDodecahedron(): Polyhedron {
  // Spike apex multiplier: 3 puts each apex well outside the dodeca's vertex
  // sphere — after makePolyhedron's normalization the apex sits on the unit
  // sphere and the base verts fall well inside, giving prominent spikes.
  const SPIKE = 3.0;
  const base = dodecaBaseVerts();
  const verts: [number, number, number][] = base.map((v) => [...v]);
  const faces: number[][] = [];
  for (const dir of dodecaFaceDirs()) {
    const { sorted, cx, cy, cz } = dodecaFacePentagon(base, dir);
    const apexIdx = verts.length;
    verts.push([cx * SPIKE, cy * SPIKE, cz * SPIKE]);
    for (let i = 0; i < 5; i++) {
      faces.push([apexIdx, sorted[i], sorted[(i + 1) % 5]]);
    }
  }
  return makePolyhedron("gstella", verts, faces);
}

export const SHAPES: Polyhedron[] = [
  makePolyhedron(
    "cube",
    [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
    [
      [0, 1, 2, 3],
      [5, 4, 7, 6],
      [0, 4, 5, 1],
      [3, 2, 6, 7],
      [4, 0, 3, 7],
      [1, 5, 6, 2],
    ],
  ),
  makeBipyramid("spike·3", 3, 1.45, 1),
  makePolyhedron(
    "tetra",
    [
      [1, 1, 1],
      [1, -1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
    ],
    [
      [0, 1, 3],
      [0, 2, 1],
      [0, 3, 2],
      [1, 2, 3],
    ],
  ),
  makeBipyramid("crystal·6", 6, 1.5, 1),
  makePolyhedron(
    "cubocta",
    [
      [0, 1, 1],
      [0, 1, -1],
      [0, -1, 1],
      [0, -1, -1],
      [1, 0, 1],
      [1, 0, -1],
      [-1, 0, 1],
      [-1, 0, -1],
      [1, 1, 0],
      [1, -1, 0],
      [-1, 1, 0],
      [-1, -1, 0],
    ],
    [
      [8, 4, 9, 5],
      [10, 6, 11, 7],
      [8, 0, 10, 1],
      [9, 2, 11, 3],
      [4, 0, 6, 2],
      [5, 1, 7, 3],
      [8, 0, 4],
      [8, 1, 5],
      [9, 4, 2],
      [9, 5, 3],
      [10, 0, 6],
      [10, 1, 7],
      [11, 6, 2],
      [11, 7, 3],
    ],
  ),
  makePolyhedron(
    "stella",
    [
      [1, 1, 1],
      [1, -1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [-1, -1, -1],
      [-1, 1, 1],
      [1, -1, 1],
      [1, 1, -1],
    ],
    [
      [0, 1, 3],
      [0, 2, 1],
      [0, 3, 2],
      [1, 2, 3],
      [4, 5, 6],
      [4, 6, 7],
      [4, 7, 5],
      [5, 7, 6],
    ],
  ),
  makeAntiprism("antiprism·5", 5, 0.6),
  makePolyhedron(
    "icosa",
    [
      [0, 1, PHI],
      [0, -1, PHI],
      [0, 1, -PHI],
      [0, -1, -PHI],
      [1, PHI, 0],
      [-1, PHI, 0],
      [1, -PHI, 0],
      [-1, -PHI, 0],
      [PHI, 0, 1],
      [-PHI, 0, 1],
      [PHI, 0, -1],
      [-PHI, 0, -1],
    ],
    [
      [0, 1, 8],
      [0, 8, 4],
      [0, 4, 5],
      [0, 5, 9],
      [0, 9, 1],
      [1, 9, 7],
      [1, 7, 6],
      [1, 6, 8],
      [8, 6, 10],
      [8, 10, 4],
      [4, 10, 2],
      [4, 2, 5],
      [5, 2, 11],
      [5, 11, 9],
      [9, 11, 7],
      [7, 11, 3],
      [7, 3, 6],
      [6, 3, 10],
      [10, 3, 2],
      [11, 2, 3],
    ],
  ),
  makeDodecahedron(),
  makePolyhedron(
    "octa",
    [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ],
    [
      [0, 2, 4],
      [0, 4, 3],
      [0, 3, 5],
      [0, 5, 2],
      [1, 4, 2],
      [1, 3, 4],
      [1, 5, 3],
      [1, 2, 5],
    ],
  ),
  makeGreatStellatedDodecahedron(),
];

// Per-shape rotation profile — each polyhedron gets a distinct spin
// signature so the silhouette has its own visual identity. Falls back to
// DEFAULT_SPIN (the original rates) for any name not listed.
export type SpinProfile = {
  baseX: number;
  baseY: number;
  bassMultX: number;
  midMultY: number;
};
export const DEFAULT_SPIN: SpinProfile = {
  baseX: 0.005,
  baseY: 0.008,
  bassMultX: 0.07,
  midMultY: 0.045,
};
export const SPIN_PROFILES: Record<string, SpinProfile> = {
  // Sideways high-speed spin — the staggered top/bottom rings smear into a
  // visible "twist" band.
  "antiprism·5": {
    baseX: 0.02,
    baseY: 0.004,
    bassMultX: 0.14,
    midMultY: 0.02,
  },
  // Fast Y rotation blurs the silhouette toward a sphere; the form snaps
  // back when the kick decays.
  octa: { baseX: 0.002, baseY: 0.045, bassMultX: 0.02, midMultY: 0.11 },
  // Crystal stand — spin around the spike axis with a tiny rocking drift.
  "spike·3": { baseX: 0.003, baseY: 0.024, bassMultX: 0.04, midMultY: 0.08 },
  "crystal·6": { baseX: 0.003, baseY: 0.024, bassMultX: 0.04, midMultY: 0.08 },
  // Monolith pace — roughly 1/3 of default for a photo-frame stillness.
  cube: { baseX: 0.0016, baseY: 0.0027, bassMultX: 0.022, midMultY: 0.014 },
  // Star-mandala — much faster than any other shape so the inward-collapsing
  // ring and the final big stella both blur into a swirling halo.
  stella: { baseX: 0.12, baseY: 0.18, bassMultX: 0.4, midMultY: 0.3 },
};
