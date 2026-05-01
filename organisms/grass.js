/**
 * grass.js — 80,000 blade instanced grass system for the Garden zone
 * Atlas: The Living World
 *
 * Responsibilities:
 *   - 80,000 InstancedMesh grass blades via Poisson-disc distribution over
 *     the Garden zone (700 × 700 units centred at CONFIG.ZONES.garden)
 *   - 6-segment tapered ribbon geometry per blade (12 triangles)
 *   - Three LOD levels: full (< 80u), reduced (< 200u), billboard (< 420u),
 *     invisible beyond 420 units
 *   - Custom vertex shader: three-frequency wind sway with height-powered
 *     deformation, spatial phase offset, unique per-instance phase
 *   - Custom fragment shader: translucency on tips, self-shadow approximation,
 *     wetness darkening, SSS-style backlight transmission
 *   - Poisson-disc placement seeded deterministically from garden zone center
 *   - Height sampling via terrain.js getHeightAt() — blades always sit flush
 *   - Seasonal colour variation driven by state.season
 *   - Per-frame uniform updates from state.js (wind, wetness, time, sun)
 *
 * Dependencies: THREE (global r128), config.js, state.js, terrain.js
 *
 * Draw call budget: 3 (one InstancedMesh per LOD level, only active LOD drawn)
 *
 * Usage:
 *   import { initGrass, updateGrass, disposeGrass } from './grass.js';
 *   await initGrass(scene);
 *   registerUpdate(updateGrass);
 */

import { CONFIG } from '../core/config.js';
import { state }  from '../core/state.js';
import { getHeightAt } from './terrain.js';

const THREE = window.THREE;

// ─── Constants ────────────────────────────────────────────────────────────────

const BLADE_COUNT       = 80_000;
const GARDEN_CENTER_X   = CONFIG.ZONES.garden.x;   // −1600
const GARDEN_CENTER_Z   = CONFIG.ZONES.garden.z;   // +1400
const GARDEN_RADIUS     = 340;   // half of 700 × 700, roughly circular field

// LOD switch distances (from camera to blade, approximate via zone center dist)
const LOD_FULL_DIST     = 80;
const LOD_MID_DIST      = 200;
const LOD_BILLBOARD_DIST= 420;
const LOD_CULL_DIST     = 440;

// Blade geometry parameters
const BLADE_SEGMENTS    = 6;     // 6 height segments → 12 triangles per blade
const BLADE_HEIGHT_MIN  = 0.28;  // metres
const BLADE_HEIGHT_MAX  = 0.72;
const BLADE_WIDTH_BASE  = 0.028; // base width
const BLADE_WIDTH_TIP   = 0.004; // tip width

// Wind shader frequencies and amplitudes
const WIND_FREQ_1       = 0.62;  // Hz — primary sway
const WIND_FREQ_2       = 1.38;  // Hz — mid ripple
const WIND_FREQ_3       = 2.90;  // Hz — tip flutter
const WIND_AMP_1        = 1.00;  // relative amplitude for primary
const WIND_AMP_2        = 0.28;
const WIND_AMP_3        = 0.10;

// Poisson-disc minimum separation between blades
const POISSON_RADIUS    = 0.62;  // units — gives ~80k blades in the zone

// ─── Module state ─────────────────────────────────────────────────────────────

let _meshFull       = null;   // InstancedMesh — full LOD (6-segment ribbon)
let _meshMid        = null;   // InstancedMesh — reduced LOD (3-segment ribbon)
let _meshBillboard  = null;   // InstancedMesh — single quad billboard
let _matFull        = null;   // ShaderMaterial
let _matMid         = null;   // ShaderMaterial (same shaders, fewer segments)
let _matBillboard   = null;   // ShaderMaterial (simplified billboard)
let _instanceData   = null;   // Float32Array — per-instance: x, y, z, phase, scaleY, rot
const _INSTANCE_STRIDE = 6;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build all grass geometry and add to the scene.
 * Generates Poisson-disc positions, samples terrain heights, uploads to GPU.
 *
 * @param {THREE.Scene} scene
 * @returns {Promise<void>}
 */
