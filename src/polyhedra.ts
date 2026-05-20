// Audio-reactive sketch — three.js + GLSL pipeline.
//
// A polyhedron at the centre morphs through ten geometric forms on the beat.
// The 3D scene (polyhedron, particles, shockwaves, dot grid) is rendered with
// WebGL through an EffectComposer with UnrealBloomPass, so bright edges and
// particles glow like neon. A second 2D canvas overlays the HUD, the shape
// swipe transition, and the snare flash — UI that wants pixel-perfect type.
//
// File map (top → bottom):
//   1.  Imports
//   2.  Canvas + DPR sizing
//   3.  Tunable constants (thresholds, frame budgets, font tokens)
//   4.  BG palette (BG_MODES) + activeMode()
//   5.  Module state (audio envelopes, timers, focal, swap, etc.)
//   6.  Session timer helper
//   7.  three.js scene setup — renderer, camera, lights
//   8.  Hero mesh + edges + InstancedMesh (uses SHAPES from ./shapes)
//   9.  Dot-grid backdrop shader
//   10. Tetra rune backdrop (lazy-loaded canvas texture)
//   11. Particle system + shockwave system
//   12. Post-processing (HDR target, bloom, chromatic+vignette+VHS+grain)
//   13. Audio input (mic / tab audio / stop) + tap tempo + shape picker
//   14. Helpers — toWorld*, hexToRgb01
//   15. Splash overlay binding
//   16. swapShape() + triggerDrop()
//   17. HUD drawing — drawHUD, drawHUDFrame, drawHUDText, drawWaveform,
//       drawLetterbox, drawSnareFlash
//   18. Swipe drawing — drawShapeSwipe (dispatcher), band / waves / synapse
//   19. Frame loop helpers — detectAudioOnsets, advanceStellaMorph,
//       renderHero, updateParticleBuffers, updateShockwaveBuffers, updatePostFX
//   20. frame() main loop
//
// Pure-data module: shape definitions + SPIN_PROFILES live in ./shapes.ts.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import {
  DEFAULT_SPIN,
  DODECA_SHAPE_NAME,
  GSTELLA_SHAPE_NAME,
  OCTA_SHAPE_NAME,
  type Polyhedron,
  SHAPES,
  SPIN_PROFILES,
  STELLA_SHAPE_NAME,
  TETRA_SHAPE_NAME,
} from "./shapes";

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

const KICK_THRESHOLD = IS_MOBILE ? 0.1 : 0.15;
const KICK_RISE = IS_MOBILE ? 0.025 : 0.04;
const KICK_COOLDOWN_FRAMES = 8;
const KICK_IMPULSE = IS_MOBILE ? 12 : 7.5;
const KICKS_PER_SHAPE_SWAP = 4;
const KICKS_PER_INVERT_ROLL = 2;
const INVERT_FLIP_CHANCE = 0.55;
const SHAPE_SWAP_FRAMES = 36;
const SWIPE_FONT = '"Bebas Neue", "Anton", "Archivo Black", sans-serif';
const VHS_CHANCE = 0.1;

const RUNIC_NAME_FONT =
  '24px "Madeon Runes", ui-monospace, "SF Mono", Menlo, monospace';

// Warm up the rune font so the first runic name uses correct metrics.
if ("fonts" in document) {
  document.fonts.load("400 24px 'Madeon Runes'").catch(() => {});
}

const GRID_SPACING = 38;
const HUD_FONT =
  '11px ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';
const HUD_MARGIN = 28;
const WAVEFORM_W = 200;
const WAVEFORM_H = 36;
const WAVEFORM_GAP = 14;

const BOUNCE_STIFFNESS = 0.18;
const BOUNCE_DAMPING = IS_MOBILE ? 0.08 : 0.1;
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
const PROLIFERATE_SCALE = 0.3; // uniform scale relative to single hero size

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
const FOCAL_Y_BIAS = 0.5;
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
const SWIPE_STYLES = ["band", "waves", "synapse"] as const;
type SwipeStyle = (typeof SWIPE_STYLES)[number];
let shapeSwapStyle: SwipeStyle = "band";
// Per-row, per-node shape names for the synapse style. Regenerated each
// time the synapse style rolls so the network is different per swap. The
// target node (centre row, centre column) is overridden at render time with
// the actual new shape name.
const SYNAPSE_ROWS = 5;
const SYNAPSE_NODES = 4;
// Store SHAPES indices instead of names so we can render `01·NAME` captions
// without re-deriving the index by name lookup.
let synapseNetwork: number[][] = [];
// Row + column of the node that "completes" — randomised per swap so the
// connecting synapse isn't always at the geometric centre.
let synapseTargetRow = 0;
let synapseTargetCol = 0;
function generateSynapseNetwork() {
  synapseNetwork = [];
  for (let r = 0; r < SYNAPSE_ROWS; r++) {
    const row: number[] = [];
    for (let i = 0; i < SYNAPSE_NODES; i++) {
      row.push((Math.random() * SHAPES.length) | 0);
    }
    synapseNetwork.push(row);
  }
  synapseTargetRow = (Math.random() * SYNAPSE_ROWS) | 0;
  synapseTargetCol = (Math.random() * SYNAPSE_NODES) | 0;
}

let prevEnvBass = 0;
let kickCooldown = 0;
let kickCount = 0;
let bouncePosY = 0;
let bounceVelY = 0;
let bounceScale = 0;
const kickTimes: number[] = [];
let bpm = 0;

// Tap-tempo state. Pressing the panel button (or spacebar) collects taps in
// a 2.5s window; ≥3 taps locks `lockedBpm`, which then drives shape swaps on
// a beat grid instead of the kick counter.
const TAP_WINDOW_MS = 2500;
const TAP_GRID_BEATS = 8;
const tapTimes: number[] = [];
let lockedBpm = 0;
let lockedBeatPhase = 0; // performance.now() at beat #0
let lockedBeatLastFired = -1; // last beat number that triggered a swap

let dropCount = 0;
// Cycles 0→2 (BLACK · WHITE · PINK) on the same cadence the old invert flag
// used to toggle. Audio resets it to 0; manual clicks (no audio) advance it.
let currentBgIdx = 0;

type Shockwave = { age: number; strength: number; rotation: number };
const shockwaves: Shockwave[] = [];

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  color: [number, number, number];
};
const particles: Particle[] = [];

type HeroInstance = {
  x: number;
  y: number;
  scale: number;
  rotOffX: number;
  rotOffY: number;
};
const heroInstances: HeroInstance[] = [];
let proliferateCount = 1; // 1 = single hero, > 1 = swarm

// Per-swap randomised state.
let vhsActive = false;
let vhsLevel = 0; // smoothed 0..1 actually applied to shader

