// Audio-reactive sketch — three.js + GLSL pipeline.
//
// A polyhedron at the centre morphs through ten geometric forms on the beat.
// The 3D scene (polyhedron, particles, shockwaves, dot grid) is rendered with
// WebGL through an EffectComposer with UnrealBloomPass, so bright edges and
// particles glow like neon. A second 2D canvas overlays the HUD, the shape
// swipe transition, and the snare flash — UI that wants pixel-perfect type.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// ---------------------------------------------------------------------------
// Canvases + sizing.
// ---------------------------------------------------------------------------
const glCanvas = document.getElementById("gl") as HTMLCanvasElement;
const hudCanvas = document.getElementById("hud") as HTMLCanvasElement;
const hud = hudCanvas.getContext("2d", { alpha: true })!;
const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
const audioStatus = document.getElementById("audioStatus")!;

// Mobile branch — narrower screens get lower DPR + lighter particle/effect
// budgets, plus a stronger bounce/sensitivity curve since phone speakers and
// mic input usually deliver weaker bass than desktop output.
const IS_MOBILE = window.innerWidth < 768;
const DPR_CAP = IS_MOBILE ? 1.5 : 2;

let dpr = 1;
let cssW = 0;
let cssH = 0;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  cssW = window.innerWidth;
  cssH = window.innerHeight;
  hudCanvas.width = Math.floor(cssW * dpr);
  hudCanvas.height = Math.floor(cssH * dpr);
  hudCanvas.style.width = cssW + "px";
  hudCanvas.style.height = cssH + "px";
  hud.setTransform(dpr, 0, 0, dpr, 0, 0);
  // three.js resize happens below after the renderer is constructed.
}
resize();

// ---------------------------------------------------------------------------
// Tunable constants.
// ---------------------------------------------------------------------------
const DROP_THRESHOLD = 0.4;
const DROP_OVERSHOOT = 1.32;
const SNARE_THRESHOLD = 0.3;
const SNARE_OVERSHOOT = 1.25;
const DROP_FRAMES = 40;
const SHAKE_FRAMES = 25;
const FLASH_FRAMES = 7;
const SHAKE_EXP = 1.4;
const PARTICLE_EXP = 1.5;
const SHAPE_SPIN_EXP = 1.5;

const KICK_THRESHOLD = IS_MOBILE ? 0.10 : 0.15;
const KICK_RISE = IS_MOBILE ? 0.025 : 0.04;
const KICK_COOLDOWN_FRAMES = 8;
const KICK_IMPULSE = IS_MOBILE ? 12 : 7.5;
const KICKS_PER_SHAPE_SWAP = 4;
const KICKS_PER_INVERT_ROLL = 2;
const INVERT_FLIP_CHANCE = 0.55;
const SHAPE_SWAP_FRAMES = 36;
const SWIPE_FONT = '"Bebas Neue", "Anton", "Archivo Black", sans-serif';
const VHS_CHANCE = 0.3;

const GRID_SPACING = 38;
const HUD_FONT = '11px ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';
const HUD_FONT_LG = '22px ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';
const HUD_MARGIN = 28;
const WAVEFORM_W = 200;
const WAVEFORM_H = 36;
const WAVEFORM_GAP = 14;

const BOUNCE_STIFFNESS = 0.18;
const BOUNCE_DAMPING = IS_MOBILE ? 0.08 : 0.10;
const BOUNCE_SCALE_DECAY = IS_MOBILE ? 0.88 : 0.83;

const MAX_PARTICLES = IS_MOBILE ? 500 : 800;
const MAX_SHOCKWAVE_POINTS = 600;

// Proliferation — on each shape swap there's a chance the single hero
// shatters into a screen-filling dot grid of tiny clones, rendered via a
// single InstancedMesh draw call.
const PROLIFERATE_CHANCE = 0.33;
const PROLIFERATE_GRID_COLS = 10;
const PROLIFERATE_GRID_ROWS = 6;
const MAX_HERO_INSTANCES = PROLIFERATE_GRID_COLS * PROLIFERATE_GRID_ROWS;
const PROLIFERATE_SCALE = 0.30; // uniform scale relative to single hero size

// ---------------------------------------------------------------------------
// Three-mode palette — BLACK · WHITE · PINK. Replaces the old binary invert
// flag with a cyclic 3-state colour scheme that swaps on the same kick
// cadence as before. Each mode redefines bg, hero material, edges, grid,
// shockwave colour, snare flash colour, and HUD typography accents.
// ---------------------------------------------------------------------------
type BgPaletteSet = {
  name: "BLACK" | "WHITE" | "PINK";
  bg: { r: number; g: number; b: number };
  heroHex: number;
  heroEmissiveHex: number;
  edgeHex: number;
  gridColor: [number, number, number];
  shockwaveColor: [number, number, number];
  snareFlashColor: { r: number; g: number; b: number };
  hudText: string;
  hudAccent: string;
  particleHexes: string[];
  // Bloom — tuned per mode so the bg doesn't bleed onto the silhouette.
  // BLACK: bg dark → low threshold OK. WHITE: bg ~1.0 → threshold must
  // exclude it or the whole frame blooms and swallows the shape.
  bloomStrength: number;
  bloomThreshold: number;
  // Edge stroke opacity baseline (audio adds on top).
  edgeOpacityBase: number;
};

const BG_MODES: BgPaletteSet[] = [
  // 0 — BLACK: deep midnight + pearl polyhedron + hot-pink edges.
  {
    name: "BLACK",
    bg: { r: 10, g: 10, b: 16 },
    heroHex: 0xf5f5fa,
    heroEmissiveHex: 0x111126,
    edgeHex: 0xff3b6b,
    gridColor: [1.0, 0.353, 0.627],
    shockwaveColor: [0.96, 0.96, 0.98],
    snareFlashColor: { r: 58, g: 254, b: 255 },
    hudText: "rgba(245, 245, 250, 0.55)",
    hudAccent: "#ff3b6b",
    particleHexes: ["#ff3b6b", "#3afeff", "#ffea29", "#f5f5fa"],
    bloomStrength: 0.45,
    bloomThreshold: 0.6,
    edgeOpacityBase: 0.55,
  },
  // 1 — WHITE: gallery cream + ink polyhedron + hot-pink edges.
  // Threshold pushed above 1.0 so the bright bg never blooms — only the
  // bg-flash and particle highlights catch the bloom pass.
  {
    name: "WHITE",
    bg: { r: 248, g: 248, b: 250 },
    heroHex: 0x1c1c2a,
    heroEmissiveHex: 0x010108,
    edgeHex: 0xff3b6b,
    gridColor: [0.11, 0.11, 0.16],
    shockwaveColor: [0.11, 0.11, 0.16],
    snareFlashColor: { r: 20, g: 20, b: 40 },
    hudText: "rgba(28, 28, 40, 0.55)",
    hudAccent: "#ff3b6b",
    particleHexes: ["#ff3b6b", "#0c0c1a", "#ffd24a", "#3afeff"],
    bloomStrength: 0.18,
    bloomThreshold: 1.05,
    edgeOpacityBase: 0.9,
  },
  // 2 — PINK: hot pink field + navy polyhedron + electric cyan edges.
  // Threshold sits above the pink bg luminance so only the cyan edges and
  // white shockwaves glow.
  {
    name: "PINK",
    bg: { r: 255, g: 59, b: 107 },
    heroHex: 0x0c0c1a,
    heroEmissiveHex: 0x140a14,
    edgeHex: 0x3afeff,
    gridColor: [0.227, 1.0, 1.0],
    shockwaveColor: [0.95, 0.95, 0.96],
    snareFlashColor: { r: 58, g: 254, b: 255 },
    hudText: "rgba(255, 255, 255, 0.65)",
    hudAccent: "#3afeff",
    particleHexes: ["#f5f5fa", "#3afeff", "#ffea29", "#0c0c1a"],
    bloomStrength: 0.4,
    bloomThreshold: 0.78,
    edgeOpacityBase: 0.8,
  },
];

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------
// On mobile the HUD text crowds the top edge, so the geometric centre reads
// as "low". Bias the focal point a touch above centre to fix the perception.
const FOCAL_Y_BIAS = IS_MOBILE ? 0.42 : 0.5;
let focalX = cssW / 2;
let focalY = cssH * FOCAL_Y_BIAS;
let targetFocalX = focalX;
let targetFocalY = focalY;

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let freqBuf: Uint8Array<ArrayBuffer> = new Uint8Array(0);
let timeBuf: Uint8Array<ArrayBuffer> = new Uint8Array(0);
let audioActive = false;
let envBass = 0;
let envMid = 0;
let envHi = 0;