export async function initGrass(scene) {
  const positions = _poissonDisc(
    GARDEN_CENTER_X, GARDEN_CENTER_Z,
    GARDEN_RADIUS, POISSON_RADIUS, BLADE_COUNT
  );

  _buildInstanceData(positions);

  const geoFull      = _buildBladeGeometry(BLADE_SEGMENTS);
  const geoMid       = _buildBladeGeometry(3);
  const geoBillboard = _buildBillboardGeometry();

  _matFull      = _buildMaterial(BLADE_SEGMENTS, false);
  _matMid       = _buildMaterial(3, false);
  _matBillboard = _buildMaterial(1, true);

  const count = positions.length;

  _meshFull      = new THREE.InstancedMesh(geoFull,      _matFull,      count);
  _meshMid       = new THREE.InstancedMesh(geoMid,       _matMid,       count);
  _meshBillboard = new THREE.InstancedMesh(geoBillboard, _matBillboard, count);

  _meshFull.castShadow      = false;
  _meshFull.receiveShadow   = false;
  _meshMid.castShadow       = false;
  _meshMid.receiveShadow    = false;
  _meshBillboard.castShadow = false;
  _meshBillboard.receiveShadow = false;

  // Set instance transforms via dummy matrix
  _applyInstanceTransforms(_meshFull);
  _applyInstanceTransforms(_meshMid);
  _applyInstanceTransforms(_meshBillboard);

  // Set custom per-instance attributes on geometry for phase & scale
  _applyInstanceAttributes(geoFull,      count);
  _applyInstanceAttributes(geoMid,       count);
  _applyInstanceAttributes(geoBillboard, count);

  // Frustum culling — disabled; the instanced mesh spans the entire garden,
  // and per-instance frustum culling is handled by LOD distance in the shader.
  _meshFull.frustumCulled      = false;
  _meshMid.frustumCulled       = false;
  _meshBillboard.frustumCulled = false;

  scene.add(_meshFull);
  scene.add(_meshMid);
  scene.add(_meshBillboard);

  // Start with mid LOD visible, full and billboard off
  _meshFull.visible      = true;
  _meshMid.visible       = false;
  _meshBillboard.visible = false;

  console.log(
    '%cATLAS GRASS%c %d blades — 3 LOD levels',
    'color:#4a8c5c;font-weight:bold', 'color:#8a7e6e', count
  );
}

/**
 * Per-frame update. Switches LOD meshes by camera-to-zone-center distance,
 * syncs all shader uniforms from state.js.
 *
 * @param {number} delta     Seconds since last frame
 * @param {number} elapsed   Total elapsed seconds
 */
export function updateGrass(delta, elapsed) {
  if (!_meshFull) return;

  // LOD selection — distance from camera to garden center
  const dx   = state.camera.x - GARDEN_CENTER_X;
  const dz   = state.camera.z - GARDEN_CENTER_Z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  const showFull      = dist < LOD_FULL_DIST;
  const showMid       = !showFull && dist < LOD_MID_DIST;
  const showBillboard = !showFull && !showMid && dist < LOD_BILLBOARD_DIST;

  _meshFull.visible      = showFull;
  _meshMid.visible       = showMid;
  _meshBillboard.visible = showBillboard;

  // If entirely out of range, skip uniform updates
  if (!showFull && !showMid && !showBillboard) return;

  const season = state.season; // 'spring' | 'summer' | 'autumn' | 'winter'
  const grassColor = _seasonalGrassColor(season);
  const tipColor   = _seasonalTipColor(season);

  // Sync uniforms on all active materials
  const mats = [_matFull, _matMid, _matBillboard].filter(Boolean);
  for (const mat of mats) {
    const u = mat.uniforms;
    u.uTime.value          = elapsed;
    u.uWindStrength.value  = state.wind.strength;
    u.uWindGust.value      = state.wind.gustStrength;
    u.uWindDir.value.set(state.wind.direction.x, state.wind.direction.z);
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
    u.uIsNight.value       = state.isNight ? 1.0 : 0.0;
    u.uGrassColor.value.set(grassColor.r, grassColor.g, grassColor.b);
    u.uTipColor.value.set(tipColor.r, tipColor.g, tipColor.b);
    u.uFogDensity.value    = state.fogDensity;
    u.uCamPos.value.copy(
      new THREE.Vector3(state.camera.x, state.camera.y, state.camera.z)
    );
  }
}

/**
 * Dispose all GPU resources. Call on logout or scene teardown.
 */
