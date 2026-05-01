/**
 * flower.js — Individual flower organism
 * Atlas: The Living World
 *
 * A self-contained ES6 class representing one living flower tied to one habit.
 * Garden.js instantiates one Flower per habit row and calls update() every frame.
 *
 * Complete responsibilities:
 *   ┌─ Geometry ──────────────────────────────────────────────────────────────┐
 *   │  Stem:    CubicBezierCurve3 → TubeGeometry, organically leaning,       │
 *   │           radius tapers base→tip, MeshStandardMaterial with wetness     │
 *   │  Leaves:  Two leaf pairs at 35% and 65% of stem; PlaneGeometry tapered  │
 *   │           silhouette; species-derived colour; drooping angle             │
 *   │  Petals:  Species-specific count, shape, and layout. Four layouts:      │
 *   │           radial fan, layered rings (peony/ranunculus), spike (foxglove) │
 *   │           drooping raceme (wisteria). PlaneGeometry with curvature       │
 *   │           encoded in vertex positions. Custom ShaderMaterial.            │
 *   │  Disk:    Central SphereGeometry dome or CylinderGeometry disc           │
 *   │  Pollen:  8 SphereGeometry motes; initially hidden; burst on check-in  │
 *   └─────────────────────────────────────────────────────────────────────────┘
 *   ┌─ Shaders ───────────────────────────────────────────────────────────────┐
 *   │  Petal vertex: wind flutter (3-frequency, tip-powered), dormancy droop  │
 *   │  Petal fragment: albedo gradient, procedural veins, SSS translucency,   │
 *   │                  Fresnel rim, Lambert diffuse, Blinn-Phong specular,     │
 *   │                  wetness response, dormancy desaturation, speckle,      │
 *   │                  tissue-paper opacity                                    │
 *   └─────────────────────────────────────────────────────────────────────────┘
 *   ┌─ Animation ─────────────────────────────────────────────────────────────┐
 *   │  Wind:         Three-frequency stem sway with spatial travelling wave   │
 *   │  Heliotropism: Sunflower head tracks live sun azimuth, ~2 min full arc  │
 *   │  Phototropism: Stem tilts toward camera on hover (±0.22 rad, lerp 0.03) │
 *   │  Growth:       Continuous real-time scale from age, easeOutCubic/Quart  │
 *   │  Dormancy:     3-day gap → petals droop + desaturate, lerp 0.4/s        │
 *   │  Bloom burst:  pollen motes erupt on first check-in after bloom stage   │
 *   └─────────────────────────────────────────────────────────────────────────┘
 *   ┌─ Interaction ───────────────────────────────────────────────────────────┐
 *   │  setHovered(bool):  triggers / releases phototropism                    │
 *   │  checkin():         clears dormancy, spawns pollen burst, re-bloom 55%  │
 *   │  getPickTargets():  returns [stemMesh, diskMesh] for raycasting         │
 *   └─────────────────────────────────────────────────────────────────────────┘
 *
 * Scene graph (all children of this.root):
 *
 *   root (Object3D) — world-space pivot, terrain-grounded
 *   └─ stemPivot (Object3D) — phototropism + wind rotation applied here
 *      ├─ stemMesh (Mesh)     — TubeGeometry stem
 *      ├─ leafGroup0 (Group)  — two leaves at 35% height
 *      ├─ leafGroup1 (Group)  — two leaves at 65% height
 *      ├─ headPivot (Object3D) — positioned at stem tip
 *      │  ├─ diskMesh (Mesh)    — central flower disk
 *      │  └─ petalGroup (Object3D) — all petal Meshes
 *      └─ pollenGroup (Object3D) — pollen particle Meshes
 *
 * Dependencies:
 *   THREE (window.THREE, r128 global), config.js, state.js, terrain.js
 *   Species data embedded directly in this file — no external data import needed.
 *
 * Usage (called by garden.js / flowers.js):
 *   const f = new Flower(habitRow, scene);
 *   registerUpdate((dt, t) => f.update(dt, t));
 *   // on interaction —
 *   f.setHovered(true);
 *   f.checkin();
 *   // on teardown —
 *   f.dispose();
 */

import { CONFIG }      from '../core/config.js';
import { state }       from '../core/state.js';
import { getHeightAt } from '../world/terrain.js';

const THREE = window.THREE;

// ─── Constants ────────────────────────────────────────────────────────────────

/** Days without check-in before dormancy begins. */
const DORMANCY_THRESHOLD_DAYS  = 3;

/** Probability that a dormant flower re-blooms on next check-in. */
const REBLOOOM_RATE            = 0.55;

/** Pollen motes emitted per bloom burst. */
const POLLEN_COUNT             = 8;

/** Max stem tilt angle toward camera on hover (radians). */
const PHOTOTROPISM_MAX_ANGLE   = 0.22;

/** Lerp speed for phototropism tilt per frame. */
const PHOTOTROPISM_LERP_SPEED  = 0.03;

/** Lerp speed for dormancy fade (fraction per second). */
const DORMANCY_LERP_SPEED      = 0.40;

// ─── Species table ────────────────────────────────────────────────────────────
//
// Single authoritative source for all twelve species.
// Shared with flowers.js via import; also embedded here for organism autonomy.
// All sizes in world units (1 unit ≈ 1 metre).

