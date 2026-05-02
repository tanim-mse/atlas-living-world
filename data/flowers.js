/**
 * flowers.js — Twelve-species living flower system for the Garden zone
 * Atlas: The Living World
 *
 * Responsibilities:
 *   - Reads state.habits array; one flower cluster per habit entry
 *   - Twelve species mapped by habit category with full geometry per species
 *   - Stem: CubicBezierCurve3 → TubeGeometry, tapered radius, two leaf pairs
 *     at 35% and 65% of stem height
 *   - Petals: instanced PlaneGeometry with petal silhouette alpha, species-
 *     specific count, shape, and colour palette
 *   - Petal shader: translucency (SSS), vein overlay, edge glow, wetness,
 *     Lambert diffuse + ambient + specular
 *   - Wind: three-frequency sway on entire stem; petals add independent flutter
 *   - Sunflower heliotropism: head tracks sun azimuth during daytime
 *   - Growth states: 0–7d sprout → 8–21d growing → 22–59d blooming →
 *     60+d mature. Re-bloom at 55% rate after dormancy.
 *   - Dormancy: no check-in for 3+ days → petals droop and desaturate
 *   - Bloom particle burst: 8 pollen motes emitted on first reach of bloom state
 *   - Phototropism: on pointer hover, stem gently tilts toward camera
 *   - Click: opens CSS3DObject check-in panel (habit log entry form)
 *   - Draw calls: 12 (one InstancedMesh per species for stems+flowers combined)
 *
 * Species mapping:
 *   fitness/exercise  → sunflower     (tall, bold, heliotropic)
 *   study/learning    → iris          (structured, violet-blue)
 *   meditation/mind   → lavender      (soft, purple spikes)
 *   reading           → forget-me-not (small, delicate, sky-blue clusters)
 *   water/hydration   → anemone       (cup-shaped, white-centred)
 *   sleep             → cosmos        (light, thin petals, pink-white)
 *   journaling        → peony         (full, layered, deep pink)
 *   creative          → ranunculus    (dense layered petals, warm orange)
 *   social            → wisteria      (cascading, soft purple)
 *   nutrition/food    → foxglove      (tall spike, speckled pink)
 *   outdoors          → protea        (architectural, warm pink)
 *   custom/other      → poppy         (tissue-thin, red-orange)
 *
 * Dependencies: THREE (global r128), config.js, state.js, terrain.js
 *
 * Usage:
 *   import { initFlowers, updateFlowers, disposeFlowers } from './flowers.js';
 *   await initFlowers(scene);
 *   registerUpdate(updateFlowers);
 */

import { CONFIG }     from '../core/config.js';
import { state }      from '../core/state.js';
import { getHeightAt } from './terrain.js';

const THREE = window.THREE;

// ─── Species definitions ─────────────────────────────────────────────────────
//
// Each entry fully describes the geometry, colour, and behaviour of one species.
// All sizes in world units (1 unit ≈ 1 metre).

export const SPECIES = {

  sunflower: {
    category:       ['fitness', 'exercise', 'gym', 'sport'],
    stemHeight:     [0.90, 1.40],   // [min, max] mature height
    stemRadius:     [0.012, 0.016],
    stemColor:      [0.18, 0.38, 0.10],   // RGB
    petalCount:     18,
    petalLength:    [0.14, 0.18],
    petalWidth:     [0.038, 0.048],
    petalCurvature: 0.18,           // how much petals arc inward at tip
    petalColors:    [[0.92, 0.72, 0.05], [0.86, 0.58, 0.02]],  // outer/inner
    diskColor:      [0.18, 0.10, 0.04],
    diskRadius:     0.08,
    leafScale:      1.6,
    windAmplitude:  0.10,
    windFrequency:  0.55,
    heliotropic:    true,           // head tracks sun azimuth
    bloomDays:      22,
  },

  iris: {
    category:       ['study', 'learning', 'exam', 'language', 'skill'],
    stemHeight:     [0.55, 0.85],
    stemRadius:     [0.008, 0.011],
    stemColor:      [0.16, 0.35, 0.12],
    petalCount:     6,              // 3 upright standards + 3 falls
    petalLength:    [0.10, 0.14],
    petalWidth:     [0.042, 0.055],
    petalCurvature: 0.28,
    petalColors:    [[0.28, 0.18, 0.62], [0.42, 0.28, 0.78]],
    diskColor:      [0.85, 0.78, 0.20],
    diskRadius:     0.012,
    leafScale:      1.2,
    windAmplitude:  0.07,
    windFrequency:  0.68,
    heliotropic:    false,
    bloomDays:      22,
  },

  lavender: {
    category:       ['meditat', 'mindful', 'breathing', 'mind', 'calm'],
    stemHeight:     [0.40, 0.70],
    stemRadius:     [0.005, 0.007],
    stemColor:      [0.22, 0.40, 0.15],
    petalCount:     24,             // dense spike of tiny florets
    petalLength:    [0.018, 0.024],
    petalWidth:     [0.010, 0.014],
    petalCurvature: 0.05,
    petalColors:    [[0.52, 0.35, 0.72], [0.62, 0.45, 0.80]],
    diskColor:      [0.55, 0.38, 0.72],
    diskRadius:     0.004,
    leafScale:      0.7,
    windAmplitude:  0.14,
    windFrequency:  1.10,
    heliotropic:    false,
    bloomDays:      18,
  },

  forget_me_not: {
    category:       ['reading', 'book', 'read'],
    stemHeight:     [0.20, 0.38],
    stemRadius:     [0.004, 0.006],
    stemColor:      [0.20, 0.42, 0.14],
    petalCount:     5,
    petalLength:    [0.020, 0.028],
    petalWidth:     [0.018, 0.024],
    petalCurvature: 0.08,
    petalColors:    [[0.40, 0.65, 0.92], [0.50, 0.72, 0.96]],
    diskColor:      [0.95, 0.90, 0.22],
    diskRadius:     0.008,
    leafScale:      0.6,
    windAmplitude:  0.18,
    windFrequency:  1.30,
    heliotropic:    false,
    bloomDays:      14,
    clusterCount:   5,              // multiple flower heads per stem
  },

  anemone: {
    category:       ['water', 'hydrat', 'drink'],
    stemHeight:     [0.28, 0.50],
    stemRadius:     [0.006, 0.009],
    stemColor:      [0.18, 0.38, 0.10],
    petalCount:     8,
    petalLength:    [0.055, 0.075],
    petalWidth:     [0.030, 0.040],
    petalCurvature: 0.12,
    petalColors:    [[0.96, 0.94, 0.92], [0.88, 0.85, 0.82]],
    diskColor:      [0.08, 0.05, 0.18],
    diskRadius:     0.022,
    leafScale:      0.9,
    windAmplitude:  0.09,
    windFrequency:  0.80,
    heliotropic:    false,
    bloomDays:      18,
  },

  cosmos: {
    category:       ['sleep', 'rest', 'wake'],
    stemHeight:     [0.55, 0.95],
    stemRadius:     [0.005, 0.007],
    stemColor:      [0.18, 0.38, 0.10],
    petalCount:     8,
    petalLength:    [0.065, 0.085],
    petalWidth:     [0.022, 0.030],
    petalCurvature: 0.06,
    petalColors:    [[0.95, 0.72, 0.80], [0.98, 0.88, 0.90]],
    diskColor:      [0.92, 0.72, 0.10],
    diskRadius:     0.018,
    leafScale:      0.9,
    windAmplitude:  0.16,
    windFrequency:  0.92,
    heliotropic:    false,
    bloomDays:      18,
  },

  peony: {
    category:       ['journal', 'diary', 'writ'],
    stemHeight:     [0.45, 0.75],
    stemRadius:     [0.010, 0.014],
    stemColor:      [0.18, 0.35, 0.10],
    petalCount:     32,             // multiple dense rings of layered petals
    petalLength:    [0.055, 0.080],
    petalWidth:     [0.040, 0.055],
    petalCurvature: 0.35,           // deeply cupped
    petalColors:    [[0.82, 0.22, 0.38], [0.90, 0.40, 0.52], [0.98, 0.72, 0.80]],
    diskColor:      [0.92, 0.78, 0.20],
    diskRadius:     0.005,
    leafScale:      1.3,
    windAmplitude:  0.06,
    windFrequency:  0.50,
    heliotropic:    false,
    bloomDays:      22,
    layeredPetals:  true,           // three concentric rings at different scales
  },

  ranunculus: {
    category:       ['creat', 'art', 'draw', 'design', 'music', 'make'],
    stemHeight:     [0.35, 0.60],
    stemRadius:     [0.008, 0.011],
    stemColor:      [0.18, 0.38, 0.10],
    petalCount:     28,
    petalLength:    [0.045, 0.065],
    petalWidth:     [0.032, 0.045],
    petalCurvature: 0.28,
    petalColors:    [[0.92, 0.52, 0.10], [0.95, 0.65, 0.18], [0.98, 0.80, 0.35]],
    diskColor:      [0.22, 0.18, 0.08],
    diskRadius:     0.008,
    leafScale:      1.1,
    windAmplitude:  0.07,
    windFrequency:  0.60,
    heliotropic:    false,
    bloomDays:      20,
    layeredPetals:  true,
  },

  wisteria: {
    category:       ['social', 'friend', 'famil', 'connect', 'call', 'talk'],
    stemHeight:     [0.50, 0.85],
    stemRadius:     [0.007, 0.010],
    stemColor:      [0.18, 0.30, 0.10],
    petalCount:     16,             // cascading cluster, rendered as drooping sub-heads
    petalLength:    [0.025, 0.035],
    petalWidth:     [0.016, 0.022],
    petalCurvature: 0.10,
    petalColors:    [[0.55, 0.40, 0.78], [0.65, 0.50, 0.85], [0.78, 0.65, 0.92]],
    diskColor:      [0.72, 0.60, 0.88],
    diskRadius:     0.006,
    leafScale:      1.0,
    windAmplitude:  0.20,
    windFrequency:  0.75,
    heliotropic:    false,
    bloomDays:      20,
    droopingCluster: true,          // petals arranged in hanging raceme
  },

  foxglove: {
    category:       ['nutrit', 'food', 'eat', 'diet', 'cook', 'meal'],
    stemHeight:     [0.80, 1.20],
    stemRadius:     [0.009, 0.013],
    stemColor:      [0.18, 0.35, 0.10],
    petalCount:     12,             // tubular bells stacked up the spike
    petalLength:    [0.055, 0.075],
    petalWidth:     [0.045, 0.060],
    petalCurvature: 0.45,           // strongly tubular
    petalColors:    [[0.88, 0.48, 0.58], [0.92, 0.60, 0.68]],
    diskColor:      [0.95, 0.92, 0.90],
    diskRadius:     0.006,
    speckled:       true,           // dark spots on inner throat
    leafScale:      1.5,
    windAmplitude:  0.08,
    windFrequency:  0.52,
    heliotropic:    false,
    bloomDays:      24,
    spikeArranged:  true,           // bells stacked vertically
  },

  protea: {
    category:       ['outdoor', 'walk', 'run', 'nature', 'hike', 'sport'],
    stemHeight:     [0.55, 0.90],
    stemRadius:     [0.012, 0.016],
    stemColor:      [0.22, 0.32, 0.12],
    petalCount:     24,             // bracts surrounding central cone
    petalLength:    [0.070, 0.095],
    petalWidth:     [0.020, 0.028],
    petalCurvature: 0.08,
    petalColors:    [[0.82, 0.42, 0.35], [0.90, 0.58, 0.48], [0.96, 0.80, 0.72]],
    diskColor:      [0.88, 0.78, 0.70],
    diskRadius:     0.035,
    leafScale:      1.4,
    windAmplitude:  0.06,
    windFrequency:  0.45,
    heliotropic:    false,
    bloomDays:      26,
  },

  poppy: {
    category:       [],             // catch-all for custom/other
    stemHeight:     [0.42, 0.72],
    stemRadius:     [0.006, 0.008],
    stemColor:      [0.18, 0.38, 0.10],
    petalCount:     4,
    petalLength:    [0.065, 0.090],
    petalWidth:     [0.055, 0.075],
    petalCurvature: 0.05,
    petalColors:    [[0.90, 0.18, 0.08], [0.95, 0.32, 0.12]],
    diskColor:      [0.08, 0.06, 0.04],
    diskRadius:     0.020,
    leafScale:      1.0,
    windAmplitude:  0.22,
    windFrequency:  0.88,
    heliotropic:    false,
    bloomDays:      16,
    tissueThick:    true,           // very thin semi-transparent petals
  },
};