export function disposeGrass() {
  const meshes = [_meshFull, _meshMid, _meshBillboard];
  const mats   = [_matFull, _matMid, _matBillboard];

  for (const mesh of meshes) {
    if (!mesh) continue;
    mesh.geometry.dispose();
    if (mesh.parent) mesh.parent.remove(mesh);
  }
  for (const mat of mats) {
    if (mat) mat.dispose();
  }

  _meshFull = _meshMid = _meshBillboard = null;
  _matFull  = _matMid  = _matBillboard  = null;
  _instanceData = null;
}

// ─── Poisson-disc sampling ────────────────────────────────────────────────────

/**
 * Generate up to `maxPoints` 2-D positions within a circular zone using
 * Bridson's Poisson-disc sampling algorithm. Deterministic seed via LCG.
 *
 * @param {number} cx           Zone center X
 * @param {number} cz           Zone center Z
 * @param {number} zoneRadius   Radius of the circular spawn area
 * @param {number} minDist      Minimum separation between points
 * @param {number} maxPoints    Target count (actual may be slightly less)
 * @returns {Array<{x, z}>}
 */
function _poissonDisc(cx, cz, zoneRadius, minDist, maxPoints) {
  // Seeded LCG pseudo-random number generator — deterministic every session
  let seed = 0x4a8c5c; // garden green seed
  function rand() {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  }

  const cellSize = minDist / Math.SQRT2;
  const gridW    = Math.ceil((zoneRadius * 2) / cellSize) + 2;
  const grid     = new Array(gridW * gridW).fill(-1);
  const points   = [];
  const active   = [];

  function gridIdx(x, z) {
    const gx = Math.floor((x - cx + zoneRadius) / cellSize);
    const gz = Math.floor((z - cz + zoneRadius) / cellSize);
    return gz * gridW + gx;
  }

  function inZone(x, z) {
    const dx = x - cx;
    const dz = z - cz;
    return dx * dx + dz * dz < zoneRadius * zoneRadius;
  }

  // First sample near zone center
  const startX = cx + (rand() - 0.5) * 4;
  const startZ = cz + (rand() - 0.5) * 4;
  points.push({ x: startX, z: startZ });
  active.push(0);
  grid[gridIdx(startX, startZ)] = 0;

  const MAX_ATTEMPTS = 24;

  while (active.length > 0 && points.length < maxPoints) {
    const randIdx   = Math.floor(rand() * active.length);
    const parentIdx = active[randIdx];
    const parent    = points[parentIdx];
    let   placed    = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const angle = rand() * Math.PI * 2;
      const dist  = minDist + rand() * minDist;
      const nx    = parent.x + Math.cos(angle) * dist;
      const nz    = parent.z + Math.sin(angle) * dist;

      if (!inZone(nx, nz)) continue;

      // Check grid cells in neighbourhood
      const gx0 = Math.max(0, Math.floor((nx - cx + zoneRadius) / cellSize) - 2);
      const gz0 = Math.max(0, Math.floor((nz - cz + zoneRadius) / cellSize) - 2);
      const gx1 = Math.min(gridW - 1, gx0 + 4);
      const gz1 = Math.min(gridW - 1, gz0 + 4);

      let tooClose = false;
      outer: for (let gzi = gz0; gzi <= gz1; gzi++) {
        for (let gxi = gx0; gxi <= gx1; gxi++) {
          const neighbour = grid[gzi * gridW + gxi];
          if (neighbour === -1) continue;
          const p  = points[neighbour];
          const dx = nx - p.x;
          const dz = nz - p.z;
          if (dx * dx + dz * dz < minDist * minDist) {
            tooClose = true;
            break outer;
          }
        }
      }

      if (!tooClose) {
        const newIdx = points.length;
        points.push({ x: nx, z: nz });
        active.push(newIdx);
        grid[gridIdx(nx, nz)] = newIdx;
        placed = true;
        break;
      }
    }

    if (!placed) {
      active.splice(randIdx, 1);
    }
  }

  return points;
}

// ─── Instance data ────────────────────────────────────────────────────────────

/**
 * Build Float32Array of per-instance data:
 *   [x, y, z, phase, scaleY, rotationY]  ×  count
 * Terrain height sampled here — blades sit precisely on terrain surface.
 */