// Cinematic letterbox state — smoothly lerps to 1 when a "feature" shape is
// active (tetra or gstella), back to 0 otherwise. Drawn on the HUD canvas
// over the GL output.
const LETTERBOX_SHAPES = new Set([
  TETRA_SHAPE_NAME,
  STELLA_SHAPE_NAME,
  GSTELLA_SHAPE_NAME,
]);
// Stella is always presented against the WHITE palette regardless of the
// currentBgIdx cycle.
const WHITE_MODE_IDX = 1;
function activeMode(): BgPaletteSet {
  if (SHAPES[currentShapeIdx].name === STELLA_SHAPE_NAME) {
    return BG_MODES[WHITE_MODE_IDX];
  }
  return BG_MODES[currentBgIdx];
}
let letterboxLevel = 0;
const sessionStartMs = performance.now();
function formatElapsed(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
const STELLA_CIRCLE_COUNT = 12;
const STELLA_CIRCLE_SCALE = 0.18;
const STELLA_MERGE_SCALE = 0.95; // per-instance scale at the convergence frame
const STELLA_MORPH_FRAMES = 100;
let stellaMorphTimer = 0;
// Dodeca is the inverse of stella — burst outward from a single centred
// dodeca into a 12-instance ring. Reuses the same instance count / scales /
// morph duration as the stella collapse for visual symmetry.
let dodecaMorphTimer = 0;
// Octa transformation — "Contraption: Ramiel" rig: cycles smoothly between
// the rigid octahedron and a layered tower (two pyramid tips + frustums +
// counter-spinning discs + a tiny central core). A cosine bell curve drives
// the deploy amount so there's no flat pause at either extreme; yaw runs at
// a constant rate so the rig keeps spinning through the cycle's stillpoints.
const OCTA_MORPH_FRAMES = 200;
let octaMorphTimer = 0;
// Fixed X tilt — yaw is the only animated rotation so the camera never
// slides under the bottom disc, where the rig reads as flat tape edges.
const RAMIEL_VIEW_TILT_X = 0.18;
// Full revolutions per deploy/fold cycle. Decoupled from the deploy curve so
// the spin doesn't stall at the extremes; raise for more aggressive motion.
const RAMIEL_REVS_PER_CYCLE = 3;
const RAMIEL_YAW_PER_FRAME =
  (Math.PI * 2 * RAMIEL_REVS_PER_CYCLE) / OCTA_MORPH_FRAMES;


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
scene.background = new THREE.Color(
  initBg.r / 255,
  initBg.g / 255,
  initBg.b / 255,
);

// Ortho: world origin at screen centre, y up, units = CSS pixels.
const camera = new THREE.OrthographicCamera(
  -cssW / 2,
  cssW / 2,
  cssH / 2,
  -cssH / 2,
  -2000,
  2000,
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
  faces: THREE.BufferGeometry;
  edges: THREE.BufferGeometry;
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
  faces.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
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

// ---------------------------------------------------------------------------
// Ramiel "Contraption" rig — at rest the upper + lower square pyramids meet
// at the equator to form a single octahedron. As the deploy amount rises,
// the two halves separate vertically and the inner pieces (two octagonal
// frustums, two counter-spinning discs, a tiny central octa core) grow from
// zero scale to fill the gap.
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
function makeRamielPyramid(
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
function makeRamielFrustum(
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

type RamielPart = {
  mesh: THREE.Mesh;
  restPos: THREE.Vector3;
  restScale: number;
  deployPos: THREE.Vector3;
  deployScale: number;
  // Local Y self-rotation multiplier on ramielYaw. World yaw of the part is
  // (group yaw rate) + (spinMult × yaw rate). Used to counter-spin the discs
  // against the group rotation for a rich kinetic silhouette.
  spinMult?: number;
};
const ramielGroup = new THREE.Group();
const ramielParts: RamielPart[] = [];

function addRamielPart(
  geom: THREE.BufferGeometry,
  restPos: Vec3,
  restScale: number,
  deployPos: Vec3,
  deployScale: number,
): RamielPart {
  const mesh = new THREE.Mesh(geom, heroMat);
  // Edges inherit the mesh transform — same wireframe highlight as heroEdges.
  mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geom), edgeMat));
  ramielGroup.add(mesh);
  const part: RamielPart = {
    mesh,
    restPos: new THREE.Vector3(...restPos),
    restScale,
    deployPos: new THREE.Vector3(...deployPos),
    deployScale,
  };
  ramielParts.push(part);
  return part;
}

// Build the rig top → bottom. At rest only the two pyramids are visible —
// together they form the octahedron silhouette. Every other part starts at
// scale 0 and grows in as the deploy amount rises toward 1.
{
  // Upper pyramid tip — covers the octa's upper half at rest, then shrinks
  // and lifts so it caps the deployed tower.
  addRamielPart(makeRamielPyramid(1, 0, 1), [0, 0, 0], 1, [0, 1.55, 0], 0.55);
  // Lower pyramid tip — mirror.
  addRamielPart(makeRamielPyramid(1, 0, -1), [0, 0, 0], 1, [0, -1.55, 0], 0.55);
  // Upper / lower frustums — narrow→wide between the pyramid tip and disc.
  addRamielPart(
    makeRamielFrustum(0.35, 0.85, 0.22, -0.22, 8, Math.PI / 8),
    [0, 0, 0], 0, [0, 1, 0], 1,
  );
  addRamielPart(
    makeRamielFrustum(0.85, 0.35, 0.22, -0.22, 8, Math.PI / 8),
    [0, 0, 0], 0, [0, -1, 0], 1,
  );
  // Upper / lower discs — wide octagonal plates, thin profile. spinMult
  // counter-spins each disc against the group yaw at a different rate so
  // the two slice past each other like a kinetic sculpture.
  const discGeom = makeRamielFrustum(1.2, 1.2, 0.08, -0.08, 8, 0);
  const upperDisc = addRamielPart(discGeom, [0, 0, 0], 0, [0, 0.55, 0], 1);
  upperDisc.spinMult = -2.5; // world rate = +1 − 2.5 = −1.5 (counter)
  const lowerDisc = addRamielPart(discGeom, [0, 0, 0], 0, [0, -0.55, 0], 1);
  lowerDisc.spinMult = 1.5; // world rate = +2.5 (faster, same direction)
  // Central core — the floating dot revealed between the parted halves.
  // Reuses the project's octahedron geom at a fixed small scale.
  const octaCoreIdx = SHAPES.findIndex((s) => s.name === OCTA_SHAPE_NAME);
  addRamielPart(geomCache[octaCoreIdx].faces, [0, 0, 0], 0, [0, 0, 0], 0.22);
}
ramielGroup.visible = false;
scene.add(ramielGroup);

// Cosine bell curve, 0 → 1 → 0 with no flat hold at either extreme. Velocity
// tapers smoothly at the endpoints so the reversals don't read as snaps.
function octaDeployAmount(): number {
  const phase = (octaMorphTimer % OCTA_MORPH_FRAMES) / OCTA_MORPH_FRAMES;
  return (1 - Math.cos(phase * Math.PI * 2)) / 2;
}

// Accumulated yaw — incremented at a constant rate so the rig keeps spinning
// through the deploy and fold extremes without ever appearing to stall.
let ramielYaw = 0;

function updateRamielPose() {
  const deploy = octaDeployAmount();
  ramielYaw += RAMIEL_YAW_PER_FRAME;
  ramielGroup.rotation.y = ramielYaw;
  ramielGroup.rotation.x = RAMIEL_VIEW_TILT_X;
  for (const part of ramielParts) {
    part.mesh.position.lerpVectors(part.restPos, part.deployPos, deploy);
    const scale =
      part.restScale + (part.deployScale - part.restScale) * deploy;
    part.mesh.scale.setScalar(scale);
    if (part.spinMult !== undefined) {
      part.mesh.rotation.y = ramielYaw * part.spinMult;
    }
  }
}

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

// Stella-specific layout — 12 small stellas placed evenly around the screen
// centre. Each instance gets a unique rotation offset so the ring reads as
// a coordinated mandala rather than every star spinning in lockstep.
function spawnStellaCircle() {
  proliferateCount = STELLA_CIRCLE_COUNT;
  heroInstances.length = 0;
  const cx = cssW / 2;
  const cy = cssH / 2;
  const radius = Math.min(cssW, cssH) * 0.32;
  for (let i = 0; i < STELLA_CIRCLE_COUNT; i++) {
    const angle = (i / STELLA_CIRCLE_COUNT) * Math.PI * 2 - Math.PI / 2;
    heroInstances.push({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      scale: STELLA_CIRCLE_SCALE,
      rotOffX: angle * 0.7,
      rotOffY: angle * 1.3,
    });
  }
}

// Inverse of spawnStellaCircle — all 12 instances start stacked at the
// centre at full single-mesh size, then advanceDodecaBurst spreads them
// outward to a ring while shrinking to the per-instance scale.
function spawnDodecaBurst() {
  proliferateCount = STELLA_CIRCLE_COUNT;
  heroInstances.length = 0;
  const cx = cssW / 2;
  const cy = cssH / 2;
  for (let i = 0; i < STELLA_CIRCLE_COUNT; i++) {
    heroInstances.push({
      x: cx,
      y: cy,
      scale: STELLA_MERGE_SCALE,
      rotOffX: 0,
      rotOffY: 0,
    });
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
// Tetra-only backdrop — fills the screen with the tetra description rendered
// in Madeon Runes. Drawn lazily once the rune font has loaded so glyph
// metrics are correct. Sits between the dot grid and the hero in render
// order, toggled on only while the tetra is locked into its ▽ pose.
// ---------------------------------------------------------------------------
const TETRA_RUNE_DESC =
  "REGULAR TETRAHEDRON FOUR EQUILATERAL TRIANGULAR FACES FOUR VERTICES SIX EDGES SIMPLEST PLATONIC SOLID SCHLAFLI THREE THREE SELF DUAL TRIANGULAR PYRAMID FIRST OF FIVE PLATONIC SOLIDS DELTA    ";
function makeTetraRuneTexture(): THREE.CanvasTexture {
  const w = 1024;
  const h = 1024;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cx = c.getContext("2d")!;
  cx.clearRect(0, 0, w, h);
  cx.fillStyle = "#ffffff";
  cx.font = '22px "Madeon Runes", monospace';
  cx.textBaseline = "top";
  const lineH = 30;
  // Each row rotates the description so columns don't visually align into
  // a grid — gives the field a more organic glyph weave.
  let phase = 0;
  for (let y = 0; y < h; y += lineH) {
    const start = (phase * 13) % TETRA_RUNE_DESC.length;
    const rotated =
      TETRA_RUNE_DESC.slice(start) + TETRA_RUNE_DESC.slice(0, start);
    cx.fillText(rotated.repeat(4), -40, y);
    phase++;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}
const tetraRuneUniforms = {
  uTex: { value: null as THREE.Texture | null },
  uColor: { value: new THREE.Color(0xff3b6b) },
  uOpacity: { value: 0.22 },
  uTime: { value: 0 },
};
const tetraRuneMat = new THREE.ShaderMaterial({
  uniforms: tetraRuneUniforms,
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D uTex;
    uniform vec3 uColor;
    uniform float uOpacity;
    uniform float uTime;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
        u.y
      );
    }

    void main() {
      float glyph = texture2D(uTex, vUv).a;
      if (glyph < 0.02) discard;

      float t = uTime * 0.001;
      // Per-cell flash — each rune cell (~1/40 of UV ≈ one glyph) gets
      // its own phase + frequency, so different runes light up at
      // different moments. pow(sin, 8) makes the flash brief and pointy.
      vec2 cellPos = floor(vUv * 40.0);
      float seed = hash(cellPos);
      float phase = seed * 100.0 + t * (1.2 + seed * 2.4);
      float flash = pow(max(0.0, sin(phase)), 8.0);

      // Slow gradient drift adds a subtle moving brightness wave on top
      // so even unflashed runes shimmer a little.
      float drift = vnoise(vUv * 5.0 + vec2(t * 0.3, t * 0.45));

      float bright = 0.55 + drift * 0.6 + flash * 3.0;
      vec3 col = uColor * bright;
      float a = glyph * uOpacity * (0.65 + flash * 1.6);
      gl_FragColor = vec4(col, a);
    }
  `,
  transparent: true,
  depthWrite: false,
});
const tetraRuneMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  tetraRuneMat,
);
tetraRuneMesh.position.z = -50;
tetraRuneMesh.renderOrder = -5; // after grid (-10), before hero (default 0)
tetraRuneMesh.visible = false;
scene.add(tetraRuneMesh);
// Draw the texture once the rune font is actually loaded — use `finally`
// so we still create the texture (with whatever fallback the browser picks)
// if the font load rejects.
let tetraRuneReady = false;
const buildRuneTex = () => {
  tetraRuneUniforms.uTex.value = makeTetraRuneTexture();
  tetraRuneReady = true;
};
if ("fonts" in document) {
  document.fonts.load('22px "Madeon Runes"').finally(buildRuneTex);
} else {
  buildRuneTex();
}

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
  0.4, // strength (per-mode override happens each frame)
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
    tDiffuse: { value: null },
    uChroma: { value: 0 },
    uVignette: { value: 0.65 },
    uVhs: { value: 0 }, // 0..1 — VHS tape look intensity
    uGrain: { value: 0.045 }, // film-grain amplitude (modulated by bass)
    uTime: { value: 0 }, // ms, for scanline/grain animation
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
    uniform float uGrain;
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

      // Subtle always-on film grain — adds a slight analogue texture that
      // unifies the silhouette, edges and bloom. Independent of the VHS
      // grain (which is much louder and only active occasionally).
      float grain = rand(vUv * 1.7 + fract(uTime * 0.0009)) - 0.5;
      col += vec3(grain * uGrain);

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
  tetraRuneMesh.scale.set(cssW, cssH, 1);
}
resizeGL();
window.addEventListener("resize", () => {
  resize();
  resizeGL();
});

// ---------------------------------------------------------------------------
// Helpers: canvas (top-left origin) → world (centre origin, y up).
// ---------------------------------------------------------------------------
function toWorldX(cx: number) {
  return cx - cssW / 2;
}
function toWorldY(cy: number) {
  return cssH / 2 - cy;
}

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
// Track the live MediaStream so stopAudio can release the OS-level mic/tab
// capture indicator — closing the AudioContext alone leaves the tracks
// running and the browser keeps showing the recording dot.
let activeStream: MediaStream | null = null;

async function startAudio(
  label: string,
  stream: MediaStream | null,
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
  activeStream = stream;
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
  if (activeStream) {
    for (const t of activeStream.getTracks()) t.stop();
    activeStream = null;
  }
  if (audioCtx) {
    try {
      await audioCtx.close();
    } catch {}
    audioCtx = null;
  }
  analyser = null;
  // Don't hard-zero the env values here — readAudio's early-return path
  // means the main loop will decay them smoothly over the next few frames,
  // avoiding the bloom/edge snap that hard-zeroing produces.
  stopBtn.hidden = true;
  audioStatus.textContent = "";
}

document.getElementById("micBtn")!.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false },
    });
    await startAudio("マイクに連動中", stream, async (ctx, pre) => {
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
    type FocusController = {
      setFocusBehavior?: (
        b: "no-focus-change" | "focus-captured-surface",
      ) => void;
    };
    const CC = (
      window as unknown as { CaptureController?: new () => FocusController }
    ).CaptureController;
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
    const audioOnly = new MediaStream(stream.getAudioTracks());
    await startAudio("タブ音声に連動中", audioOnly, async (ctx, pre) => {
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

stopBtn.addEventListener("click", () => {
  void stopAudio();
  // Clear the tap tempo too — once the audio source is dismissed the lock
  // is almost certainly stale (different track / no track at all).
  lockedBpm = 0;
  tapTimes.length = 0;
  tapBpmEl.textContent = "—";
  tapBpmEl.classList.remove("locked");
});

const tapBpmEl = document.getElementById("tapBpm")!;
function handleTap() {
  const now = performance.now();
  // Reset the tap history if the gap since the last tap exceeded the window.
  if (
    tapTimes.length > 0 &&
    now - tapTimes[tapTimes.length - 1] > TAP_WINDOW_MS
  ) {
    tapTimes.length = 0;
  }
  tapTimes.push(now);
  if (tapTimes.length > 8) tapTimes.shift();
  if (tapTimes.length >= 3) {
    let sum = 0;
    for (let i = 1; i < tapTimes.length; i++) {
      sum += tapTimes[i] - tapTimes[i - 1];
    }
    const candidate = 60000 / (sum / (tapTimes.length - 1));
    if (candidate >= 40 && candidate <= 220) {
      lockedBpm = Math.round(candidate);
      lockedBeatPhase = tapTimes[tapTimes.length - 1];
      lockedBeatLastFired = -1;
    }
  }
  tapBpmEl.textContent =
    lockedBpm > 0 ? `${lockedBpm} BPM ✕` : `${tapTimes.length}/3`;
  tapBpmEl.classList.toggle("locked", lockedBpm > 0);
}
// When the BPM is locked, clicking the readout clears it — keeps the reset
// affordance inline with the value so the panel doesn't grow another button.
tapBpmEl.addEventListener("click", () => {
  if (lockedBpm === 0) return;
  lockedBpm = 0;
  tapTimes.length = 0;
  tapBpmEl.textContent = "—";
  tapBpmEl.classList.remove("locked");
});
document.getElementById("tapBtn")!.addEventListener("click", handleTap);
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  // Skip when a button/input is focused — those already handle space natively.
  if (tag === "BUTTON" || tag === "INPUT") return;
  handleTap();
  e.preventDefault();
});

// Shape jump selector — populate with every SHAPES entry; selecting an
// option immediately swaps to that shape. swapShape syncs its value when a
// kick/tap-grid swap fires so the dropdown always reflects what's on screen.
const shapeSelect = document.getElementById(
  "shapeSelect",
) as HTMLSelectElement;
for (let i = 0; i < SHAPES.length; i++) {
  const opt = document.createElement("option");
  opt.value = String(i);
  opt.textContent = SHAPES[i].name;
  shapeSelect.appendChild(opt);
}
shapeSelect.value = String(currentShapeIdx);
shapeSelect.addEventListener("change", () => {
  const idx = parseInt(shapeSelect.value, 10);
  if (Number.isFinite(idx)) swapShape(idx);
});

function readAudio() {
  if (!analyser || !audioActive) return;
  analyser.getByteFrequencyData(freqBuf);
  const N = freqBuf.length;
  let bSum = 0,
    mSum = 0,
    hSum = 0,
    bN = 0,
    mN = 0,
    hN = 0;
  for (let i = 1; i < 6 && i < N; i++) {
    bSum += freqBuf[i];
    bN++;
  }
  for (let i = 6; i < 50 && i < N; i++) {
    mSum += freqBuf[i];
    mN++;
  }
  for (let i = 50; i < 200 && i < N; i++) {
    hSum += freqBuf[i];
    hN++;
  }
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
      size: 6 + Math.random() * 14,
      color: palette[(Math.random() * palette.length) | 0],
    });
  }
}

function swapShape(targetIdx?: number) {
  currentShapeIdx =
    targetIdx === undefined
      ? (currentShapeIdx + 1) % SHAPES.length
      : ((targetIdx % SHAPES.length) + SHAPES.length) % SHAPES.length;
  if (shapeSelect) shapeSelect.value = String(currentShapeIdx);
  shapeSwapTimer = SHAPE_SWAP_FRAMES;
  // 8 sweep directions — 4 cardinal + 4 diagonal.
  shapeSwapDirection = (Math.random() * 8) | 0;
  shapeSwapStyle = SWIPE_STYLES[(Math.random() * SWIPE_STYLES.length) | 0];
  // Waves only read clearly when sliding sideways — clamp to indices 2/3
  // (left→right / right→left) when the wave style is rolled.
  if (shapeSwapStyle === "waves") {
    shapeSwapDirection = Math.random() < 0.5 ? 2 : 3;
  } else if (shapeSwapStyle === "synapse") {
    // Synapse uses purely vertical band travel — top↓ or bottom↑.
    shapeSwapDirection = Math.random() < 0.5 ? 0 : 1;
    generateSynapseNetwork();
  }
  applyShape(currentShapeIdx);
  // Layout rolls — stella collapses inward, dodeca explodes outward; every
  // other shape (tetra included) rolls for the grid-swarm.
  const swapName = SHAPES[currentShapeIdx].name;
  const isStellaSwap = swapName === STELLA_SHAPE_NAME;
  const isDodecaSwap = swapName === DODECA_SHAPE_NAME;
  if (isStellaSwap) {
    spawnStellaCircle();
    stellaMorphTimer = STELLA_MORPH_FRAMES;
  } else if (isDodecaSwap) {
    spawnDodecaBurst();
    dodecaMorphTimer = STELLA_MORPH_FRAMES;
  } else if (swapName === OCTA_SHAPE_NAME) {
    // Restart the octa→Ramiel transformation from the regular-octahedron
    // form whenever the octa is (re)selected.
    octaMorphTimer = 0;
    proliferateCount = 1;
  } else if (Math.random() < PROLIFERATE_CHANCE) {
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
  drawHUDFrame();
  drawHUDText();
  hud.restore();
  drawLetterbox();
  drawShapeSwipe();
  drawSnareFlash();
}

// Viewfinder-style corner brackets + a tiny "session" metadata strip at the
// bottom-left. Adds structure to empty corners and gives the canvas the
// graphic-design feel of a Madeon / Alltta visual identity.
function drawHUDFrame() {
  const mode = activeMode();
  hud.strokeStyle = mode.hudText;
  hud.lineWidth = 1;
  const cbm = 14; // margin from safe-area edge
  const cbl = 18; // bracket arm length
  // Brackets follow the safe area, sliding inward as the letterbox bars
  // grow so they stay legible above the black strips.
  const barH = cssH * 0.075 * letterboxLevel;
  const top = barH + cbm;
  const bot = cssH - barH - cbm;
  // top-left
  hud.beginPath();
  hud.moveTo(cbm, top + cbl);
  hud.lineTo(cbm, top);
  hud.lineTo(cbm + cbl, top);
  hud.stroke();
  // top-right
  hud.beginPath();
  hud.moveTo(cssW - cbm - cbl, top);
  hud.lineTo(cssW - cbm, top);
  hud.lineTo(cssW - cbm, top + cbl);
  hud.stroke();
  // bottom-left
  hud.beginPath();
  hud.moveTo(cbm, bot - cbl);
  hud.lineTo(cbm, bot);
  hud.lineTo(cbm + cbl, bot);
  hud.stroke();
  // bottom-right
  hud.beginPath();
  hud.moveTo(cssW - cbm - cbl, bot);
  hud.lineTo(cssW - cbm, bot);
  hud.lineTo(cssW - cbm, bot - cbl);
  hud.stroke();

  // Registration-mark "+" inside each corner — a sub-tick for that
  // measurement-instrument precision feel.
  const reg = 6;
  const regOffset = cbl + 8;
  const drawReg = (x: number, y: number) => {
    hud.beginPath();
    hud.moveTo(x - reg / 2, y);
    hud.lineTo(x + reg / 2, y);
    hud.moveTo(x, y - reg / 2);
    hud.lineTo(x, y + reg / 2);
    hud.stroke();
  };
  hud.lineWidth = 0.6;
  drawReg(cbm + regOffset, top + regOffset);
  drawReg(cssW - cbm - regOffset, top + regOffset);
  drawReg(cbm + regOffset, bot - regOffset);
  drawReg(cssW - cbm - regOffset, bot - regOffset);

  // Bottom-left metadata stack — 3 lines, slight visual hierarchy. The
  // first row sits on the same baseline as the corner bracket arm so it
  // reads as part of the bracket grid; the next two lines are progressively
  // dimmer for an editorial weight contrast.
  hud.textAlign = "left";
  hud.textBaseline = "alphabetic";
  const metaX = HUD_MARGIN + 8;
  hud.font = `700 ${HUD_FONT}`;
  hud.fillStyle = mode.hudText;
  hud.fillText("SESSION 2026.05", metaX, bot - 30);
  hud.font = HUD_FONT;
  hud.fillText("POLYHEDRA SERIES", metaX, bot - 18);
  hud.fillStyle = mode.hudText.replace(/[\d.]+\)$/, "0.4)");
  hud.fillText(
    `SN—2026.05 · POLY—${String(currentShapeIdx + 1).padStart(2, "0")} · Φ 1.618`,
    metaX,
    bot - 6,
  );
}

// Cinematic letterbox bars — fade in when a feature shape (tetra, gstella)
// is current, fade out otherwise. The level is smoothed in the main loop so
// the bars sweep in/out softly rather than snapping.
function drawLetterbox() {
  if (letterboxLevel < 0.01) return;
  const barH = cssH * 0.075 * letterboxLevel;
  hud.fillStyle = `rgba(0, 0, 0, ${0.78 * letterboxLevel})`;
  hud.fillRect(0, 0, cssW, barH);
  hud.fillRect(0, cssH - barH, cssW, barH);

  // Inner cyan rule lines — a thin "frame inside the frame" that lifts the
  // bars from pure black plates to a designed letterbox.
  hud.strokeStyle = `rgba(58, 254, 255, ${0.55 * letterboxLevel})`;
  hud.lineWidth = 0.8;
  hud.beginPath();
  hud.moveTo(0, barH - 3);
  hud.lineTo(cssW, barH - 3);
  hud.moveTo(0, cssH - barH + 3);
  hud.lineTo(cssW, cssH - barH + 3);
  hud.stroke();

  // Faint scanlines inside the bars for CRT/film texture.
  hud.strokeStyle = `rgba(58, 254, 255, ${0.08 * letterboxLevel})`;
  hud.lineWidth = 0.5;
  for (let y = 4; y < barH - 6; y += 4) {
    hud.beginPath();
    hud.moveTo(0, y);
    hud.lineTo(cssW, y);
    hud.stroke();
    const y2 = cssH - barH + 5 + (y - 4);
    if (y2 < cssH - 2) {
      hud.beginPath();
      hud.moveTo(0, y2);
      hud.lineTo(cssW, y2);
      hud.stroke();
    }
  }

  // Centred title in the bottom bar once it's tall enough to fit text.
  if (letterboxLevel > 0.5 && barH > 22) {
    hud.fillStyle = `rgba(191, 245, 255, ${0.75 * letterboxLevel})`;
    hud.font = `11px ${SWIPE_FONT}`;
    hud.textAlign = "center";
    hud.textBaseline = "middle";
    hud.fillText(
      "POLYHEDRA · 2026.05 · SESSION",
      cssW / 2,
      cssH - barH / 2,
    );
  }
}

function drawHUDText() {
  const mode = activeMode();
  const textColor = mode.hudText;
  const accentColor = mode.hudAccent;
  const shape = SHAPES[currentShapeIdx];
  // Letterbox safe-area offsets — every top-anchored coordinate slides down
  // and every bottom-anchored one slides up so the bars never cover text.
  const barH = cssH * 0.075 * letterboxLevel;
  const topY = HUD_MARGIN + barH;

  hud.textAlign = "left";
  hud.textBaseline = "top";
  hud.font = HUD_FONT;
  hud.fillStyle = textColor;
  const idx = String(currentShapeIdx + 1).padStart(2, "0");
  const total = String(SHAPES.length).padStart(2, "0");
  hud.fillText(`${idx} / ${total}`, HUD_MARGIN, topY);

  hud.font = RUNIC_NAME_FONT;
  hud.fillStyle = accentColor;
  hud.fillText(shape.name.toUpperCase(), HUD_MARGIN, topY + 18);

  hud.font = HUD_FONT;
  hud.fillStyle = textColor;
  hud.fillText("polyhedra · studio", HUD_MARGIN, topY + 48);

  // ---- Top-right: oscilloscope (when audio active), then BEAT + BPM ----
  if (audioActive) {
    drawWaveform(
      cssW - HUD_MARGIN - WAVEFORM_W,
      topY,
      textColor,
      accentColor,
    );
  }
  const readoutY = audioActive ? topY + WAVEFORM_H + WAVEFORM_GAP : topY;

  hud.textAlign = "right";
  hud.font = HUD_FONT;
  hud.fillStyle = textColor;
  hud.fillText(
    `BEAT ${String(kickCount).padStart(3, "0")}`,
    cssW - HUD_MARGIN,
    readoutY,
  );
  // Prefer the tap-locked BPM when set; fall back to auto-detected.
  const displayBpm = lockedBpm > 0 ? lockedBpm : audioActive ? bpm : 0;
  if (displayBpm > 0) {
    hud.fillStyle = accentColor;
    const prefix = lockedBpm > 0 ? "TAP" : "~";
    hud.fillText(
      `${prefix}${lockedBpm > 0 ? " " : ""}${displayBpm} BPM`,
      cssW - HUD_MARGIN,
      readoutY + 16,
    );
  }
  // Continuous session timer — independent of audio state, ticks from page
  // load. Reads like a broadcast / capture indicator.
  hud.fillStyle = textColor;
  hud.fillText(
    formatElapsed(performance.now() - sessionStartMs),
    cssW - HUD_MARGIN,
    readoutY + (displayBpm > 0 ? 32 : 16),
  );
  if (audioActive) {
    hud.fillStyle = textColor;
    hud.fillText(
      "● live",
      cssW - HUD_MARGIN,
      cssH - HUD_MARGIN - barH - 12,
    );
  }
  hud.textAlign = "left";
}

// Time-domain oscilloscope drawn into the supplied top-left anchored
// rectangle on the HUD canvas. Muted colour for the centre rail, accent
// for the trace.
function drawWaveform(
  x: number,
  y: number,
  _baselineColor: string,
  traceColor: string,
) {
  if (!analyser) return;
  analyser.getByteTimeDomainData(timeBuf);
  const cy = y + WAVEFORM_H / 2;

  hud.strokeStyle = traceColor;
  hud.lineWidth = 1.2;
  hud.lineJoin = "round";
  hud.lineCap = "round";
  hud.beginPath();
  const N = timeBuf.length;
  // Auto-gain — iOS Safari often returns a near-flat time-domain buffer for
  // getUserMedia streams. Scale the trace by the buffer's peak so quiet
  // signals are visible, capped at 6x to avoid runaway noise amplification.
  let peak = 1;
  for (let i = 0; i < N; i += 4) {
    const a = Math.abs(timeBuf[i] - 128);
    if (a > peak) peak = a;
  }
  const ampScale = Math.min(40, 240 / peak);
  const maxOffset = WAVEFORM_H * 0.48;
  for (let i = 0; i < WAVEFORM_W; i++) {
    const sampleIdx = Math.floor((i / WAVEFORM_W) * N);
    const v = ((timeBuf[sampleIdx] - 128) / 128) * ampScale;
    // Soft-clip with tanh so peaks taper instead of flatlining at the rail
    // (the flat rail was rendering as an underline at high gain).
    const offset = Math.tanh(v) * maxOffset;
    const py = cy + offset;
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
  if (shapeSwapStyle === "waves") drawWavesSwipe();
  else if (shapeSwapStyle === "synapse") drawSynapseSwipe();
  else drawBandSwipe();
}

// Rotated band that slides across the screen, revealing the shape name as
// it passes the centre. Eight directions × inertia easing.
function drawBandSwipe() {
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

  // Technical-drawing grid — thin dark lines on the pink fill, every 40px.
  hud.strokeStyle = `rgba(${swipeFg.r}, ${swipeFg.g}, ${swipeFg.b}, 0.18)`;
  hud.lineWidth = 0.5;
  const gridStep = 40;
  for (let gx = 0; gx <= cssW; gx += gridStep) {
    hud.beginPath();
    hud.moveTo(gx, 0);
    hud.lineTo(gx, cssH);
    hud.stroke();
  }
  for (let gy = 0; gy <= cssH; gy += gridStep) {
    hud.beginPath();
    hud.moveTo(0, gy);
    hud.lineTo(cssW, gy);
    hud.stroke();
  }

  // Huge index number sized to bleed past both screen edges — the digits
  // frame the centred shape name like a magazine spread.
  const idxStr = String(currentShapeIdx + 1).padStart(2, "0");
  const REF = 100;
  hud.font = `${REF}px ${SWIPE_FONT}`;
  const refW = hud.measureText(idxStr).width || 1;
  const fitW = (REF * cssW * 1.3) / refW;
  const fitH = cssH * 0.95;
  const bigFontSize = Math.min(fitW, fitH) | 0;
  hud.font = `${bigFontSize}px ${SWIPE_FONT}`;
  hud.fillStyle = `rgba(${swipeFg.r}, ${swipeFg.g}, ${swipeFg.b}, 0.2)`;
  hud.textAlign = "center";
  hud.textBaseline = "middle";
  hud.fillText(idxStr, cssW / 2, cssH / 2);

  drawSwipeName(`rgb(${swipeFg.r}, ${swipeFg.g}, ${swipeFg.b})`);
  hud.restore();
}

// Same sliding band mechanism as the band swipe, but the band's interior is
// painted with stacked sine waves that merge into a single bold wave as the
// band crosses the screen centre. The band entering and leaving the canvas
// naturally fades the whole effect in and out — no explicit alpha ramp.
function drawWavesSwipe() {
  const t = 1 - shapeSwapTimer / SHAPE_SWAP_FRAMES;
  const p = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  // Wave merge — slow rise to the peak then quick spread back out so the
  // waves visibly disperse again before the band exits. Peak at p ≈ 0.7;
  // before that the waves slide together, after that they spread apart.
  const MERGE_PEAK = 0.7;
  const merge =
    p < MERGE_PEAK
      ? p / MERGE_PEAK
      : Math.max(0, 1 - (p - MERGE_PEAK) / (1 - MERGE_PEAK));

  const angle = SWIPE_ANGLES[shapeSwapDirection];
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const diag = Math.hypot(cssW, cssH);
  const bandSize = diag * 4;
  const travelHalf = diag * 2;
  const offset = -travelHalf + p * 2 * travelHalf;
  const bandCx = cssW / 2 + dx * offset;
  const bandCy = cssH / 2 + dy * offset;

  hud.save();
  hud.translate(bandCx, bandCy);
  hud.rotate(angle);
  hud.beginPath();
  hud.rect(-bandSize / 2, -bandSize / 2, bandSize, bandSize);
  hud.clip();
  hud.setTransform(dpr, 0, 0, dpr, 0, 0);

  hud.fillStyle = "#000";
  hud.fillRect(0, 0, cssW, cssH);

  // Madeon-style cyan vertical gradient shared by the waves and the shape
  // name — pale top, hot cyan mid, deep teal bottom. Spans the screen
  // height so each row of waves picks up a different colour band.
  const cyanGrad = hud.createLinearGradient(0, 0, 0, cssH);
  cyanGrad.addColorStop(0, "#bff5ff");
  cyanGrad.addColorStop(0.5, "#3afeff");
  cyanGrad.addColorStop(1, "#0e7c8c");

  const N = 7;
  const ROWS = 6;
  // Wave amplitude stays constant throughout the transition — only the
  // per-wave phase offsets animate (spread → align → spread), so the waves
  // visibly slide together and apart at fixed height.
  const amp = 48;

  // Oscilloscope reference grid — very dim cyan dotted lines, drawn under
  // the waves to suggest a measurement screen.
  hud.strokeStyle = "rgba(58, 254, 255, 0.12)";
  hud.lineWidth = 0.5;
  hud.setLineDash([2, 4]);
  for (let v = 1; v < 8; v++) {
    const x = (v / 8) * cssW;
    hud.beginPath();
    hud.moveTo(x, 0);
    hud.lineTo(x, cssH);
    hud.stroke();
  }
  for (let h = 1; h < ROWS * 3; h++) {
    const y = (h / (ROWS * 3)) * cssH;
    hud.beginPath();
    hud.moveTo(0, y);
    hud.lineTo(cssW, y);
    hud.stroke();
  }
  hud.setLineDash([]);

  hud.lineWidth = 1.4 + merge * 3;
  hud.strokeStyle = cyanGrad;
  // merge-driven alpha applied via globalAlpha so the gradient stops keep
  // their pure colours.
  hud.globalAlpha = 0.6 + merge * 0.4;
  // Each row hosts its own merging wave group at its own vertical centre.
  // Per-row phase offset keeps adjacent rows visually distinct rather than
  // perfect copies. Per-wave (inside the row) phase decays to zero so the
  // row's curves slide together as merge → 1.
  const freq = 0.025;
  const tickSpacing = 60;
  for (let r = 0; r < ROWS; r++) {
    const rowY = ((r + 1) / (ROWS + 1)) * cssH;
    for (let i = 0; i < N; i++) {
      const phase =
        t * 4.8 + r * 0.5 + (i - (N - 1) / 2) * 1.0 * (1 - merge);
      hud.beginPath();
      for (let x = 0; x <= cssW; x += 4) {
        const y = rowY + Math.sin(x * freq + phase) * amp;
        if (x === 0) hud.moveTo(x, y);
        else hud.lineTo(x, y);
      }
      hud.stroke();
    }
    // Tick marks crossing the centre wave of each row — small vertical
    // segments at fixed x positions for a measurement-grid feel.
    const centrePhase = t * 4.8 + r * 0.5;
    hud.lineWidth = 0.5;
    for (let x = tickSpacing / 2; x < cssW; x += tickSpacing) {
      const y = rowY + Math.sin(x * freq + centrePhase) * amp;
      hud.beginPath();
      hud.moveTo(x, y - 3);
      hud.lineTo(x, y + 3);
      hud.stroke();
    }
    hud.lineWidth = 1.4 + merge * 3;
  }
  hud.globalAlpha = 1;

  // Channel labels at the left edge — CH 01, CH 02, ...
  hud.fillStyle = "rgba(58, 254, 255, 0.45)";
  hud.font = `9px ${SWIPE_FONT}`;
  hud.textAlign = "left";
  hud.textBaseline = "middle";
  for (let r = 0; r < ROWS; r++) {
    const rowY = ((r + 1) / (ROWS + 1)) * cssH;
    hud.fillText(`CH ${String(r + 1).padStart(2, "0")}`, 12, rowY);
  }

  drawSwipeName(cyanGrad);
  hud.restore();
}

// Synapse-style transition — multiple rows of horizontal "wires" with
// labelled shape-name nodes. The centre node opens at mid-transition,
// halves slide apart with cyan glow between them, revealing the new shape
// name. Locked to vertical band travel so the wires read horizontally.
function drawSynapseSwipe() {
  const t = 1 - shapeSwapTimer / SHAPE_SWAP_FRAMES;
  const p = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  // Band slide (same mechanism as drawBandSwipe / drawWavesSwipe).
  const angle = SWIPE_ANGLES[shapeSwapDirection];
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const diag = Math.hypot(cssW, cssH);
  const bandSize = diag * 4;
  const travelHalf = diag * 2;
  const offset = -travelHalf + p * 2 * travelHalf;
  const bandCx = cssW / 2 + dx * offset;
  const bandCy = cssH / 2 + dy * offset;

  hud.save();
  hud.translate(bandCx, bandCy);
  hud.rotate(angle);
  hud.beginPath();
  hud.rect(-bandSize / 2, -bandSize / 2, bandSize, bandSize);
  hud.clip();
  hud.setTransform(dpr, 0, 0, dpr, 0, 0);

  hud.fillStyle = "#000";
  hud.fillRect(0, 0, cssW, cssH);

  if (synapseNetwork.length === 0) {
    hud.restore();
    return;
  }

  // Target row + column are picked at swap time (see generateSynapseNetwork).
  const targetRow = synapseTargetRow;
  const targetCol = synapseTargetCol;

  // Node geometry — width scales down on narrow screens so 4 nodes fit
  // without clipping at the edges.
  const NODE_W = Math.min(120, cssW * 0.2);
  const NODE_HALF = NODE_W / 2;
  const NODE_H = 28;

  const wireColor = "rgba(58, 254, 255, 0.35)";
  const boxStroke = "rgba(58, 254, 255, 0.7)";
  const textColor = "#bff5ff";
  const nodeFont = `12px ${SWIPE_FONT}`;

  // The network starts fully fragmented — every node has a gap, signalling
  // "disconnected". The target node closes (gap → 0) over p = 0.4 → 0.7,
  // becoming the single synapse that completes the circuit.
  const DEFAULT_GAP = 22;
  const closeAmount = Math.max(0, Math.min(1, (p - 0.4) / 0.3));

  // Large background name for the connecting shape — sits behind the
  // synapse network and fades in alongside `closeAmount` so it's easy to
  // read which synapse just fired. Uses the standard cyan gradient at
  // closeAmount-driven alpha so it reaches full intensity by lock-in.
  if (closeAmount > 0.05) {
    const a = closeAmount;
    const bgGrad = hud.createLinearGradient(0, 0, 0, cssH);
    bgGrad.addColorStop(0, `rgba(191, 245, 255, ${a})`);
    bgGrad.addColorStop(0.5, `rgba(58, 254, 255, ${a})`);
    bgGrad.addColorStop(1, `rgba(14, 124, 140, ${a})`);
    drawSwipeName(bgGrad);
  }

  // Time-based phase for moving pulses on the wires — independent of the
  // swipe progress so the dots glide at a constant velocity regardless of t.
  const pulseClock = performance.now() / 1000;
  const PULSE_SPEED = 180; // px/sec
  const PULSES_PER_ROW = 3;

  for (let r = 0; r < SYNAPSE_ROWS; r++) {
    const rowY = (r + 0.5) * (cssH / SYNAPSE_ROWS);
    const row = synapseNetwork[r];

    // Dashed wire across the full row width.
    hud.strokeStyle = wireColor;
    hud.lineWidth = 1;
    hud.setLineDash([8, 5]);
    hud.beginPath();
    hud.moveTo(0, rowY);
    hud.lineTo(cssW, rowY);
    hud.stroke();
    hud.setLineDash([]);

    // Pulse dots travelling along the wire — alternating direction per row
    // so the network reads as bi-directional firing.
    const dir = r % 2 === 0 ? 1 : -1;
    for (let pi = 0; pi < PULSES_PER_ROW; pi++) {
      const phase = (pi / PULSES_PER_ROW) * cssW;
      let px = (phase + dir * pulseClock * PULSE_SPEED) % cssW;
      if (px < 0) px += cssW;
      hud.fillStyle = "rgba(58, 254, 255, 0.85)";
      hud.beginPath();
      hud.arc(px, rowY, 1.6, 0, Math.PI * 2);
      hud.fill();
    }

    for (let i = 0; i < row.length; i++) {
      const cx = (i + 0.5) * (cssW / row.length);
      const isTarget = r === targetRow && i === targetCol;
      const shapeIdx = isTarget ? currentShapeIdx : row[i];
      const name = SHAPES[shapeIdx].name.toUpperCase();
      const idLabel = String(shapeIdx + 1).padStart(2, "0");
      const gap = isTarget ? DEFAULT_GAP * (1 - closeAmount) : DEFAULT_GAP;

      // Burst halo behind the target node as it locks in (final 15%).
      if (isTarget && closeAmount > 0.85) {
        const ba = (closeAmount - 0.85) / 0.15;
        const br = NODE_W * (0.6 + ba * 1.4);
        const burst = hud.createRadialGradient(
          cx, rowY, NODE_W * 0.4,
          cx, rowY, br,
        );
        burst.addColorStop(0, `rgba(58, 254, 255, ${0.5 * ba})`);
        burst.addColorStop(1, "rgba(58, 254, 255, 0)");
        hud.fillStyle = burst;
        hud.fillRect(cx - br, rowY - br, br * 2, br * 2);
      }

      // Two rounded half-boxes; outer corners rounded, inner corners square
      // so the two halves visually fuse when the gap closes.
      const leftX = cx - NODE_HALF - gap / 2;
      const rightX = cx + gap / 2;
      const RADII_L: [number, number, number, number] = [5, 0, 0, 5];
      const RADII_R: [number, number, number, number] = [0, 5, 5, 0];
      hud.fillStyle = "rgba(0, 0, 0, 0.85)";
      hud.beginPath();
      hud.roundRect(leftX, rowY - NODE_H / 2, NODE_HALF, NODE_H, RADII_L);
      hud.fill();
      hud.beginPath();
      hud.roundRect(rightX, rowY - NODE_H / 2, NODE_HALF, NODE_H, RADII_R);
      hud.fill();

      // Target's outline brightens + thickens as it closes; others stay dim.
      hud.strokeStyle = isTarget
        ? `rgba(58, 254, 255, ${0.55 + closeAmount * 0.45})`
        : boxStroke;
      hud.lineWidth = isTarget ? 1.2 + closeAmount * 0.8 : 1;
      hud.beginPath();
      hud.roundRect(leftX, rowY - NODE_H / 2, NODE_HALF, NODE_H, RADII_L);
      hud.stroke();
      hud.beginPath();
      hud.roundRect(rightX, rowY - NODE_H / 2, NODE_HALF, NODE_H, RADII_R);
      hud.stroke();

      // Cyan glow inside the closing gap — peaks while shrinking, vanishes
      // when fully closed (no gap left to fill).
      if (isTarget && gap > 1 && closeAmount > 0.05) {
        const grad = hud.createLinearGradient(
          cx - gap / 2,
          rowY,
          cx + gap / 2,
          rowY,
        );
        grad.addColorStop(0, "rgba(58, 254, 255, 0)");
        grad.addColorStop(0.5, `rgba(58, 254, 255, ${0.85 * closeAmount})`);
        grad.addColorStop(1, "rgba(58, 254, 255, 0)");
        hud.fillStyle = grad;
        hud.fillRect(cx - gap / 2, rowY - NODE_H / 2, gap, NODE_H);
      }

      // Status indicator — open circle for disconnected, filled (per
      // closeAmount) for the target as it connects.
      const dotR = 2.5;
      const dotX = leftX - 8;
      const dotY = rowY;
      hud.strokeStyle = "rgba(58, 254, 255, 0.7)";
      hud.lineWidth = 0.9;
      hud.beginPath();
      hud.arc(dotX, dotY, dotR, 0, Math.PI * 2);
      hud.stroke();
      if (isTarget && closeAmount > 0.05) {
        hud.fillStyle = `rgba(58, 254, 255, ${closeAmount})`;
        hud.beginPath();
        hud.arc(dotX, dotY, dotR, 0, Math.PI * 2);
        hud.fill();
      }

      // Split the name — left half ends at the inner edge of the left box,
      // right half starts at the inner edge of the right box.
      const split = Math.ceil(name.length / 2);
      const leftText = name.slice(0, split);
      const rightText = name.slice(split);

      hud.font = nodeFont;
      hud.textBaseline = "middle";
      hud.fillStyle = isTarget
        ? `rgba(58, 254, 255, ${0.7 + closeAmount * 0.3})`
        : textColor;
      hud.textAlign = "right";
      hud.fillText(leftText, cx - gap / 2 - 2, rowY);
      hud.textAlign = "left";
      hud.fillText(rightText, cx + gap / 2 + 2, rowY);

      // ID caption below the node.
      hud.font = `8px ${SWIPE_FONT}`;
      hud.fillStyle = isTarget
        ? "rgba(58, 254, 255, 0.85)"
        : "rgba(58, 254, 255, 0.45)";
      hud.textAlign = "center";
      hud.textBaseline = "top";
      hud.fillText(idLabel, cx, rowY + NODE_H / 2 + 3);
    }
  }

  hud.restore();
}

// Shared text layout for whichever swipe style is active. Picks a font size
// that fits the widest line into ~95% width and the total stack into ~85%
// height, then renders each line stacked around screen centre.
function drawSwipeName(fillStyle: string | CanvasGradient) {
  const lines = swipeNameLines(SHAPES[currentShapeIdx].name);
  hud.textAlign = "center";
  hud.textBaseline = "middle";
  const REF = 100;
  hud.font = `${REF}px ${SWIPE_FONT}`;
  let refWidth = 1;
  for (const line of lines) {
    const w = hud.measureText(line).width;
    if (w > refWidth) refWidth = w;
  }
  const LINE_SPACING = 1.05;
  const fitWidth = ((cssW * 0.95) / refWidth) * REF;
  const fitHeight = (cssH * 0.85) / (lines.length * LINE_SPACING);
  const fontSize = Math.min(fitWidth, fitHeight) | 0;
  hud.font = `${fontSize}px ${SWIPE_FONT}`;
  hud.fillStyle = fillStyle;
  const lineH = fontSize * LINE_SPACING;
  const startY = cssH / 2 - ((lines.length - 1) * lineH) / 2;
  for (let i = 0; i < lines.length; i++) {
    hud.fillText(lines[i], cssW / 2, startY + i * lineH);
  }
}

// Long-form names for the swipe banner — return one entry per line. Short
// shape names just pass through as a single uppercase line.
function swipeNameLines(name: string): string[] {
  if (name === "gstella") return ["GREAT STELLATED", "DODECAHEDRON"];
  return [name.toUpperCase()];
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
// Onset detection — pull kick/drop/snare events out of the bass/mid
// envelopes, advance kickCount + BPM tracking, and let kick-driven swaps
// fire when no tap-lock is active.
function detectAudioOnsets() {
  if (!audioActive) return;
  bassPeak = Math.max(envBass * 1.02, bassPeak * 0.985 + envBass * 0.015);
  midPeak = Math.max(envMid * 1.02, midPeak * 0.97 + envMid * 0.03);
  if (
    dropTimer === 0 &&
    envBass > DROP_THRESHOLD &&
    envBass / Math.max(0.15, bassPeak) > DROP_OVERSHOOT
  ) {
    triggerDrop();
  }
  if (
    flashTimer === 0 &&
    envMid > SNARE_THRESHOLD &&
    envMid / Math.max(0.12, midPeak) > SNARE_OVERSHOOT
  ) {
    flashTimer = FLASH_FRAMES;
    flashIntensity = envMid;
  }
  const bassRise = envBass - prevEnvBass;
  prevEnvBass = envBass;
  if (
    kickCooldown === 0 &&
    envBass > KICK_THRESHOLD &&
    bassRise > KICK_RISE
  ) {
    kickCooldown = KICK_COOLDOWN_FRAMES;
    kickCount++;
    // When tap-locked, the beat grid drives shape swaps instead of kicks.
    if (lockedBpm === 0 && kickCount % KICKS_PER_SHAPE_SWAP === 0) {
      swapShape();
    }
    if (
      kickCount % KICKS_PER_INVERT_ROLL === 0 &&
      Math.random() < INVERT_FLIP_CHANCE
    ) {
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
      for (let i = 1; i < kickTimes.length; i++)
        total += kickTimes[i] - kickTimes[i - 1];
      bpm = Math.round(60000 / (total / (kickTimes.length - 1)));
    }
  }
  if (kickCooldown > 0) kickCooldown--;
}

// Animate the stella ring inward each frame so the 12 instances converge
// at the centre over STELLA_MORPH_FRAMES and the rotation offsets decay so
// they all align. When the timer expires we flip to single-mesh mode.
function advanceStellaMorph() {
  if (
    stellaMorphTimer <= 0 ||
    proliferateCount !== STELLA_CIRCLE_COUNT ||
    SHAPES[currentShapeIdx].name !== STELLA_SHAPE_NAME
  ) {
    return;
  }
  const t = 1 - stellaMorphTimer / STELLA_MORPH_FRAMES;
  const eased = t * t * (3 - 2 * t);
  const cx = cssW / 2;
  const cy = cssH / 2;
  const radius = (1 - eased) * Math.min(cssW, cssH) * 0.32;
  const scale =
    STELLA_CIRCLE_SCALE + eased * (STELLA_MERGE_SCALE - STELLA_CIRCLE_SCALE);
  const offSmooth = 1 - eased;
  for (let i = 0; i < STELLA_CIRCLE_COUNT; i++) {
    const angle = (i / STELLA_CIRCLE_COUNT) * Math.PI * 2 - Math.PI / 2;
    const inst = heroInstances[i];
    inst.x = cx + Math.cos(angle) * radius;
    inst.y = cy + Math.sin(angle) * radius;
    inst.scale = scale;
    inst.rotOffX = angle * 0.7 * offSmooth;
    inst.rotOffY = angle * 1.3 * offSmooth;
  }
  stellaMorphTimer--;
  if (stellaMorphTimer === 0) proliferateCount = 1;
}

// Mirror of advanceStellaMorph for dodeca — the 12 instances start stacked
// at the centre and disperse outward to a ring, shrinking from MERGE_SCALE
// to CIRCLE_SCALE and growing per-instance rotation offsets so each spins
// to its own angle. proliferateCount stays at 12 when the timer expires.
function advanceDodecaBurst() {
  if (
    dodecaMorphTimer <= 0 ||
    proliferateCount !== STELLA_CIRCLE_COUNT ||
    SHAPES[currentShapeIdx].name !== DODECA_SHAPE_NAME
  ) {
    return;
  }
  const t = 1 - dodecaMorphTimer / STELLA_MORPH_FRAMES;
  const eased = t * t * (3 - 2 * t);
  const cx = cssW / 2;
  const cy = cssH / 2;
  const radius = eased * Math.min(cssW, cssH) * 0.32;
  const scale =
    STELLA_MERGE_SCALE + eased * (STELLA_CIRCLE_SCALE - STELLA_MERGE_SCALE);
  for (let i = 0; i < STELLA_CIRCLE_COUNT; i++) {
    const angle = (i / STELLA_CIRCLE_COUNT) * Math.PI * 2 - Math.PI / 2;
    const inst = heroInstances[i];
    inst.x = cx + Math.cos(angle) * radius;
    inst.y = cy + Math.sin(angle) * radius;
    inst.scale = scale;
    inst.rotOffX = angle * 0.7 * eased;
    inst.rotOffY = angle * 1.3 * eased;
  }
  dodecaMorphTimer--;
}

// Hero rendering — rotation accumulation, size, position, and the swarm /
// single-mesh dispatch. Also drives the tetra rune backdrop visibility and
// the stella ring → centre morph.
function renderHero(mode: BgPaletteSet) {
  const shapeName = SHAPES[currentShapeIdx].name;
  const isTetra = shapeName === TETRA_SHAPE_NAME;
  const isStella = shapeName === STELLA_SHAPE_NAME;

  tetraRuneMesh.visible = isTetra && tetraRuneReady;
  if (tetraRuneMesh.visible) {
    tetraRuneUniforms.uColor.value.set(mode.edgeHex);
    tetraRuneUniforms.uTime.value = performance.now();
  }

  // Ramiel transformation — while octa is current, octaMorphTimer wraps
  // continuously so the deploy/fold cosine cycle plays on repeat. Every
  // non-pyramid part has restScale=0, so the rig collapses cleanly to a
  // single octahedron silhouette at the resting endpoints of each cycle.
  const isOcta = shapeName === OCTA_SHAPE_NAME;
  if (isOcta) {
    octaMorphTimer = (octaMorphTimer + 1) % OCTA_MORPH_FRAMES;
    updateRamielPose();
  }
  ramielGroup.visible = isOcta;

  advanceStellaMorph();
  advanceDodecaBurst();

  // Per-shape spin profile during the swarm/ring phase; default once stella
  // has merged into a single big mesh.
  const spin =
    isStella && proliferateCount === 1
      ? DEFAULT_SPIN
      : (SPIN_PROFILES[shapeName] ?? DEFAULT_SPIN);
  shapeRotX += spin.baseX + Math.pow(envBass, SHAPE_SPIN_EXP) * spin.bassMultX;
  shapeRotY += spin.baseY + Math.pow(envMid, SHAPE_SPIN_EXP) * spin.midMultY;
  const pop = dropTimer > 0 ? 1 + (dropTimer / DROP_FRAMES) * 0.45 : 1;
  // swapPop kept modest so swap-time growth doesn't spike bloom contribution.
  const swapPop =
    shapeSwapTimer > 0
      ? 1 + Math.pow(shapeSwapTimer / SHAPE_SWAP_FRAMES, 0.7) * 0.22
      : 1;
  // On mobile the canvas is narrow, so the base ratio is lifted to fill more
  // of the screen and to make bass/bounce reactions read on smaller silhouettes.
  const heroBase = IS_MOBILE ? 0.14 : 0.085;
  const heroAudioMult =
    1 + Math.pow(envBass, 1.5) * 0.35 + bounceScale * 0.5;
  const heroSize =
    Math.min(cssW, cssH) * heroBase * heroAudioMult * pop * swapPop;

  if (proliferateCount > 1) {
    // ---- Swarm mode: render every clone via InstancedMesh ----
    heroGroup.visible = false;
    instancedHero.visible = true;
    instancedHero.count = proliferateCount;
    for (let i = 0; i < proliferateCount; i++) {
      const inst = heroInstances[i];
      _instEuler.set(shapeRotX + inst.rotOffX, shapeRotY + inst.rotOffY, 0);
      _instQuat.setFromEuler(_instEuler);
      _instPos.set(toWorldX(inst.x), toWorldY(inst.y), 0);
      const s = heroSize * inst.scale;
      _instScale.set(s, s, s);
      _instM4.compose(_instPos, _instQuat, _instScale);
      instancedHero.setMatrixAt(i, _instM4);
    }
    instancedHero.instanceMatrix.needsUpdate = true;
    return;
  }

  // ---- Single mode: hero mesh + edges with bounce + focal ----
  instancedHero.visible = false;
  heroGroup.rotation.x = shapeRotX;
  heroGroup.rotation.y = shapeRotY;
  const px = isStella ? 0 : toWorldX(focalX);
  const py = isStella
    ? toWorldY(cssH / 2 + bouncePosY)
    : toWorldY(focalY + bouncePosY);
  heroGroup.position.set(px, py, 0);
  // Octa is rendered exclusively via the Ramiel rig — its two pyramid halves
  // form the octahedron silhouette at rest, so heroGroup stays hidden the
  // entire time octa is current and the rig drives all the motion.
  if (isOcta) {
    heroGroup.visible = false;
    ramielGroup.position.set(px, py, 0);
    ramielGroup.scale.setScalar(heroSize);
  } else {
    heroGroup.visible = true;
    heroGroup.scale.setScalar(heroSize);
  }
}

// Confetti physics + buffer write — one entry per live particle, oldest
// first so splice removals don't shuffle indices being read.
function updateParticleBuffers() {
  let pCount = 0;
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.age++;
    if (p.age >= p.life) {
      particles.splice(i, 1);
      continue;
    }
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.1;
    p.vx *= 0.985;
    p.vy *= 0.99;
    const lifeT = p.age / p.life;
    const alpha = 1 - lifeT;
    const size = p.size * (1 - lifeT * 0.3);
    const o3 = pCount * 3;
    ptsPositions[o3] = toWorldX(p.x);
    ptsPositions[o3 + 1] = toWorldY(p.y);
    ptsPositions[o3 + 2] = 20;
    ptsColors[o3] = p.color[0] * alpha;
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
}

// Shockwaves → expanding rings. Each wave emits N_RING points per frame at
// its current radius; the whole ring fades + spins as the wave ages out.
function updateShockwaveBuffers(mode: BgPaletteSet) {
  let swPointCount = 0;
  const swColor = mode.shockwaveColor;
  const farX = Math.max(focalX, cssW - focalX);
  const farY = Math.max(focalY, cssH - focalY);
  const outerR = Math.hypot(farX, farY) + 40;
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const sw = shockwaves[i];
    sw.age++;
    const lifetime = 75;
    if (sw.age >= lifetime) {
      shockwaves.splice(i, 1);
      continue;
    }
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
      swPositions[o3] = toWorldX(x);
      swPositions[o3 + 1] = toWorldY(y);
      swPositions[o3 + 2] = 10;
      swColors[o3] = swColor[0] * alpha;
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
}

// Post-processing uniform updates — bloom, chromatic aberration baseline,
// and the smoothly-lerped VHS intensity. HDR + tone mapping mean we don't
// need huge linear-domain strengths.
function updatePostFX(mode: BgPaletteSet) {
  bloomPass.strength = mode.bloomStrength + (audioActive ? envBass * 0.35 : 0);
  bloomPass.threshold = mode.bloomThreshold;
  const baselineChroma = 0.2;
  const audioChroma = audioActive ? envBass * 0.85 : 0;
  const dropChroma = dropTimer > 0 ? (dropTimer / DROP_FRAMES) * 1.6 : 0;
  chromaticVignettePass.uniforms.uChroma.value =
    baselineChroma + audioChroma + dropChroma;
  chromaticVignettePass.uniforms.uVignette.value =
    0.7 - (audioActive ? envBass * 0.15 : 0);
  vhsLevel += ((vhsActive ? 1 : 0) - vhsLevel) * 0.12;
  chromaticVignettePass.uniforms.uVhs.value = vhsLevel;
  // Film grain — quiet baseline, lifts ~50% at strong bass so the texture
  // breathes with the music.
  chromaticVignettePass.uniforms.uGrain.value =
    0.038 + (audioActive ? envBass * 0.045 : 0);
  chromaticVignettePass.uniforms.uTime.value = performance.now();
  chromaticVignettePass.uniforms.uResolution.value.set(cssW, cssH);
  // Letterbox bars — fade in for feature shapes only.
  const letterboxTarget = LETTERBOX_SHAPES.has(SHAPES[currentShapeIdx].name)
    ? 1
    : 0;
  letterboxLevel += (letterboxTarget - letterboxLevel) * 0.07;
}

function frame() {
  readAudio();
  // When audio is inactive (never started or just stopped), decay the band
  // envelopes toward zero. readAudio early-returns in this state so they
  // would otherwise stay frozen at their last reading.
  if (!audioActive) {
    envBass *= 0.92;
    envMid *= 0.92;
    envHi *= 0.92;
  }

  // Tap-tempo beat grid — when a BPM is locked, fire a shape swap every
  // TAP_GRID_BEATS beats. Runs independently of audio so the visual stays
  // on-grid even without an input source.
  if (lockedBpm > 0) {
    const beatDur = 60000 / lockedBpm;
    const beatNum = Math.floor((performance.now() - lockedBeatPhase) / beatDur);
    if (beatNum > lockedBeatLastFired) {
      lockedBeatLastFired = beatNum;
      if (beatNum > 0 && beatNum % TAP_GRID_BEATS === 0) swapShape();
    }
  }

  // Focal glide + onset detection.
  focalX += (targetFocalX - focalX) * 0.13;
  focalY += (targetFocalY - focalY) * 0.13;
  detectAudioOnsets();

  // Bounce spring + decay; timer ticks.
  bounceVelY += -bouncePosY * BOUNCE_STIFFNESS - bounceVelY * BOUNCE_DAMPING;
  bouncePosY += bounceVelY;
  bounceScale *= BOUNCE_SCALE_DECAY;
  if (dropTimer > 0) dropTimer--;
  if (shakeTimer > 0) shakeTimer--;
  if (flashTimer > 0) flashTimer--;
  if (shapeSwapTimer > 0) shapeSwapTimer--;

  // Camera shake (applied to camera; HUD draws receive the same offset).
  const shakeT = shakeTimer > 0 ? shakeTimer / SHAKE_FRAMES : 0;
  const sx = shakeT > 0 ? (Math.random() - 0.5) * shakeStrength * shakeT : 0;
  const sy = shakeT > 0 ? (Math.random() - 0.5) * shakeStrength * shakeT : 0;

  // Active palette → scene background + materials + grid uniforms. setRGB
  // defaults to the linear working space, so we explicitly tag the input
  // as sRGB to match the swipe panel painted on the HUD canvas.
  const mode = activeMode();
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

  renderHero(mode);
  updateParticleBuffers();
  updateShockwaveBuffers(mode);
  updatePostFX(mode);

  camera.position.x = sx;
  camera.position.y = -sy;
  composer.render();
  drawHUD(sx, -sy);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