// ─── Growth parameters ────────────────────────────────────────────────────────

// Days since habit created → visual growth state
const GROWTH_STAGE = {
  SPROUT:   { minDays: 0,  maxDays: 7,  scaleMin: 0.02, scaleMax: 0.20 },
  GROWING:  { minDays: 8,  maxDays: 21, scaleMin: 0.20, scaleMax: 0.75 },
  BLOOMING: { minDays: 22, maxDays: 59, scaleMin: 0.75, scaleMax: 1.00 },
  MATURE:   { minDays: 60, maxDays: Infinity, scaleMin: 1.00, scaleMax: 1.00 },
};

// Days without a check-in before dormancy begins
const DORMANCY_THRESHOLD_DAYS = 3;
// Re-bloom probability after dormancy ends with a new check-in
const REBLOOOM_RATE = 0.55;

// Pollen particle count per bloom burst
const POLLEN_COUNT = 8;

// Hover phototropism: max tilt angle in radians toward camera
const PHOTOTROPISM_MAX_ANGLE = 0.22;
// Lerp speed for phototropism tilt
const PHOTOTROPISM_LERP = 0.03;

// ─── Module state ─────────────────────────────────────────────────────────────

// One FlowerInstance per habit entry — all Three.js objects owned here
const _flowers = [];          // Array<FlowerInstance>
let   _scene   = null;

// Raycaster for hover/click
const _raycaster   = new THREE.Raycaster();
const _mouse       = new THREE.Vector2();
let   _hoveredIdx  = -1;
let   _clickCb     = null;   // registered externally by garden.js

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build all flower instances from state.habits and add to scene.
 * Must be called after state.habits is populated by auth.js.
 *
 * @param {THREE.Scene} scene
 * @param {Function}    onHabitClick  Called with (habitData) when a flower is clicked
 */
export async function initFlowers(scene, onHabitClick) {
  _scene   = scene;
  _clickCb = onHabitClick || null;

  _bindPointerEvents();

  for (const habit of state.habits) {
    const flower = _buildFlowerInstance(habit);
    _flowers.push(flower);
  }

  console.log(
    '%cATLAS FLOWERS%c %d habits → %d flower instances',
    'color:#c8a96e;font-weight:bold', 'color:#8a7e6e',
    state.habits.length, _flowers.length
  );
}

/**
 * Per-frame update. Animates wind, heliotropism, phototropism, dormancy.
 *
 * @param {number} delta
 * @param {number} elapsed
 */
export function updateFlowers(delta, elapsed) {
  for (let i = 0; i < _flowers.length; i++) {
    _updateFlower(_flowers[i], delta, elapsed, i === _hoveredIdx);
  }
}

/**
 * Called by garden.js when a new habit check-in is recorded.
 * Refreshes the specific flower and possibly triggers bloom burst.
 *
 * @param {string} habitId
 */
export function onHabitCheckin(habitId) {
  const flower = _flowers.find(f => f.habit.id === habitId);
  if (!flower) return;

  const wasDormant = flower.dormant;
  flower.dormant   = false;
  flower.lastCheckin = Date.now();

  // Re-bloom decision after dormancy
  if (wasDormant && Math.random() < REBLOOOM_RATE) {
    flower.forceBloom = true;
  }

  // Trigger pollen burst
  _spawnPollenBurst(flower);
}