function _buildInstanceData(positions) {
  const count = positions.length;
  _instanceData = new Float32Array(count * _INSTANCE_STRIDE);

  // Seeded RNG for deterministic per-blade variation
  let seed = 0xc8a96e;
  function rand() {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  }

  for (let i = 0; i < count; i++) {
    const p      = positions[i];
    const y      = getHeightAt(p.x, p.z);
    const phase  = rand() * Math.PI * 2;          // unique wind phase per blade
    const scaleY = BLADE_HEIGHT_MIN + rand() * (BLADE_HEIGHT_MAX - BLADE_HEIGHT_MIN);
    const rotY   = rand() * Math.PI * 2;          // random facing direction

    const base = i * _INSTANCE_STRIDE;
    _instanceData[base + 0] = p.x;
    _instanceData[base + 1] = y;
    _instanceData[base + 2] = p.z;
    _instanceData[base + 3] = phase;
    _instanceData[base + 4] = scaleY;
    _instanceData[base + 5] = rotY;
  }
}

/**
 * Apply InstancedMesh transforms from _instanceData.
 * Each blade gets a Matrix4 encoding its world translation and Y rotation.
 * Height scale is encoded in the instanceAttribute, not the matrix,
 * so the vertex shader can apply it per-segment correctly.
 */
function _applyInstanceTransforms(mesh) {
  const count  = mesh.count;
  const dummy  = new THREE.Object3D();

  for (let i = 0; i < count; i++) {
    const base = i * _INSTANCE_STRIDE;
    dummy.position.set(
      _instanceData[base + 0],
      _instanceData[base + 1],
      _instanceData[base + 2]
    );
    dummy.rotation.set(0, _instanceData[base + 5], 0);
    dummy.scale.set(1, 1, 1); // Y scale handled per-vertex in shader
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }

  mesh.instanceMatrix.needsUpdate = true;
}

/**
 * Attach per-instance Float32 attributes (phase, scaleY) directly on geometry.
 * These flow into the vertex shader as `attribute float aPhase` and `aScaleY`.
 */
function _applyInstanceAttributes(geo, count) {
  const phases  = new Float32Array(count);
  const scalesY = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const base    = i * _INSTANCE_STRIDE;
    phases[i]     = _instanceData[base + 3];
    scalesY[i]    = _instanceData[base + 4];
  }

  geo.setAttribute('aPhase',  new THREE.InstancedBufferAttribute(phases,  1));
  geo.setAttribute('aScaleY', new THREE.InstancedBufferAttribute(scalesY, 1));
}

// ─── Geometry builders ────────────────────────────────────────────────────────

/**
 * Build a single tapered ribbon grass blade geometry.
 *
 * The blade is a strip of (segments) quads in local Y, centred on X=0, Z=0.
 * Width tapers linearly from BLADE_WIDTH_BASE at the root to BLADE_WIDTH_TIP
 * at the tip. The actual height is 1.0 — per-instance scaleY applied in shader.
 *
 * Local-space coordinate convention:
 *   Y = 0  — root (ground level)
 *   Y = 1  — tip
 *   X = ±width/2 at each segment
 *
 * Attributes:
 *   position (vec3), uv (vec2), aNormalised (float) — 0=root, 1=tip
 *
 * @param {number} segments
 * @returns {THREE.BufferGeometry}
 */
