/**
 * tree.js — L-system tree generator for The Grove (Journal zone)
 * Atlas: The Living World
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * OVERVIEW
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Each journal entry spawns one living tree in the Grove. The tree's entire
 * morphology — branching density, height, trunk radius, elevation bias, bark
 * texture ageing, root complexity, leaf count, and seasonal state — is driven
 * by that entry's data: word count, mood valence/energy, entry type, and how
 * long ago it was written.
 *
 * Architecture
 * ─────────────
 *   Tree (class)
 *     • buildGeometry()     — runs L-system, builds all meshes
 *     • update(delta, t)    — per-frame: wind, seasonal leaf fall, snow
 *     • dispose()           — releases all GPU resources
 *     • getPickTarget()     — returns trunk mesh for raycasting (grove.js)
 *
 * L-system
 * ─────────
 *   Four production rules, driven by entry characteristics:
 *     energetic   (energy > 0.65)  → tall, upward-reaching, many sub-branches
 *     reflective  (energy < 0.35)  → wide, drooping, few tight branches
 *     short       (wordCount < 60) → small, compact, single-generation branches
 *     normal      (default)        → balanced canopy
 *
 *   Derivation depth: 4 (enough for realistic complexity, cheap at runtime).
 *   Axiom:            F
 *   Rules applied stochastically with weights seeded by entry UUID so the
 *   same entry always produces the same tree between sessions.
 *
 * Geometry strategy
 * ──────────────────
 *   Branches are merged per depth level into 8 draw calls total (depths 0–7,
 *   each depth has its own merged geometry + single ShaderMaterial instance).
 *   This keeps draw calls within the performance budget (budget: 8 for trees).
 *
 *   Leaves are separate InstancedMesh (15,000 instances across all grove trees,
 *   managed by grove.js; tree.js contributes leaf instance data via
 *   getLeafInstances()). This file owns the geometry template only.
 *
 *   Root systems: 8–14 surface roots per tree, each a CatmullRomCurve3
 *   extruded as TubeGeometry, merged into one root mesh per tree.
 *
 * Shading
 * ────────
 *   All bark ShaderMaterials share one GLSL program (inline in this file).
 *   Uniforms that vary per-depth-level: uBranchAge, uBranchRadius, uMossAmount.
 *   Global uniforms updated every frame: uTime, uWetness, uWindStrength,
 *   uWindDirection, uSunDir, uSunColor, uIsNight, uFogDensity, uSeason.
 *
 *   Frost emissive in winter: uSeason drives a lerp toward blue-white tint.
 *   Moss coverage: driven by state.season ('autumn'/'winter' = more moss).
 *   AO: baked at generation — darker at branch forks and near the ground.
 *
 * Secondary "year trees"
 * ───────────────────────
 *   One additional, visually distinct tree per calendar year is built by
 *   grove.js calling Tree.buildYearTree(year, entryCount). These are arc-
 *   positioned around the grove perimeter. tree.js exports the static factory.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEPENDENCIES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   THREE (global r128)
 *   core/state.js   — reads state.season, state.wetness, state.wind, state.isNight
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * EXPORTS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   class Tree
 *     new Tree(entryData, scene, position)
 *     .buildGeometry()                     → Promise<void>
 *     .update(delta, elapsed)
 *     .dispose()
 *     .getPickTarget()                     → THREE.Mesh
 *     .getLeafInstances()                  → Array<LeafInstance>
 *     .triggerLeafFall(count)              — called by grove.js on season change
 *
 *   function buildYearTree(year, entryCount, scene, position) → Tree
 *
 *   LEAF_GEOMETRY    THREE.PlaneGeometry — shared leaf template
 *   LEAF_MATERIAL    THREE.ShaderMaterial — shared leaf shader
 */

import { state } from '../core/state.js';

const THREE = window.THREE;

// ─── Shared leaf resources (initialised once, reused by all trees) ────────────

/** @type {THREE.PlaneGeometry|null} Shared across all leaf instances. */
export let LEAF_GEOMETRY = null;

/** @type {THREE.ShaderMaterial|null} Shared across all leaf instances. */
export let LEAF_MATERIAL  = null;

// ─── Constants ────────────────────────────────────────────────────────────────

// L-system iteration depth. 4 gives a convincing tree without over-subdivision.
const L_DEPTH        = 4;

// Trunk radius (world units) at base. Scaled by word-count multiplier.
const BASE_RADIUS    = 0.28;

// How much radius decreases per depth level: r(d) = BASE_RADIUS * RADIUS_DECAY^d
const RADIUS_DECAY   = 0.62;

// Base branch segment length (world units). Scaled by word-count multiplier.
const SEG_LENGTH     = 1.85;

// Tube geometry segments per branch (higher = rounder cross-section)
const TUBE_RADIAL_SEGS = 6;   // hexagonal — cheap and convincing at tree scale
const TUBE_TUBE_SEGS   = 3;   // subdivisions along branch axis

// Maximum number of roots per tree. Actual count seeded from UUID.
const ROOT_COUNT_MIN = 8;
const ROOT_COUNT_MAX = 14;

// Leaf size range (world units, quad half-size)
const LEAF_SIZE_MIN  = 0.16;
const LEAF_SIZE_MAX  = 0.30;

// Leaf wind parameters
const LEAF_WIND_FREQ = 2.2;    // Hz
const LEAF_WIND_AMP  = 0.25;   // radians

// Seasonal leaf fall: max leaves shed per second during a fall event
const LEAF_FALL_RATE = 12;

// ─── Seasonal color tables ────────────────────────────────────────────────────

/** Leaf colors per season. Indexed by state.season string. */
const LEAF_COLORS = {
  spring: new THREE.Color(0x6aab44),  // bright fresh green
  summer: new THREE.Color(0x2d6e22),  // deep mature green
  autumn: new THREE.Color(0xc46e1a),  // amber-orange
  winter: new THREE.Color(0x8a9a7a),  // muted grey-green, bare or frosty
};

/** Leaf colors modulated by journal mood valence (0–1). */
function _moodLeafColor(baseColor, valence, energy) {
  // High valence → slightly warmer, more saturated
  // Low valence  → cooler, more olive/sage
  const warm = new THREE.Color(0xd4882a);  // warm amber
  const cool = new THREE.Color(0x4a6b4a);  // muted sage
  const mood = new THREE.Color().copy(baseColor);
  mood.lerp(valence > 0.5 ? warm : cool, Math.abs(valence - 0.5) * 0.4);
  // High energy → slightly brighter
  mood.multiplyScalar(0.85 + energy * 0.3);
  return mood;
}

// ─── Deterministic pseudo-random seeded by UUID ───────────────────────────────

/**
 * Tiny mulberry32 PRNG seeded from a UUID string.
 * Returns a function: () => float in [0, 1).
 *
 * @param {string} uuid
 * @returns {function(): number}
 */