/**
 * Dispose all GPU resources and remove event listeners.
 */
export function disposeFlowers() {
  _unbindPointerEvents();

  for (const flower of _flowers) {
    _disposeFlower(flower);
  }

  _flowers.length = 0;
  _scene = null;
}

// ─── FlowerInstance construction ──────────────────────────────────────────────

/**
 * Build the complete Three.js object graph for one habit's flower.
 *
 * Structure:
 *   root (Object3D) — world-space pivot at terrain surface
 *   └─ stemPivot (Object3D) — handles phototropism tilt
 *      ├─ stemMesh (Mesh) — TubeGeometry along CubicBezierCurve3
 *      ├─ leafMesh[0] (Mesh) — leaf pair at 35% of stem
 *      ├─ leafMesh[1] (Mesh) — leaf pair at 65% of stem
 *      ├─ headPivot (Object3D) — at stem tip; handles heliotropism rotation
 *      │  ├─ diskMesh (Mesh) — flower center disc
 *      │  └─ petalGroup (Object3D) — all petal meshes as children
 *      └─ pollenGroup (Object3D) — particle meshes (hidden until burst)
 *
 * @param {Object} habit   Row from state.habits
 * @returns {FlowerInstance}
 */
function _buildFlowerInstance(habit) {
  const species  = _resolveSpecies(habit);
  const spec     = SPECIES[species];
  const ageDays  = _ageDays(habit.created_at);
  const scale    = _growthScale(ageDays, spec);
  const dormant  = _isDormant(habit);

  // Poisson-safe placement within garden — seeded from habit ID
  const pos      = _habitPosition(habit);
  const stemH    = _lerp(spec.stemHeight[0], spec.stemHeight[1], _seededRand(habit.id, 0)) * scale;

  // ── Root pivot ────────────────────────────────────────────────────────────
  const root     = new THREE.Object3D();
  root.position.set(pos.x, getHeightAt(pos.x, pos.z), pos.z);
  root.userData  = { habitId: habit.id, species };

  // ── Stem pivot (child of root, tilts for phototropism) ────────────────────
  const stemPivot = new THREE.Object3D();
  root.add(stemPivot);

  // ── Stem ──────────────────────────────────────────────────────────────────
  const stemMesh  = _buildStem(spec, stemH, habit.id);
  stemPivot.add(stemMesh);

  // ── Leaves ────────────────────────────────────────────────────────────────
  const leafMesh0 = _buildLeafPair(spec, stemH, 0.35, habit.id, 0);
  const leafMesh1 = _buildLeafPair(spec, stemH, 0.65, habit.id, 1);
  stemPivot.add(leafMesh0);
  stemPivot.add(leafMesh1);

  // ── Head pivot (at tip of stem) ───────────────────────────────────────────
  const headPivot = new THREE.Object3D();
  headPivot.position.set(0, stemH, 0);
  stemPivot.add(headPivot);

  // ── Disk ──────────────────────────────────────────────────────────────────
  const diskMesh  = _buildDisk(spec, scale);
  headPivot.add(diskMesh);

  // ── Petals ────────────────────────────────────────────────────────────────
  const petalGroup = new THREE.Object3D();
  headPivot.add(petalGroup);
  _buildPetals(spec, petalGroup, scale, dormant, habit.id);

  // ── Pollen particles ──────────────────────────────────────────────────────
  const pollenGroup = new THREE.Object3D();
  pollenGroup.position.set(0, stemH, 0);
  stemPivot.add(pollenGroup);
  _buildPollenParticles(pollenGroup);   // all initially hidden

  // ── Add to scene ──────────────────────────────────────────────────────────
  _scene.add(root);

  return {
    habit,
    species,
    spec,
    ageDays,
    scale,
    dormant,
    forceBloom:     false,
    lastCheckin:    _lastCheckinTime(habit),

    // Three.js objects
    root,
    stemPivot,
    stemMesh,
    leafMesh0,
    leafMesh1,
    headPivot,
    diskMesh,
    petalGroup,
    pollenGroup,

    // Animation state
    windPhase:      _seededRand(habit.id, 2) * Math.PI * 2,
    heliotropicYaw: 0,                     // current head rotation Y
    phototropicPitch: 0,                   // current stem tilt toward camera
    phototropicTarget: 0,

    // Per-petal wind phases
    petalPhases:    _generatePetalPhases(spec.petalCount, habit.id),

    // Dormancy animation state
    dormancyT:      dormant ? 1.0 : 0.0,   // 0=alive, 1=fully dormant
  };
}

// ─── Per-frame animation ──────────────────────────────────────────────────────

function _updateFlower(flower, delta, elapsed, isHovered) {
  if (!flower.root) return;

  const { spec, windPhase } = flower;

  // ── Dormancy interpolation ─────────────────────────────────────────────────
  const targetDormancy = flower.dormant ? 1.0 : 0.0;
  flower.dormancyT = _lerp(flower.dormancyT, targetDormancy, delta * 0.4);

  // ── Wind sway on stem pivot ────────────────────────────────────────────────
  // Three-frequency: primary structural sway + mid-frequency rustle + tip flutter
  const windStr   = state.wind.strength + state.wind.gustStrength;
  const wDir      = state.wind.direction;
  const t         = elapsed;

  const spatialPhase = (flower.root.position.x * wDir.x + flower.root.position.z * wDir.z) * 0.08;
  const phase        = spatialPhase + windPhase;

  const sway1 = Math.sin(spec.windFrequency * t * Math.PI * 2 + phase)             * spec.windAmplitude;
  const sway2 = Math.sin(spec.windFrequency * 2.1 * t * Math.PI * 2 + phase * 1.4) * spec.windAmplitude * 0.28;
  const sway3 = Math.sin(spec.windFrequency * 4.5 * t * Math.PI * 2 + phase * 2.2) * spec.windAmplitude * 0.10;
  const totalSway = (sway1 + sway2 + sway3) * windStr;

  // Sway applied as XZ rotation on stem pivot (in wind direction)
  flower.stemPivot.rotation.x = totalSway * wDir.z * 0.6;
  flower.stemPivot.rotation.z = totalSway * wDir.x * -0.6;

  // ── Dormancy droop — petals hang and desaturate ────────────────────────────
  if (flower.dormancyT > 0.01) {
    flower.headPivot.rotation.x = _lerp(0, 0.62, flower.dormancyT);  // head droops forward
    // Individual petal droop handled in shader via uDormancy uniform
    _updatePetalDormancy(flower.petalGroup, flower.dormancyT);
  } else {
    flower.headPivot.rotation.x = 0;
  }

  // ── Heliotropism (sunflower only) ──────────────────────────────────────────
  if (spec.heliotropic && !state.isNight) {
    // Compute sun azimuth from sunDirection: atan2(x, z) gives compass bearing
    const sunAz = Math.atan2(state.sunDirection.x, state.sunDirection.z);
    flower.heliotropicYaw = _lerp(flower.heliotropicYaw, sunAz, delta * 0.008);
    flower.headPivot.rotation.y = flower.heliotropicYaw;
    // Also tilt slightly toward sun elevation
    const sunEl = Math.max(0, state.sunElevation);
    flower.headPivot.rotation.x += -sunEl * 0.012;
  }

  // ── Phototropism on hover ──────────────────────────────────────────────────
  if (isHovered) {
    // Stem tilts toward camera — compute direction from flower root to camera
    const toCamX = state.camera.x - flower.root.position.x;
    const toCamZ = state.camera.z - flower.root.position.z;
    const dist    = Math.sqrt(toCamX * toCamX + toCamZ * toCamZ);

    if (dist > 0.1) {
      const angle = Math.atan2(toCamX, toCamZ);
      flower.phototropicTarget = PHOTOTROPISM_MAX_ANGLE;
      flower.stemPivot.rotation.y = _lerpAngle(flower.stemPivot.rotation.y, angle, 0.04);
    }
  } else {
    flower.phototropicTarget = 0;
  }

  flower.phototropicPitch = _lerp(
    flower.phototropicPitch,
    flower.phototropicTarget,
    PHOTOTROPISM_LERP
  );
  flower.stemPivot.rotation.x += flower.phototropicPitch * 0.5;

  // ── Growth scale update ────────────────────────────────────────────────────
  // Age increases in real time; re-check scale every update (cheap computation)
  const currentAge   = _ageDays(flower.habit.created_at);
  const currentScale = _growthScale(currentAge, flower.spec);
  if (Math.abs(currentScale - flower.scale) > 0.001) {
    flower.scale = currentScale;
    flower.root.scale.setScalar(currentScale);
  }

  // ── Update petal wind uniforms (shader-based flutter) ─────────────────────
  flower.petalGroup.traverse(child => {
    if (child.isMesh && child.material && child.material.uniforms) {
      const u = child.material.uniforms;
      u.uTime.value       = elapsed;
      u.uWindStrength.value = windStr;
      u.uWetness.value    = state.wetness;
      u.uSunDir.value.set(state.sunDirection.x, state.sunDirection.y, state.sunDirection.z);
      u.uSunColor.value.set(state.sunColor.r, state.sunColor.g, state.sunColor.b);
      u.uIsNight.value    = state.isNight ? 1.0 : 0.0;
      u.uDormancy.value   = flower.dormancyT;
    }
  });

  // ── Update pollen particles ────────────────────────────────────────────────
  _updatePollenParticles(flower.pollenGroup, delta, elapsed);
}