let bassPeak = 0;
let midPeak = 0;
let dropTimer = 0;
let flashTimer = 0;
let flashIntensity = 0;
let shakeTimer = 0;
let shakeStrength = 0;

let shapeRotX = 0.5;
let shapeRotY = 0.7;
let currentShapeIdx = 0;
let shapeSwapTimer = 0;
let shapeSwapDirection = 0;

let prevEnvBass = 0;
let kickCooldown = 0;
let kickCount = 0;
let bouncePosY = 0;
let bounceVelY = 0;
let bounceScale = 0;
const kickTimes: number[] = [];
let bpm = 0;

let dropCount = 0;
// Cycles 0→2 (BLACK · WHITE · PINK) on the same cadence the old invert flag
// used to toggle. Audio resets it to 0; manual clicks (no audio) advance it.
let currentBgIdx = 0;

type Shockwave = { age: number; strength: number; rotation: number };
const shockwaves: Shockwave[] = [];

type Particle = {
  x: number; y: number;
  vx: number; vy: number;
  age: number; life: number;
  size: number;
  color: [number, number, number];
};
const particles: Particle[] = [];

type HeroInstance = {
  x: number; y: number;
  scale: number;
  rotOffX: number; rotOffY: number;
};
const heroInstances: HeroInstance[] = [];
let proliferateCount = 1; // 1 = single hero, > 1 = swarm

// Per-swap randomised state.
let vhsActive = false;
let vhsLevel = 0; // smoothed 0..1 actually applied to shader

// ---------------------------------------------------------------------------
// Polyhedra (data + builders are pure, unchanged).
// ---------------------------------------------------------------------------
type Face3 = { idx: number[]; n: [number, number, number] };
type Polyhedron = {
  name: string;
  verts: [number, number, number][];
  faces: Face3[];
};

function makePolyhedron(
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
    v[0] / maxNorm, v[1] / maxNorm, v[2] / maxNorm,
  ]);
  const faces: Face3[] = faceIndices.map((rawIdx) => {
    const idx = [...rawIdx];
    let cx = 0, cy = 0, cz = 0;
    for (const i of idx) { cx += verts[i][0]; cy += verts[i][1]; cz += verts[i][2]; }
    cx /= idx.length; cy /= idx.length; cz /= idx.length;
    const v0 = verts[idx[0]], v1 = verts[idx[1]], v2 = verts[idx[2]];
    const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
    const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    if (nx * cx + ny * cy + nz * cz < 0) {
      idx.reverse();
      nx = -nx; ny = -ny; nz = -nz;
    }
    return { idx, n: [nx, ny, nz] };
  });
  return { name, verts, faces };
}

const PHI = (1 + Math.sqrt(5)) / 2;

function ringVerts(
  n: number, radius: number, y: number, offsetTurns = 0,
): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + offsetTurns) / n) * Math.PI * 2;
    out.push([Math.cos(a) * radius, y, Math.sin(a) * radius]);
  }
  return out;
}

function makeBipyramid(
  name: string, n: number, height: number, radius = 1,
): Polyhedron {
  const verts: [number, number, number][] = [
    [0, height, 0], [0, -height, 0], ...ringVerts(n, radius, 0),
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

function makeDodecahedron(): Polyhedron {
  const IP = 1 / PHI;
  const verts: [number, number, number][] = [];
  for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
    verts.push([sx, sy, sz]);
  }
  for (const a of [1, -1]) for (const b of [1, -1]) {
    verts.push([0, a * PHI, b * IP]);
    verts.push([a * IP, 0, b * PHI]);
    verts.push([a * PHI, b * IP, 0]);
  }
  const faceDirs: [number, number, number][] = [];
  for (const a of [1, -1]) for (const b of [1, -1]) {
    faceDirs.push([0, a, b * PHI]);
    faceDirs.push([a, b * PHI, 0]);
    faceDirs.push([a * PHI, 0, b]);
  }
  const faces: number[][] = faceDirs.map((dir) => {
    const top5 = verts
      .map((v, idx) => ({ idx, d: v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2] }))
      .sort((a, b) => b.d - a.d)
      .slice(0, 5)
      .map((x) => x.idx);
    const cx = top5.reduce((s, i) => s + verts[i][0], 0) / 5;
    const cy = top5.reduce((s, i) => s + verts[i][1], 0) / 5;
    const cz = top5.reduce((s, i) => s + verts[i][2], 0) / 5;
    let ux = Math.abs(dir[0]) < 0.9 ? 1 : 0;
    let uy = Math.abs(dir[0]) < 0.9 ? 0 : 1;
    let uz = 0;
    const dlen2 = dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2;
    const du = (dir[0] * ux + dir[1] * uy + dir[2] * uz) / dlen2;
    ux -= dir[0] * du; uy -= dir[1] * du; uz -= dir[2] * du;
    const ul = Math.hypot(ux, uy, uz);
    ux /= ul; uy /= ul; uz /= ul;
    let vx = dir[1] * uz - dir[2] * uy;
    let vy = dir[2] * ux - dir[0] * uz;
    let vz = dir[0] * uy - dir[1] * ux;
    const vl = Math.hypot(vx, vy, vz);
    vx /= vl; vy /= vl; vz /= vl;
    return top5
      .map((i) => {
        const dx = verts[i][0] - cx;
        const dy = verts[i][1] - cy;
        const dz = verts[i][2] - cz;
        return {
          idx: i,
          angle: Math.atan2(dx * vx + dy * vy + dz * vz, dx * ux + dy * uy + dz * uz),
        };
      })
      .sort((a, b) => a.angle - b.angle)
      .map((x) => x.idx);
  });
  return makePolyhedron("dodeca", verts, faces);
}