function _buildBladeGeometry(segments) {
  const vertCount = (segments + 1) * 2;       // two verts per segment row
  const triCount  = segments * 2;              // two tris per quad
  const idxCount  = triCount * 3;

  const positions   = new Float32Array(vertCount * 3);
  const uvs         = new Float32Array(vertCount * 2);
  const normalised  = new Float32Array(vertCount); // height 0→1
  const indices     = new Uint16Array(idxCount);

  for (let s = 0; s <= segments; s++) {
    const t     = s / segments;                // 0 at root, 1 at tip
    const width = BLADE_WIDTH_BASE + (BLADE_WIDTH_TIP - BLADE_WIDTH_BASE) * t;
    const y     = t;                           // local height 0–1

    const li = s * 2;       // left vertex index
    const ri = s * 2 + 1;  // right vertex index

    // Left vertex
    positions[li * 3 + 0] = -width * 0.5;
    positions[li * 3 + 1] = y;
    positions[li * 3 + 2] = 0;
    uvs[li * 2 + 0] = 0;
    uvs[li * 2 + 1] = t;
    normalised[li]  = t;

    // Right vertex
    positions[ri * 3 + 0] = width * 0.5;
    positions[ri * 3 + 1] = y;
    positions[ri * 3 + 2] = 0;
    uvs[ri * 2 + 0] = 1;
    uvs[ri * 2 + 1] = t;
    normalised[ri]  = t;
  }

  // Indices — two triangles per quad, winding consistent for double-sided
  let ii = 0;
  for (let s = 0; s < segments; s++) {
    const a = s * 2;
    const b = s * 2 + 1;
    const c = s * 2 + 2;
    const d = s * 2 + 3;
    // First triangle: a, b, c
    indices[ii++] = a; indices[ii++] = b; indices[ii++] = c;
    // Second triangle: b, d, c
    indices[ii++] = b; indices[ii++] = d; indices[ii++] = c;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',    new THREE.BufferAttribute(positions,  3));
  geo.setAttribute('uv',          new THREE.BufferAttribute(uvs,        2));
  geo.setAttribute('aNormalised', new THREE.BufferAttribute(normalised, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();

  return geo;
}

/**
 * Build a single flat quad (billboard) for the lowest LOD level.
 * Faces the camera in the vertex shader via spherical billboard transform.
 *
 * @returns {THREE.BufferGeometry}
 */
function _buildBillboardGeometry() {
  const positions  = new Float32Array([
    -0.5, 0, 0,
     0.5, 0, 0,
     0.5, 1, 0,
    -0.5, 1, 0,
  ]);
  const uvs        = new Float32Array([0, 0,  1, 0,  1, 1,  0, 1]);
  const normalised = new Float32Array([0, 0, 1, 1]);
  const indices    = new Uint16Array([0, 1, 2,  0, 2, 3]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',    new THREE.BufferAttribute(positions,  3));
  geo.setAttribute('uv',          new THREE.BufferAttribute(uvs,        2));
  geo.setAttribute('aNormalised', new THREE.BufferAttribute(normalised, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));

  return geo;
}

// ─── Material ─────────────────────────────────────────────────────────────────

/**
 * Build a ShaderMaterial for grass blades.
 *
 * @param {number}  segments    Blade segment count (controls LOD label only)
 * @param {boolean} billboard   True → cylindrical billboard vertex shader
 * @returns {THREE.ShaderMaterial}
 */
function _buildMaterial(segments, billboard) {
  return new THREE.ShaderMaterial({
    uniforms: {
      // Time
      uTime:         { value: 0.0 },

      // Wind — driven by state.wind every frame
      uWindStrength: { value: 0.2 },
      uWindGust:     { value: 0.0 },
      uWindDir:      { value: new THREE.Vector2(0.82, 0.28) },

      // Environment
      uWetness:      { value: 0.0 },
      uSunDir:       { value: new THREE.Vector3(0.5, 1.0, 0.5) },
      uSunColor:     { value: new THREE.Vector3(1.0, 0.95, 0.88) },
      uIsNight:      { value: 0.0 },
      uFogDensity:   { value: 0.0004 },
      uCamPos:       { value: new THREE.Vector3() },

      // Colours — updated seasonally
      uGrassColor:   { value: new THREE.Vector3(0.22, 0.42, 0.12) },
      uTipColor:     { value: new THREE.Vector3(0.52, 0.60, 0.22) },
    },

    vertexShader:   billboard ? _billboardVert() : _bladeVert(),
    fragmentShader: _bladeFrag(),

    side:        THREE.DoubleSide,
    transparent: false,
    depthWrite:  true,
    depthTest:   true,

    // Alpha test in fragment shader handles silhouette — no alpha blending
    // needed at this opacity level
    alphaTest:   0.0,
  });
}

// ─── Seasonal colours ─────────────────────────────────────────────────────────

function _seasonalGrassColor(season) {
  // Base albedo colour per season — physically motivated
  const colours = {
    spring: { r: 0.22, g: 0.48, b: 0.14 },  // fresh vivid green
    summer: { r: 0.19, g: 0.40, b: 0.10 },  // deep mature green
    autumn: { r: 0.42, g: 0.38, b: 0.08 },  // olive-gold
    winter: { r: 0.28, g: 0.32, b: 0.18 },  // desaturated, frost-touched
  };
  return colours[season] || colours.summer;
}

function _seasonalTipColor(season) {
  // Tips are lighter and more yellow-shifted (light transmission at thin edges)
  const colours = {
    spring: { r: 0.52, g: 0.68, b: 0.24 },
    summer: { r: 0.48, g: 0.60, b: 0.18 },
    autumn: { r: 0.70, g: 0.54, b: 0.14 },
    winter: { r: 0.42, g: 0.44, b: 0.28 },
  };
  return colours[season] || colours.summer;
}

// ─── GLSL — Blade vertex shader ───────────────────────────────────────────────

/**
 * Full ribbon blade vertex shader.
 *
 * Attributes (per vertex):
 *   aNormalised float — 0=root, 1=tip; drives wind magnitude
 *
 * Attributes (per instance, InstancedBufferAttribute):
 *   aPhase  float — unique per-blade random phase [0, 2π]
 *   aScaleY float — blade height in world units
 *
 * Wind model — three overlapping frequencies added:
 *   displacement = windStrength × sum(ampN × sin(freqN × time + spatialPhase + instancePhase))
 *   spatialPhase = dot(worldXZ, windDir) × 0.14  — creates travelling wave
 *   heightPower  = aNormalised^2.2               — roots barely move, tips flutter
 *   gustOffset   = gustStrength × sin(time×3.1 + phase)
 */
function _bladeVert() {
  return /* glsl */`
    /**
     * grass blade vertex shader
     *
     * Uniforms:
     *   uTime:         float  — elapsed seconds
     *   uWindStrength: float  — 0 (still) to 1 (gale)
     *   uWindGust:     float  — instantaneous gust on top of base
     *   uWindDir:      vec2   — normalised XZ wind direction
     *   uWetness:      float  — 0–1 global wetness
     *   uSunDir:       vec3   — world-space sun direction
     *   uCamPos:       vec3   — camera world position (for fog)
     *   uGrassColor:   vec3   — base blade colour (seasonal)
     *   uTipColor:     vec3   — tip colour (seasonal)
     *   uFogDensity:   float
     *
     * Per-instance:
     *   aPhase:  float — random wind phase per blade
     *   aScaleY: float — blade height
     */

    precision highp float;

    // Standard three.js instance matrix
    // (instanced mesh provides instanceMatrix automatically)

    attribute float aNormalised;   // per vertex: 0=root, 1=tip
    attribute float aPhase;        // per instance: unique wind phase
    attribute float aScaleY;       // per instance: blade height scale

    uniform float uTime;
    uniform float uWindStrength;
    uniform float uWindGust;
    uniform vec2  uWindDir;
    uniform float uWetness;
    uniform vec3  uCamPos;
    uniform float uFogDensity;

    varying float vNorm;           // height 0→1 passed to fragment
    varying float vCamDist;
    varying vec3  vWorldPos;

    // Three-frequency wind accumulation
    // Returns X-displacement in local-instance space (along wind dir)
    float windDisplacement(vec3 worldPos, float t) {
      // Travelling wave phase — dot with world XZ gives spatial coherence
      float spatialPhase = dot(worldPos.xz, uWindDir) * 0.14;
      float base         = spatialPhase + aPhase;

      float d1 = ${WIND_AMP_1.toFixed(2)} * sin(${WIND_FREQ_1.toFixed(2)} * t * 6.2832 + base);
      float d2 = ${WIND_AMP_2.toFixed(2)} * sin(${WIND_FREQ_2.toFixed(2)} * t * 6.2832 + base * 1.3 + 0.8);
      float d3 = ${WIND_AMP_3.toFixed(2)} * sin(${WIND_FREQ_3.toFixed(2)} * t * 6.2832 + base * 2.1 + 1.6);

      // Gust: a slower low-frequency swell modulating all three
      float gust = uWindGust * sin(uTime * 3.1 + aPhase * 0.7);

      return (d1 + d2 + d3 + gust) * (uWindStrength + uWindGust);
    }

    void main() {
      // Scale blade by per-instance height
      vec3 pos = position;
      pos.y   *= aScaleY;

      // Apply instance matrix (translation + Y-rotation)
      vec4 worldPos4 = instanceMatrix * vec4(pos, 1.0);
      vec3 worldPos  = worldPos4.xyz;

      // Height power — roots anchored, tips sway
      float heightPow = pow(aNormalised, 2.2);

      // Wind displacement — XZ plane only, in world space along wind direction
      float disp       = windDisplacement(worldPos, uTime) * heightPow * 0.22;
      worldPos.x      += uWindDir.x * disp;
      worldPos.z      += uWindDir.y * disp;

      // Wetness bends the blade slightly (weight of water on tips)
      float wetSag     = uWetness * heightPow * 0.06;
      worldPos.y      -= wetSag * aScaleY;

      vNorm     = aNormalised;
      vWorldPos = worldPos;
      vCamDist  = length(worldPos - uCamPos);

      gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
    }
  `;
}

/**
 * Billboard vertex shader for lowest LOD level.
 * Blade faces camera (Y-axis cylindrical billboard) — no horizontal tilt.
 * Wind still displaces the tip in XZ.
 */
function _billboardVert() {
  return /* glsl */`
    precision highp float;

    attribute float aNormalised;
    attribute float aPhase;
    attribute float aScaleY;

    uniform float uTime;
    uniform float uWindStrength;
    uniform float uWindGust;
    uniform vec2  uWindDir;
    uniform float uWetness;
    uniform vec3  uCamPos;
    uniform float uFogDensity;

    varying float vNorm;
    varying float vCamDist;
    varying vec3  vWorldPos;

    float windDisplacement(vec3 worldPos) {
      float spatialPhase = dot(worldPos.xz, uWindDir) * 0.14;
      float base         = spatialPhase + aPhase;
      float d = 0.62 * sin(0.62 * uTime * 6.2832 + base)
              + 0.28 * sin(1.38 * uTime * 6.2832 + base * 1.3 + 0.8)
              + 0.10 * sin(2.90 * uTime * 6.2832 + base * 2.1 + 1.6);
      return (d + uWindGust * sin(uTime * 3.1 + aPhase * 0.7)) * uWindStrength;
    }

    void main() {
      // Instance pivot is the blade root in world space
      vec3 pivot = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

      // Cylindrical billboard: right vector from camera XZ, up stays world-Y
      vec3 camDir = normalize(uCamPos - pivot);
      camDir.y    = 0.0;
      camDir      = normalize(camDir);
      vec3 right  = cross(vec3(0.0, 1.0, 0.0), camDir);

      // Local position expanded in billboard space
      vec3 localPos = right * position.x * 0.035
                    + vec3(0.0, position.y * aScaleY, 0.0);

      vec3 worldPos = pivot + localPos;

      // Wind on tip
      float heightPow = pow(aNormalised, 2.2);
      float disp      = windDisplacement(worldPos) * heightPow * 0.22;
      worldPos.x     += uWindDir.x * disp;
      worldPos.z     += uWindDir.y * disp;
      worldPos.y     -= uWetness * heightPow * 0.06 * aScaleY;

      vNorm     = aNormalised;
      vWorldPos = worldPos;
      vCamDist  = length(worldPos - uCamPos);

      gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
    }
  `;
}

// ─── GLSL — Blade fragment shader ────────────────────────────────────────────

/**
 * Shared fragment shader for all LOD levels.
 *
 * Lighting model:
 *   1. Albedo: lerp(uGrassColor, uTipColor, vNorm^1.6) — colour gradients
 *      from root to tip
 *   2. Translucency (SSS approximation): thin tips transmit backlit sunlight.
 *      backlight = max(dot(-N, L), 0) × tipFactor — adds warm yellow-green glow
 *      when sun is behind blade
 *   3. Self-shadow approximation: blades near their root are in self-shadow
 *      from the blade above. NdotL attenuated at low normalised heights.
 *   4. Wetness: darkens albedo (water absorption) + wet specular sheen
 *   5. Lambert diffuse + ambient + translucency → no Phong specular on grass
 *      (grass surface is matte; wetness adds a gentle highlight separately)
 *   6. Exponential fog applied at the end.
 */
function _bladeFrag() {
  return /* glsl */`
    /**
     * grass blade fragment shader
     *
     * Uniforms:
     *   uGrassColor: vec3   — base colour (root)
     *   uTipColor:   vec3   — tip colour
     *   uSunDir:     vec3   — world-space direction toward sun
     *   uSunColor:   vec3   — sun light colour (temperature-driven)
     *   uIsNight:    float  — 0=day, 1=night
     *   uWetness:    float  — global wetness 0–1
     *   uFogDensity: float
     *   uCamPos:     vec3   — camera world position
     *
     * Varyings:
     *   vNorm:    float — blade height 0=root 1=tip
     *   vCamDist: float — camera distance in world units
     *   vWorldPos: vec3
     */

    precision mediump float;

    uniform vec3  uGrassColor;
    uniform vec3  uTipColor;
    uniform vec3  uSunDir;
    uniform vec3  uSunColor;
    uniform float uIsNight;
    uniform float uWetness;
    uniform float uFogDensity;
    uniform vec3  uCamPos;

    varying float vNorm;
    varying float vCamDist;
    varying vec3  vWorldPos;

    void main() {
      // ── Alpha — thin tips dissolve cleanly ───────────────────────────────
      // Outer edge of tip fades, giving blade a natural silhouette without
      // clipping artefacts. No explicit uv needed — vNorm drives it.
      float tipFade = 1.0 - smoothstep(0.82, 1.0, vNorm);
      if (tipFade < 0.08) discard;

      // ── Albedo — root-to-tip gradient ────────────────────────────────────
      float colorT  = pow(vNorm, 1.6);
      vec3  albedo  = mix(uGrassColor, uTipColor, colorT);

      // Micro-variation — break up the flat colour with a noise-like hash
      // (deterministic per vNorm — no texture needed)
      float vary  = fract(sin(vWorldPos.x * 127.1 + vWorldPos.z * 311.7) * 43758.5);
      albedo     += vec3(vary * 0.04 - 0.02);

      // ── Wetness ───────────────────────────────────────────────────────────
      // Water absorbed by grass surface → darker, more saturated at base
      float wetBaseFactor = uWetness * (1.0 - vNorm * 0.7);
      albedo             *= 1.0 - wetBaseFactor * 0.22;

      // ── Lighting — Lambert diffuse ────────────────────────────────────────
      // Blades are thin — use face normal (approximate as up-facing)
      // Grass normals computed at geometry level are close enough.
      // We use a simplified fixed-normal approach: normals are
      // roughly vertical at root and tilt forward at tip.
      vec3  N       = normalize(vec3(0.0, 1.0, vNorm * 0.35));
      vec3  L       = normalize(uSunDir);
      float NdotL   = max(dot(N, L), 0.0);

      // ── Self-shadow approximation ─────────────────────────────────────────
      // Blades near the ground are shaded by neighbouring blades.
      // Smoothly darken the lower 30% of each blade.
      float selfShadow = smoothstep(0.0, 0.3, vNorm) * 0.55 + 0.45;
      NdotL           *= selfShadow;

      // ── Translucency / backlit SSS approximation ──────────────────────────
      // When sunlight comes from behind the blade, thin tips transmit it.
      // This gives the characteristic warm glow of backlit grass.
      vec3  viewDir    = normalize(uCamPos - vWorldPos);
      float backLight  = max(dot(-N, L), 0.0);         // back-face lighting
      float tipFactor  = pow(vNorm, 1.8);              // tips transmit most
      float sss        = backLight * tipFactor * 0.55;
      // SSS colour: warm yellow-green (sunlight filtered through chlorophyll)
      vec3  sssColor   = uSunColor * vec3(0.80, 0.95, 0.25) * sss;

      // ── Ambient ───────────────────────────────────────────────────────────
      vec3 ambientDay   = vec3(0.06, 0.10, 0.07) * albedo;
      vec3 ambientNight = vec3(0.02, 0.03, 0.05) * albedo;
      vec3 ambient      = mix(ambientDay, ambientNight, uIsNight);

      // ── Wet specular ──────────────────────────────────────────────────────
      // A faint gloss on rain-soaked grass blades (surface water film)
      vec3 H        = normalize(L + viewDir);
      float NdotH   = max(dot(N, H), 0.0);
      float wetSpec  = pow(NdotH, 64.0) * uWetness * 0.18;

      // ── Final composite ───────────────────────────────────────────────────
      vec3 sunLightColor = uSunColor * mix(1.0, 0.08, uIsNight);
      vec3 diffuse       = albedo * NdotL * sunLightColor;
      vec3 finalColor    = ambient + diffuse + sssColor + vec3(wetSpec);

      // ── Tip fade alpha ────────────────────────────────────────────────────
      // Applied after lighting so the transition is lit correctly
      finalColor *= tipFade;

      // ── Fog ───────────────────────────────────────────────────────────────
      float fogFactor    = exp(-uFogDensity * vCamDist * vCamDist);
      fogFactor          = clamp(fogFactor, 0.0, 1.0);
      vec3 fogColorDay   = vec3(0.58, 0.72, 0.88);
      vec3 fogColorNight = vec3(0.04, 0.06, 0.12);
      vec3 fogColor      = mix(fogColorDay, fogColorNight, uIsNight);
      finalColor         = mix(fogColor, finalColor, fogFactor);

      gl_FragColor = vec4(finalColor, tipFade);
    }
  `;
}