function _makeRng(uuid) {
  // Hash UUID bytes into a 32-bit seed
  let seed = 0;
  for (let i = 0; i < uuid.length; i++) {
    seed = Math.imul(seed ^ uuid.charCodeAt(i), 0x9e3779b9);
    seed ^= seed >>> 16;
  }

  return function () {
    seed  += 0x6d2b79f5;
    let t  = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t     ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── L-system engine ──────────────────────────────────────────────────────────

/**
 * L-system string rewriter. Operates on a symbol array for speed.
 *
 * Symbols:
 *   F  — draw forward (branch segment)
 *   +  — turn left (yaw +angle)
 *   -  — turn right (yaw -angle)
 *   ^  — pitch up
 *   &  — pitch down
 *   \  — roll left
 *   /  — roll right
 *   [  — push turtle state
 *   ]  — pop turtle state
 *   L  — place leaf cluster
 *
 * @param {string}   axiom
 * @param {Object}   rules  Map from symbol → replacement string
 * @param {number}   depth  Number of derivation iterations
 * @param {function} rng    Seeded PRNG
 * @returns {string}        Derived string
 */
function _derive(axiom, rules, depth, rng) {
  let current = axiom;
  for (let i = 0; i < depth; i++) {
    let next = '';
    for (const ch of current) {
      if (ch in rules) {
        const rule = rules[ch];
        // rule is either a string or an array of {weight, str} for stochastic rules
        if (Array.isArray(rule)) {
          const roll     = rng();
          let   cumul    = 0;
          let   selected = rule[rule.length - 1].str;
          for (const option of rule) {
            cumul += option.weight;
            if (roll < cumul) { selected = option.str; break; }
          }
          next += selected;
        } else {
          next += rule;
        }
      } else {
        next += ch;
      }
    }
    current = next;
  }
  return current;
}

// ─── Entry type classification ────────────────────────────────────────────────

/**
 * Classify a journal entry into one of four tree archetypes.
 *
 * @param {Object} entry  Supabase journal_entries row
 * @returns {'energetic'|'reflective'|'short'|'normal'}
 */
function _classifyEntry(entry) {
  const words  = entry.word_count || 0;
  const energy = entry.mood_energy != null ? entry.mood_energy : 0.5;

  if (words < 60) return 'short';
  if (energy > 0.65) return 'energetic';
  if (energy < 0.35) return 'reflective';
  return 'normal';
}

/**
 * Build L-system rules for the given tree archetype.
 *
 * energetic  → tall, upright, many ascending sub-branches
 * reflective → wide, drooping lateral branching, gentle pitch-down
 * short      → compact, single-generation, few leaves
 * normal     → balanced, symmetric canopy
 *
 * @param {'energetic'|'reflective'|'short'|'normal'} type
 * @returns {Object}  rules map for _derive()
 */
function _buildRules(type) {
  switch (type) {
    case 'energetic':
      return {
        F: [
          { weight: 0.45, str: 'FF^[^F+FL][-FL]/[^F-FL]' },
          { weight: 0.35, str: 'FF^[^F+FL][/F-FL]^FL' },
          { weight: 0.20, str: 'F^[+FL][-FL][^FL]' },
        ],
      };

    case 'reflective':
      return {
        F: [
          { weight: 0.50, str: 'FF&[&F+FL][-FL]/[&F-FL]' },
          { weight: 0.30, str: 'FF&[+FL][-FL]FL' },
          { weight: 0.20, str: 'F&[+FL][-FL]' },
        ],
      };

    case 'short':
      return {
        F: [
          { weight: 0.55, str: 'F[+FL][-FL]' },
          { weight: 0.30, str: 'F[+FL]FL' },
          { weight: 0.15, str: 'FF' },
        ],
      };

    case 'normal':
    default:
      return {
        F: [
          { weight: 0.40, str: 'FF[^F+FL][-FL]/[^F-FL]' },
          { weight: 0.35, str: 'FF[+FL][-FL]FL' },
          { weight: 0.25, str: 'F[^FL][-FL][+FL]' },
        ],
      };
  }
}

// ─── Turtle interpreter ───────────────────────────────────────────────────────

/**
 * Turtle state record.
 */
class TurtleState {
  constructor() {
    this.pos     = new THREE.Vector3(0, 0, 0);
    this.heading = new THREE.Quaternion();   // orientation as quaternion
    this.depth   = 0;                        // branching depth
    this.radius  = BASE_RADIUS;
    this.length  = SEG_LENGTH;
  }

  clone() {
    const s     = new TurtleState();
    s.pos       = this.pos.clone();
    s.heading   = this.heading.clone();
    s.depth     = this.depth;
    s.radius    = this.radius;
    s.length    = this.length;
    return s;
  }
}

/**
 * Interpret an L-system string into branch segments and leaf positions.
 *
 * Returns:
 *   branches:   Array<BranchSegment>  { start, end, depth, radius, ao }
 *   leafClusters: Array<LeafCluster>  { position, normal, depth, size }
 *
 * @param {string}   lStr          Derived L-system string
 * @param {Object}   params        { lengthScale, radiusScale, baseAngle, type }
 * @param {function} rng           Seeded PRNG for noise
 * @returns {{ branches: Array, leafClusters: Array }}
 */
function _interpret(lStr, params, rng) {
  const { lengthScale, radiusScale, baseAngle } = params;

  const branches     = [];
  const leafClusters = [];
  const stack        = [];

  const turtle = new TurtleState();
  turtle.radius = BASE_RADIUS * radiusScale;
  turtle.length = SEG_LENGTH  * lengthScale;

  // Unit vectors for rotation axes (in local space, rotated by heading)
  const UP    = new THREE.Vector3(0, 1, 0);
  const RIGHT = new THREE.Vector3(1, 0, 0);
  const FWD   = new THREE.Vector3(0, 0, 1);

  // Small random jitter per symbol to prevent perfectly symmetrical geometry
  const jitter = () => (rng() - 0.5) * 0.15;

  for (const sym of lStr) {
    switch (sym) {
      case 'F': {
        // Forward: draw one branch segment
        const dir  = FWD.clone().applyQuaternion(turtle.heading);
        const start = turtle.pos.clone();
        const end   = turtle.pos.clone().addScaledVector(dir, turtle.length);

        // AO: darker near ground and at high depth
        const ao = Math.max(
          0.3,
          1.0 - (turtle.depth / L_DEPTH) * 0.45 - (turtle.pos.y / 12.0) * 0.12
        );

        branches.push({
          start:  start,
          end:    end,
          depth:  turtle.depth,
          radius: turtle.radius,
          ao:     ao,
        });

        turtle.pos.copy(end);

        // Radius and length shrink with depth
        turtle.radius *= RADIUS_DECAY;
        turtle.length *= 0.88;
        turtle.depth   = Math.min(turtle.depth + 1, L_DEPTH);
        break;
      }

      case '+': {
        const angle = (baseAngle + jitter() * 8) * (Math.PI / 180);
        const q     = new THREE.Quaternion().setFromAxisAngle(UP, angle);
        turtle.heading.premultiply(q);
        break;
      }

      case '-': {
        const angle = -(baseAngle + jitter() * 8) * (Math.PI / 180);
        const q     = new THREE.Quaternion().setFromAxisAngle(UP, angle);
        turtle.heading.premultiply(q);
        break;
      }

      case '^': {
        const angle = (baseAngle * 0.65 + jitter() * 6) * (Math.PI / 180);
        const q     = new THREE.Quaternion().setFromAxisAngle(RIGHT, -angle);
        turtle.heading.premultiply(q);
        break;
      }

      case '&': {
        const angle = (baseAngle * 0.65 + jitter() * 6) * (Math.PI / 180);
        const q     = new THREE.Quaternion().setFromAxisAngle(RIGHT, angle);
        turtle.heading.premultiply(q);
        break;
      }

      case '\\': {
        const angle = (baseAngle * 0.4) * (Math.PI / 180);
        const q     = new THREE.Quaternion().setFromAxisAngle(FWD, -angle);
        turtle.heading.premultiply(q);
        break;
      }

      case '/': {
        const angle = (baseAngle * 0.4) * (Math.PI / 180);
        const q     = new THREE.Quaternion().setFromAxisAngle(FWD, angle);
        turtle.heading.premultiply(q);
        break;
      }

      case '[': {
        stack.push(turtle.clone());
        break;
      }

      case ']': {
        if (stack.length > 0) {
          const s      = stack.pop();
          turtle.pos     = s.pos;
          turtle.heading = s.heading;
          turtle.depth   = s.depth;
          turtle.radius  = s.radius;
          turtle.length  = s.length;
        }
        break;
      }

      case 'L': {
        // Leaf cluster at current position
        const dir  = FWD.clone().applyQuaternion(turtle.heading);
        const size = LEAF_SIZE_MIN + rng() * (LEAF_SIZE_MAX - LEAF_SIZE_MIN);
        leafClusters.push({
          position: turtle.pos.clone().addScaledVector(dir, turtle.length * 0.5),
          normal:   dir.clone(),
          depth:    turtle.depth,
          size:     size,
        });
        break;
      }

      default:
        break;
    }
  }

  return { branches, leafClusters };
}

// ─── Geometry builders ────────────────────────────────────────────────────────

/**
 * Build a CubicBezierCurve3 branch and return a TubeGeometry.
 * The curve adds organic S-shaped curvature between start and end points.
 *
 * @param {THREE.Vector3} start
 * @param {THREE.Vector3} end
 * @param {number}        radius
 * @param {function}      rng
 * @returns {THREE.BufferGeometry}
 */
function _buildBranchGeometry(start, end, radius, rng) {
  const dir    = end.clone().sub(start);
  const len    = dir.length();
  const mid1   = start.clone().addScaledVector(dir, 0.33);
  const mid2   = start.clone().addScaledVector(dir, 0.66);

  // Add perpendicular organic offset to control points
  const perp   = _perpendicular(dir.clone().normalize());
  const offset1 = (rng() - 0.5) * len * 0.22;
  const offset2 = (rng() - 0.5) * len * 0.22;

  mid1.addScaledVector(perp, offset1);
  mid2.addScaledVector(perp, offset2);

  const curve  = new THREE.CubicBezierCurve3(start, mid1, mid2, end);

  // Taper radius: thick at start, thinner at end
  // TubeGeometry doesn't support per-point radii natively, so we use a
  // fixed radius at the segment midpoint (correct visual impression at this scale).
  return new THREE.TubeGeometry(
    curve,
    TUBE_TUBE_SEGS,
    Math.max(radius, 0.008),
    TUBE_RADIAL_SEGS,
    false
  );
}

/**
 * Return a vector perpendicular to the input.
 * Picks the axis least aligned with v to avoid degenerate cross products.
 *
 * @param {THREE.Vector3} v  Must be normalised
 * @returns {THREE.Vector3}  Normalised perpendicular
 */
function _perpendicular(v) {
  const abs = v.clone().set(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
  let   axis;
  if (abs.x <= abs.y && abs.x <= abs.z) axis = new THREE.Vector3(1, 0, 0);
  else if (abs.y <= abs.z)              axis = new THREE.Vector3(0, 1, 0);
  else                                  axis = new THREE.Vector3(0, 0, 1);
  return v.clone().cross(axis).normalize();
}

/**
 * Build root system geometry (surface roots crawling outward from base).
 * Merges all roots into a single BufferGeometry.
 *
 * @param {number}   count   Number of roots (8–14)
 * @param {function} rng     Seeded PRNG
 * @returns {THREE.BufferGeometry}
 */
function _buildRootGeometry(count, rng) {
  const geos = [];

  for (let i = 0; i < count; i++) {
    const angle      = (i / count) * Math.PI * 2 + (rng() - 0.5) * 0.8;
    const rootLength = 0.8 + rng() * 1.4;
    const points     = [];

    // Start at base, crawl outward along terrain surface
    const startX = Math.cos(angle) * 0.12;
    const startZ = Math.sin(angle) * 0.12;

    for (let j = 0; j <= 6; j++) {
      const t       = j / 6;
      const dist    = t * rootLength;
      const heightY = Math.max(0, (1.0 - t * 1.2) * 0.18 - t * 0.05);
      // Slight lateral wander
      const wander  = (rng() - 0.5) * 0.12 * t;
      points.push(new THREE.Vector3(
        startX + Math.cos(angle + wander) * dist,
        heightY,
        startZ + Math.sin(angle + wander) * dist,
      ));
    }

    const curve      = new THREE.CatmullRomCurve3(points);
    const rootRadius = 0.022 + rng() * 0.018;

    const geo = new THREE.TubeGeometry(curve, 5, rootRadius, 4, false);
    geos.push(geo);
  }

  // Merge all root geometries
  return _mergeGeometries(geos);
}

/**
 * Manually merge an array of BufferGeometries into one.
 * (Three.js r128 does not have BufferGeometryUtils as a module import
 * in the vanilla CDN build; we implement a minimal merge here.)
 *
 * @param {THREE.BufferGeometry[]} geos
 * @returns {THREE.BufferGeometry}
 */
function _mergeGeometries(geos) {
  const nonEmpty = geos.filter(g => {
    const pos = g.attributes.position;
    return pos && pos.count > 0;
  });
  if (nonEmpty.length === 0) return new THREE.BufferGeometry();
  if (nonEmpty.length === 1) return nonEmpty[0].clone();

  let totalVerts   = 0;
  let totalIndices = 0;
  const hasNormals = nonEmpty.every(g => g.attributes.normal);
  const hasUvs     = nonEmpty.every(g => g.attributes.uv);

  for (const g of nonEmpty) {
    totalVerts   += g.attributes.position.count;
    if (g.index) totalIndices += g.index.count;
  }

  const positions  = new Float32Array(totalVerts * 3);
  const normals    = hasNormals ? new Float32Array(totalVerts * 3) : null;
  const uvs        = hasUvs    ? new Float32Array(totalVerts * 2) : null;
  const indices    = totalIndices > 0 ? new Uint32Array(totalIndices) : null;

  let vOffset = 0;
  let iOffset = 0;
  let baseVert = 0;

  for (const g of nonEmpty) {
    const pos  = g.attributes.position.array;
    const nrm  = hasNormals ? g.attributes.normal.array  : null;
    const uv   = hasUvs     ? g.attributes.uv.array      : null;
    const idx  = g.index    ? g.index.array               : null;
    const vc   = g.attributes.position.count;

    positions.set(pos, vOffset * 3);
    if (normals && nrm) normals.set(nrm, vOffset * 3);
    if (uvs     && uv)  uvs.set(uv,     vOffset * 2);

    if (indices && idx) {
      for (let k = 0; k < idx.length; k++) {
        indices[iOffset + k] = idx[k] + baseVert;
      }
      iOffset += idx.length;
    }

    vOffset  += vc;
    baseVert += vc;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (normals) merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (uvs)     merged.setAttribute('uv',     new THREE.BufferAttribute(uvs,     2));
  if (indices) merged.setIndex(new THREE.BufferAttribute(indices, 1));

  merged.computeVertexNormals();
  return merged;
}

// ─── Bark shader ─────────────────────────────────────────────────────────────

/**
 * Returns vertex shader GLSL source for bark rendering.
 * @returns {string}
 */
function _barkVert() {
  return /* glsl */`
    /**
     * Bark vertex shader
     * Uniforms:
     *   uTime:          float  — elapsed seconds
     *   uWindStrength:  float  — global wind strength 0-1
     *   uWindDirection: vec2   — normalised XZ wind vector
     *   uBranchDepth:   float  — LOD depth level (0 = trunk, 7 = twig)
     *   uLengthScale:   float  — word-count-driven length multiplier
     */
    precision highp float;

    uniform float uTime;
    uniform float uWindStrength;
    uniform vec2  uWindDirection;
    uniform float uBranchDepth;
    uniform float uLengthScale;

    varying vec3  vWorldPos;
    varying vec3  vWorldNormal;
    varying vec2  vUv;
    varying float vAO;
    varying float vDepth;

    // Height-based wind: tips move more than base
    float windDisplace(float height, float phase) {
      float freq1 = 0.52;
      float freq2 = 1.38;
      float freq3 = 2.94;
      float w1 = sin(uTime * freq1 + phase)         * 0.50;
      float w2 = sin(uTime * freq2 + phase * 1.41)  * 0.30;
      float w3 = sin(uTime * freq3 + phase * 0.73)  * 0.20;
      return (w1 + w2 + w3) * uWindStrength * height * height;
    }

    void main() {
      vec4 worldPos4 = modelMatrix * vec4(position, 1.0);
      vec3 worldPos  = worldPos4.xyz;

      // Wind deformation — only on upper branches (depth > 0)
      float windHeight  = max(0.0, worldPos.y);
      float depthFactor = uBranchDepth / 4.0;  // 0 at trunk, 1 at tips
      float phase       = dot(worldPos.xz, vec2(12.34, 56.78));

      float dispX = windDisplace(windHeight * depthFactor, phase);
      float dispZ = windDisplace(windHeight * depthFactor, phase + 1.5708);

      worldPos.x += uWindDirection.x * dispX;
      worldPos.z += uWindDirection.y * dispZ;

      vWorldPos    = worldPos;
      vWorldNormal = normalize(mat3(transpose(inverse(modelMatrix))) * normal);
      vUv          = uv;
      vDepth       = uBranchDepth;

      // AO: packed in uv.y channel at generation time (repurposed)
      // We bake it directly into a uniform per mesh; see uBakedAO
      vAO          = 1.0;

      gl_Position  = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
    }
  `;
}

/**
 * Returns fragment shader GLSL source for bark rendering.
 * @returns {string}
 */
function _barkFrag() {
  return /* glsl */`
    /**
     * Bark fragment shader
     *
     * Uniforms:
     *   uBranchDepth:   float  — 0 = trunk, 4+ = twig
     *   uBranchRadius:  float  — radius of this branch level (world units)
     *   uBranchAge:     float  — tree age in days / 365, normalised 0-1
     *   uMossAmount:    float  — driven by season: autumn/winter > spring/summer
     *   uWetness:       float  — global wetness 0-1
     *   uSunDir:        vec3   — normalised sun direction
     *   uSunColor:      vec3   — sun light RGB
     *   uIsNight:       float  — 0=day, 1=night
     *   uFogDensity:    float  — exponential fog coefficient
     *   uSeason:        float  — 0=spring, 1=summer, 2=autumn, 3=winter
     *   uFrostAmount:   float  — winter frost emissive 0-1
     *   uBakedAO:       float  — baked AO from generation (per-mesh constant)
     */
    precision mediump float;

    uniform float uBranchDepth;
    uniform float uBranchRadius;
    uniform float uBranchAge;
    uniform float uMossAmount;
    uniform float uWetness;
    uniform vec3  uSunDir;
    uniform vec3  uSunColor;
    uniform float uIsNight;
    uniform float uFogDensity;
    uniform float uSeason;
    uniform float uFrostAmount;
    uniform float uBakedAO;

    varying vec3  vWorldPos;
    varying vec3  vWorldNormal;
    varying vec2  vUv;
    varying float vDepth;

    // ── Hash noise for bark texture ───────────────────────────────────────────
    float hash2(vec2 p) {
      p = fract(p * vec2(234.34, 435.345));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }

    float fbm2(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 4; i++) {
        v += a * hash2(p);
        p  = p * 2.03 + vec2(1.7, 9.2);
        a *= 0.5;
      }
      return v;
    }

    // ── Bark albedo ───────────────────────────────────────────────────────────
    vec3 barkAlbedo() {
      // Base: dark brown, lightens with depth (thinner branches = lighter bark)
      vec3 darkBark  = vec3(0.22, 0.15, 0.09);
      vec3 lightBark = vec3(0.42, 0.30, 0.18);
      vec3 base      = mix(darkBark, lightBark, uBranchDepth / 4.0);

      // Tileable bark texture via FBM noise
      float tiling   = 14.0 / max(uBranchRadius, 0.01);   // more rings on thin branches
      tiling         = clamp(tiling, 8.0, 80.0);
      float grain    = fbm2(vUv * vec2(tiling * 0.5, tiling * 3.0));
      base          += vec3(grain * 0.08 - 0.04);

      // Vertical groove lines (characteristic of real bark)
      float groove   = abs(sin(vUv.x * tiling * 6.28)) * 0.5 + 0.5;
      groove         = pow(groove, 3.0);
      base          -= vec3(groove * 0.06);

      // Age: older bark has more texture contrast, slightly darker base
      base          *= mix(1.0, 0.82, uBranchAge * 0.4);

      // Moss: on upper faces (where rain accumulates), driven by season
      float upFacing = max(dot(normalize(vWorldNormal), vec3(0.0, 1.0, 0.0)), 0.0);
      float mossMask = upFacing * uMossAmount * (1.0 - uBranchDepth / 6.0);
      vec3  mossCol  = vec3(0.22, 0.38, 0.16);  // wet forest moss green
      base           = mix(base, mossCol, mossMask * 0.6);

      return base;
    }

    // ── Bark roughness ────────────────────────────────────────────────────────
    float barkRoughness() {
      float r = mix(0.88, 0.78, uBranchDepth / 4.0);  // thinner = smoother
      r       = mix(r, 0.92, uBranchAge * 0.25);       // age = rougher
      r       = mix(r, r * 0.62, uWetness);            // wet = less rough
      return r;
    }

    void main() {
      vec3  N        = normalize(vWorldNormal);
      vec3  L        = normalize(uSunDir);
      vec3  V        = normalize(cameraPosition - vWorldPos);
      vec3  H        = normalize(L + V);

      float NdotL    = max(dot(N, L), 0.0);
      float NdotH    = max(dot(N, H), 0.0);

      // ── Albedo ────────────────────────────────────────────────────────────
      vec3 albedo    = barkAlbedo();

      // Frost emissive in winter
      vec3 frostCol  = vec3(0.78, 0.88, 1.0);
      albedo         = mix(albedo, frostCol, uFrostAmount * 0.35);

      // Wetness darkening
      albedo        *= 1.0 - uWetness * 0.22;

      // ── Roughness ─────────────────────────────────────────────────────────
      float roughness = barkRoughness();

      // ── Lighting ──────────────────────────────────────────────────────────
      // Ambient: slightly blue-tinted sky (forest has complex sky occlusion)
      vec3 ambientDay   = vec3(0.06, 0.075, 0.11) * albedo;
      vec3 ambientNight = vec3(0.015, 0.02, 0.04) * albedo;
      vec3 ambient      = mix(ambientDay, ambientNight, uIsNight);

      // SSS approximation: bark thin enough at tips to transmit some light
      // Higher depth = thinner bark = more SSS
      float sssFactor = uBranchDepth / 4.0 * 0.15;
      float sss       = smoothstep(0.0, 1.0, dot(-N, L)) * sssFactor;
      vec3  sssColor  = albedo * vec3(0.8, 0.55, 0.35) * sss;

      // Diffuse
      vec3 sunColor  = uSunColor * mix(1.0, 0.10, uIsNight);
      vec3 diffuse   = albedo * NdotL * sunColor;

      // Specular (bark is rough — specular is minimal)
      float shininess = mix(4.0, 48.0, 1.0 - roughness);
      float spec      = pow(NdotH, shininess) * (1.0 - roughness) * 0.18;
      // Extra wet sheen
      float wetSpec   = uWetness * pow(NdotH, 96.0) * 0.35;
      vec3  specular  = (spec + wetSpec) * sunColor;

      // ── Frost emissive ────────────────────────────────────────────────────
      vec3 frostEmit  = frostCol * uFrostAmount * 0.04;

      // ── Baked AO ──────────────────────────────────────────────────────────
      float ao        = uBakedAO;

      vec3 finalColor = (ambient + diffuse + specular + sssColor + frostEmit) * ao;

      // ── Exponential fog ───────────────────────────────────────────────────
      float camDist   = length(cameraPosition - vWorldPos);
      float fogFactor = exp(-uFogDensity * camDist * camDist);
      fogFactor       = clamp(fogFactor, 0.0, 1.0);

      vec3 fogDay     = vec3(0.58, 0.72, 0.88);
      vec3 fogNight   = vec3(0.04, 0.06, 0.12);
      vec3 fogColor   = mix(fogDay, fogNight, uIsNight);

      finalColor      = mix(fogColor, finalColor, fogFactor);

      gl_FragColor    = vec4(finalColor, 1.0);
    }
  `;
}

// ─── Leaf shader ─────────────────────────────────────────────────────────────

/**
 * Vertex shader for leaves (InstancedMesh).
 * @returns {string}
 */
function _leafVert() {
  return /* glsl */`
    /**
     * Leaf vertex shader
     *
     * Uses instanced rendering. Each instance = one leaf quad.
     * instanceMatrix encodes position, rotation, scale.
     *
     * Uniforms:
     *   uTime:          float — elapsed seconds
     *   uWindStrength:  float — global wind 0-1
     *   uWindDirection: vec2  — normalised XZ
     *   uLeafColor:     vec3  — seasonal / mood-driven color
     *   uWetness:       float
     *   uSunDir:        vec3
     *   uSunColor:      vec3
     *   uIsNight:       float
     *   uFogDensity:    float
     */
    precision highp float;

    uniform float uTime;
    uniform float uWindStrength;
    uniform vec2  uWindDirection;
    uniform vec3  uLeafColor;
    uniform float uWetness;
    uniform vec3  uSunDir;
    uniform vec3  uSunColor;
    uniform float uIsNight;
    uniform float uFogDensity;

    varying vec3  vWorldPos;
    varying vec3  vWorldNormal;
    varying vec2  vUv;
    varying float vTransmit;

    void main() {
      // Per-instance world position extracted from instanceMatrix
      vec4 worldPos4  = instanceMatrix * vec4(position, 1.0);
      vec3 worldPos   = (modelMatrix * worldPos4).xyz;

      // Height-based wind sway (leaves are at branch tips)
      float height    = max(0.0, worldPos.y);
      float phase     = dot(worldPos.xz, vec2(17.42, 31.87));
      float sway      = sin(uTime * ${LEAF_WIND_FREQ.toFixed(2)} + phase) * ${LEAF_WIND_AMP.toFixed(2)};
      float flutter   = sin(uTime * 4.8 + phase * 0.5) * 0.06;  // rapid flutter
      float totalSway = (sway + flutter) * uWindStrength * (height * 0.04 + 0.5);

      worldPos.x += uWindDirection.x * totalSway;
      worldPos.z += uWindDirection.y * totalSway;

      vWorldPos    = worldPos;
      vWorldNormal = normalize(mat3(transpose(inverse(modelMatrix)))
                    * (mat3(instanceMatrix) * normal));
      vUv          = uv;

      // Transmittance: thin leaf lets some light through from behind
      // Used in fragment for backlit SSS
      vTransmit = 0.35;

      gl_Position  = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
    }
  `;
}

/**
 * Fragment shader for leaves.
 * @returns {string}
 */
function _leafFrag() {
  return /* glsl */`
    /**
     * Leaf fragment shader
     *
     * Features:
     *   - Vein overlay via UV-based procedural pattern
     *   - Subsurface scattering approximation (backlit translucency)
     *   - Edge glow when backlit
     *   - Seasonal color from uLeafColor uniform
     *   - Wetness response: darker, slightly specular
     *   - Alpha clip for leaf silhouette
     */
    precision mediump float;

    uniform float uTime;
    uniform float uWindStrength;
    uniform vec2  uWindDirection;
    uniform vec3  uLeafColor;
    uniform float uWetness;
    uniform vec3  uSunDir;
    uniform vec3  uSunColor;
    uniform float uIsNight;
    uniform float uFogDensity;

    varying vec3  vWorldPos;
    varying vec3  vWorldNormal;
    varying vec2  vUv;
    varying float vTransmit;

    // Leaf silhouette alpha (oval with slight irregularity)
    float leafAlpha(vec2 uv) {
      vec2  centered = uv - 0.5;
      // Oval shape — narrower at tip, wider at base
      float rx       = 0.38;
      float ry       = 0.48 + centered.y * 0.10;
      float oval     = length(centered / vec2(rx, ry));
      return 1.0 - smoothstep(0.82, 1.0, oval);
    }

    // Procedural vein pattern
    float veinMask(vec2 uv) {
      float mid   = abs(uv.x - 0.5);               // central vein
      float lat1  = abs(uv.x - 0.5 - 0.15 * uv.y); // lateral right
      float lat2  = abs(uv.x - 0.5 + 0.15 * uv.y); // lateral left
      float vein  = smoothstep(0.02, 0.0, mid)
                  + smoothstep(0.015, 0.0, lat1) * 0.5
                  + smoothstep(0.015, 0.0, lat2) * 0.5;
      return clamp(vein, 0.0, 1.0);
    }

    void main() {
      // Leaf silhouette clip
      float alpha = leafAlpha(vUv);
      if (alpha < 0.05) discard;

      vec3  N     = normalize(vWorldNormal);
      vec3  L     = normalize(uSunDir);
      vec3  V     = normalize(cameraPosition - vWorldPos);

      // ── Albedo ────────────────────────────────────────────────────────────
      vec3 albedo = uLeafColor;

      // Vein overlay: slightly darker than base
      float vein  = veinMask(vUv);
      albedo      = mix(albedo, albedo * 0.7, vein * 0.6);

      // Subtle per-leaf variation via UV hash
      float vary  = fract(sin(dot(floor(vUv * 4.0), vec2(12.98, 78.23))) * 43758.5);
      albedo     *= 0.92 + vary * 0.16;

      // Wetness: darker, glossier
      albedo     *= 1.0 - uWetness * 0.18;

      // ── Lighting ──────────────────────────────────────────────────────────
      float NdotL = max(dot(N, L),   0.0);
      float NdotV = max(dot(N, V),   0.0);

      // Backlit SSS: when sun is behind the leaf, transmit through
      float backlit    = max(dot(-N, L), 0.0);
      vec3  sssTint    = albedo * vec3(1.1, 1.35, 0.7);  // warm yellow-green bleed
      vec3  sss        = sssTint * backlit * vTransmit;

      // Edge glow when backlit and near silhouette edge
      float edgeDist   = min(vUv.x, 1.0 - vUv.x) * 2.0;
      float edgeGlow   = (1.0 - smoothstep(0.0, 0.35, edgeDist)) * backlit * 0.5;
      sss             += albedo * edgeGlow;

      // Diffuse — two-sided
      float diffFront  = NdotL;
      float diffBack   = max(dot(-N, L), 0.0) * 0.4;
      float diff       = max(diffFront, diffBack);

      vec3 sunColor    = uSunColor * mix(1.0, 0.08, uIsNight);
      vec3 ambDay      = vec3(0.06, 0.09, 0.07) * albedo;
      vec3 ambNight    = vec3(0.01, 0.02, 0.015) * albedo;
      vec3 ambient     = mix(ambDay, ambNight, uIsNight);

      vec3 finalColor  = ambient + albedo * diff * sunColor + sss;

      // Wet specular highlight
      vec3  H          = normalize(L + V);
      float spec       = pow(max(dot(N, H), 0.0), 24.0) * uWetness * 0.3;
      finalColor      += sunColor * spec;

      // ── Fog ───────────────────────────────────────────────────────────────
      float camDist    = length(cameraPosition - vWorldPos);
      float fogFactor  = exp(-uFogDensity * camDist * camDist);
      fogFactor        = clamp(fogFactor, 0.0, 1.0);

      vec3 fogDay      = vec3(0.58, 0.72, 0.88);
      vec3 fogNight    = vec3(0.04, 0.06, 0.12);
      vec3 fogColor    = mix(fogDay, fogNight, uIsNight);
      finalColor       = mix(fogColor, finalColor, fogFactor);

      gl_FragColor     = vec4(finalColor, alpha * 0.92);
    }
  `;
}

// ─── Shared resource initialisation ──────────────────────────────────────────

/**
 * Initialise LEAF_GEOMETRY and LEAF_MATERIAL once.
 * Called by grove.js before building any Tree instances.
 */
export function initLeafResources() {
  if (LEAF_GEOMETRY) return;   // already initialised

  LEAF_GEOMETRY = new THREE.PlaneGeometry(1, 1, 1, 1);
  // PlaneGeometry faces +Z; we want leaves to face up/out — grove.js sets instance rotations

  LEAF_MATERIAL = new THREE.ShaderMaterial({
    vertexShader:   _leafVert(),
    fragmentShader: _leafFrag(),
    uniforms: {
      uTime:          { value: 0 },
      uWindStrength:  { value: 0.2 },
      uWindDirection: { value: new THREE.Vector2(0.82, 0.28) },
      uLeafColor:     { value: new THREE.Color(0x2d6e22) },
      uWetness:       { value: 0 },
      uSunDir:        { value: new THREE.Vector3(0.4, 1, 0.3).normalize() },
      uSunColor:      { value: new THREE.Vector3(1, 0.95, 0.88) },
      uIsNight:       { value: 0 },
      uFogDensity:    { value: 0.0004 },
    },
    side:        THREE.DoubleSide,
    transparent: true,
    alphaTest:   0.05,
    depthWrite:  false,   // transparent leaves — no self-occluding depth writes
  });
}

/**
 * Update LEAF_MATERIAL uniforms from global state.
 * Called once per frame by grove.js.
 *
 * @param {number} elapsed  Elapsed seconds
 */
export function updateLeafMaterial(elapsed) {
  if (!LEAF_MATERIAL) return;
  const u = LEAF_MATERIAL.uniforms;
  u.uTime.value            = elapsed;
  u.uWindStrength.value    = state.wind.strength + state.wind.gustStrength;
  u.uWindDirection.value.set(state.wind.direction.x, state.wind.direction.z);
  u.uWetness.value         = state.wetness;
  u.uSunDir.value.set(state.sunDirection.x, state.sunDirection.y, state.sunDirection.z);
  u.uSunColor.value.set(state.sunColor.r, state.sunColor.g, state.sunColor.b);
  u.uIsNight.value         = state.isNight ? 1.0 : 0.0;
  u.uFogDensity.value      = state.fogDensity;

  // Seasonal leaf color
  const baseSeason = LEAF_COLORS[state.season] || LEAF_COLORS.summer;
  u.uLeafColor.value.copy(baseSeason);
}

// ─── Tree class ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} LeafInstance
 * @property {THREE.Vector3} position  World position
 * @property {THREE.Euler}   rotation  World rotation (faces roughly upward/outward)
 * @property {number}        scale     Quad scale (world units)
 * @property {THREE.Color}   color     Leaf color (mood/season-derived) — not used
 *                                     directly but stored for grove.js instancedMesh
 *                                     color attribute if extended later
 */

export class Tree {
  /**
   * @param {Object}         entryData   Supabase journal_entries row
   * @param {THREE.Scene}    scene
   * @param {THREE.Vector3}  position    World position of tree base
   */
  constructor(entryData, scene, position) {
    /** @type {Object} */
    this._entry     = entryData;
    /** @type {THREE.Scene} */
    this._scene     = scene;
    /** @type {THREE.Vector3} */
    this._position  = position.clone();

    // Seeded RNG — same entry always produces same tree
    this._rng       = _makeRng(entryData.id || String(Math.random()));

    // Tree classification
    this._type      = _classifyEntry(entryData);

    // Data-driven scale multipliers
    const words          = entryData.word_count || 80;
    this._lengthScale    = 0.55 + Math.min(words / 600, 1.0) * 0.85;
    this._radiusScale    = 0.45 + Math.min(words / 800, 1.0) * 0.80;

    // Mood valence/energy (0–1)
    this._valence        = entryData.mood_valence != null ? entryData.mood_valence : 0.5;
    this._energy         = entryData.mood_energy  != null ? entryData.mood_energy  : 0.5;

    // Age: days since entry was written
    const created        = entryData.created_at ? new Date(entryData.created_at) : new Date();
    this._ageDays        = (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24);
    this._ageNorm        = Math.min(this._ageDays / 730, 1.0);  // full maturity in 2 years

    // Branch angle (base) — reflective trees are wider-angled (drooping)
    this._baseAngle      = this._type === 'reflective' ? 32
                         : this._type === 'energetic'  ? 22
                         : this._type === 'short'      ? 28
                         : 26;

    // Three.js objects
    /** @type {THREE.Group} Root group — all tree geometry lives here. */
    this.root            = new THREE.Group();
    this.root.position.copy(this._position);

    /** @type {THREE.Mesh|null} Trunk mesh — pick target for raycasting. */
    this._trunkMesh      = null;

    /** @type {THREE.Mesh[]} All branch meshes (one per depth level 0–7). */
    this._branchMeshes   = [];

    /** @type {THREE.ShaderMaterial[]} One per depth level. */
    this._branchMaterials = [];

    /** @type {THREE.Mesh|null} Merged root geometry. */
    this._rootMesh       = null;

    /** @type {LeafInstance[]} Leaf positions for grove.js InstancedMesh. */
    this._leafInstances  = [];

    // Falling leaves state
    this._fallingLeaves  = [];  // active physics-leaf objects
    this._leafFallTimer  = 0;
    this._leafFallRate   = 0;   // leaves per second, set by triggerLeafFall

    // Seasonal transition targets
    this._targetMoss     = 0;
    this._currentMoss    = 0;
    this._targetFrost    = 0;
    this._currentFrost   = 0;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Build all geometry and add to scene.
   * Must be called once after construction.
   *
   * @returns {Promise<void>}
   */
  async buildGeometry() {
    // 1. Run L-system
    const rules    = _buildRules(this._type);
    const derived  = _derive('F', rules, L_DEPTH, this._rng);

    const params   = {
      lengthScale: this._lengthScale,
      radiusScale: this._radiusScale,
      baseAngle:   this._baseAngle,
      type:        this._type,
    };

    const { branches, leafClusters } = _interpret(derived, params, this._rng);

    // 2. Elevation bias driven by mood_valence
    // Positive valence → taller tree (up to +15%)
    // Negative valence → shorter tree (down to −12%)
    const elevBias = (this._valence - 0.5) * 2.0;  // −1 to +1
    this.root.scale.y = 1.0 + elevBias * 0.14;
    this.root.scale.x = 1.0 + (this._energy - 0.5) * 0.08;
    this.root.scale.z = this.root.scale.x;

    // 3. Build branch meshes — merged per depth level
    this._buildBranchMeshes(branches);

    // 4. Root system
    const rootCount = ROOT_COUNT_MIN + Math.floor(
      this._rng() * (ROOT_COUNT_MAX - ROOT_COUNT_MIN + 1)
    );
    this._buildRootMesh(rootCount);

    // 5. Leaf instances (for grove.js InstancedMesh)
    this._buildLeafInstances(leafClusters);

    // 6. Add to scene
    this._scene.add(this.root);

    // 7. Shadow casting
    this.root.traverse(child => {
      if (child.isMesh) {
        child.castShadow    = true;
        child.receiveShadow = true;
      }
    });
  }

  /**
   * Per-frame update. Call from grove.js update loop.
   *
   * @param {number} delta    Seconds since last frame
   * @param {number} elapsed  Total elapsed seconds
   */
  update(delta, elapsed) {
    // Update all branch material uniforms (shared GLSL, per-mesh uniforms vary)
    const windStr = state.wind.strength + state.wind.gustStrength;

    for (const mat of this._branchMaterials) {
      const u = mat.uniforms;
      u.uTime.value            = elapsed;
      u.uWindStrength.value    = windStr;
      u.uWindDirection.value.set(state.wind.direction.x, state.wind.direction.z);
      u.uWetness.value         = state.wetness;
      u.uSunDir.value.set(state.sunDirection.x, state.sunDirection.y, state.sunDirection.z);
      u.uSunColor.value.set(state.sunColor.r, state.sunColor.g, state.sunColor.b);
      u.uIsNight.value         = state.isNight ? 1.0 : 0.0;
      u.uFogDensity.value      = state.fogDensity;

      // Seasonal derived uniforms
      const season = state.season;
      u.uMossAmount.value      = this._currentMoss;
      u.uFrostAmount.value     = this._currentFrost;
    }

    // Seasonal lerp targets
    const targetMoss  = season === 'autumn' ? 0.55
                      : season === 'winter' ? 0.40
                      : season === 'spring' ? 0.30
                      : 0.15;   // summer — least moss
    const targetFrost = season === 'winter' ? 0.6 + this._rng() * 0.3 : 0.0;

    // Lerp toward targets — 72-hour real-time transition (spec)
    // We lerp per frame at a speed that covers 0→1 in ~72 real hours
    const lerpRate = delta / (72 * 3600);  // very slow
    this._currentMoss  += (targetMoss  - this._currentMoss)  * Math.min(lerpRate * 3600, 1.0);
    this._currentFrost += (targetFrost - this._currentFrost) * Math.min(lerpRate * 3600, 1.0);

    // Leaf fall physics
    if (this._leafFallRate > 0) {
      this._updateLeafFall(delta, elapsed);
    }
  }

  /**
   * Clean up all GPU resources and remove from scene.
   */
  dispose() {
    this._scene.remove(this.root);

    for (const mesh of this._branchMeshes) {
      if (mesh.geometry) mesh.geometry.dispose();
    }
    for (const mat of this._branchMaterials) {
      mat.dispose();
    }

    if (this._rootMesh) {
      if (this._rootMesh.geometry) this._rootMesh.geometry.dispose();
      if (this._rootMesh.material) this._rootMesh.material.dispose();
    }

    // Falling leaf quads
    for (const leaf of this._fallingLeaves) {
      this._scene.remove(leaf.mesh);
      if (leaf.mesh.geometry) leaf.mesh.geometry.dispose();
    }
    this._fallingLeaves.length = 0;

    this._branchMeshes.length    = 0;
    this._branchMaterials.length = 0;
    this._leafInstances.length   = 0;
    this._trunkMesh              = null;
    this._rootMesh               = null;
  }

  /**
   * Returns the trunk mesh — used by grove.js for raycasting.
   *
   * @returns {THREE.Mesh|null}
   */
  getPickTarget() {
    return this._trunkMesh;
  }

  /**
   * Returns leaf instance data for grove.js to place into its InstancedMesh.
   * Each entry describes one leaf quad in world space.
   *
   * @returns {LeafInstance[]}
   */
  getLeafInstances() {
    return this._leafInstances;
  }

  /**
   * Begin a leaf fall event.
   * grove.js calls this during season transitions (summer→autumn, autumn→winter).
   *
   * @param {number} totalCount  Total leaves to shed
   */
  triggerLeafFall(totalCount) {
    this._leafFallRate  = LEAF_FALL_RATE;
    this._leafFallBudget = totalCount;
  }

  // ── Private geometry builders ──────────────────────────────────────────────

  /**
   * Build one merged geometry + ShaderMaterial per depth level.
   * Branches at the same depth share the same material instance (same uniforms)
   * so they can be batched as one draw call each.
   *
   * @param {Array} branches  Output of _interpret()
   */
  _buildBranchMeshes(branches) {
    // Group branches by depth
    const byDepth = new Map();  // depth → BranchSegment[]
    for (const b of branches) {
      const d = Math.min(b.depth, 7);
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d).push(b);
    }

    for (const [depth, segs] of byDepth) {
      // Merge all branch geometries at this depth
      const geos = segs.map(seg =>
        _buildBranchGeometry(seg.start, seg.end, seg.radius, this._rng)
      );

      const merged = _mergeGeometries(geos);
      // Free per-segment geometries
      for (const g of geos) g.dispose();

      // Baked AO: average AO of all segments at this depth
      const avgAO = segs.reduce((sum, s) => sum + s.ao, 0) / segs.length;

      // Per-depth material
      const mat = new THREE.ShaderMaterial({
        vertexShader:   _barkVert(),
        fragmentShader: _barkFrag(),
        uniforms: {
          uTime:          { value: 0 },
          uWindStrength:  { value: 0.2 },
          uWindDirection: { value: new THREE.Vector2(0.82, 0.28) },
          uBranchDepth:   { value: depth },
          uLengthScale:   { value: this._lengthScale },
          uBranchRadius:  { value: BASE_RADIUS * Math.pow(RADIUS_DECAY, depth) },
          uBranchAge:     { value: this._ageNorm },
          uMossAmount:    { value: 0.15 },
          uWetness:       { value: 0 },
          uSunDir:        { value: new THREE.Vector3(0.4, 1, 0.3).normalize() },
          uSunColor:      { value: new THREE.Vector3(1, 0.95, 0.88) },
          uIsNight:       { value: 0 },
          uFogDensity:    { value: 0.0004 },
          uSeason:        { value: 1.0 },
          uFrostAmount:   { value: 0 },
          uBakedAO:       { value: avgAO },
        },
        side: THREE.FrontSide,
      });

      const mesh = new THREE.Mesh(merged, mat);
      // No extra position: branches are in tree-local space from the turtle's origin
      this.root.add(mesh);

      this._branchMeshes.push(mesh);
      this._branchMaterials.push(mat);

      // Trunk: depth 0
      if (depth === 0) this._trunkMesh = mesh;
    }

    // Fallback if L-system produced no depth-0 branches
    if (!this._trunkMesh && this._branchMeshes.length > 0) {
      this._trunkMesh = this._branchMeshes[0];
    }
  }

  /**
   * Build and add the root system mesh.
   *
   * @param {number} count  Number of surface roots
   */
  _buildRootMesh(count) {
    const geo = _buildRootGeometry(count, this._rng);

    // Root material — darker, rougher bark, heavily AO'd
    const mat = new THREE.ShaderMaterial({
      vertexShader:   _barkVert(),
      fragmentShader: _barkFrag(),
      uniforms: {
        uTime:          { value: 0 },
        uWindStrength:  { value: 0 },           // roots don't sway
        uWindDirection: { value: new THREE.Vector2(0.82, 0.28) },
        uBranchDepth:   { value: 0 },           // treated as trunk-level bark
        uLengthScale:   { value: 1.0 },
        uBranchRadius:  { value: 0.04 },
        uBranchAge:     { value: this._ageNorm },
        uMossAmount:    { value: 0.35 },        // roots accumulate more moss
        uWetness:       { value: 0 },
        uSunDir:        { value: new THREE.Vector3(0.4, 1, 0.3).normalize() },
        uSunColor:      { value: new THREE.Vector3(1, 0.95, 0.88) },
        uIsNight:       { value: 0 },
        uFogDensity:    { value: 0.0004 },
        uSeason:        { value: 1.0 },
        uFrostAmount:   { value: 0 },
        uBakedAO:       { value: 0.42 },        // roots are heavily occluded
      },
      side: THREE.FrontSide,
    });

    this._rootMesh = new THREE.Mesh(geo, mat);
    this.root.add(this._rootMesh);

    // Roots share the same seasonal uniform updates as branches
    this._branchMaterials.push(mat);
  }

  /**
   * Convert raw leaf cluster data from the turtle into LeafInstance records.
   * Each cluster spawns 4–8 individual leaf quads with random orientations.
   *
   * @param {Array} leafClusters  Output of _interpret()
   */
  _buildLeafInstances(leafClusters) {
    const seasonColor = LEAF_COLORS[state.season] || LEAF_COLORS.summer;
    const leafColor   = _moodLeafColor(seasonColor, this._valence, this._energy);

    for (const cluster of leafClusters) {
      // Number of leaves per cluster: more leaves on high-energy trees
      const clusterCount = 4 + Math.floor(this._rng() * (4 + this._energy * 4));

      for (let i = 0; i < clusterCount; i++) {
        // Random position within cluster radius
        const spread  = cluster.size * 1.2;
        const offset  = new THREE.Vector3(
          (this._rng() - 0.5) * spread,
          (this._rng() - 0.5) * spread * 0.5,
          (this._rng() - 0.5) * spread,
        );

        // World position: tree local → world
        const localPos = cluster.position.clone().add(offset);
        const worldPos = localPos.clone().applyMatrix4(this.root.matrixWorld);

        // Random rotation: mostly face upward/outward with some random roll
        const rx = (this._rng() - 0.5) * 0.8;
        const ry = this._rng() * Math.PI * 2;
        const rz = (this._rng() - 0.5) * 0.4;

        this._leafInstances.push({
          position: worldPos,
          rotation: new THREE.Euler(rx, ry, rz, 'YXZ'),
          scale:    cluster.size * (0.75 + this._rng() * 0.5),
          color:    leafColor.clone(),
        });
      }
    }
  }

  // ── Leaf fall physics ──────────────────────────────────────────────────────

  /**
   * Per-frame leaf fall simulation.
   * Spawns new falling leaves at the set rate.
   * Each falling leaf is a small PlaneGeometry quad with physics-driven
   * position update (velocity, drag, angular, wind influence, ground settle).
   *
   * Text-bearing autumn leaves: one in six falling leaves during autumn
   * carries a fragment of a journal sentence from this tree's entry.
   *
   * @param {number} delta
   * @param {number} elapsed
   */
  _updateLeafFall(delta, elapsed) {
    // Spawn new leaves
    if (this._leafFallBudget > 0) {
      this._leafFallTimer += delta;
      const spawnInterval = 1.0 / this._leafFallRate;

      while (this._leafFallTimer >= spawnInterval && this._leafFallBudget > 0) {
        this._leafFallTimer -= spawnInterval;
        this._leafFallBudget--;
        this._spawnFallingLeaf(elapsed);
      }
    }

    // Update in-flight leaves
    const gravity    = -0.8;   // m/s²
    const airDrag    = 0.94;   // velocity multiplier per frame at 60fps
    const windForce  = state.wind.strength * 0.35;
    const groundY    = this._position.y;

    for (let i = this._fallingLeaves.length - 1; i >= 0; i--) {
      const leaf = this._fallingLeaves[i];

      // Physics integration
      leaf.velocity.y   += gravity * delta;
      leaf.velocity.x   += state.wind.direction.x * windForce * delta;
      leaf.velocity.z   += state.wind.direction.z * windForce * delta;

      // Air drag
      leaf.velocity.x   *= Math.pow(airDrag, delta * 60);
      leaf.velocity.y   *= Math.pow(airDrag, delta * 60);
      leaf.velocity.z   *= Math.pow(airDrag, delta * 60);

      // Sinusoidal drift (leaves spiral as they fall)
      const driftX = Math.sin(elapsed * leaf.driftFreq + leaf.driftPhase) * 0.12;
      const driftZ = Math.cos(elapsed * leaf.driftFreq + leaf.driftPhase * 0.7) * 0.12;

      leaf.mesh.position.x += (leaf.velocity.x + driftX) * delta;
      leaf.mesh.position.y +=  leaf.velocity.y            * delta;
      leaf.mesh.position.z += (leaf.velocity.z + driftZ) * delta;

      // Angular velocity
      leaf.mesh.rotation.x += leaf.angVel.x * delta;
      leaf.mesh.rotation.y += leaf.angVel.y * delta;
      leaf.mesh.rotation.z += leaf.angVel.z * delta;

      // Dampen rotation as leaf slows
      const speed = leaf.velocity.length();
      leaf.angVel.multiplyScalar(1.0 - delta * 0.8);

      // Ground settle: when y reaches terrain height, fade out and remove
      if (leaf.mesh.position.y <= groundY + 0.04) {
        leaf.mesh.position.y = groundY + 0.02;
        // Zero vertical velocity, slow horizontal
        leaf.velocity.y       = 0;
        leaf.velocity.x      *= 0.1;
        leaf.velocity.z      *= 0.1;
        leaf.settled          = true;

        // Fade out the material over ~4 seconds on ground
        leaf.settleTimer     += delta;
        const opacity         = Math.max(0, 1.0 - leaf.settleTimer / 4.0);
        if (leaf.mesh.material) leaf.mesh.material.opacity = opacity;

        if (opacity <= 0) {
          this._scene.remove(leaf.mesh);
          if (leaf.mesh.geometry) leaf.mesh.geometry.dispose();
          if (leaf.mesh.material) leaf.mesh.material.dispose();
          this._fallingLeaves.splice(i, 1);
        }
      }
    }
  }

  /**
   * Spawn a single physics-driven falling leaf.
   *
   * @param {number} elapsed
   */
  _spawnFallingLeaf(elapsed) {
    // Choose a random leaf instance as spawn point
    if (this._leafInstances.length === 0) return;

    const src  = this._leafInstances[
      Math.floor(this._rng() * this._leafInstances.length)
    ];

    const geo  = new THREE.PlaneGeometry(
      src.scale * 1.2,
      src.scale * 1.2,
      1, 1
    );

    // Text-bearing leaf: autumn, 1-in-6 chance
    const isTextLeaf = state.season === 'autumn' && this._rng() < 0.167;
    const leafColor  = LEAF_COLORS[state.season] || LEAF_COLORS.summer;

    let mat;
    if (isTextLeaf) {
      mat = this._buildTextLeafMaterial(leafColor);
    } else {
      mat = new THREE.MeshBasicMaterial({
        color:       leafColor,
        side:        THREE.DoubleSide,
        transparent: true,
        opacity:     0.88,
        depthWrite:  false,
      });
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(src.position);
    mesh.rotation.copy(src.rotation);

    this._scene.add(mesh);

    // Initial velocity: slightly random downward + wind
    const vel = new THREE.Vector3(
      (this._rng() - 0.5) * 0.4 + state.wind.direction.x * 0.3,
      0.1 + this._rng() * 0.3,   // slight initial upward puff before falling
      (this._rng() - 0.5) * 0.4 + state.wind.direction.z * 0.3,
    );

    this._fallingLeaves.push({
      mesh,
      velocity:    vel,
      angVel:      new THREE.Vector3(
        (this._rng() - 0.5) * 3.0,
        (this._rng() - 0.5) * 2.0,
        (this._rng() - 0.5) * 3.0,
      ),
      driftFreq:   1.5 + this._rng() * 2.0,
      driftPhase:  this._rng() * Math.PI * 2,
      settled:     false,
      settleTimer: 0,
    });
  }

  /**
   * Build a canvas texture material for a text-bearing autumn leaf.
   * Renders a fragment of the journal entry's content on the leaf surface.
   *
   * @param {THREE.Color} leafColor
   * @returns {THREE.MeshBasicMaterial}
   */
  _buildTextLeafMaterial(leafColor) {
    const canvas = document.createElement('canvas');
    canvas.width  = 128;
    canvas.height = 128;
    const ctx     = canvas.getContext('2d');

    // Leaf background
    ctx.fillStyle = `#${leafColor.getHexString()}`;
    ctx.fillRect(0, 0, 128, 128);

    // Extract a short phrase from the journal entry content
    const content = this._entry.content || '';
    const words   = content.split(/\s+/).filter(Boolean);
    const start   = Math.floor(this._rng() * Math.max(1, words.length - 5));
    const phrase  = words.slice(start, start + 5).join(' ');

    // Draw text
    ctx.fillStyle   = 'rgba(0,0,0,0.55)';
    ctx.font        = '11px Georgia, serif';
    ctx.textAlign   = 'center';
    ctx.textBaseline = 'middle';

    // Word wrap at ~14 chars per line
    const maxLen = 14;
    const lines  = [];
    let line     = '';
    for (const word of phrase.split(' ')) {
      if ((line + word).length > maxLen && line.length > 0) {
        lines.push(line.trim());
        line = '';
      }
      line += word + ' ';
    }
    if (line.trim()) lines.push(line.trim());

    const lineH = 14;
    const startY = 64 - (lines.length - 1) * lineH / 2;
    lines.forEach((l, i) => {
      ctx.fillText(l, 64, startY + i * lineH);
    });

    return new THREE.MeshBasicMaterial({
      map:         new THREE.CanvasTexture(canvas),
      side:        THREE.DoubleSide,
      transparent: true,
      opacity:     0.88,
      depthWrite:  false,
    });
  }
}

// ─── Year tree factory ────────────────────────────────────────────────────────

/**
 * Build a secondary "year tree" — one per calendar year of journaling.
 * These are larger, more architecturally distinct trees placed in an arc
 * around the grove perimeter. grove.js computes the positions; this function
 * constructs the Tree with specially crafted synthetic entry data.
 *
 * @param {number}        year         Calendar year (e.g. 2024)
 * @param {number}        entryCount   Number of journal entries in that year
 * @param {THREE.Scene}   scene
 * @param {THREE.Vector3} position     Arc position computed by grove.js
 * @returns {Tree}
 */
export function buildYearTree(year, entryCount, scene, position) {
  // Synthesise an entry-like object: a prolific year makes a large tree
  const syntheticEntry = {
    id:           `year-tree-${year}`,
    word_count:   Math.max(200, entryCount * 40),  // generous size
    mood_valence: 0.58,    // year trees are slightly positive — resilience
    mood_energy:  0.52,
    created_at:   new Date(year, 0, 1).toISOString(),
    content:      String(year),
  };

  const tree = new Tree(syntheticEntry, scene, position);

  // Year trees: always 'normal' archetype, overriding mood-driven type
  // They are the chronicle pillars — balanced and enduring
  tree._type         = 'normal';
  tree._lengthScale  = 0.9 + Math.min(entryCount / 120, 1.0) * 0.85;
  tree._radiusScale  = 0.8 + Math.min(entryCount / 160, 1.0) * 0.75;
  tree._baseAngle    = 24;

  // Attach year label (grove.js will read this to place a stone placard)
  tree.yearLabel      = String(year);
  tree.yearEntryCount = entryCount;

  return tree;
}