const SHAPES: Polyhedron[] = [
  makePolyhedron("cube",
    [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]],
    [[0,1,2,3],[5,4,7,6],[0,4,5,1],[3,2,6,7],[4,0,3,7],[1,5,6,2]],
  ),
  makeBipyramid("spike·3", 3, 1.45, 1),
  makePolyhedron("tetra",
    [[1,1,1],[1,-1,-1],[-1,1,-1],[-1,-1,1]],
    [[0,1,3],[0,2,1],[0,3,2],[1,2,3]],
  ),
  makeBipyramid("crystal·6", 6, 1.5, 1),
  makePolyhedron("cubocta",
    [[0,1,1],[0,1,-1],[0,-1,1],[0,-1,-1],[1,0,1],[1,0,-1],[-1,0,1],[-1,0,-1],
     [1,1,0],[1,-1,0],[-1,1,0],[-1,-1,0]],
    [[8,4,9,5],[10,6,11,7],[8,0,10,1],[9,2,11,3],[4,0,6,2],[5,1,7,3],
     [8,0,4],[8,1,5],[9,4,2],[9,5,3],[10,0,6],[10,1,7],[11,6,2],[11,7,3]],
  ),
  makePolyhedron("stella",
    [[1,1,1],[1,-1,-1],[-1,1,-1],[-1,-1,1],[-1,-1,-1],[-1,1,1],[1,-1,1],[1,1,-1]],
    [[0,1,3],[0,2,1],[0,3,2],[1,2,3],[4,5,6],[4,6,7],[4,7,5],[5,7,6]],
  ),
  makeAntiprism("antiprism·5", 5, 0.6),
  makePolyhedron("icosa",
    [[0,1,PHI],[0,-1,PHI],[0,1,-PHI],[0,-1,-PHI],[1,PHI,0],[-1,PHI,0],
     [1,-PHI,0],[-1,-PHI,0],[PHI,0,1],[-PHI,0,1],[PHI,0,-1],[-PHI,0,-1]],
    [[0,1,8],[0,8,4],[0,4,5],[0,5,9],[0,9,1],[1,9,7],[1,7,6],[1,6,8],[8,6,10],
     [8,10,4],[4,10,2],[4,2,5],[5,2,11],[5,11,9],[9,11,7],[7,11,3],[7,3,6],
     [6,3,10],[10,3,2],[11,2,3]],
  ),
  makeDodecahedron(),
  makePolyhedron("octa",
    [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]],
    [[0,2,4],[0,4,3],[0,3,5],[0,5,2],[1,4,2],[1,3,4],[1,5,3],[1,2,5]],
  ),
];

// ---------------------------------------------------------------------------
// three.js setup — orthographic camera so canvas-style 2D coords work for
// particles/shockwaves while the polyhedron rotates in real 3D.
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  canvas: glCanvas,
  antialias: true,
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(cssW, cssH, false);
// Tone mapping compresses HDR (blown-out bloom) → LDR smoothly. ACES Filmic
// gives the cinematic roll-off that keeps very bright bass moments from
// flashing the screen pure white.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// Slightly under-exposed so the bloom + bass-flash peaks roll off well
// below pure white, even on shape-swap moments.
renderer.toneMappingExposure = 0.85;

const scene = new THREE.Scene();
const initBg = BG_MODES[0].bg;
scene.background = new THREE.Color(initBg.r / 255, initBg.g / 255, initBg.b / 255);

// Ortho: world origin at screen centre, y up, units = CSS pixels.
const camera = new THREE.OrthographicCamera(
  -cssW / 2, cssW / 2,
   cssH / 2, -cssH / 2,
  -2000, 2000,
);
camera.position.z = 200;

const ambient = new THREE.AmbientLight(0x9095b0, 0.55);
scene.add(ambient);
const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
keyLight.position.set(0.45, 0.7, 0.55);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xff5388, 0.5);
rimLight.position.set(-0.4, -0.3, 0.4);
scene.add(rimLight);

// ---------------------------------------------------------------------------
// Polyhedron mesh — geometry cache built once per shape, edges precomputed.
// ---------------------------------------------------------------------------
const heroMat = new THREE.MeshPhysicalMaterial({
  color: BG_MODES[0].heroHex,
  flatShading: true,
  roughness: 0.35,
  metalness: 0.05,
  clearcoat: 0.4,
  clearcoatRoughness: 0.25,
  emissive: BG_MODES[0].heroEmissiveHex,
  emissiveIntensity: 0.18, // dimmer self-glow — keeps swap-pop from blowing out
});
const edgeMat = new THREE.LineBasicMaterial({
  color: BG_MODES[0].edgeHex,
  transparent: true,
  opacity: 0.85,
});

function buildGeometry(poly: Polyhedron): {
  faces: THREE.BufferGeometry; edges: THREE.BufferGeometry;
} {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const f of poly.faces) {
    for (let i = 1; i < f.idx.length - 1; i++) {
      const a = poly.verts[f.idx[0]];
      const b = poly.verts[f.idx[i]];
      const c = poly.verts[f.idx[i + 1]];
      positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      for (let k = 0; k < 3; k++) normals.push(f.n[0], f.n[1], f.n[2]);
    }
  }
  const faces = new THREE.BufferGeometry();
  faces.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  faces.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  // Wireframe edges: dedupe edges across faces.
  const edgeSet = new Set<string>();
  const edgePts: number[] = [];
  for (const f of poly.faces) {
    for (let i = 0; i < f.idx.length; i++) {
      const a = f.idx[i];
      const b = f.idx[(i + 1) % f.idx.length];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      const va = poly.verts[a];
      const vb = poly.verts[b];
      edgePts.push(va[0], va[1], va[2], vb[0], vb[1], vb[2]);
    }
  }
  const edges = new THREE.BufferGeometry();
  edges.setAttribute("position", new THREE.Float32BufferAttribute(edgePts, 3));
  return { faces, edges };
}

const geomCache = SHAPES.map((p) => buildGeometry(p));

const heroMesh = new THREE.Mesh(geomCache[0].faces, heroMat);
const heroEdges = new THREE.LineSegments(geomCache[0].edges, edgeMat);
const heroGroup = new THREE.Group();
heroGroup.add(heroMesh);
heroGroup.add(heroEdges);
scene.add(heroGroup);

// InstancedMesh used only when proliferateCount > 1 — single GPU draw call
// renders every clone in the swarm at the cost of one matrix per instance.
const instancedHero = new THREE.InstancedMesh(
  geomCache[0].faces,
  heroMat,
  MAX_HERO_INSTANCES,
);
instancedHero.frustumCulled = false;
instancedHero.visible = false;
scene.add(instancedHero);

// Scratch instances to avoid per-frame allocations in the swarm path.
const _instM4 = new THREE.Matrix4();
const _instQuat = new THREE.Quaternion();
const _instPos = new THREE.Vector3();
const _instScale = new THREE.Vector3();
const _instEuler = new THREE.Euler();

function applyShape(idx: number) {
  heroMesh.geometry = geomCache[idx].faces;
  heroEdges.geometry = geomCache[idx].edges;
  instancedHero.geometry = geomCache[idx].faces;
}