export const SPECIES = {

  sunflower: {
    // Habit categories this species represents
    category:        ['fitness', 'exercise', 'gym', 'sport'],
    // Mature stem height range [min, max]
    stemHeight:      [0.90, 1.40],
    // Stem tube radius range [base, tip proportional min-max]
    stemRadius:      [0.012, 0.016],
    // Stem & leaf colour (linear RGB)
    stemColor:       [0.18, 0.38, 0.10],
    // Total petal count (outer ring for layered species)
    petalCount:      18,
    petalLength:     [0.14, 0.18],
    petalWidth:      [0.038, 0.048],
    // 0=flat, 0.5=strongly cupped. Encoded into geometry vertex positions.
    petalCurvature:  0.18,
    // Colour stops from base to tip for layered gradient in fragment shader
    petalColors:     [[0.92, 0.72, 0.05], [0.86, 0.58, 0.02]],
    diskColor:       [0.18, 0.10, 0.04],
    diskRadius:      0.08,
    leafScale:       1.6,
    windAmplitude:   0.10,   // radians of sway at full wind strength
    windFrequency:   0.55,   // primary sway frequency (Hz)
    // Head tracks live sun azimuth continuously
    heliotropic:     true,
    bloomDays:       22,
    // Layout flags — only one may be true, or none for standard radial fan
    layeredPetals:   false,
    droopingCluster: false,
    spikeArranged:   false,
    tissueThick:     false,
    speckled:        false,
    clusterCount:    1,
  },

  iris: {
    category:        ['study', 'learning', 'exam', 'language', 'skill'],
    stemHeight:      [0.55, 0.85],
    stemRadius:      [0.008, 0.011],
    stemColor:       [0.16, 0.35, 0.12],
    // 3 upright standards + 3 drooping falls — handled by iris-specific layout
    petalCount:      6,
    petalLength:     [0.10, 0.14],
    petalWidth:      [0.042, 0.055],
    petalCurvature:  0.28,
    petalColors:     [[0.28, 0.18, 0.62], [0.42, 0.28, 0.78]],
    diskColor:       [0.85, 0.78, 0.20],
    diskRadius:      0.012,
    leafScale:       1.2,
    windAmplitude:   0.07,
    windFrequency:   0.68,
    heliotropic:     false,
    bloomDays:       22,
    layeredPetals:   false,
    droopingCluster: false,
    spikeArranged:   false,
    tissueThick:     false,
    speckled:        false,
    clusterCount:    1,
    irisLayout:      true,   // 3 standards upright, 3 falls drooping
  },

  lavender: {
    category:        ['meditat', 'mindful', 'breathing', 'mind', 'calm'],
    stemHeight:      [0.40, 0.70],
    stemRadius:      [0.005, 0.007],
    stemColor:       [0.22, 0.40, 0.15],
    // Dense spike of tiny florets — spikeArranged handles layout
    petalCount:      24,
    petalLength:     [0.018, 0.024],
    petalWidth:      [0.010, 0.014],
    petalCurvature:  0.05,
    petalColors:     [[0.52, 0.35, 0.72], [0.62, 0.45, 0.80]],
    diskColor:       [0.55, 0.38, 0.72],
    diskRadius:      0.004,
    leafScale:       0.7,
    windAmplitude:   0.14,
    windFrequency:   1.10,
    heliotropic:     false,
    bloomDays:       18,
    layeredPetals:   false,
    droopingCluster: false,
    spikeArranged:   true,   // florets stacked up the spike
    tissueThick:     false,
    speckled:        false,
    clusterCount:    1,
  },

  forget_me_not: {
    category:        ['reading', 'book', 'read'],
    stemHeight:      [0.20, 0.38],
    stemRadius:      [0.004, 0.006],
    stemColor:       [0.20, 0.42, 0.14],
    petalCount:      5,
    petalLength:     [0.020, 0.028],
    petalWidth:      [0.018, 0.024],
    petalCurvature:  0.08,
    petalColors:     [[0.40, 0.65, 0.92], [0.50, 0.72, 0.96]],
    diskColor:       [0.95, 0.90, 0.22],
    diskRadius:      0.008,
    leafScale:       0.6,
    windAmplitude:   0.18,
    windFrequency:   1.30,
    heliotropic:     false,
    bloomDays:       14,
    layeredPetals:   false,
    droopingCluster: false,
    spikeArranged:   false,
    tissueThick:     false,
    speckled:        false,
    // Multiple small flower heads per stem, branching from top
    clusterCount:    5,
  },

  anemone: {
    category:        ['water', 'hydrat', 'drink'],
    stemHeight:      [0.28, 0.50],
    stemRadius:      [0.006, 0.009],
    stemColor:       [0.18, 0.38, 0.10],
    petalCount:      8,
    petalLength:     [0.055, 0.075],
    petalWidth:      [0.030, 0.040],
    petalCurvature:  0.12,
    petalColors:     [[0.96, 0.94, 0.92], [0.88, 0.85, 0.82]],
    diskColor:       [0.08, 0.05, 0.18],
    diskRadius:      0.022,
    leafScale:       0.9,
    windAmplitude:   0.09,
    windFrequency:   0.80,
    heliotropic:     false,
    bloomDays:       18,
    layeredPetals:   false,
    droopingCluster: false,
    spikeArranged:   false,
    tissueThick:     false,
    speckled:        false,
    clusterCount:    1,
  },

  cosmos: {
    category:        ['sleep', 'rest', 'wake'],
    stemHeight:      [0.55, 0.95],
    stemRadius:      [0.005, 0.007],
    stemColor:       [0.18, 0.38, 0.10],
    petalCount:      8,
    petalLength:     [0.065, 0.085],
    petalWidth:      [0.022, 0.030],
    petalCurvature:  0.06,
    petalColors:     [[0.95, 0.72, 0.80], [0.98, 0.88, 0.90]],
    diskColor:       [0.92, 0.72, 0.10],
    diskRadius:      0.018,
    leafScale:       0.9,
    windAmplitude:   0.16,
    windFrequency:   0.92,
    heliotropic:     false,
    bloomDays:       18,
    layeredPetals:   false,
    droopingCluster: false,
    spikeArranged:   false,
    tissueThick:     false,
    speckled:        false,
    clusterCount:    1,
  },

  peony: {
    category:        ['journal', 'diary', 'writ'],
    stemHeight:      [0.45, 0.75],
    stemRadius:      [0.010, 0.014],
    stemColor:       [0.18, 0.35, 0.10],
    // Three concentric rings; outer ring gets this count, inner rings scale down
    petalCount:      32,
    petalLength:     [0.055, 0.080],
    petalWidth:      [0.040, 0.055],
    petalCurvature:  0.35,
    petalColors:     [[0.82, 0.22, 0.38], [0.90, 0.40, 0.52], [0.98, 0.72, 0.80]],
    diskColor:       [0.92, 0.78, 0.20],
    diskRadius:      0.005,
    leafScale:       1.3,
    windAmplitude:   0.06,
    windFrequency:   0.50,
    heliotropic:     false,
    bloomDays:       22,
    layeredPetals:   true,
    droopingCluster: false,
    spikeArranged:   false,
    tissueThick:     false,
    speckled:        false,
    clusterCount:    1,
  },

  ranunculus: {
    category:        ['creat', 'art', 'draw', 'design', 'music', 'make'],
    stemHeight:      [0.35, 0.60],
    stemRadius:      [0.008, 0.011],
    stemColor:       [0.18, 0.38, 0.10],
    petalCount:      28,
    petalLength:     [0.045, 0.065],
    petalWidth:      [0.032, 0.045],
    petalCurvature:  0.28,
    petalColors:     [[0.92, 0.52, 0.10], [0.95, 0.65, 0.18], [0.98, 0.80, 0.35]],
    diskColor:       [0.22, 0.18, 0.08],
    diskRadius:      0.008,
    leafScale:       1.1,
    windAmplitude:   0.07,
    windFrequency:   0.60,
    heliotropic:     false,
    bloomDays:       20,
    layeredPetals:   true,
    droopingCluster: false,
    spikeArranged:   false,
    tissueThick:     false,
    speckled:        false,
    clusterCount:    1,
  },

  wisteria: {
    category:        ['social', 'friend', 'famil', 'connect', 'call', 'talk'],
    stemHeight:      [0.50, 0.85],
    stemRadius:      [0.007, 0.010],
    stemColor:       [0.18, 0.30, 0.10],
    petalCount:      16,
    petalLength:     [0.025, 0.035],
    petalWidth:      [0.016, 0.022],
    petalCurvature:  0.10,
    petalColors:     [[0.55, 0.40, 0.78], [0.65, 0.50, 0.85], [0.78, 0.65, 0.92]],
    diskColor:       [0.72, 0.60, 0.88],
    diskRadius:      0.006,
    leafScale:       1.0,
    windAmplitude:   0.20,
    windFrequency:   0.75,
    heliotropic:     false,
    bloomDays:       20,
    layeredPetals:   false,
    droopingCluster: true,
    spikeArranged:   false,
    tissueThick:     false,
    speckled:        false,
    clusterCount:    1,
  },

  foxglove: {
    category:        ['nutrit', 'food', 'eat', 'diet', 'cook', 'meal'],
    stemHeight:      [0.80, 1.20],
    stemRadius:      [0.009, 0.013],
    stemColor:       [0.18, 0.35, 0.10],
    // Tubular bells stacked up the spike
    petalCount:      12,
    petalLength:     [0.055, 0.075],
    petalWidth:      [0.045, 0.060],
    petalCurvature:  0.45,
    petalColors:     [[0.88, 0.48, 0.58], [0.92, 0.60, 0.68]],
    diskColor:       [0.95, 0.92, 0.90],
    diskRadius:      0.006,
    leafScale:       1.5,
    windAmplitude:   0.08,
    windFrequency:   0.52,
    heliotropic:     false,
    bloomDays:       24,
    layeredPetals:   false,
    droopingCluster: false,
    spikeArranged:   true,
    tissueThick:     false,
    speckled:        true,   // dark spots on inner throat
    clusterCount:    1,
  },

  protea: {
    category:        ['outdoor', 'walk', 'run', 'nature', 'hike'],
    stemHeight:      [0.55, 0.90],
    stemRadius:      [0.012, 0.016],
    stemColor:       [0.22, 0.32, 0.12],
    // Bracts surrounding a central cone — treated as standard radial fan
    petalCount:      24,
    petalLength:     [0.070, 0.095],
    petalWidth:      [0.020, 0.028],
    petalCurvature:  0.08,
    petalColors:     [[0.82, 0.42, 0.35], [0.90, 0.58, 0.48], [0.96, 0.80, 0.72]],
    diskColor:       [0.88, 0.78, 0.70],
    diskRadius:      0.035,
    leafScale:       1.4,
    windAmplitude:   0.06,
    windFrequency:   0.45,
    heliotropic:     false,
    bloomDays:       26,
    layeredPetals:   false,
    droopingCluster: false,
    spikeArranged:   false,
    tissueThick:     false,
    speckled:        false,
    clusterCount:    1,
  },

  poppy: {
    // Catch-all — used when no category keyword matches
    category:        [],
    stemHeight:      [0.42, 0.72],
    stemRadius:      [0.006, 0.008],
    stemColor:       [0.18, 0.38, 0.10],
    petalCount:      4,
    petalLength:     [0.065, 0.090],
    petalWidth:      [0.055, 0.075],
    petalCurvature:  0.05,
    petalColors:     [[0.90, 0.18, 0.08], [0.95, 0.32, 0.12]],
    diskColor:       [0.08, 0.06, 0.04],
    diskRadius:      0.020,
    leafScale:       1.0,
    windAmplitude:   0.22,
    windFrequency:   0.88,
    heliotropic:     false,
    bloomDays:       16,
    layeredPetals:   false,
    droopingCluster: false,
    spikeArranged:   false,
    // Very thin semi-transparent petals — like tissue paper
    tissueThick:     true,
    speckled:        false,
    clusterCount:    1,
  },
};

// ─── Flower class ─────────────────────────────────────────────────────────────

export class Flower {