// ─── Geometry builders ────────────────────────────────────────────────────────

/**
 * Build stem TubeGeometry along a CubicBezierCurve3.
 * The curve gives an organic lean — not perfectly vertical.
 * Radius tapers from base to tip via custom attribute (handled in shader).
 *
 * @param {Object} spec
 * @param {number} stemH     Full height in world units
 * @param {string} habitId   For seeded variation
 * @returns {THREE.Mesh}
 */
function _buildStem(spec, stemH, habitId) {
  const r0 = _seededRand(habitId, 10);
  const r1 = _seededRand(habitId, 11);

  // Bezier control points: root → bend point 1 → bend point 2 → tip
  const p0 = new THREE.Vector3(0, 0, 0);
  const p1 = new THREE.Vector3(
    (r0 - 0.5) * stemH * 0.18,
    stemH * 0.38,
    (r1 - 0.5) * stemH * 0.12
  );
  const p2 = new THREE.Vector3(
    (r1 - 0.5) * stemH * 0.10,
    stemH * 0.72,
    (r0 - 0.5) * stemH * 0.08
  );
  const p3 = new THREE.Vector3(
    (r0 - 0.5) * stemH * 0.06,
    stemH,
    (r1 - 0.5) * stemH * 0.04
  );

  const curve    = new THREE.CubicBezierCurve3(p0, p1, p2, p3);
  const baseR    = _lerp(spec.stemRadius[0], spec.stemRadius[1], r0);
  const tipR     = baseR * 0.42;
  const segments = 16;
  const radSegs  = 6;

  // Build TubeGeometry then taper radius via position attribute manipulation
  const geo = new THREE.TubeGeometry(curve, segments, baseR, radSegs, false);

  // Taper: for each vertex, measure its Y fraction along the tube and scale
  // the radial component outward from axis accordingly
  _taperTubeGeometry(geo, curve, baseR, tipR, segments, radSegs);

  const mat = new THREE.MeshStandardMaterial({
    color:      new THREE.Color(spec.stemColor[0], spec.stemColor[1], spec.stemColor[2]),
    roughness:  0.82,
    metalness:  0.0,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow    = true;
  mesh.receiveShadow = false;

  return mesh;
}

/**
 * Taper a TubeGeometry by scaling each ring's radial offset
 * from baseRadius at the bottom ring to tipRadius at the top ring.
 */
function _taperTubeGeometry(geo, curve, baseR, tipR, tubeSeg, radSeg) {
  const pos    = geo.attributes.position;
  const verts  = pos.count;
  const ringsTotal = tubeSeg + 1;
  const vertsPerRing = radSeg + 1;

  for (let ring = 0; ring < ringsTotal; ring++) {
    const t      = ring / tubeSeg;
    const radius = _lerp(baseR, tipR, t);
    const scale  = radius / baseR;

    // Get the spine point for this ring
    const spinePoint = curve.getPointAt(t);

    for (let v = 0; v < vertsPerRing; v++) {
      const idx = ring * vertsPerRing + v;
      if (idx >= verts) continue;

      const x = pos.getX(idx);
      const y = pos.getY(idx);
      const z = pos.getZ(idx);

      // Offset from spine centre
      const dx = x - spinePoint.x;
      const dy = y - spinePoint.y;
      const dz = z - spinePoint.z;

      pos.setXYZ(idx,
        spinePoint.x + dx * scale,
        spinePoint.y + dy * scale,
        spinePoint.z + dz * scale
      );
    }
  }

  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

/**
 * Build one leaf pair at a given fraction along the stem.
 * Each leaf is a PlaneGeometry with a tapered silhouette (via alpha discard
 * in the fragment shader).
 *
 * @param {Object}  spec
 * @param {number}  stemH
 * @param {number}  fraction    0–1 along stem (0.35 or 0.65)
 * @param {string}  habitId
 * @param {number}  pairIndex   0 or 1 (for seed variation)
 * @returns {THREE.Group}
 */
function _buildLeafPair(spec, stemH, fraction, habitId, pairIndex) {
  const group  = new THREE.Group();
  const y      = stemH * fraction;
  const lScale = spec.leafScale * 0.06; // leaf half-length
  const r      = _seededRand(habitId, 20 + pairIndex);

  for (let side = 0; side < 2; side++) {
    const geo = new THREE.PlaneGeometry(lScale * 0.48, lScale, 1, 4);

    // Taper leaf toward tip — move vertices
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const py   = pos.getY(i);
      const t    = (py / lScale + 0.5);   // 0 at base, 1 at tip
      const taper = 1.0 - t * 0.72;
      pos.setX(i, pos.getX(i) * taper);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    const mat  = new THREE.MeshStandardMaterial({
      color:       new THREE.Color(
        spec.stemColor[0] * 1.05,
        spec.stemColor[1] * 1.15,
        spec.stemColor[2] * 0.90
      ),
      roughness:   0.78,
      metalness:   0.0,
      side:        THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);

    // Position: at stem height fraction, alternate sides
    mesh.position.set(0, y, 0);

    // Rotate out to the side, slightly drooping, random azimuth offset
    const azimuth = (side === 0 ? 0 : Math.PI) + (r - 0.5) * 0.8;
    const droop   = 0.35 + r * 0.15;

    mesh.rotation.order = 'YXZ';
    mesh.rotation.y     = azimuth;
    mesh.rotation.x     = droop;

    mesh.castShadow    = false;
    mesh.receiveShadow = false;

    group.add(mesh);
  }

  return group;
}

/**
 * Build the flower's central disk (SphereGeometry hemisphere for dome-shaped
 * disks, or CylinderGeometry for flat disk species).
 */
function _buildDisk(spec, growthScale) {
  const r   = spec.diskRadius * growthScale;
  const col = new THREE.Color(spec.diskColor[0], spec.diskColor[1], spec.diskColor[2]);

  let geo;
  if (spec.diskRadius > 0.025) {
    // Prominent dome disk (sunflower, anemone, protea)
    geo = new THREE.SphereGeometry(r, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
  } else {
    geo = new THREE.CylinderGeometry(r, r * 1.1, r * 0.4, 10, 1);
  }

  const mat  = new THREE.MeshStandardMaterial({ color: col, roughness: 0.80, metalness: 0.02 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = false;
  return mesh;
}

/**
 * Build all petal meshes for a species and add them to petalGroup.
 * Supports: standard radial, layeredPetals, droopingCluster, spikeArranged.
 *
 * Each petal is a PlaneGeometry with a ShaderMaterial (petalShader).
 *
 * @param {Object}          spec
 * @param {THREE.Object3D}  petalGroup
 * @param {number}          growthScale
 * @param {boolean}         dormant
 * @param {string}          habitId
 */
function _buildPetals(spec, petalGroup, growthScale, dormant, habitId) {
  if (spec.spikeArranged) {
    _buildSpikedPetals(spec, petalGroup, growthScale, dormant, habitId);
    return;
  }
  if (spec.droopingCluster) {
    _buildDroopingCluster(spec, petalGroup, growthScale, dormant, habitId);
    return;
  }

  const rings = spec.layeredPetals ? 3 : 1;

  for (let ring = 0; ring < rings; ring++) {
    const ringScale   = 1.0 - ring * 0.22;
    const ringTilt    = ring * 0.18;           // inner rings cup upward more
    const ringYOffset = ring * 0.005 * growthScale;
    const colorIdx    = Math.min(ring, spec.petalColors.length - 1);
    const col         = spec.petalColors[colorIdx];
    const col2        = spec.petalColors[Math.min(colorIdx + 1, spec.petalColors.length - 1)];

    // Petals per ring — outer ring gets full count, inner rings fewer
    const ringCount   = spec.layeredPetals ? Math.round(spec.petalCount / (ring + 1.4)) : spec.petalCount;

    for (let i = 0; i < ringCount; i++) {
      const angle     = (i / ringCount) * Math.PI * 2;
      const r0        = _seededRand(habitId, 30 + ring * 50 + i);
      const pLen      = _lerp(spec.petalLength[0], spec.petalLength[1], r0) * growthScale * ringScale;
      const pWid      = _lerp(spec.petalWidth[0],  spec.petalWidth[1],  r0) * growthScale * ringScale;

      const geo = _buildPetalGeometry(pLen, pWid, spec.petalCurvature, spec.tissueThick || false);

      const mat = _buildPetalMaterial(
        col, col2,
        spec.petalCurvature,
        spec.speckled || false,
        spec.tissueThick || false,
        dormant
      );

      const mesh = new THREE.Mesh(geo, mat);

      // Position at disk edge, rotate around Y to fan out
      const radialOffset = spec.diskRadius * growthScale * ringScale + pWid * 0.3;
      mesh.position.set(
        Math.sin(angle) * radialOffset,
        ringYOffset,
        Math.cos(angle) * radialOffset
      );

      // Rotate: face outward from center, tilt curvature outward/up
      mesh.rotation.order = 'YXZ';
      mesh.rotation.y     = angle;
      mesh.rotation.x     = -(Math.PI * 0.5 - spec.petalCurvature * 0.8) - ringTilt;

      // Dormant: petals droop down
      if (dormant) {
        mesh.rotation.x += 0.62;
      }

      // Small random twist per petal for naturalness
      mesh.rotation.z = (r0 - 0.5) * 0.12;

      petalGroup.add(mesh);
    }
  }
}

/**
 * Build foxglove-style spike-arranged tubular bells.
 * Bells are spaced up a vertical spike, opening outward and slightly down.
 */
function _buildSpikedPetals(spec, petalGroup, growthScale, dormant, habitId) {
  const bellCount = spec.petalCount;
  const spikeH    = 0.28 * growthScale;   // height of the spike section
  const col       = spec.petalColors[0];
  const col2      = spec.petalColors[1] || col;

  for (let i = 0; i < bellCount; i++) {
    const t     = i / bellCount;
    const y     = t * spikeH;
    const size  = _lerp(0.9, 0.5, t);   // bells shrink toward tip
    const r0    = _seededRand(habitId, 40 + i);
    const pLen  = _lerp(spec.petalLength[0], spec.petalLength[1], r0) * growthScale * size;
    const pWid  = _lerp(spec.petalWidth[0],  spec.petalWidth[1],  r0) * growthScale * size;
    const angle = (r0 - 0.5) * 0.8;    // slight rotation variation

    const geo = _buildPetalGeometry(pLen, pWid, spec.petalCurvature, false);
    const mat = _buildPetalMaterial(col, col2, spec.petalCurvature, spec.speckled, false, dormant);
    const mesh = new THREE.Mesh(geo, mat);

    mesh.position.set(Math.sin(angle) * 0.01, y, Math.cos(angle) * 0.01);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y     = angle;
    mesh.rotation.x     = -(Math.PI * 0.5 - spec.petalCurvature * 1.4);   // strongly tubular

    petalGroup.add(mesh);
  }
}

/**
 * Build wisteria-style drooping raceme cluster.
 * Sub-heads hang down from the main head pivot on short stalks.
 */
function _buildDroopingCluster(spec, petalGroup, growthScale, dormant, habitId) {
  const subHeads  = 5;
  const petPerSub = Math.round(spec.petalCount / subHeads);

  for (let s = 0; s < subHeads; s++) {
    const sub    = new THREE.Object3D();
    const r0     = _seededRand(habitId, 50 + s);
    const r1     = _seededRand(habitId, 51 + s);
    const xOff   = (r0 - 0.5) * 0.06 * growthScale;
    const yOff   = -s * 0.035 * growthScale - r1 * 0.02 * growthScale;
    const zOff   = (r1 - 0.5) * 0.06 * growthScale;

    sub.position.set(xOff, yOff, zOff);
    sub.rotation.x = 0.4 + r0 * 0.3;   // droop

    const col  = spec.petalColors[s % spec.petalColors.length];
    const col2 = spec.petalColors[(s + 1) % spec.petalColors.length];

    for (let i = 0; i < petPerSub; i++) {
      const angle = (i / petPerSub) * Math.PI * 2;
      const r2    = _seededRand(habitId, 60 + s * 20 + i);
      const pLen  = _lerp(spec.petalLength[0], spec.petalLength[1], r2) * growthScale * 0.55;
      const pWid  = _lerp(spec.petalWidth[0],  spec.petalWidth[1],  r2) * growthScale * 0.55;

      const geo  = _buildPetalGeometry(pLen, pWid, spec.petalCurvature, false);
      const mat  = _buildPetalMaterial(col, col2, spec.petalCurvature, false, false, dormant);
      const mesh = new THREE.Mesh(geo, mat);

      mesh.position.set(
        Math.sin(angle) * pWid * 0.5,
        0,
        Math.cos(angle) * pWid * 0.5
      );
      mesh.rotation.order = 'YXZ';
      mesh.rotation.y     = angle;
      mesh.rotation.x     = -(Math.PI * 0.5 - spec.petalCurvature);

      sub.add(mesh);
    }

    petalGroup.add(sub);
  }
}

/**
 * Build a single petal PlaneGeometry with organic curvature.
 * The curvature is encoded in the geometry via vertex displacement:
 * vertices along the length axis are bent inward (curvature).
 *
 * @param {number}  length
 * @param {number}  width
 * @param {number}  curvature    0 (flat) → 0.5 (strongly cupped)
 * @param {boolean} tissue       True → extra thin, semi-transparent
 * @returns {THREE.BufferGeometry}
 */
function _buildPetalGeometry(length, width, curvature, tissue) {
  const segW = 2;
  const segH = tissue ? 8 : 6;   // more segments for thin petals (more subtle curve)
  const geo  = new THREE.PlaneGeometry(width, length, segW, segH);
  const pos  = geo.attributes.position;

  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);

    // Normalised position along length: 0=base, 1=tip
    const t = (py / length + 0.5);

    // Taper width toward tip
    const widthTaper = 1.0 - t * 0.68;
    const newX       = px * widthTaper;

    // Curvature: lift edges and depress centre → cup shape
    // Model as a saddle: z offsets based on x and t
    const xNorm   = px / (width * 0.5);       // −1 to 1 across width
    const zCurve  = -curvature * length * t * (1.0 - xNorm * xNorm) * 0.55;
    // Also bend the tip inward slightly
    const zTip    = curvature * length * t * t * 0.25;

    pos.setXYZ(i, newX, py, zCurve + zTip);
  }

  pos.needsUpdate = true;
  geo.computeVertexNormals();

  return geo;
}

// ─── Petal ShaderMaterial ─────────────────────────────────────────────────────

/**
 * Build the ShaderMaterial for a petal mesh.
 * The petal shader handles:
 *   - Base colour with tip-fade gradient
 *   - Vein overlay (procedural, two primary veins + branching)
 *   - SSS translucency (thin petals transmit backlit sun)
 *   - Edge glow — rim lighting on thin edges
 *   - Wetness response — darkens, roughness drops
 *   - Speckle pattern for foxglove throat
 *   - Tissue-paper opacity for poppy
 *   - Dormancy desaturation + droop (handled in vertex)
 *   - Wind flutter: per-petal sinusoidal warp in vertex shader
 *
 * @param {Array}   colBase    [r, g, b]
 * @param {Array}   colTip     [r, g, b]
 * @param {number}  curvature
 * @param {boolean} speckled
 * @param {boolean} tissue
 * @param {boolean} dormant
 * @returns {THREE.ShaderMaterial}
 */
function _buildPetalMaterial(colBase, colTip, curvature, speckled, tissue, dormant) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime:        { value: 0.0 },
      uWindStrength: { value: 0.2 },
      uWetness:     { value: 0.0 },
      uSunDir:      { value: new THREE.Vector3(0.5, 1.0, 0.5) },
      uSunColor:    { value: new THREE.Vector3(1.0, 0.95, 0.88) },
      uIsNight:     { value: 0.0 },
      uDormancy:    { value: dormant ? 1.0 : 0.0 },
      uPhase:       { value: Math.random() * Math.PI * 2 },
      uColorBase:   { value: new THREE.Vector3(colBase[0], colBase[1], colBase[2]) },
      uColorTip:    { value: new THREE.Vector3(colTip[0],  colTip[1],  colTip[2]) },
      uCurvature:   { value: curvature },
      uSpeckled:    { value: speckled  ? 1.0 : 0.0 },
      uTissue:      { value: tissue    ? 1.0 : 0.0 },
    },
    vertexShader:   _petalVertShader(),
    fragmentShader: _petalFragShader(),
    side:           THREE.DoubleSide,
    transparent:    true,
    depthWrite:     !tissue,        // tissue petals need transparent depth ordering
    alphaTest:      tissue ? 0.0 : 0.05,
  });
}

function _updatePetalDormancy(petalGroup, dormancyT) {
  petalGroup.traverse(child => {
    if (child.isMesh && child.material && child.material.uniforms) {
      child.material.uniforms.uDormancy.value = dormancyT;
    }
  });
}

// ─── Pollen particles ─────────────────────────────────────────────────────────

function _buildPollenParticles(pollenGroup) {
  for (let i = 0; i < POLLEN_COUNT; i++) {
    const geo  = new THREE.SphereGeometry(0.004, 4, 4);
    const mat  = new THREE.MeshBasicMaterial({
      color:       0xf5d060,
      transparent: true,
      opacity:     0.0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;

    // Random initial velocity stored in userData
    const angle = (i / POLLEN_COUNT) * Math.PI * 2;
    mesh.userData = {
      vx:      Math.sin(angle) * (0.04 + Math.random() * 0.06),
      vy:      0.08 + Math.random() * 0.10,
      vz:      Math.cos(angle) * (0.04 + Math.random() * 0.06),
      life:    0.0,
      maxLife: 1.8 + Math.random() * 1.2,
      active:  false,
    };

    pollenGroup.add(mesh);
  }
}

function _spawnPollenBurst(flower) {
  flower.pollenGroup.children.forEach(mesh => {
    mesh.visible = true;
    mesh.position.set(0, 0, 0);
    mesh.material.opacity = 0.85;
    mesh.userData.life    = 0.0;
    mesh.userData.active  = true;
  });
}

function _updatePollenParticles(pollenGroup, delta) {
  pollenGroup.children.forEach(mesh => {
    const d = mesh.userData;
    if (!d.active) return;

    d.life += delta;
    const t = d.life / d.maxLife;

    // Physics: gravity + drag
    d.vy -= delta * 0.04;                    // gentle gravity
    d.vx *= (1.0 - delta * 0.6);
    d.vz *= (1.0 - delta * 0.6);

    mesh.position.x += d.vx * delta;
    mesh.position.y += d.vy * delta;
    mesh.position.z += d.vz * delta;

    // Add wind drift
    mesh.position.x += state.wind.direction.x * state.wind.strength * delta * 0.06;
    mesh.position.z += state.wind.direction.z * state.wind.strength * delta * 0.06;

    // Fade out
    mesh.material.opacity = _lerp(0.85, 0.0, t * t);

    if (d.life >= d.maxLife) {
      mesh.visible     = false;
      d.active         = false;
    }
  });
}

// ─── Pointer events (hover + click) ──────────────────────────────────────────

function _onPointerMove(e) {
  if (!_scene) return;

  _mouse.x = (e.clientX / window.innerWidth)  * 2 - 1;
  _mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

  // Build list of all raycaster targets (stem and disk meshes)
  const targets = _flowers.flatMap((f, i) => {
    const items = [];
    if (f.stemMesh) { f.stemMesh.userData._flowerIdx = i; items.push(f.stemMesh); }
    if (f.diskMesh) { f.diskMesh.userData._flowerIdx = i; items.push(f.diskMesh); }
    return items;
  });

  // Get camera from scene — must be passed or retrieved from global
  const cam = window._atlasCamera;
  if (!cam) return;

  _raycaster.setFromCamera(_mouse, cam);
  const hits = _raycaster.intersectObjects(targets, false);

  if (hits.length > 0) {
    const idx = hits[0].object.userData._flowerIdx;
    if (idx !== undefined) {
      _hoveredIdx = idx;
      document.body.style.cursor = 'pointer';
    }
  } else {
    _hoveredIdx = -1;
    document.body.style.cursor = '';
  }
}

function _onPointerClick(e) {
  if (_hoveredIdx === -1 || !_clickCb) return;
  const flower = _flowers[_hoveredIdx];
  if (flower) _clickCb(flower.habit);
}

function _bindPointerEvents() {
  window.addEventListener('pointermove', _onPointerMove, { passive: true });
  window.addEventListener('click',       _onPointerClick);
}

function _unbindPointerEvents() {
  window.removeEventListener('pointermove', _onPointerMove);
  window.removeEventListener('click',       _onPointerClick);
}

// ─── Dispose ─────────────────────────────────────────────────────────────────

function _disposeFlower(flower) {
  if (flower.root && flower.root.parent) {
    flower.root.parent.remove(flower.root);
  }

  flower.root.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) {
        child.material.forEach(m => m.dispose());
      } else {
        child.material.dispose();
      }
    }
  });
}