// Lay out the swarm on a perfect grid — every clone at its cell centre,
// uniform scale, shared rotation. The whole array reads as a single
// coordinated "dot grid" rather than a scattered swarm.
function spawnProliferation() {
  proliferateCount = MAX_HERO_INSTANCES;
  heroInstances.length = 0;
  const cellW = cssW / PROLIFERATE_GRID_COLS;
  const cellH = cssH / PROLIFERATE_GRID_ROWS;
  for (let r = 0; r < PROLIFERATE_GRID_ROWS; r++) {
    for (let c = 0; c < PROLIFERATE_GRID_COLS; c++) {
      heroInstances.push({
        x: cellW * (c + 0.5),
        y: cellH * (r + 0.5),
        scale: PROLIFERATE_SCALE,
        rotOffX: 0,
        rotOffY: 0,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Dot grid backdrop — fullscreen plane behind the scene, fragment shader
// draws the breathing pink lattice.
// ---------------------------------------------------------------------------
const gridUniforms = {
  uResolution: { value: new THREE.Vector2(cssW, cssH) },
  uFocal: { value: new THREE.Vector2(focalX, focalY) },
  uTime: { value: 0 },
  uBass: { value: 0 },
  uSpacing: { value: GRID_SPACING },
  uColor: { value: new THREE.Vector3(...BG_MODES[0].gridColor) },
};

const gridMat = new THREE.ShaderMaterial({
  uniforms: gridUniforms,
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform vec2 uResolution;
    uniform vec2 uFocal;
    uniform float uTime;
    uniform float uBass;
    uniform float uSpacing;
    uniform vec3 uColor;

    void main() {
      vec2 pixel = vUv * uResolution;
      vec2 cell  = floor(pixel / uSpacing) * uSpacing + uSpacing * 0.5;
      float d = distance(pixel, cell);
      // Dot mask: ~1.5 px radius with smooth edge.
      float dot = 1.0 - smoothstep(1.0, 2.2, d);
      // Radial ripple from the focal point.
      float fd = distance(cell, uFocal);
      float wave = cos(fd * 0.022 - uTime * 0.0028) * 0.5 + 0.5;
      float a = 0.04 + uBass * 0.55 * wave;
      gl_FragColor = vec4(uColor, a * dot);
    }
  `,
  transparent: true,
  depthWrite: false,
});
const gridGeom = new THREE.PlaneGeometry(2, 2); // clip space
const gridMesh = new THREE.Mesh(gridGeom, gridMat);
gridMesh.frustumCulled = false;
gridMesh.renderOrder = -10;
gridMesh.position.z = -100;
scene.add(gridMesh);

// ---------------------------------------------------------------------------
// Particle system — single THREE.Points object, custom shader uses a
// precomputed star sprite texture. Used both for confetti AND shockwave
// rings; we just blit positions into the buffer each frame.
// ---------------------------------------------------------------------------
function makeStarTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const cx = c.getContext("2d")!;
  const cxc = size / 2;
  const outerR = size * 0.45;
  const innerR = outerR * 0.22;
  cx.fillStyle = "#ffffff";
  cx.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const x = cxc + Math.cos(a) * r;
    const y = cxc + Math.sin(a) * r;
    if (i === 0) cx.moveTo(x, y);
    else cx.lineTo(x, y);
  }
  cx.closePath();
  cx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}
const starTexture = makeStarTexture();

const ptsPositions = new Float32Array(MAX_PARTICLES * 3);
const ptsColors = new Float32Array(MAX_PARTICLES * 3);
const ptsSizes = new Float32Array(MAX_PARTICLES);
const ptsGeom = new THREE.BufferGeometry();
ptsGeom.setAttribute("position", new THREE.BufferAttribute(ptsPositions, 3));
ptsGeom.setAttribute("aColor", new THREE.BufferAttribute(ptsColors, 3));
ptsGeom.setAttribute("aSize", new THREE.BufferAttribute(ptsSizes, 1));
ptsGeom.setDrawRange(0, 0);

const ptsMat = new THREE.ShaderMaterial({
  uniforms: { uTex: { value: starTexture }, uPixelRatio: { value: dpr } },
  vertexShader: /* glsl */ `
    attribute vec3 aColor;
    attribute float aSize;
    varying vec3 vColor;
    uniform float uPixelRatio;
    void main() {
      vColor = aColor;
      vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPos;
      gl_PointSize = aSize * uPixelRatio;
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D uTex;
    varying vec3 vColor;
    void main() {
      vec4 t = texture2D(uTex, gl_PointCoord);
      if (t.a < 0.02) discard;
      gl_FragColor = vec4(vColor * t.a, t.a);
    }
  `,
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
const pointsMesh = new THREE.Points(ptsGeom, ptsMat);
pointsMesh.frustumCulled = false;
pointsMesh.renderOrder = 5;
scene.add(pointsMesh);

// Shockwaves use their own bigger buffer + Points object.
const swPositions = new Float32Array(MAX_SHOCKWAVE_POINTS * 3);
const swColors = new Float32Array(MAX_SHOCKWAVE_POINTS * 3);
const swSizes = new Float32Array(MAX_SHOCKWAVE_POINTS);
const swGeom = new THREE.BufferGeometry();
swGeom.setAttribute("position", new THREE.BufferAttribute(swPositions, 3));
swGeom.setAttribute("aColor", new THREE.BufferAttribute(swColors, 3));
swGeom.setAttribute("aSize", new THREE.BufferAttribute(swSizes, 1));
swGeom.setDrawRange(0, 0);
const shockwaveMesh = new THREE.Points(swGeom, ptsMat);
shockwaveMesh.frustumCulled = false;
shockwaveMesh.renderOrder = 3;
scene.add(shockwaveMesh);

// ---------------------------------------------------------------------------
// Post-processing — bloom for the neon glow on edges and particles.
// ---------------------------------------------------------------------------
// HDR render target — half-float precision means bright bloom contributions
// can exceed 1.0 without clamping. The final OutputPass tone-maps everything
// back into the LDR display range.
const hdrTarget = new THREE.WebGLRenderTarget(cssW, cssH, {
  type: THREE.HalfFloatType,
  format: THREE.RGBAFormat,
});
const composer = new EffectComposer(renderer, hdrTarget);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(cssW, cssH),
  0.4,  // strength (per-mode override happens each frame)
  0.32, // radius — tighter so bright clusters don't spread across the frame
  0.55, // threshold (per-mode override)
);
composer.addPass(bloomPass);

// ---------------------------------------------------------------------------
// Final pass — radial RGB chromatic aberration + vignette in one shader.
// On a still frame both effects are subtle (a faint analog-photo feel); on
// big bass / drops the chromatic offset scales up dramatically so the image
// splits along its colour channels for a moment.
// ---------------------------------------------------------------------------
const chromaticVignettePass = new ShaderPass({
  uniforms: {
    tDiffuse:    { value: null },
    uChroma:     { value: 0 },
    uVignette:   { value: 0.65 },
    uVhs:        { value: 0 },     // 0..1 — VHS tape look intensity
    uTime:       { value: 0 },     // ms, for scanline/grain animation
    uResolution: { value: new THREE.Vector2(cssW, cssH) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uChroma;
    uniform float uVignette;
    uniform float uVhs;
    uniform float uTime;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float rand(vec2 co) {
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 center = vec2(0.5);
      vec2 uv = vUv;

      // VHS tape: horizontal tracking jitter + slight wave warp.
      if (uVhs > 0.01) {
        float t = uTime * 0.001;
        float trackJitter = sin(uv.y * 80.0 + t * 3.0) * 0.0025
                          + (rand(vec2(floor(uv.y * 180.0), floor(t * 8.0))) - 0.5) * 0.004;
        uv.x += trackJitter * uVhs;
      }

      vec2 dir = uv - center;

      // Radial chromatic offset (extra during VHS).
      float chroma = uChroma + uVhs * 0.8;
      float k = chroma * 0.014;
      vec2 rUv = uv + dir * k;
      vec2 bUv = uv - dir * k;
      float r = texture2D(tDiffuse, rUv).r;
      float g = texture2D(tDiffuse, uv).g;
      float b = texture2D(tDiffuse, bUv).b;
      vec3 col = vec3(r, g, b);

      // VHS layer: scanlines, grain, slight saturation loss, faint
      // horizontal-band brightness ripple.
      if (uVhs > 0.01) {
        // Scanlines (fine horizontal stripes).
        float scan = sin(vUv.y * uResolution.y * 1.6) * 0.5 + 0.5;
        scan = mix(1.0, 0.55 + 0.45 * pow(scan, 2.0), uVhs);
        col *= scan;

        // Slow vertical bright band (tape head sweeping).
        float band = sin(vUv.y * 3.0 - uTime * 0.0009) * 0.5 + 0.5;
        col *= mix(1.0, 0.92 + band * 0.12, uVhs);

        // Per-pixel noise grain.
        float n = rand(vUv + fract(uTime * 0.0015));
        col += (n - 0.5) * 0.18 * uVhs;

        // Slight desaturation toward analogue look.
        float gray = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(col, vec3(gray), 0.18 * uVhs);
      }

      // Vignette (deeper when VHS is on).
      float vigFloor = mix(uVignette, uVignette - 0.18, uVhs);
      float vig = 1.0 - dot(dir, dir) * (1.4 + uVhs * 0.6);
      vig = clamp(vig, vigFloor, 1.0);
      col *= vig;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
composer.addPass(chromaticVignettePass);

// Tone-map HDR → display, sRGB conversion. Must be the last pass.
composer.addPass(new OutputPass());

// Hook up sizing for renderer + composer now that they exist.
function resizeGL() {
  renderer.setSize(cssW, cssH, false);
  composer.setSize(cssW, cssH);
  bloomPass.setSize(cssW, cssH);
  camera.left = -cssW / 2;
  camera.right = cssW / 2;
  camera.top = cssH / 2;
  camera.bottom = -cssH / 2;
  camera.updateProjectionMatrix();
  gridUniforms.uResolution.value.set(cssW, cssH);
  (ptsMat.uniforms.uPixelRatio.value as number) = dpr;
}
resizeGL();
window.addEventListener("resize", () => { resize(); resizeGL(); });

// ---------------------------------------------------------------------------
// Helpers: canvas (top-left origin) → world (centre origin, y up).
// ---------------------------------------------------------------------------
function toWorldX(cx: number) { return cx - cssW / 2; }
function toWorldY(cy: number) { return cssH / 2 - cy; }

// Parse "#rrggbb" → [r, g, b] in [0,1].
function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}
// Cached per-mode particle colour tables, looked up by currentBgIdx.
const particleColorTable: [number, number, number][][] = BG_MODES.map((m) =>
  m.particleHexes.map(hexToRgb01),
);

// ---------------------------------------------------------------------------
// Audio plumbing.
// ---------------------------------------------------------------------------
async function startAudio(
  label: string,
  setup: (ctx: AudioContext, pre: GainNode) => Promise<void>,
) {
  await stopAudio();
  const ctx = new AudioContext();
  const a = ctx.createAnalyser();
  a.fftSize = 1024;
  a.smoothingTimeConstant = 0.6;
  const pre = ctx.createGain();
  pre.connect(a);
  await setup(ctx, pre);
  audioCtx = ctx;
  analyser = a;
  freqBuf = new Uint8Array(a.frequencyBinCount);
  timeBuf = new Uint8Array(a.fftSize);
  audioActive = true;
  stopBtn.hidden = false;
  audioStatus.textContent = label;
  currentBgIdx = 0;
  dropCount = 0;
}

async function stopAudio() {
  audioActive = false;
  if (audioCtx) { try { await audioCtx.close(); } catch {} audioCtx = null; }
  analyser = null;
  envBass = envMid = envHi = 0;
  stopBtn.hidden = true;
  audioStatus.textContent = "";
}

document.getElementById("micBtn")!.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false },
    });
    await startAudio("マイクに連動中", async (ctx, pre) => {
      const src = ctx.createMediaStreamSource(stream);
      // Phone mics tend to feed thin/quiet signal; boost the analyser input
      // so kick detection and the bounce respond visibly.
      if (IS_MOBILE) {
        const gain = ctx.createGain();
        gain.gain.value = 1.8;
        src.connect(gain).connect(pre);
      } else {
        src.connect(pre);
      }
    });
  } catch (err) {
    const e = err as DOMException;
    audioStatus.textContent = `マイク失敗: ${e.name || "Error"}${e.message ? " — " + e.message : ""}`;
    console.error(err);
  }
});

document.getElementById("tabBtn")!.addEventListener("click", async () => {
  try {
    // Keep focus on this tab even when the user picks another tab to share.
    // Chrome 105+ only; other browsers silently ignore the option.
    type FocusController = { setFocusBehavior?: (b: "no-focus-change" | "focus-captured-surface") => void };
    const CC = (window as unknown as { CaptureController?: new () => FocusController }).CaptureController;
    const controller = CC ? new CC() : undefined;
    controller?.setFocusBehavior?.("no-focus-change");
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      ...(controller ? { controller } : {}),
    } as DisplayMediaStreamOptions);
    for (const t of stream.getVideoTracks()) t.stop();
    if (stream.getAudioTracks().length === 0) {
      audioStatus.textContent = "「音声を共有」にチェックを入れてください";
      return;
    }
    await startAudio("タブ音声に連動中", async (ctx, pre) => {
      const audioOnly = new MediaStream(stream.getAudioTracks());
      const src = ctx.createMediaStreamSource(audioOnly);
      src.connect(pre);
    });
  } catch (err) {
    if ((err as DOMException).name === "NotAllowedError") {
      audioStatus.textContent = "キャンセルされました";
    } else {
      audioStatus.textContent = "タブ音声の取得に失敗しました";
    }
    console.error(err);
  }
});

stopBtn.addEventListener("click", () => { void stopAudio(); });

function readAudio() {
  if (!analyser || !audioActive) return;
  analyser.getByteFrequencyData(freqBuf);
  const N = freqBuf.length;
  let bSum = 0, mSum = 0, hSum = 0, bN = 0, mN = 0, hN = 0;
  for (let i = 1; i < 6 && i < N; i++) { bSum += freqBuf[i]; bN++; }
  for (let i = 6; i < 50 && i < N; i++) { mSum += freqBuf[i]; mN++; }
  for (let i = 50; i < 200 && i < N; i++) { hSum += freqBuf[i]; hN++; }
  const bass = bN ? bSum / bN / 255 : 0;
  const mid = mN ? mSum / mN / 255 : 0;
  const hi = hN ? hSum / hN / 255 : 0;
  envBass = bass > envBass ? bass : envBass * 0.86 + bass * 0.14;
  envMid = mid * 0.4 + envMid * 0.6;
  envHi = hi * 0.5 + envHi * 0.5;
}

// ---------------------------------------------------------------------------
// Spawn helpers + onset triggers.
// ---------------------------------------------------------------------------
function spawnParticles(n: number, energy: number) {
  const palette = particleColorTable[currentBgIdx];
  for (let i = 0; i < n; i++) {
    if (particles.length >= MAX_PARTICLES) break;
    const a = Math.random() * Math.PI * 2;
    const speed = 3 + Math.random() * 9 * energy;
    particles.push({
      x: focalX,
      y: focalY,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed - Math.random() * 3,
      age: 0,
      life: 80 + Math.random() * 70,
      size: (6 + Math.random() * 14),
      color: palette[(Math.random() * palette.length) | 0],
    });
  }
}

function swapShape() {
  currentShapeIdx = (currentShapeIdx + 1) % SHAPES.length;
  shapeSwapTimer = SHAPE_SWAP_FRAMES;
  // 8 sweep directions — 4 cardinal + 4 diagonal.
  shapeSwapDirection = (Math.random() * 8) | 0;
  applyShape(currentShapeIdx);
  // Roll for swarm — most swaps stay single, occasional ones explode into
  // a grid-distributed dot-array of small clones.
  if (Math.random() < PROLIFERATE_CHANCE) {
    spawnProliferation();
  } else {
    proliferateCount = 1;
  }
  // Roll for VHS tape look.
  vhsActive = Math.random() < VHS_CHANCE;
  const strength = audioActive ? Math.max(0.55, envBass) : 0.65;
  bounceVelY -= strength * KICK_IMPULSE;
  bounceScale = Math.max(bounceScale, strength);
}

function triggerDrop() {
  dropTimer = DROP_FRAMES;
  shockwaves.push({
    age: 0,
    strength: envBass,
    rotation: Math.random() * Math.PI * 2,
  });
  shakeTimer = SHAKE_FRAMES;
  shakeStrength = Math.pow(envBass, SHAKE_EXP) * 28;
  const particleCount = 30 + ((Math.pow(envBass, PARTICLE_EXP) * 70) | 0);
  spawnParticles(particleCount, envBass);
  const m = Math.min(cssW, cssH) * 0.18;
  targetFocalX = m + Math.random() * (cssW - 2 * m);
  // On mobile keep the shape in the upper-mid band so it doesn't dive under
  // the status panel or the HUD text.
  const yMax = IS_MOBILE ? cssH * 0.65 : cssH - m;
  targetFocalY = m + Math.random() * (yMax - m);
  dropCount++;
  swapShape();
}

const splash = document.getElementById("splash");
if (splash) {
  // Pointerdown fires before the window listener below — stopPropagation
  // prevents the dismiss tap from also triggering a shape swap.
  splash.addEventListener("pointerdown", (e) => {
    splash.classList.add("hidden");
    e.stopPropagation();
  });
}

window.addEventListener("pointerdown", (e) => {
  if ((e.target as Element | null)?.closest(".panel")) return;
  if (!audioActive) {
    swapShape();
    currentBgIdx = (currentBgIdx + 1) % BG_MODES.length;
  }
});

// ---------------------------------------------------------------------------
// 2D HUD canvas drawing.
// ---------------------------------------------------------------------------
function drawHUD(shakeX: number, shakeY: number) {
  hud.clearRect(0, 0, cssW, cssH);
  hud.save();
  hud.translate(shakeX, shakeY);
  drawHUDText();
  hud.restore();
  drawShapeSwipe();
  drawSnareFlash();
}

function drawHUDText() {
  const mode = BG_MODES[currentBgIdx];
  const textColor = mode.hudText;
  const accentColor = mode.hudAccent;
  const shape = SHAPES[currentShapeIdx];

  hud.textAlign = "left";
  hud.textBaseline = "top";
  hud.font = HUD_FONT;
  hud.fillStyle = textColor;
  const idx = String(currentShapeIdx + 1).padStart(2, "0");
  const total = String(SHAPES.length).padStart(2, "0");
  hud.fillText(`${idx} / ${total}`, HUD_MARGIN, HUD_MARGIN);

  hud.font = HUD_FONT_LG;
  hud.fillStyle = accentColor;
  hud.fillText(shape.name.toUpperCase(), HUD_MARGIN, HUD_MARGIN + 18);

  hud.font = HUD_FONT;
  hud.fillStyle = textColor;
  hud.fillText("polyhedra · studio", HUD_MARGIN, HUD_MARGIN + 48);

  // ---- Top-right: oscilloscope (when audio active), then BEAT + BPM ----
  if (audioActive) {
    drawWaveform(
      cssW - HUD_MARGIN - WAVEFORM_W,
      HUD_MARGIN,
      textColor,
      accentColor,
    );
  }
  const readoutY = audioActive
    ? HUD_MARGIN + WAVEFORM_H + WAVEFORM_GAP
    : HUD_MARGIN;

  hud.textAlign = "right";
  hud.font = HUD_FONT;
  hud.fillStyle = textColor;
  hud.fillText(
    `BEAT ${String(kickCount).padStart(3, "0")}`,
    cssW - HUD_MARGIN,
    readoutY,
  );
  if (audioActive && bpm > 0) {
    hud.fillStyle = accentColor;
    hud.fillText(`~${bpm} BPM`, cssW - HUD_MARGIN, readoutY + 16);
  }
  if (audioActive) {
    hud.fillStyle = textColor;
    hud.fillText("● live", cssW - HUD_MARGIN, cssH - HUD_MARGIN - 12);
  }
  hud.textAlign = "left";
}

// Time-domain oscilloscope drawn into the supplied top-left anchored
// rectangle on the HUD canvas. Muted colour for the centre rail, accent
// for the trace.
function drawWaveform(
  x: number,
  y: number,
  baselineColor: string,
  traceColor: string,
) {
  if (!analyser) return;
  analyser.getByteTimeDomainData(timeBuf);
  const cy = y + WAVEFORM_H / 2;

  hud.strokeStyle = baselineColor;
  hud.lineWidth = 0.5;
  hud.beginPath();
  hud.moveTo(x, cy);
  hud.lineTo(x + WAVEFORM_W, cy);
  hud.stroke();

  hud.strokeStyle = traceColor;
  hud.lineWidth = 1.2;
  hud.lineJoin = "round";
  hud.lineCap = "round";
  hud.beginPath();
  const N = timeBuf.length;
  for (let i = 0; i < WAVEFORM_W; i++) {
    const sampleIdx = Math.floor((i / WAVEFORM_W) * N);
    const v = (timeBuf[sampleIdx] - 128) / 128;
    const py = cy + v * (WAVEFORM_H * 0.45);
    if (i === 0) hud.moveTo(x + i, py);
    else hud.lineTo(x + i, py);
  }
  hud.stroke();
}

// 8 sweep directions: index → angle of the slide direction.
//
//   0 ↓  top → bottom         4 ↘  NW → SE
//   1 ↑  bottom → top         5 ↖  SE → NW
//   2 →  left → right         6 ↗  SW → NE
//   3 ←  right → left         7 ↙  NE → SW
const SWIPE_ANGLES = [
  Math.PI * 0.5,
  Math.PI * 1.5,
  0,
  Math.PI,
  Math.PI * 0.25,
  Math.PI * 1.25,
  Math.PI * 1.75,
  Math.PI * 0.75,
];

function drawShapeSwipe() {
  if (shapeSwapTimer <= 0) return;
  const t = 1 - shapeSwapTimer / SHAPE_SWAP_FRAMES;
  const p = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  const angle = SWIPE_ANGLES[shapeSwapDirection];
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const diag = Math.hypot(cssW, cssH);
  // Band is 4× the screen diagonal in both dimensions so it always fully
  // covers the canvas at p=0.5 regardless of slide angle. Offset travels
  // from -2*diag (band fully behind entering edge) to +2*diag (fully past
  // exiting edge) — a comfortable margin for any direction.
  const bandSize = diag * 4;
  const travelHalf = diag * 2;
  const offset = -travelHalf + p * 2 * travelHalf;
  const bandCx = cssW / 2 + dx * offset;
  const bandCy = cssH / 2 + dy * offset;

  hud.save();
  // Build the rotated clip rectangle in band-local space.
  hud.translate(bandCx, bandCy);
  hud.rotate(angle);
  hud.beginPath();
  hud.rect(-bandSize / 2, -bandSize / 2, bandSize, bandSize);
  hud.clip();
  // Reset to the DPR-scaled identity so subsequent fill + text draw in
  // screen-pixel coordinates, but the clip region remains the rotated band.
  hud.setTransform(dpr, 0, 0, dpr, 0, 0);

  const swipeBg = BG_MODES[2].bg;
  const swipeFg = BG_MODES[0].bg;
  hud.fillStyle = `rgb(${swipeBg.r}, ${swipeBg.g}, ${swipeBg.b})`;
  hud.fillRect(0, 0, cssW, cssH);

  const name = SHAPES[currentShapeIdx].name.toUpperCase();
  hud.textAlign = "center";
  hud.textBaseline = "middle";
  const REF = 100;
  hud.font = `${REF}px ${SWIPE_FONT}`;
  const refWidth = hud.measureText(name).width || 1;
  const fitWidth = (cssW * 0.95) / refWidth * REF;
  const fitHeight = cssH * 0.85;
  const fontSize = Math.min(fitWidth, fitHeight) | 0;
  hud.font = `${fontSize}px ${SWIPE_FONT}`;
  hud.fillStyle = `rgb(${swipeFg.r}, ${swipeFg.g}, ${swipeFg.b})`;
  hud.fillText(name, cssW / 2, cssH / 2);
  hud.restore();
}

function drawSnareFlash() {
  if (flashTimer <= 0) return;
  const a = (flashTimer / FLASH_FRAMES) * flashIntensity * 0.32;
  const c = BG_MODES[currentBgIdx].snareFlashColor;
  hud.fillStyle = `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
  hud.fillRect(0, 0, cssW, cssH);
}

// ---------------------------------------------------------------------------
// Main loop.
// ---------------------------------------------------------------------------
function frame() {
  readAudio();

  // Focal glide.
  focalX += (targetFocalX - focalX) * 0.13;
  focalY += (targetFocalY - focalY) * 0.13;

  // Onset detection.
  if (audioActive) {
    bassPeak = Math.max(envBass * 1.02, bassPeak * 0.985 + envBass * 0.015);
    midPeak  = Math.max(envMid  * 1.02, midPeak  * 0.97  + envMid  * 0.03);
    if (dropTimer === 0 && envBass > DROP_THRESHOLD &&
        envBass / Math.max(0.15, bassPeak) > DROP_OVERSHOOT) {
      triggerDrop();
    }
    if (flashTimer === 0 && envMid > SNARE_THRESHOLD &&
        envMid / Math.max(0.12, midPeak) > SNARE_OVERSHOOT) {
      flashTimer = FLASH_FRAMES;
      flashIntensity = envMid;
    }
    const bassRise = envBass - prevEnvBass;
    prevEnvBass = envBass;
    if (kickCooldown === 0 && envBass > KICK_THRESHOLD && bassRise > KICK_RISE) {
      kickCooldown = KICK_COOLDOWN_FRAMES;
      kickCount++;
      if (kickCount % KICKS_PER_SHAPE_SWAP === 0) swapShape();
      if (kickCount % KICKS_PER_INVERT_ROLL === 0 &&
          Math.random() < INVERT_FLIP_CHANCE) {
        // Cycle to a different bg mode (never repeat the current).
        const others = [0, 1, 2].filter((m) => m !== currentBgIdx);
        currentBgIdx = others[(Math.random() * others.length) | 0];
      }
      const now = performance.now();
      const last = kickTimes[kickTimes.length - 1];
      if (last !== undefined) {
        const dt = now - last;
        if (dt < 200 || dt > 2000) kickTimes.length = 0;
      }
      kickTimes.push(now);
      if (kickTimes.length > 8) kickTimes.shift();
      if (kickTimes.length >= 4) {
        let total = 0;
        for (let i = 1; i < kickTimes.length; i++) total += kickTimes[i] - kickTimes[i - 1];
        bpm = Math.round(60000 / (total / (kickTimes.length - 1)));
      }
    }
    if (kickCooldown > 0) kickCooldown--;
  }

  // Bounce spring + decay.
  bounceVelY += -bouncePosY * BOUNCE_STIFFNESS - bounceVelY * BOUNCE_DAMPING;
  bouncePosY += bounceVelY;
  bounceScale *= BOUNCE_SCALE_DECAY;

  if (dropTimer > 0) dropTimer--;
  if (shakeTimer > 0) shakeTimer--;
  if (flashTimer > 0) flashTimer--;
  if (shapeSwapTimer > 0) shapeSwapTimer--;

  // Camera shake (applied to camera position; HUD shake passed separately).
  const shakeT = shakeTimer > 0 ? shakeTimer / SHAKE_FRAMES : 0;
  const sx = shakeT > 0 ? (Math.random() - 0.5) * shakeStrength * shakeT : 0;
  const sy = shakeT > 0 ? (Math.random() - 0.5) * shakeStrength * shakeT : 0;

  // Background is fixed to the active mode's colour. setRGB defaults to the
  // linear working space, so we explicitly tag the input as sRGB to match
  // the way the swipe panel is painted on the HUD canvas — without this
  // the bg ends up much more washed-out than the swipe band it transitions
  // to/from.
  const mode = BG_MODES[currentBgIdx];
  (scene.background as THREE.Color).setRGB(
    mode.bg.r / 255,
    mode.bg.g / 255,
    mode.bg.b / 255,
    THREE.SRGBColorSpace,
  );

  heroMat.color.set(mode.heroHex);
  heroMat.emissive.set(mode.heroEmissiveHex);
  edgeMat.color.set(mode.edgeHex);
  edgeMat.opacity = mode.edgeOpacityBase + (audioActive ? envBass * 0.35 : 0);

  const gc = mode.gridColor;
  gridUniforms.uColor.value.set(gc[0], gc[1], gc[2]);
  gridUniforms.uFocal.value.set(focalX, cssH - focalY);
  gridUniforms.uBass.value = audioActive ? envBass : 0;
  gridUniforms.uTime.value = performance.now();

  // Hero rotation + size (shared between single and swarm modes).
  shapeRotX += 0.005 + Math.pow(envBass, SHAPE_SPIN_EXP) * 0.07;
  shapeRotY += 0.008 + Math.pow(envMid, SHAPE_SPIN_EXP) * 0.045;
  const pop = dropTimer > 0 ? 1 + (dropTimer / DROP_FRAMES) * 0.45 : 1;
  // swapPop kept modest so the cube growth doesn't spike bloom contribution
  // (which was responsible for a brief white-out on swap moments).
  const swapPop = shapeSwapTimer > 0
    ? 1 + Math.pow(shapeSwapTimer / SHAPE_SWAP_FRAMES, 0.7) * 0.22
    : 1;
  // On mobile the canvas is narrow, so 0.085 of min-dim reads as tiny and
  // makes the bass/bounce effects feel weaker than they are. Bump the base
  // ratio so the silhouette fills more of the screen on phones.
  const heroBase = IS_MOBILE ? 0.14 : 0.085;
  const heroSize = Math.min(cssW, cssH) * heroBase *
    (1 + Math.pow(envBass, 1.5) * 0.35 + bounceScale * 0.5) *
    pop * swapPop;

  if (proliferateCount > 1) {
    // ---- Swarm mode: render every clone via InstancedMesh ----
    heroGroup.visible = false;
    instancedHero.visible = true;
    instancedHero.count = proliferateCount;
    for (let i = 0; i < proliferateCount; i++) {
      const inst = heroInstances[i];
      _instEuler.set(
        shapeRotX + inst.rotOffX,
        shapeRotY + inst.rotOffY,
        0,
      );
      _instQuat.setFromEuler(_instEuler);
      _instPos.set(toWorldX(inst.x), toWorldY(inst.y), 0);
      const s = heroSize * inst.scale;
      _instScale.set(s, s, s);
      _instM4.compose(_instPos, _instQuat, _instScale);
      instancedHero.setMatrixAt(i, _instM4);
    }
    instancedHero.instanceMatrix.needsUpdate = true;
  } else {
    // ---- Single mode: hero mesh + edges with bounce + focal ----
    heroGroup.visible = true;
    instancedHero.visible = false;
    heroGroup.rotation.x = shapeRotX;
    heroGroup.rotation.y = shapeRotY;
    heroGroup.position.x = toWorldX(focalX);
    heroGroup.position.y = toWorldY(focalY + bouncePosY);
    heroGroup.scale.setScalar(heroSize);
  }

  // Confetti physics + buffer write.
  let pCount = 0;
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.age++;
    if (p.age >= p.life) { particles.splice(i, 1); continue; }
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.1;
    p.vx *= 0.985;
    p.vy *= 0.99;
    const lifeT = p.age / p.life;
    const alpha = 1 - lifeT;
    const size = p.size * (1 - lifeT * 0.3);
    const o3 = pCount * 3;
    ptsPositions[o3]     = toWorldX(p.x);
    ptsPositions[o3 + 1] = toWorldY(p.y);
    ptsPositions[o3 + 2] = 20;
    ptsColors[o3]     = p.color[0] * alpha;
    ptsColors[o3 + 1] = p.color[1] * alpha;
    ptsColors[o3 + 2] = p.color[2] * alpha;
    ptsSizes[pCount] = size;
    pCount++;
    if (pCount >= MAX_PARTICLES) break;
  }
  ptsGeom.setDrawRange(0, pCount);
  ptsGeom.getAttribute("position").needsUpdate = true;
  ptsGeom.getAttribute("aColor").needsUpdate = true;
  ptsGeom.getAttribute("aSize").needsUpdate = true;

  // Shockwaves → expanding rings.
  let swPointCount = 0;
  const swColor = mode.shockwaveColor;
  const farX = Math.max(focalX, cssW - focalX);
  const farY = Math.max(focalY, cssH - focalY);
  const outerR = Math.hypot(farX, farY) + 40;
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const sw = shockwaves[i];
    sw.age++;
    const lifetime = 75;
    if (sw.age >= lifetime) { shockwaves.splice(i, 1); continue; }
    const t = sw.age / lifetime;
    const ease = 1 - Math.pow(1 - t, 2.4);
    const radius = 70 + outerR * 0.6 * ease;
    const N_RING = 42;
    const baseSize = sw.strength * (1 - t) * 22 + 4;
    const alpha = (1 - t) * 0.95;
    const ringSpin = sw.rotation + sw.age * 0.028;
    for (let s = 0; s < N_RING; s++) {
      if (swPointCount >= MAX_SHOCKWAVE_POINTS) break;
      const a = (s / N_RING) * Math.PI * 2 + ringSpin;
      const x = focalX + Math.cos(a) * radius;
      const y = focalY + Math.sin(a) * radius;
      const o3 = swPointCount * 3;
      swPositions[o3]     = toWorldX(x);
      swPositions[o3 + 1] = toWorldY(y);
      swPositions[o3 + 2] = 10;
      swColors[o3]     = swColor[0] * alpha;
      swColors[o3 + 1] = swColor[1] * alpha;
      swColors[o3 + 2] = swColor[2] * alpha;
      swSizes[swPointCount] = baseSize;
      swPointCount++;
    }
  }
  swGeom.setDrawRange(0, swPointCount);
  swGeom.getAttribute("position").needsUpdate = true;
  swGeom.getAttribute("aColor").needsUpdate = true;
  swGeom.getAttribute("aSize").needsUpdate = true;

  // Bloom — per-mode baseline (so bright backgrounds don't drown the
  // silhouette) plus a softer bass boost. HDR + tone mapping handle
  // headroom now, so we don't need a huge linear-domain strength.
  bloomPass.strength = mode.bloomStrength + (audioActive ? envBass * 0.35 : 0);
  bloomPass.threshold = mode.bloomThreshold;

  // Chromatic aberration: subtle baseline, scales with bass, surges on drops.
  const baselineChroma = 0.2;
  const audioChroma = audioActive ? envBass * 0.85 : 0;
  const dropChroma = dropTimer > 0 ? (dropTimer / DROP_FRAMES) * 1.6 : 0;
  chromaticVignettePass.uniforms.uChroma.value =
    baselineChroma + audioChroma + dropChroma;
  chromaticVignettePass.uniforms.uVignette.value =
    0.7 - (audioActive ? envBass * 0.15 : 0);
  // Smoothly lerp VHS intensity toward its target so the look fades in
  // and out instead of snapping mid-frame.
  vhsLevel += ((vhsActive ? 1 : 0) - vhsLevel) * 0.12;
  chromaticVignettePass.uniforms.uVhs.value = vhsLevel;
  chromaticVignettePass.uniforms.uTime.value = performance.now();
  chromaticVignettePass.uniforms.uResolution.value.set(cssW, cssH);

  // Camera shake.
  camera.position.x = sx;
  camera.position.y = -sy;

  composer.render();

  // 2D HUD layer.
  drawHUD(sx, -sy);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