  /**
   * Construct and place one flower in the scene.
   *
   * @param {Object}       habit   Row from state.habits (id, name, category,
   *                               created_at, flower_species optional)
   * @param {THREE.Scene}  scene   The live Three.js scene
   */
  constructor(habit, scene) {
    this._habit    = habit;
    this._scene    = scene;
    this._specKey  = Flower.resolveSpecies(habit);
    this._spec     = SPECIES[this._specKey];

    // ── Animation state ────────────────────────────────────────────────────
    this._windPhase          = _seededRand(habit.id, 2) * Math.PI * 2;
    this._heliotropicYaw     = 0;
    this._phototropicPitch   = 0;
    this._phototropicTarget  = 0;
    this._dormancyT          = 0;    // lerped 0→1
    this._hovered            = false;
    this._bloomed            = false; // pollen burst sent once per bloom stage entry

    // ── Derived geometry parameters (seeded from habit id) ─────────────────
    const r0 = _seededRand(habit.id, 0);
    this._stemH = _lerp(
      this._spec.stemHeight[0],
      this._spec.stemHeight[1],
      r0
    );

    // ── Determine initial state ────────────────────────────────────────────
    this._ageDays   = _ageDays(habit.created_at);
    this._scale     = _growthScale(this._ageDays, this._spec);
    this._dormant   = _isDormant(habit);
    this._dormancyT = this._dormant ? 1.0 : 0.0;

    // ── Build scene graph ──────────────────────────────────────────────────
    this._buildSceneGraph();

    // ── Apply initial growth scale ─────────────────────────────────────────
    this.root.scale.setScalar(this._scale);

    // ── Add to scene ──────────────────────────────────────────────────────
    scene.add(this.root);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Per-frame update. Called by flowers.js with scene deltaTime and elapsed.
   *
   * @param {number} delta    Seconds since last frame
   * @param {number} elapsed  Total elapsed seconds since scene start
   */
  update(delta, elapsed) {
    this._updateDormancy(delta);
    this._updateWind(elapsed);
    this._updateHeliotropism(delta);
    this._updatePhototropism(delta);
    this._updateGrowth();
    this._updatePetalUniforms(elapsed, delta);
    this._updatePollen(delta);
  }

  /**
   * Notify this flower that it has been hovered or un-hovered.
   * Triggers / releases phototropism.
   *
   * @param {boolean} hovered
   */
  setHovered(hovered) {
    this._hovered = hovered;
  }

  /**
   * Record a new habit check-in. Clears dormancy, spawns pollen burst,
   * and possibly re-blooms if the flower was dormant.
   */
  checkin() {
    const wasDormant  = this._dormant;
    this._dormant     = false;

    if (wasDormant && Math.random() < REBLOOOM_RATE) {
      // Re-bloom: reset bloom flag so pollen burst fires again
      this._bloomed = false;
    }

    this._spawnPollenBurst();
  }

  /**
   * Return the meshes that the raycaster in flowers.js should test against.
   * These are the broadest collision targets for this flower.
   *
   * @returns {THREE.Mesh[]}
   */
  getPickTargets() {
    const targets = [];
    if (this._stemMesh) targets.push(this._stemMesh);
    if (this._diskMesh) targets.push(this._diskMesh);
    return targets;
  }

  /**
   * Dispose all GPU resources and remove from scene.
   * Must be called on logout or zone teardown.
   */
  dispose() {
    if (this.root && this.root.parent) {
      this.root.parent.remove(this.root);
    }

    this.root.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });

    this._scene    = null;
    this._stemMesh = null;
    this._diskMesh = null;
  }

  /**
   * Resolve which species key a habit row maps to.
   * Static so flowers.js can call it without instantiating.
   *
   * @param {Object} habit
   * @returns {string}  Key into SPECIES
   */
  static resolveSpecies(habit) {
    // Explicit override wins
    if (habit.flower_species && SPECIES[habit.flower_species]) {
      return habit.flower_species;
    }

    const name = (
      (habit.name     || '') + ' ' +
      (habit.category || '')
    ).toLowerCase();

    for (const [key, spec] of Object.entries(SPECIES)) {
      if (key === 'poppy') continue;   // poppy = catch-all, skip in scan
      for (const kw of spec.category) {
        if (name.includes(kw)) return key;
      }
    }

    return 'poppy';
  }

  // ── Scene graph construction ───────────────────────────────────────────────

  _buildSceneGraph() {
    const habit = this._habit;
    const spec  = this._spec;

    // World-space position, terrain-grounded
    const pos = _habitPosition(habit);
    const y   = getHeightAt(pos.x, pos.z);

    // ── Root pivot ──────────────────────────────────────────────────────────
    this.root = new THREE.Object3D();
    this.root.position.set(pos.x, y, pos.z);
    this.root.userData = { habitId: habit.id, species: this._specKey };

    // ── Stem pivot — wind and phototropism are applied here ─────────────────
    this._stemPivot = new THREE.Object3D();
    this.root.add(this._stemPivot);

    // ── Stem ────────────────────────────────────────────────────────────────
    this._stemMesh = this._buildStem();
    this._stemPivot.add(this._stemMesh);
    // Tag for raycaster identification
    this._stemMesh.userData.flowerRef = this;

    // ── Leaf pairs ──────────────────────────────────────────────────────────
    this._leafGroup0 = this._buildLeafPair(0.35, 0);
    this._leafGroup1 = this._buildLeafPair(0.65, 1);
    this._stemPivot.add(this._leafGroup0);
    this._stemPivot.add(this._leafGroup1);

    // ── Head pivot at stem tip ───────────────────────────────────────────────
    this._headPivot = new THREE.Object3D();
    this._headPivot.position.set(0, this._stemH, 0);
    this._stemPivot.add(this._headPivot);

    // ── Disk ────────────────────────────────────────────────────────────────
    this._diskMesh = this._buildDisk();
    this._headPivot.add(this._diskMesh);
    this._diskMesh.userData.flowerRef = this;

    // ── Petals ──────────────────────────────────────────────────────────────
    this._petalGroup = new THREE.Object3D();
    this._headPivot.add(this._petalGroup);
    this._buildAllPetals();

    // ── Pollen group at head position ────────────────────────────────────────
    this._pollenGroup = new THREE.Object3D();
    this._pollenGroup.position.set(0, this._stemH, 0);
    this._stemPivot.add(this._pollenGroup);
    this._buildPollenParticles();

    // ── Cluster heads (forget-me-not and species with clusterCount > 1) ─────
    if (spec.clusterCount > 1) {
      this._buildClusterHeads();
    }
  }

  // ── Stem ───────────────────────────────────────────────────────────────────

  /**
   * Build the stem as a TubeGeometry extruded along a CubicBezierCurve3.
   * The four control points create an organic, naturally leaning posture.
   * Radius tapers from base to ~42% at tip via direct vertex manipulation.
   *
   * @returns {THREE.Mesh}
   */
  _buildStem() {
    const spec    = this._spec;
    const id      = this._habit.id;
    const h       = this._stemH;

    const r0 = _seededRand(id, 10);
    const r1 = _seededRand(id, 11);

    // Cubic Bezier control points — lean varies per-instance via seeded rand
    //   p0 = ground
    //   p1 = lower bend (35–38% up), random XZ lean
    //   p2 = upper bend (70–72% up), slight correction back toward vertical
    //   p3 = tip, very slight offset from vertical
    const p0 = new THREE.Vector3(0,                       0,       0);
    const p1 = new THREE.Vector3((r0 - 0.5) * h * 0.18,  h * 0.38, (r1 - 0.5) * h * 0.12);
    const p2 = new THREE.Vector3((r1 - 0.5) * h * 0.10,  h * 0.72, (r0 - 0.5) * h * 0.08);
    const p3 = new THREE.Vector3((r0 - 0.5) * h * 0.06,  h,        (r1 - 0.5) * h * 0.04);

    const curve    = new THREE.CubicBezierCurve3(p0, p1, p2, p3);
    const baseR    = _lerp(spec.stemRadius[0], spec.stemRadius[1], r0);
    const tipR     = baseR * 0.42;
    const tubeSeg  = 16;  // path segments — enough for smooth curves
    const radSeg   = 6;   // radial segments — hexagonal cross-section

    const geo = new THREE.TubeGeometry(curve, tubeSeg, baseR, radSeg, false);
    _taperTube(geo, curve, baseR, tipR, tubeSeg, radSeg);

    const mat = new THREE.MeshStandardMaterial({
      color:     new THREE.Color(spec.stemColor[0], spec.stemColor[1], spec.stemColor[2]),
      roughness: 0.82,
      metalness: 0.0,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow    = true;
    mesh.receiveShadow = false;

    // Store curve for leaf placement along actual path
    mesh.userData.curve = curve;

    return mesh;
  }

  // ── Leaf pairs ─────────────────────────────────────────────────────────────

  /**
   * Build a pair of leaves at a given fraction along the stem height.
   * Each leaf is a PlaneGeometry tapered toward its tip, angled outward
   * from the stem with a natural drooping angle.
   *
   * @param {number} fraction   0–1 along stem (0.35 or 0.65)
   * @param {number} pairIdx    0 or 1 (for seed variation)
   * @returns {THREE.Group}
   */
  _buildLeafPair(fraction, pairIdx) {
    const spec  = this._spec;
    const id    = this._habit.id;
    const group = new THREE.Group();
    const y     = this._stemH * fraction;
    const lLen  = spec.leafScale * 0.06;   // half-length in world units
    const lWid  = lLen * 0.42;

    // Use seeded rand so left/right symmetry is consistent per flower
    const r = _seededRand(id, 20 + pairIdx * 7);

    const leafMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(
        spec.stemColor[0] * 1.05,
        spec.stemColor[1] * 1.18,
        spec.stemColor[2] * 0.88
      ),
      roughness:   0.75,
      metalness:   0.0,
      side:        THREE.DoubleSide,
    });

    for (let side = 0; side < 2; side++) {
      // 4 width segments × 5 length segments — enough for a tapered silhouette
      const geo = new THREE.PlaneGeometry(lWid, lLen, 2, 5);
      const pos = geo.attributes.position;

      for (let i = 0; i < pos.count; i++) {
        const ly   = pos.getY(i);
        // t=0 at base, t=1 at tip
        const t    = (ly / lLen + 0.5);
        // Taper: width narrows toward tip
        const taper = 1.0 - t * 0.75;
        // Slight mid-rib bow: centre lifts in Z
        const midbow = Math.sin(t * Math.PI) * 0.008;
        pos.setX(i, pos.getX(i) * taper);
        pos.setZ(i, pos.getZ(i) + midbow);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();

      const mesh  = new THREE.Mesh(geo, leafMat.clone());
      mesh.position.set(0, y, 0);
      mesh.receiveShadow = false;
      mesh.castShadow    = false;

      // Alternate sides: 0° and 180° around stem Y axis, with random offset
      const azimuth = (side === 0 ? 0 : Math.PI) + (r - 0.5) * 0.9;
      // Droop: leaves hang outward at 30–48° from horizontal
      const droop   = 0.52 + r * 0.28;

      mesh.rotation.order = 'YXZ';
      mesh.rotation.y     = azimuth;
      mesh.rotation.x     = droop;

      group.add(mesh);
    }

    return group;
  }

  // ── Disk ───────────────────────────────────────────────────────────────────

  /**
   * Build the flower's central disk.
   * Prominent disk species (sunflower, anemone, protea) use a hemisphere dome.
   * All others use a flat cylinder disc.
   *
   * @returns {THREE.Mesh}
   */
  _buildDisk() {
    const spec = this._spec;
    const col  = new THREE.Color(spec.diskColor[0], spec.diskColor[1], spec.diskColor[2]);
    const r    = spec.diskRadius;

    let geo;
    if (r > 0.025) {
      // Hemisphere dome — prominent disk
      geo = new THREE.SphereGeometry(r, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.52);
    } else {
      // Flat disc
      geo = new THREE.CylinderGeometry(r, r * 1.12, r * 0.45, 12, 1);
    }

    const mat  = new THREE.MeshStandardMaterial({ color: col, roughness: 0.80, metalness: 0.02 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow    = false;
    mesh.receiveShadow = false;
    return mesh;
  }

  // ── Petals ─────────────────────────────────────────────────────────────────

  /**
   * Dispatch to the correct petal layout builder based on species flags.
   */
  _buildAllPetals() {
    const spec = this._spec;

    if (spec.irisLayout) {
      this._buildIrisPetals();
    } else if (spec.spikeArranged) {
      this._buildSpikedPetals();
    } else if (spec.droopingCluster) {
      this._buildDroopingCluster();
    } else {
      // Standard radial fan — also handles layeredPetals
      this._buildRadialPetals();
    }
  }

  /**
   * Standard radial fan.
   * For layeredPetals species (peony, ranunculus) three concentric rings are
   * built at progressively smaller scale and increasing upward cup angle.
   * Each ring uses the next colour stop in petalColors[].
   */
  _buildRadialPetals() {
    const spec   = this._spec;
    const rings  = spec.layeredPetals ? 3 : 1;

    for (let ring = 0; ring < rings; ring++) {
      const ringScale   = 1.0 - ring * 0.22;
      const ringTiltAdd = ring * 0.20;           // inner rings cup more steeply
      const ringYOff    = ring * 0.006;          // inner rings sit slightly above outer
      const colorIdx    = Math.min(ring, spec.petalColors.length - 1);
      const col         = spec.petalColors[colorIdx];
      const col2        = spec.petalColors[Math.min(colorIdx + 1, spec.petalColors.length - 1)];
      const ringCount   = spec.layeredPetals
        ? Math.round(spec.petalCount / (ring + 1.5))
        : spec.petalCount;

      for (let i = 0; i < ringCount; i++) {
        const angle = (i / ringCount) * Math.PI * 2;
        const r0    = _seededRand(this._habit.id, 30 + ring * 60 + i);
        const pLen  = _lerp(spec.petalLength[0], spec.petalLength[1], r0) * ringScale;
        const pWid  = _lerp(spec.petalWidth[0],  spec.petalWidth[1],  r0) * ringScale;

        const geo  = _buildPetalGeo(pLen, pWid, spec.petalCurvature, spec.tissueThick);
        const mat  = _buildPetalMat(col, col2, spec.petalCurvature, spec.speckled, spec.tissueThick, this._dormant);
        const mesh = new THREE.Mesh(geo, mat);

        // Radial offset from disk: disk edge + half petal width so there's no gap
        const radOff = spec.diskRadius + pWid * 0.35;

        mesh.position.set(
          Math.sin(angle) * radOff,
          ringYOff,
          Math.cos(angle) * radOff
        );

        // YXZ rotation: face outward from disk, tilt back for curvature
        mesh.rotation.order = 'YXZ';
        mesh.rotation.y     = angle;
        // Tilt from vertical: petals lean back relative to disk plane
        mesh.rotation.x     = -(Math.PI * 0.5 - spec.petalCurvature * 0.85) - ringTiltAdd;
        // Dormant: tip droops downward
        if (this._dormant) mesh.rotation.x += 0.62;
        // Small random twist for naturalness
        mesh.rotation.z     = (_seededRand(this._habit.id, 80 + ring * 60 + i) - 0.5) * 0.14;

        this._petalGroup.add(mesh);
      }
    }
  }

  /**
   * Iris layout: 3 standard petals upright, 3 falls drooping downward.
   * Standards fan upward (rotation.x = -1.1 rad), falls spread outward-down
   * (rotation.x = +0.6 rad). Alternating around the disk.
   */
  _buildIrisPetals() {
    const spec = this._spec;
    const col  = spec.petalColors[0];
    const col2 = spec.petalColors[1] || col;

    for (let i = 0; i < 6; i++) {
      const isStandard = i % 2 === 0;      // alternating standard / fall
      const angle      = (i / 6) * Math.PI * 2;
      const r0         = _seededRand(this._habit.id, 30 + i);
      const pLen       = _lerp(spec.petalLength[0], spec.petalLength[1], r0);
      const pWid       = _lerp(spec.petalWidth[0],  spec.petalWidth[1],  r0);

      const geo  = _buildPetalGeo(pLen, pWid, spec.petalCurvature, false);
      const mat  = _buildPetalMat(col, col2, spec.petalCurvature, false, false, this._dormant);
      const mesh = new THREE.Mesh(geo, mat);

      const radOff = spec.diskRadius + pWid * 0.3;
      mesh.position.set(Math.sin(angle) * radOff, 0, Math.cos(angle) * radOff);

      mesh.rotation.order = 'YXZ';
      mesh.rotation.y     = angle;

      if (isStandard) {
        // Standards: upright, slightly backward
        mesh.rotation.x = -1.10;
      } else {
        // Falls: droop outward and down
        mesh.rotation.x = +0.55;
      }

      mesh.rotation.z = (_seededRand(this._habit.id, 90 + i) - 0.5) * 0.08;

      this._petalGroup.add(mesh);
    }
  }

  /**
   * Spike arrangement for lavender florets and foxglove bells.
   * Units are placed up a vertical spike with decreasing size toward tip.
   * Foxglove bells open strongly outward; lavender florets are compact.
   */
  _buildSpikedPetals() {
    const spec     = this._spec;
    const id       = this._habit.id;
    const col      = spec.petalColors[0];
    const col2     = spec.petalColors[1] || col;
    const isFoxglo = spec.speckled;   // foxglove has speckle; lavender does not
    // Spike height above the head pivot — proportional to stem height
    const spikeH   = (isFoxglo ? 0.30 : 0.18) * this._stemH;
    const count    = spec.petalCount;

    for (let i = 0; i < count; i++) {
      const t      = i / count;
      const y      = t * spikeH;
      const size   = _lerp(1.0, 0.42, t);      // units shrink toward tip
      const r0     = _seededRand(id, 40 + i);
      const pLen   = _lerp(spec.petalLength[0], spec.petalLength[1], r0) * size;
      const pWid   = _lerp(spec.petalWidth[0],  spec.petalWidth[1],  r0) * size;
      // Slight random azimuth twist per unit so they don't stack perfectly
      const azRand = (_seededRand(id, 41 + i) - 0.5) * 0.6;

      const geo  = _buildPetalGeo(pLen, pWid, spec.petalCurvature, false);
      const mat  = _buildPetalMat(col, col2, spec.petalCurvature, isFoxglo, false, this._dormant);
      const mesh = new THREE.Mesh(geo, mat);

      mesh.position.set(
        Math.sin(azRand) * 0.01,
        y,
        Math.cos(azRand) * 0.01
      );

      mesh.rotation.order = 'YXZ';
      mesh.rotation.y     = azRand;
      // Strong outward tilt for tubular bells; compact for lavender florets
      mesh.rotation.x     = -(Math.PI * 0.5 - spec.petalCurvature * (isFoxglo ? 1.6 : 0.8));

      this._petalGroup.add(mesh);
    }
  }

  /**
   * Wisteria drooping raceme: five sub-head Object3Ds hang below the head pivot,
   * each pre-rotated to droop. Each sub-head holds a small radial fan of petals.
   */
  _buildDroopingCluster() {
    const spec    = this._spec;
    const id      = this._habit.id;
    const subN    = 5;
    const petPerSub = Math.round(spec.petalCount / subN);

    for (let s = 0; s < subN; s++) {
      const sub  = new THREE.Object3D();
      const r0   = _seededRand(id, 50 + s);
      const r1   = _seededRand(id, 51 + s);

      sub.position.set(
        (r0 - 0.5) * 0.07,
        -s * 0.038 - r1 * 0.022,   // cascade downward
        (r1 - 0.5) * 0.07
      );
      sub.rotation.x = 0.40 + r0 * 0.30;    // each sub-head droops differently

      const colIdx  = s % spec.petalColors.length;
      const col     = spec.petalColors[colIdx];
      const col2    = spec.petalColors[(colIdx + 1) % spec.petalColors.length];

      for (let i = 0; i < petPerSub; i++) {
        const angle = (i / petPerSub) * Math.PI * 2;
        const r2    = _seededRand(id, 60 + s * 20 + i);
        const pLen  = _lerp(spec.petalLength[0], spec.petalLength[1], r2) * 0.55;
        const pWid  = _lerp(spec.petalWidth[0],  spec.petalWidth[1],  r2) * 0.55;

        const geo  = _buildPetalGeo(pLen, pWid, spec.petalCurvature, false);
        const mat  = _buildPetalMat(col, col2, spec.petalCurvature, false, false, this._dormant);
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

      this._petalGroup.add(sub);
    }
  }

  /**
   * Cluster heads for forget-me-not: multiple small flower heads branching
   * from the top of the stem on short secondary stalks.
   */
  _buildClusterHeads() {
    const spec  = this._spec;
    const id    = this._habit.id;
    const n     = spec.clusterCount;   // 5 for forget-me-not
    const col   = spec.petalColors[0];
    const col2  = spec.petalColors[1] || col;

    for (let c = 1; c < n; c++) {    // c=0 is the main head; secondary 1…n-1
      const r0     = _seededRand(id, 70 + c);
      const r1     = _seededRand(id, 71 + c);
      const angle  = (c / (n - 1)) * Math.PI * 2;
      const spread = 0.032 + r0 * 0.018;

      // Small secondary pivot hanging from headPivot
      const pivot = new THREE.Object3D();
      pivot.position.set(
        Math.sin(angle) * spread,
        -r1 * 0.02,
        Math.cos(angle) * spread
      );
      pivot.rotation.x = 0.15 + r0 * 0.25;  // droop slightly

      // Tiny disk
      const diskGeo = new THREE.SphereGeometry(spec.diskRadius * 0.8, 8, 6,
        0, Math.PI * 2, 0, Math.PI * 0.52);
      const diskMat = new THREE.MeshStandardMaterial({
        color:     new THREE.Color(spec.diskColor[0], spec.diskColor[1], spec.diskColor[2]),
        roughness: 0.80,
        metalness: 0.0,
      });
      pivot.add(new THREE.Mesh(diskGeo, diskMat));

      // Small petal ring
      for (let i = 0; i < spec.petalCount; i++) {
        const a   = (i / spec.petalCount) * Math.PI * 2;
        const r2  = _seededRand(id, 72 + c * 10 + i);
        const pLen = _lerp(spec.petalLength[0], spec.petalLength[1], r2) * 0.75;
        const pWid = _lerp(spec.petalWidth[0],  spec.petalWidth[1],  r2) * 0.75;

        const geo  = _buildPetalGeo(pLen, pWid, spec.petalCurvature, false);
        const mat  = _buildPetalMat(col, col2, spec.petalCurvature, false, false, this._dormant);
        const mesh = new THREE.Mesh(geo, mat);

        mesh.position.set(
          Math.sin(a) * (spec.diskRadius * 0.8 + pWid * 0.3),
          0,
          Math.cos(a) * (spec.diskRadius * 0.8 + pWid * 0.3)
        );
        mesh.rotation.order = 'YXZ';
        mesh.rotation.y     = a;
        mesh.rotation.x     = -(Math.PI * 0.5 - spec.petalCurvature * 0.8);

        pivot.add(mesh);
      }

      this._headPivot.add(pivot);
    }
  }

  // ── Pollen ─────────────────────────────────────────────────────────────────

  _buildPollenParticles() {
    for (let i = 0; i < POLLEN_COUNT; i++) {
      const geo  = new THREE.SphereGeometry(0.0038, 4, 4);
      const mat  = new THREE.MeshBasicMaterial({
        color:       0xf5d060,
        transparent: true,
        opacity:     0.0,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;

      // Launch velocity in random hemisphere, seeded per mote
      const angle = (i / POLLEN_COUNT) * Math.PI * 2;
      const lift  = 0.06 + _seededRand(this._habit.id, 90 + i) * 0.08;
      mesh.userData = {
        vx:      Math.sin(angle) * (0.04 + _seededRand(this._habit.id, 91 + i) * 0.05),
        vy:      lift,
        vz:      Math.cos(angle) * (0.04 + _seededRand(this._habit.id, 92 + i) * 0.05),
        life:    0.0,
        maxLife: 1.8 + _seededRand(this._habit.id, 93 + i) * 1.2,
        active:  false,
      };

      this._pollenGroup.add(mesh);
    }
  }

  _spawnPollenBurst() {
    for (const mesh of this._pollenGroup.children) {
      mesh.position.set(0, 0, 0);
      mesh.material.opacity = 0.88;
      mesh.visible          = true;
      mesh.userData.life    = 0.0;
      mesh.userData.active  = true;
    }
  }

  _updatePollen(delta) {
    for (const mesh of this._pollenGroup.children) {
      const d = mesh.userData;
      if (!d.active) continue;

      d.life += delta;
      const t = d.life / d.maxLife;

      // Physics: gravity + exponential drag
      d.vy -= delta * 0.05;
      d.vx *= Math.pow(1.0 - 0.65 * delta, 1);
      d.vz *= Math.pow(1.0 - 0.65 * delta, 1);

      mesh.position.x += d.vx * delta;
      mesh.position.y += d.vy * delta;
      mesh.position.z += d.vz * delta;

      // Wind drift
      mesh.position.x += state.wind.direction.x * state.wind.strength * 0.06 * delta;
      mesh.position.z += state.wind.direction.z * state.wind.strength * 0.06 * delta;

      // Quadratic fade — snappy exit
      mesh.material.opacity = Math.max(0, 0.88 * (1.0 - t * t));

      if (d.life >= d.maxLife) {
        mesh.visible = false;
        d.active     = false;
      }
    }
  }

  // ── Per-frame sub-updates ──────────────────────────────────────────────────

  /**
   * Lerp dormancyT toward target. Reads this._dormant, writes this._dormancyT.
   * 45 seconds to go fully dormant (0.4/s × dt accumulated).
   */
  _updateDormancy(delta) {
    const target     = this._dormant ? 1.0 : 0.0;
    this._dormancyT  = _lerp(this._dormancyT, target, DORMANCY_LERP_SPEED * delta);

    if (this._dormancyT > 0.01) {
      // Head droops forward proportionally
      this._headPivot.rotation.x = _lerp(0, 0.62, this._dormancyT);
    } else {
      this._headPivot.rotation.x = 0;
    }
  }

  /**
   * Three-frequency stem sway driven by state.wind.
   * Spatial phase from world position creates a coherent travelling wave —
   * not every flower swaying identically.
   */
  _updateWind(elapsed) {
    const spec     = this._spec;
    const wStr     = state.wind.strength + state.wind.gustStrength;
    const wDir     = state.wind.direction;
    const pos      = this.root.position;

    const spatial  = (pos.x * wDir.x + pos.z * wDir.z) * 0.08;
    const phase    = spatial + this._windPhase;
    const TWO_PI   = Math.PI * 2;

    const s1 = Math.sin(spec.windFrequency       * elapsed * TWO_PI + phase)        * spec.windAmplitude;
    const s2 = Math.sin(spec.windFrequency * 2.1 * elapsed * TWO_PI + phase * 1.4)  * spec.windAmplitude * 0.28;
    const s3 = Math.sin(spec.windFrequency * 4.5 * elapsed * TWO_PI + phase * 2.2)  * spec.windAmplitude * 0.10;
    const sw  = (s1 + s2 + s3) * wStr;

    // Apply sway as XZ rotation on stem pivot, decomposed into wind direction
    this._stemPivot.rotation.x = sw * wDir.z * 0.60;
    this._stemPivot.rotation.z = sw * wDir.x * -0.60;
  }

  /**
   * Sunflower heliotropism: head pivot tracks sun azimuth slowly.
   * At night the head rests at its last daytime position.
   * Also tilts slightly down at high sun elevation (midday overhead).
   */
  _updateHeliotropism(delta) {
    if (!this._spec.heliotropic) return;
    if (state.isNight) return;

    const sunAz = Math.atan2(state.sunDirection.x, state.sunDirection.z);
    // ~2-minute full arc at 0.008 per second
    this._heliotropicYaw = _lerpAngle(this._heliotropicYaw, sunAz, delta * 0.008);
    this._headPivot.rotation.y = this._heliotropicYaw;

    // Tilt: sun elevation in degrees, high noon = head pitches slightly downward
    const el = Math.max(0, state.sunElevation);
    // Subtract from whatever dormancy already set
    this._headPivot.rotation.x += -el * 0.010;
  }

  /**
   * Phototropism: when hovered, stem tilts toward camera.
   * Azimuth tracks camera direction; pitch lerps toward max angle.
   * Smoothly relaxes back when unhovered.
   */
  _updatePhototropism(delta) {
    if (this._hovered) {
      const dx   = state.camera.x - this.root.position.x;
      const dz   = state.camera.z - this.root.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist > 0.1) {
        const targetYaw          = Math.atan2(dx, dz);
        this._stemPivot.rotation.y = _lerpAngle(
          this._stemPivot.rotation.y,
          targetYaw,
          0.04
        );
      }

      this._phototropicTarget = PHOTOTROPISM_MAX_ANGLE;
    } else {
      this._phototropicTarget = 0;
    }

    this._phototropicPitch = _lerp(
      this._phototropicPitch,
      this._phototropicTarget,
      PHOTOTROPISM_LERP_SPEED
    );

    // Additive onto wind-driven rotation (both affect same pivot)
    this._stemPivot.rotation.x += this._phototropicPitch * 0.5;
  }

  /**
   * Continuous growth: recompute scale from real elapsed age every frame.
   * The per-second delta on ageDays is negligible — scale only changes
   * visibly over days — but this ensures the transition is never snapped.
   */
  _updateGrowth() {
    const age      = _ageDays(this._habit.created_at);
    const newScale = _growthScale(age, this._spec);

    if (Math.abs(newScale - this._scale) > 0.0008) {
      this._scale = newScale;
      this.root.scale.setScalar(newScale);
    }

    // Check if we've just entered bloom stage for the first time
    if (!this._bloomed && age >= this._spec.bloomDays) {
      this._bloomed = true;
      this._spawnPollenBurst();
    }
  }

  /**
   * Push this frame's global state into every petal ShaderMaterial uniform.
   * Traversal cost is low — max ~32 petals per flower.
   */
  _updatePetalUniforms(elapsed, delta) {
    const wStr = state.wind.strength + state.wind.gustStrength;

    this._petalGroup.traverse(child => {
      if (!child.isMesh || !child.material?.uniforms) return;

      const u = child.material.uniforms;
      u.uTime.value          = elapsed;
      u.uWindStrength.value  = wStr;
      u.uWetness.value       = state.wetness;
      u.uSunDir.value.set(
        state.sunDirection.x,
        state.sunDirection.y,
        state.sunDirection.z
      );
      u.uSunColor.value.set(
        state.sunColor.r,
        state.sunColor.g,
        state.sunColor.b
      );
      u.uIsNight.value    = state.isNight ? 1.0 : 0.0;
      u.uDormancy.value   = this._dormancyT;
    });
  }

}  // end class Flower

// ─── Module-level geometry helpers ───────────────────────────────────────────
//
// These are pure functions, not class methods — they have no internal state
// and can be called during construction without `this` context issues.

/**
 * Build one petal as a PlaneGeometry with organic curvature baked into
 * the vertex positions. Width tapers toward the tip; a saddle deformation
 * lifts the side edges and pushes the centre down, producing a real cupped
 * petal cross-section rather than a flat card.
 *
 * @param {number}  length        Petal length in world units
 * @param {number}  width         Petal width at widest point
 * @param {number}  curvature     0=flat, 0.45=strongly cupped
 * @param {boolean} tissue        True → extra width segments for thin poppy petals
 * @returns {THREE.BufferGeometry}
 */
function _buildPetalGeo(length, width, curvature, tissue) {
  const segW = tissue ? 4 : 2;    // more width segments for tissue petals
  const segH = tissue ? 10 : 7;   // more length segments preserves curve on thin petals
  const geo  = new THREE.PlaneGeometry(width, length, segW, segH);
  const pos  = geo.attributes.position;

  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);

    // t = 0 at base, 1 at tip (PlaneGeometry Y runs −length/2 to +length/2)
    const t      = py / length + 0.5;
    // Width taper: linearly narrow toward tip
    const taper  = 1.0 - t * 0.70;
    const newX   = px * taper;

    // Normalised X across width: −1=left edge, +1=right edge
    const xNorm  = (px / (width * 0.5));

    // Saddle curvature in Z:
    //   Centre (xNorm≈0) is pushed back; edges (|xNorm|≈1) curve forward.
    //   This gives the characteristic cupped cross-section.
    //   Strength increases along length (more curved at tip than base).
    const zCup   = -curvature * length * t * (1.0 - xNorm * xNorm) * 0.60;

    // Tip pinch: tip curves gently back like a real petal
    const zTip   = curvature * length * t * t * 0.22;

    pos.setXYZ(i, newX, py, zCup + zTip);
  }

  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Build the ShaderMaterial for one petal mesh.
 *
 * All visual decisions are driven by uniforms updated each frame —
 * this material never needs to be rebuilt when state changes.
 *
 * @param {number[]} colBase    [r, g, b] at petal base
 * @param {number[]} colTip     [r, g, b] at petal tip
 * @param {number}   curvature
 * @param {boolean}  speckled   Foxglove throat spots
 * @param {boolean}  tissue     Poppy semi-transparency
 * @param {boolean}  dormant    Initial dormancy state (sets uDormancy)
 * @returns {THREE.ShaderMaterial}
 */
function _buildPetalMat(colBase, colTip, curvature, speckled, tissue, dormant) {
  return new THREE.ShaderMaterial({
    uniforms: {
      // Time
      uTime:         { value: 0.0 },
      // Wind
      uWindStrength: { value: 0.2 },
      // Per-petal unique flutter phase — randomised at material creation time
      uPhase:        { value: Math.random() * Math.PI * 2 },
      // Environment
      uWetness:      { value: 0.0 },
      uSunDir:       { value: new THREE.Vector3(0.5, 1.0, 0.5) },
      uSunColor:     { value: new THREE.Vector3(1.0, 0.95, 0.88) },
      uIsNight:      { value: 0.0 },
      // Appearance
      uColorBase:    { value: new THREE.Vector3(colBase[0], colBase[1], colBase[2]) },
      uColorTip:     { value: new THREE.Vector3(colTip[0],  colTip[1],  colTip[2]) },
      uCurvature:    { value: curvature },
      uSpeckled:     { value: speckled ? 1.0 : 0.0 },
      uTissue:       { value: tissue   ? 1.0 : 0.0 },
      // Dormancy
      uDormancy:     { value: dormant  ? 1.0 : 0.0 },
    },
    vertexShader:   _petalVert(),
    fragmentShader: _petalFrag(),
    side:           THREE.DoubleSide,
    transparent:    true,
    // Tissue petals need sorted transparency; others can use alpha-test
    depthWrite:     !tissue,
    alphaTest:      tissue ? 0.0 : 0.04,
  });
}

/**
 * Taper a TubeGeometry in-place.
 * For each ring along the tube's path, the radial component of every vertex
 * is scaled so the tube narrows from baseR at ring 0 to tipR at the last ring.
 *
 * @param {THREE.BufferGeometry} geo
 * @param {THREE.CubicBezierCurve3} curve
 * @param {number} baseR
 * @param {number} tipR
 * @param {number} tubeSeg     Path segment count
 * @param {number} radSeg      Radial segment count
 */
function _taperTube(geo, curve, baseR, tipR, tubeSeg, radSeg) {
  const pos           = geo.attributes.position;
  const vertsPerRing  = radSeg + 1;

  for (let ring = 0; ring <= tubeSeg; ring++) {
    const t      = ring / tubeSeg;
    const scale  = _lerp(baseR, tipR, t) / baseR;
    const spine  = curve.getPointAt(t);

    for (let v = 0; v < vertsPerRing; v++) {
      const idx = ring * vertsPerRing + v;
      if (idx >= pos.count) continue;

      const dx = pos.getX(idx) - spine.x;
      const dy = pos.getY(idx) - spine.y;
      const dz = pos.getZ(idx) - spine.z;

      pos.setXYZ(idx,
        spine.x + dx * scale,
        spine.y + dy * scale,
        spine.z + dz * scale
      );
    }
  }

  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

// ─── Placement ────────────────────────────────────────────────────────────────

/**
 * Deterministic world-space XZ position for a habit's flower.
 * Seeded from the habit UUID so position is stable across sessions
 * and independent of habit ordering.
 *
 * @param {Object} habit
 * @returns {{ x: number, z: number }}
 */
function _habitPosition(habit) {
  const r0 = _seededRand(habit.id, 0);
  const r1 = _seededRand(habit.id, 1);
  const spread = 280;   // half-extent, within 600×600 of the 700×700 garden
  return {
    x: CONFIG.ZONES.garden.x + (r0 - 0.5) * 2 * spread,
    z: CONFIG.ZONES.garden.z + (r1 - 0.5) * 2 * spread,
  };
}

// ─── Growth helpers ───────────────────────────────────────────────────────────

/**
 * Days elapsed since a habit was created.
 * @param {string} createdAt  ISO timestamp
 * @returns {number}
 */
function _ageDays(createdAt) {
  if (!createdAt) return 0;
  return (Date.now() - new Date(createdAt).getTime()) / 86_400_000;
}

/**
 * Map age in days to a uniform growth scale [0, 1].
 *
 * Stages:
 *   0–1d:         sprout emergence  0.01 → 0.08   (linear)
 *   1–8d:         early growth      0.08 → 0.30   (easeOutCubic)
 *   8–bloomDays:  growing           0.30 → 1.00   (easeOutQuart)
 *   bloomDays+:   mature            1.00           (capped)
 *
 * @param {number} ageDays
 * @param {Object} spec
 * @returns {number}  Scale 0–1
 */
function _growthScale(ageDays, spec) {
  const bloom = spec.bloomDays || 22;

  if (ageDays < 1) {
    return _lerp(0.01, 0.08, ageDays);
  }
  if (ageDays < 8) {
    return _lerp(0.08, 0.30, _easeOutCubic((ageDays - 1) / 7));
  }
  if (ageDays < bloom) {
    return _lerp(0.30, 1.00, _easeOutQuart((ageDays - 8) / (bloom - 8)));
  }
  return 1.0;
}

/**
 * True if the most recent check-in for this habit is older than
 * DORMANCY_THRESHOLD_DAYS, or if no check-ins exist at all.
 *
 * @param {Object} habit
 * @returns {boolean}
 */
function _isDormant(habit) {
  const logs = (state.habitLogs || []).filter(l => l.habit_id === habit.id);
  if (!logs.length) return false;

  const latest   = logs.reduce((a, b) => (a.date > b.date ? a : b));
  const daysSince = (Date.now() - new Date(latest.date).getTime()) / 86_400_000;
  return daysSince >= DORMANCY_THRESHOLD_DAYS;
}

// ─── Math utilities ───────────────────────────────────────────────────────────

/** Clamped linear interpolation. */
function _lerp(a, b, t) {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

/**
 * Lerp two angles with ±π wrapping.
 * Prevents the stem from spinning the wrong way around when the camera
 * crosses the 0/2π boundary.
 */
function _lerpAngle(current, target, alpha) {
  let diff = target - current;
  while (diff >  Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * alpha;
}

function _easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function _easeOutQuart(t) { return 1 - Math.pow(1 - t, 4); }

/**
 * Seeded deterministic pseudo-random from a UUID string and an integer salt.
 * Uses a multiply-xorshift hash — resistant to UUID substring collisions.
 *
 * @param {string} uuid
 * @param {number} salt   Integer, differentiates multiple calls per UUID
 * @returns {number}      Float in [0, 1]
 */
function _seededRand(uuid, salt) {
  let h = (salt * 2654435761) | 0;
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
 * Vertex shader for all petal meshes across all twelve species.
 *
 * Uniforms:
 *   uTime:         float — elapsed seconds
 *   uWindStrength: float — 0 (still) to 1 (gale)
 *   uPhase:        float — per-petal unique random phase [0, 2π]
 *   uDormancy:     float — 0=alive, 1=fully dormant
 *
 * Wind model:
 *   Three sinusoidal frequencies (14.2, 9.8, 6.4 Hz) applied exclusively
 *   to tip vertices (tipT = smoothstep(0.25, 1.0, uv.y)).
 *   Each petal has a unique uPhase → no two petals on the same flower
 *   flutter identically.
 *   Dormancy adds a curl in the Z axis proportional to tipT², drooping
 *   the tip without affecting the base — in addition to the head pivot
 *   rotation applied in JS.
 *
 * Varyings out:
 *   vUv          vec2  — texture coords: x=0–1 across width, y=0–1 base→tip
 *   vWorldNormal vec3  — world-space normal for lighting
 *   vWorldPos    vec3  — world-space position for fog and SSS
 *   vTipFactor   float — smoothstep(0.25, 1.0, uv.y) cached for fragment
 */
function _petalVert() {
  return /* glsl */`
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

      // Height factor: 0 at base (uv.y=0), 1 at tip (uv.y=1)
      // smoothstep keeps base anchor firm while tips become freely mobile.
      float tipT = smoothstep(0.25, 1.0, uv.y);

      // ── Wind flutter (three-frequency independent warp) ──────────────────
      // Each frequency targets a different motion quality:
      //   14.2 Hz — rapid tip flutter (leaf tremor)
      //    9.8 Hz — medium ripple (breath of wind passing through)
      //    6.4 Hz — slow roll (whole-petal oscillation)
      float fX = sin(uTime * 14.2 + uPhase)        * 0.010 * uWindStrength * tipT;
      float fZ = sin(uTime *  9.8 + uPhase * 1.70) * 0.007 * uWindStrength * tipT;
      float fY = sin(uTime *  6.4 + uPhase * 0.85) * 0.005 * uWindStrength * tipT * tipT;

      pos.x += fX;
      pos.z += fZ;
      pos.y += fY;

      // ── Dormancy tip curl ─────────────────────────────────────────────────
      // Tips droop along +Z (into the petal's "face" direction), simulating
      // wilting. tipT² concentrates the droop at the very tip.
      // Combined with the head pivot's rotation.x += 0.62 applied in JS,
      // the whole head hangs and each tip individually curls inward.
      float droopZ = uDormancy * tipT * tipT * 0.040;
      pos.z += droopZ;

      // ── Transform to world space ──────────────────────────────────────────
      vec4 worldPos4  = modelMatrix * vec4(pos, 1.0);
      vWorldPos       = worldPos4.xyz;
      vWorldNormal    = normalize(mat3(modelMatrix) * normal);
      vUv             = uv;
      vTipFactor      = tipT;

      gl_Position = projectionMatrix * viewMatrix * worldPos4;
    }
  `;
}

// ─── GLSL — Petal fragment shader ────────────────────────────────────────────

/**
 * Fragment shader for all petal meshes.
 *
 * Lighting model (physically motivated throughout, no fill lights):
 *
 *   1. Silhouette alpha
 *      Width taper removes corners of the PlaneGeometry quad; tip fade
 *      softens the tip edge. Tissue species additionally reduce opacity
 *      throughout for poppy's paper-thin look.
 *
 *   2. Albedo gradient
 *      mix(uColorBase, uColorTip, t^1.4) — colour deepens toward the tip.
 *      Procedural noise hash breaks up any flat uniformity.
 *
 *   3. Vein overlay
 *      Two symmetric primary veins at uv.x = 0.32 and 0.68 (normalised),
 *      a central midrib, and secondary branches that fan outward above
 *      25% height using a repeating fract() ramp. All veins are 12–18%
 *      darker than the base colour, visible most strongly on lit faces.
 *
 *   4. Speckle (foxglove only)
 *      Hash-based dot pattern in the basal third of the petal interior,
 *      concentrated toward the centre, deep maroon-brown. Driven by uSpeckled.
 *
 *   5. Wetness
 *      Albedo darkened by up to 20%, roughness reduced (surface film).
 *      Wet specular highlight added separately.
 *
 *   6. Dormancy desaturation
 *      Luminance-preserving desaturation toward 72% grey; additional 18%
 *      global darkening. Net effect: petal goes pale and dull, reads as wilted.
 *
 *   7. Lambert diffuse
 *      NdotL with DoubleSide normal flip. Sun colour temperature-driven.
 *
 *   8. Ambient (sky dome)
 *      Separate day and night values, mixed by uIsNight.
 *
 *   9. SSS translucency
 *      max(dot(-N, L), 0)^1.5 × tipFactor × transmittance. The transmittance
 *      value ranges from 0.35 (thick base) to 0.75 (thin tip) and is
 *      modulated by curvature (deeply cupped petals transmit less because
 *      thicker walls). SSS colour is the sun colour filtered by the petal
 *      albedo with a warm chlorophyll shift.
 *
 *  10. Fresnel rim glow
 *      pow(1 - NdotV, 3.8) × 0.28. Petals catch light at grazing angles,
 *      producing the characteristic bright edge seen in backlit flowers.
 *
 *  11. Blinn-Phong specular
 *      Low roughness-driven shininess. Wetness adds a sharper highlight.
 *
 *  12. Fog
 *      Exponential fog matching terrain.js — same fogColor day/night values.
 */
function _petalFrag() {
  return /* glsl */`
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

    // Camera position provided automatically by Three.js ShaderMaterial
    // as 'cameraPosition' (vec3, world space) — no extra uniform needed.

    varying vec2  vUv;
    varying vec3  vWorldNormal;
    varying vec3  vWorldPos;
    varying float vTipFactor;

    // ── Deterministic hash — no texture lookup needed ─────────────────────
    float hash2(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    // ── Luminance for desaturation ────────────────────────────────────────
    float luminance(vec3 c) {
      return dot(c, vec3(0.2126, 0.7152, 0.0722));
    }

    vec3 desaturate(vec3 col, float amount) {
      return mix(col, vec3(luminance(col)), amount);
    }

    // ── Procedural vein mask ──────────────────────────────────────────────
    // Returns [0, 1] where 1 = on a vein.
    // uv: x=0–1 across petal width, y=0–1 base to tip.
    float veinMask(vec2 uv) {
      // Two symmetric primary veins (normalised positions in uv-x space)
      float v1 = 1.0 - smoothstep(0.0, 0.022, abs(uv.x - 0.32));
      float v2 = 1.0 - smoothstep(0.0, 0.022, abs(uv.x - 0.68));
      float primary = max(v1, v2);

      // Central midrib — strong at base, fades to absent at 80% height
      float midrib = (1.0 - smoothstep(0.0, 0.014, abs(uv.x - 0.50)))
                   * (1.0 - smoothstep(0.0, 0.80, uv.y));

      // Secondary branches — fan outward above 25% height
      float secondary = 0.0;
      if (uv.y > 0.25) {
        // Repeating ramp at 3.5× frequency creates branch nodes
        float node     = fract(uv.y * 3.5);
        // Branch angle widens with height and fades after 55% of petal
        float branchX  = abs(uv.x - 0.5) - node * 0.20 * (uv.y - 0.25);
        secondary      = (1.0 - smoothstep(0.0, 0.018, abs(branchX)))
                       * (1.0 - smoothstep(0.40, 0.58, uv.y))
                       * 0.55;
      }

      return clamp(primary * 0.60 + midrib * 0.80 + secondary, 0.0, 1.0);
    }

    void main() {

      // ── Silhouette alpha ─────────────────────────────────────────────────
      // Two components combined: width taper (removes quad corners) + tip fade.
      // Width taper: mapped so edges align with the tapered geometry.
      //   xEdge = how far we are from the petal centre (0=centre, 1=edge)
      //   The geometry tapers so the effective edge moves inward as uv.y→1.
      //   We approximate this with a linear envelope.
      float xEdge    = abs(vUv.x - 0.5) * 2.0;
      float envelope = 1.0 - vUv.y * 0.70 + 0.001;   // matching taper in geometry
      float widthA   = 1.0 - smoothstep(0.50, 1.0, xEdge / envelope);
      float tipA     = 1.0 - smoothstep(0.88, 1.0, vUv.y);

      float alpha;
      if (uTissue > 0.5) {
        // Tissue (poppy): semi-transparent throughout, not just at edges
        alpha = widthA * tipA * 0.70;
      } else {
        alpha = widthA * tipA;
      }
      if (alpha < 0.04) discard;

      // ── Albedo ──────────────────────────────────────────────────────────
      float colorT = pow(vUv.y, 1.4);
      vec3  albedo = mix(uColorBase, uColorTip, colorT);

      // Micro-variation — hash breaks up uniformity without a texture
      float vary  = hash2(vWorldPos.xz * 20.0) * 0.06 - 0.03;
      albedo     += vec3(vary);
      albedo      = clamp(albedo, 0.0, 1.0);

      // ── Vein overlay ─────────────────────────────────────────────────────
      float vein = veinMask(vUv);
      // Veins are 14% darker than the surrounding albedo
      albedo     = mix(albedo, albedo * 0.86, vein * 0.60);

      // ── Speckle (foxglove throat) ─────────────────────────────────────────
      if (uSpeckled > 0.5) {
        // Maroon-brown dots concentrated at petal base interior
        float spotZone  = smoothstep(0.04, 0.30, vUv.y)
                        * (1.0 - smoothstep(0.30, 0.50, vUv.y));
        float spotNoise = step(0.72, hash2(floor(vUv * vec2(5.0, 9.0))));
        albedo          = mix(albedo, albedo * vec3(0.28, 0.12, 0.10),
                             spotNoise * spotZone);
      }

      // ── Wetness ──────────────────────────────────────────────────────────
      float wetFactor = uWetness * 0.80;
      albedo         *= 1.0 - wetFactor * 0.20;

      // ── Dormancy desaturation ─────────────────────────────────────────────
      albedo  = desaturate(albedo, uDormancy * 0.72);
      albedo *= 1.0 - uDormancy * 0.18;

      // ── Normals ──────────────────────────────────────────────────────────
      vec3 N = normalize(vWorldNormal);
      // DoubleSide: flip normal for back face so it lights correctly
      if (!gl_FrontFacing) N = -N;

      vec3 L = normalize(uSunDir);
      vec3 V = normalize(cameraPosition - vWorldPos);
      vec3 H = normalize(L + V);

      // ── Diffuse (Lambert) ─────────────────────────────────────────────────
      float NdotL   = max(dot(N, L), 0.0);
      vec3  sunCol  = uSunColor * mix(1.0, 0.08, uIsNight);
      vec3  diffuse = albedo * NdotL * sunCol;

      // ── Ambient ───────────────────────────────────────────────────────────
      // Sky dome contribution: slightly blue-tinted by day, deep blue by night.
      vec3 ambDay   = vec3(0.08, 0.10, 0.13) * albedo;
      vec3 ambNight = vec3(0.02, 0.03, 0.05) * albedo;
      vec3 ambient  = mix(ambDay, ambNight, uIsNight);

      // ── SSS translucency ──────────────────────────────────────────────────
      // Transmittance: thin tips let more light through (0.35 at base → 0.75
      // at tip). Deeply cupped petals (high curvature) are thicker, so less
      // light transmits — physically correct for peony vs poppy.
      float backFace   = max(dot(-N, L), 0.0);
      float transmit   = mix(0.35, 0.75, vTipFactor) * (1.0 - uCurvature * 0.45);
      float sss        = pow(backFace, 1.5) * transmit * (1.0 - uDormancy * 0.80);
      // Sun filtered by petal colour + warm chlorophyll shift
      vec3  sssCol     = sunCol * albedo * vec3(1.10, 1.04, 0.86) * sss * 0.88;

      // ── Fresnel rim (edge glow) ────────────────────────────────────────────
      // Petals glow at grazing viewing angles — especially visible at petal
      // edges in backlit conditions. Exponent 3.8 keeps the rim narrow.
      float NdotV  = max(dot(N, V), 0.0);
      float rim    = pow(1.0 - NdotV, 3.8) * 0.26 * (1.0 - uIsNight);
      vec3  rimCol = sunCol * rim * (albedo * 1.35 + vec3(0.10));

      // ── Specular (Blinn-Phong) ────────────────────────────────────────────
      // Low shininess — petals are soft, not glossy. Wetness increases gloss.
      float roughness = mix(0.72, 0.50, wetFactor);
      float shininess = mix(4.0, 56.0, 1.0 - roughness);
      float NdotH     = max(dot(N, H), 0.0);
      float spec      = pow(NdotH, shininess) * (1.0 - roughness) * 0.20;
      // Rain water film: sharper, brighter highlight on top of base specular
      float wetSpec   = pow(NdotH, 112.0) * wetFactor * 0.38;
      vec3  specular  = sunCol * (spec + wetSpec);

      // ── Composite ─────────────────────────────────────────────────────────
      vec3 finalColor = ambient + diffuse + sssCol + rimCol + specular;

      // ── Exponential fog ───────────────────────────────────────────────────
      // Matches terrain.js fog density and colour exactly so petals blend
      // naturally with the landscape at distance.
      float camDist      = length(vWorldPos - cameraPosition);
      float fogFactor    = exp(-0.0004 * camDist * camDist);
      fogFactor          = clamp(fogFactor, 0.0, 1.0);
      vec3  fogDay       = vec3(0.58, 0.72, 0.88);
      vec3  fogNight     = vec3(0.04, 0.06, 0.12);
      vec3  fogColor     = mix(fogDay, fogNight, uIsNight);
      finalColor         = mix(fogColor, finalColor, fogFactor);

      gl_FragColor = vec4(finalColor, alpha);
    }
  `;
}