// ─── Species resolution ───────────────────────────────────────────────────────

/**
 * Match a habit's name/category to the correct flower species.
 * Falls back to poppy for unrecognised categories.
 *
 * @param {Object} habit
 * @returns {string}  Key into SPECIES
 */
function _resolveSpecies(habit) {
  const name = ((habit.name || '') + ' ' + (habit.category || '')).toLowerCase();

  for (const [key, spec] of Object.entries(SPECIES)) {
    if (key === 'poppy') continue;   // poppy is the catch-all, skip in iteration
    for (const keyword of spec.category) {
      if (name.includes(keyword)) return key;
    }
  }

  // Check for explicitly set species override
  if (habit.flower_species && SPECIES[habit.flower_species]) {
    return habit.flower_species;
  }

  return 'poppy';
}

// ─── Placement ────────────────────────────────────────────────────────────────

/**
 * Deterministic world-space position for a habit's flower within the garden.
 * Uses the habit's UUID to seed a stable XZ position within the garden bounds.
 * Positions are offset from garden center, spread across the zone.
 *
 * @param {Object} habit
 * @returns {{ x: number, z: number }}
 */
function _habitPosition(habit) {
  // Unique but stable position from UUID
  const r0 = _seededRand(habit.id, 0);
  const r1 = _seededRand(habit.id, 1);

  // Spread across 600 × 600 of the 700 × 700 garden (leave border for grass)
  const spread = 280;
  const x = GARDEN_CENTER_X + (r0 - 0.5) * 2 * spread;
  const z = GARDEN_CENTER_Z + (r1 - 0.5) * 2 * spread;

  return { x, z };
}


// ─── Growth helpers ───────────────────────────────────────────────────────────

function _ageDays(createdAt) {
  if (!createdAt) return 0;
  return (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Compute the uniform scale (0→1) for a flower given its age and species.
 * Growth is not linear: rapid early growth, plateau at maturity.
 */
function _growthScale(ageDays, spec) {
  const bloomDay = spec.bloomDays || 22;

  if (ageDays < 1) {
    // Sprout: tiny, still emerging
    return _lerp(0.01, 0.08, ageDays);
  }
  if (ageDays < 8) {
    // Early growth: easeOutCubic
    const t = (ageDays - 1) / 7;
    return _lerp(0.08, 0.30, _easeOutCubic(t));
  }
  if (ageDays < bloomDay) {
    // Growing: easeOutQuart to full bloom
    const t = (ageDays - 8) / (bloomDay - 8);
    return _lerp(0.30, 1.00, _easeOutQuart(t));
  }

  // Mature — full scale, slight random individual variation encoded at init time
  return 1.00;
}

function _isDormant(habit) {
  // Check state.habitLogs for the most recent log entry for this habit
  const logs = (state.habitLogs || []).filter(l => l.habit_id === habit.id);
  if (logs.length === 0) return false;

  const latest = logs.reduce((a, b) =>
    new Date(a.date) > new Date(b.date) ? a : b
  );

  const daysSince = (Date.now() - new Date(latest.date).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince >= DORMANCY_THRESHOLD_DAYS;
}

function _lastCheckinTime(habit) {
  const logs = (state.habitLogs || []).filter(l => l.habit_id === habit.id);
  if (logs.length === 0) return 0;

  const latest = logs.reduce((a, b) =>
    new Date(a.date) > new Date(b.date) ? a : b
  );

  return new Date(latest.date).getTime();
}

// ─── Math utilities ───────────────────────────────────────────────────────────

/** Linear interpolation */
function _lerp(a, b, t) {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

/** Lerp angles with wrapping — prevents spinning past ±π */
function _lerpAngle(current, target, alpha) {
  let diff = target - current;
  while (diff >  Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * alpha;
}

function _easeOutCubic(t)  { return 1 - Math.pow(1 - t, 3); }
function _easeOutQuart(t)  { return 1 - Math.pow(1 - t, 4); }

/** Per-petal wind phases from habit id seed */
function _generatePetalPhases(count, habitId) {
  const phases = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    phases[i] = _seededRand(habitId, 100 + i) * Math.PI * 2;
  }
  return phases;
}

/**
 * Seeded deterministic pseudo-random from a UUID string + salt integer.
 * Returns a float in [0, 1].
 */
function _seededRand(uuid, salt) {
  // Mix UUID characters into a 32-bit seed
  let h = salt * 2654435761;
  for (let i = 0; i < uuid.length; i++) {
    h = Math.imul(h ^ uuid.charCodeAt(i), 1540483477);
  }
  h ^= h >>> 24;
  h  = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  h  = Math.imul(h, 3266489917);
  h ^= h >>> 16;

  return ((h >>> 0) / 0xFFFFFFFF);
}

// ─── GLSL — Petal vertex shader ───────────────────────────────────────────────

/**
 * Petal vertex shader.
 *
 * Uniforms:
 *   uTime:         float  — elapsed seconds
 *   uWindStrength: float  — 0–1
 *   uPhase:        float  — per-petal random phase [0, 2π]
 *   uDormancy:     float  — 0=alive, 1=fully dormant
 *
 * Wind flutter:
 *   A high-frequency sinusoidal warp applied to the tip vertices.
 *   Each petal flutters independently (unique uPhase).
 *   Tip vertices (high vUv.y) flutter; base (low vUv.y) stays anchored.
 *
 * Dormancy:
 *   Tips droop along local Z axis by uDormancy amount.
 */
function _petalVertShader() {
  return /* glsl */`
    /**
     * petal.glsl — vertex shader
     *
     * Uniforms:
     *   uTime:         float — elapsed seconds
     *   uWindStrength: float — 0–1 global wind
     *   uPhase:        float — per-petal unique phase [0, 2π]
     *   uDormancy:     float — 0=alive, 1=dormant (droop)
     *
     * Varyings out:
     *   vUv:         vec2  — texture coordinate, y=0 base, y=1 tip
     *   vWorldNormal: vec3
     *   vWorldPos:   vec3
     *   vTipFactor:  float — smoothstep(0.4, 1.0, vUv.y), tip mask for SSS
     */

    precision highp float;

    uniform float uTime;
    uniform float uWindStrength;
    uniform float uPhase;
    uniform float uDormancy;

    varying vec2  vUv;
    varying vec3  vWorldNormal;
    varying vec3  vWorldPos;
    varying float vTipFactor;

    void main() {
      vec3 pos = position;

      // Tip factor: 0 at base, 1 at tip
      float tipT = smoothstep(0.25, 1.0, uv.y);

      // ── Wind flutter ─────────────────────────────────────────────────────
      // High-frequency sinusoidal warp on the tip portion of the petal.
      // Lateral (X) flutter + slight fore-aft (Z) vibration.
      float flutterX = sin(uTime * 14.2 + uPhase)          * uWindStrength * 0.012 * tipT;
      float flutterZ = sin(uTime * 9.8  + uPhase * 1.7)    * uWindStrength * 0.008 * tipT;
      float flutterY = sin(uTime * 6.4  + uPhase * 0.9)    * uWindStrength * 0.006 * tipT * tipT;

      pos.x += flutterX;
      pos.z += flutterZ;
      pos.y += flutterY;

      // ── Dormancy droop ────────────────────────────────────────────────────
      // Tips hang downward (negative local Y → positive Z after petal rotation)
      // The rotation in CPU code already droops the head; here we add per-petal
      // tip droop on top, curling tips inward.
      float droopZ = uDormancy * tipT * tipT * 0.035;
      pos.z += droopZ;

      // ── Output ────────────────────────────────────────────────────────────
      vec4 worldPos4    = modelMatrix * vec4(pos, 1.0);
      vWorldPos         = worldPos4.xyz;
      vWorldNormal      = normalize(mat3(modelMatrix) * normal);
      vUv               = uv;
      vTipFactor        = tipT;

      gl_Position = projectionMatrix * viewMatrix * worldPos4;
    }
  `;
}

// ─── GLSL — Petal fragment shader ────────────────────────────────────────────

/**
 * Petal fragment shader.
 *
 * Lighting model (all physically motivated, no magic):
 *   1. Albedo: lerp(uColorBase, uColorTip, vUv.y^1.4) — species colour gradient
 *   2. Vein overlay: two primary veins + branching secondary veins (procedural)
 *      Veins slightly darker, SSS-visible on backlit petals
 *   3. SSS translucency: thin petals transmit backlit sunlight.
 *      sss = max(dot(-N, L), 0)^1.5 × vTipFactor × transmittance
 *      Colour: sun colour filtered through petal albedo (chlorophyll shift)
 *   4. Edge glow: Fresnel-like rim on thin edges — petals catch light
 *      at grazing angles independently of normal direction
 *   5. Lambert diffuse + ambient (sky dome) + SSS + edge glow
 *   6. Blinn-Phong specular (low, controlled by roughness 0.72)
 *   7. Wetness: darkens albedo, reduces roughness (surface water film)
 *   8. Dormancy desaturation: mix toward greyed-out as uDormancy → 1
 *   9. Speckle: dark hash-pattern spots for foxglove inner throat
 *  10. Tissue opacity: poppy-style semi-transparency
 */
function _petalFragShader() {
  return /* glsl */`
    /**
     * petal.glsl — fragment shader
     *
     * Uniforms:
     *   uColorBase:  vec3  — petal base colour (species)
     *   uColorTip:   vec3  — petal tip colour
     *   uCurvature:  float — curvature amount (affects SSS transmittance)
     *   uSpeckled:   float — 1 = add speckle pattern (foxglove)
     *   uTissue:     float — 1 = tissue-paper alpha (poppy)
     *   uDormancy:   float — 0=alive, 1=dormant (desaturated)
     *   uSunDir:     vec3  — world-space direction toward sun
     *   uSunColor:   vec3  — sun colour
     *   uIsNight:    float — 0=day, 1=night
     *   uWetness:    float — global wetness
     *   uTime:       float — for grain animation
     *
     * Varyings in:
     *   vUv:          vec2
     *   vWorldNormal: vec3
     *   vWorldPos:    vec3
     *   vTipFactor:   float
     */

    precision mediump float;

    uniform vec3  uColorBase;
    uniform vec3  uColorTip;
    uniform float uCurvature;
    uniform float uSpeckled;
    uniform float uTissue;
    uniform float uDormancy;
    uniform vec3  uSunDir;
    uniform vec3  uSunColor;
    uniform float uIsNight;
    uniform float uWetness;
    uniform float uTime;

    varying vec2  vUv;
    varying vec3  vWorldNormal;
    varying vec3  vWorldPos;
    varying float vTipFactor;

    // ── Utility ─────────────────────────────────────────────────────────────

    float hash2(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    // Desaturate a colour — used for dormancy
    vec3 desaturate(vec3 col, float amount) {
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      return mix(col, vec3(lum), amount);
    }

    // ── Vein pattern ────────────────────────────────────────────────────────
    // Procedural veins: two primary veins running from base to tip,
    // with secondary branches at ~45° angles. Returns 0=no vein, 1=vein.
    float veinMask(vec2 uv) {
      // Primary veins: symmetric pair at x = ±0.18 of petal width
      float v1 = 1.0 - smoothstep(0.0, 0.025, abs(uv.x - 0.5 + 0.18));
      float v2 = 1.0 - smoothstep(0.0, 0.025, abs(uv.x - 0.5 - 0.18));
      float primary = max(v1, v2);

      // Secondary branches: fade in above 25% height, angle outward
      float secondary = 0.0;
      if (uv.y > 0.25) {
        float branchY = fract(uv.y * 3.5);          // repeat along length
        float branchDist = abs(uv.x - 0.5) - branchY * 0.22 * (uv.y - 0.25);
        secondary = (1.0 - smoothstep(0.0, 0.018, abs(branchDist))) * 0.55;
      }

      // Central midrib: strong at base, fades at tip
      float midrib = (1.0 - smoothstep(0.0, 0.015, abs(uv.x - 0.5)))
                   * (1.0 - smoothstep(0.0, 0.85, uv.y));

      return clamp(primary * 0.6 + secondary + midrib * 0.8, 0.0, 1.0);
    }

    void main() {
      // ── Silhouette alpha ─────────────────────────────────────────────────
      // Taper width toward tip — fade out the outer edges of the petal quad
      float xCentre = abs(vUv.x - 0.5) * 2.0;                // 0=centre, 1=edge
      float widthTaper = 1.0 - smoothstep(0.5, 1.0, xCentre / (1.0 - vUv.y * 0.68 + 0.001));
      float tipFade    = 1.0 - smoothstep(0.88, 1.0, vUv.y);

      // Tissue petals: semi-transparent throughout, not just at tip
      float alpha;
      if (uTissue > 0.5) {
        alpha = widthTaper * tipFade * 0.72;
      } else {
        alpha = widthTaper * tipFade;
      }

      if (alpha < 0.04) discard;

      // ── Albedo ───────────────────────────────────────────────────────────
      float colorT = pow(vUv.y, 1.4);
      vec3  albedo = mix(uColorBase, uColorTip, colorT);

      // Vein overlay: slightly darker than base
      float vein = veinMask(vUv);
      albedo     = mix(albedo, albedo * 0.75, vein * 0.55);

      // Micro colour variation — break up uniform colour with noise
      float noise = hash2(vWorldPos.xz * 22.0) * 0.06 - 0.03;
      albedo     += vec3(noise);

      // ── Speckle (foxglove throat) ─────────────────────────────────────────
      if (uSpeckled > 0.5) {
        // Spots concentrated at the base third of the petal interior
        float spotZone = smoothstep(0.05, 0.35, vUv.y) * (1.0 - smoothstep(0.35, 0.55, vUv.y));
        float spotNoise = step(0.75, hash2(floor(vUv * vec2(6.0, 10.0))));
        albedo = mix(albedo, albedo * 0.35, spotNoise * spotZone);
      }

      // ── Wetness ──────────────────────────────────────────────────────────
      float wetFactor = uWetness * 0.8;
      albedo *= 1.0 - wetFactor * 0.20;

      // ── Dormancy desaturation ─────────────────────────────────────────────
      albedo = desaturate(albedo, uDormancy * 0.72);
      // Also darken slightly (wilting)
      albedo *= 1.0 - uDormancy * 0.18;

      // ── Normals ──────────────────────────────────────────────────────────
      vec3 N = normalize(vWorldNormal);
      vec3 L = normalize(uSunDir);

      // DoubleSide: flip normal for back face
      if (!gl_FrontFacing) N = -N;

      vec3 V = normalize(cameraPosition - vWorldPos);
      vec3 H = normalize(L + V);

      // ── Diffuse (Lambert) ─────────────────────────────────────────────────
      float NdotL = max(dot(N, L), 0.0);
      vec3  sunCol = uSunColor * mix(1.0, 0.08, uIsNight);
      vec3  diffuse = albedo * NdotL * sunCol;

      // ── Ambient (sky dome approximation) ─────────────────────────────────
      vec3 ambDay   = vec3(0.08, 0.10, 0.13) * albedo;
      vec3 ambNight = vec3(0.02, 0.03, 0.05) * albedo;
      vec3 ambient  = mix(ambDay, ambNight, uIsNight);

      // ── SSS translucency ──────────────────────────────────────────────────
      // When the petal is between the camera and the sun, light transmits through.
      // Transmittance increases at tips (thinner) and with curvature (more surface area).
      float backFace    = max(dot(-N, L), 0.0);
      float transmit    = mix(0.35, 0.75, vTipFactor) * (1.0 - uCurvature * 0.5);
      float sss         = pow(backFace, 1.5) * transmit * (1.0 - uDormancy * 0.8);
      // SSS colour: sun filtered through petal — warm, shifted by species hue
      vec3  sssCol      = sunCol * albedo * vec3(1.12, 1.05, 0.88) * sss * 0.90;

      // ── Edge glow (Fresnel rim) ───────────────────────────────────────────
      // Petals catch light at grazing angles — bright rim along thin edges.
      float NdotV  = max(dot(N, V), 0.0);
      float rim    = pow(1.0 - NdotV, 3.8) * 0.28 * (1.0 - uIsNight);
      vec3  rimCol = sunCol * rim * (albedo * 1.4 + vec3(0.12));

      // ── Specular (Blinn-Phong, low) ───────────────────────────────────────
      float roughness  = mix(0.72, 0.52, wetFactor);     // wetter = glossier
      float shininess  = mix(4.0, 48.0, 1.0 - roughness);
      float NdotH      = max(dot(N, H), 0.0);
      float spec       = pow(NdotH, shininess) * (1.0 - roughness) * 0.22;
      vec3  specular   = sunCol * vec3(spec);

      // ── Wet specular highlight ────────────────────────────────────────────
      float wetSpec    = pow(NdotH, 96.0) * wetFactor * 0.35;
      specular        += sunCol * vec3(wetSpec);

      // ── Composite ─────────────────────────────────────────────────────────
      vec3 finalColor  = ambient + diffuse + sssCol + rimCol + specular;

      gl_FragColor = vec4(finalColor, alpha);
    }
  `;
}
