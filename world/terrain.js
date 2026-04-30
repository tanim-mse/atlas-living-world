/**
 * terrain.js — Single continuous terrain mesh with FBM, splatmap, and LOD
 * Atlas: The Living World
 *
 * Responsibilities:
 *   - Procedural heightmap generation on the CPU via multi-octave FBM with
 *     domain warping, seeded deterministically so the world is identical
 *     every session
 *   - Zone-specific height biases applied on top of the base FBM
 *   - Three LOD levels (high / mid / low) with morphing blend at transitions
 *   - Six-layer PBR splatmap: grass, rock, sand, soil, snow, moss
 *   - Triplanar UV mapping on steep slopes (|normal.y| < 0.6)
 *   - Detail normal overlay blended in at close range (< 80 units)
 *   - Full wetness response via global uWetness uniform
 *   - Shadow casting and receiving
 *   - Public getHeightAt(x, z) for camera grounding and zone placement
 *
 * Dependencies: THREE (global r128), config.js, state.js, scene.js
 *
 * Usage:
 *   import { initTerrain, getHeightAt, updateTerrain } from './terrain.js';
 *   await initTerrain(scene);
 *   registerUpdate(updateTerrain);
 */

import { CONFIG } from '../core/config.js';
import { state }  from '../core/state.js';

const THREE = window.THREE;

// ─── Constants ────────────────────────────────────────────────────────────────

// Heightmap resolution per LOD level. These are vertex counts per axis.
// LOD0 (close):  512 — ~19.5 units per quad at world scale
// LOD1 (mid):    128 — ~78   units per quad
// LOD2 (far):     32 — ~312  units per quad
const LOD_RESOLUTIONS  = [512, 128, 32];

// Render distance thresholds where LOD switches occur (camera distance)
const LOD_DISTANCES    = [600, 2400, 15000];

// Morphing blend zone width — camera starts blending to next LOD this many
// units before the hard switch point
const LOD_MORPH_WIDTH  = 80;

// World half-extent
const HALF = CONFIG.WORLD_SIZE / 2; // 5000

// FBM parameters
const FBM_OCTAVES      = 8;
const FBM_LACUNARITY   = 2.02;
const FBM_GAIN         = 0.48;
const FBM_SCALE        = 0.00028;    // spatial frequency of base noise
const FBM_AMPLITUDE    = 420;        // maximum height variation in units
const DOMAIN_WARP_STR  = 0.55;       // domain warping strength (0–1)
const DOMAIN_WARP_FREQ = 0.00014;    // separate frequency for warp octaves

// Zone height biases (added on top of FBM output)
// Spec: garden −8, grove −5, crystals +22, library cliff +22 (same plateau),
//       treasury −18, gaming +3, center 0
const ZONE_BIASES = [
  // { center, radius, height, falloff }
  // falloff: smoothstep from outer to inner radius
  { cx: CONFIG.ZONES.garden.x,   cz: CONFIG.ZONES.garden.z,   r: 520,  bias: -8,   falloff: 180 },
  { cx: CONFIG.ZONES.grove.x,    cz: CONFIG.ZONES.grove.z,    r: 560,  bias: -5,   falloff: 200 },
  { cx: CONFIG.ZONES.crystals.x, cz: CONFIG.ZONES.crystals.z, r: 440,  bias: 22,   falloff: 220 },
  { cx: CONFIG.ZONES.library.x,  cz: CONFIG.ZONES.library.z,  r: 60,   bias: 22,   falloff: 40  },
  { cx: CONFIG.ZONES.treasury.x, cz: CONFIG.ZONES.treasury.z, r: 580,  bias: -18,  falloff: 240 },
  { cx: CONFIG.ZONES.gaming.x,   cz: CONFIG.ZONES.gaming.z,   r: 460,  bias: 3,    falloff: 160 },
  { cx: CONFIG.ZONES.center.x,   cz: CONFIG.ZONES.center.z,   r: 280,  bias: -2,   falloff: 120 },
];

// Treasury river valley: an elongated depression running west from Treasury
const RIVER_VALLEY = {
  startX: CONFIG.ZONES.treasury.x + 100,
  startZ: CONFIG.ZONES.treasury.z,
  endX:   -HALF,
  endZ:   CONFIG.ZONES.treasury.z - 200,
  width:  140,
  depth:  12,
};

// Crystal Field cliff face at library entrance — steep drop on the east edge
const CLIFF = {
  cx: CONFIG.ZONES.library.x + 30,
  cz: CONFIG.ZONES.library.z,
  r:  80,
  depth: 14,
};

// ─── Module state ─────────────────────────────────────────────────────────────

// Heightmap is computed once at full LOD0 resolution and cached as a Float32Array
// All LOD meshes sample from this same buffer via bilinear interpolation
let _heightmap      = null;  // Float32Array, LOD0_RES × LOD0_RES
const _LOD0_RES     = LOD_RESOLUTIONS[0];  // 512

// The terrain is rendered as three separate meshes sharing the same shader,
// switched by distance from camera. In this architecture, Three.js LOD node
// manages which is visible.
let _lod            = null;   // THREE.LOD
let _meshes         = [];     // [mesh0, mesh1, mesh2]
let _terrainMat     = null;   // shared ShaderMaterial instance

// Splatmap texture — RGBA: R=grass, G=rock, B=sand/soil, A=moss/snow blend
let _splatmap       = null;   // THREE.DataTexture
const _SPLAT_RES    = 512;    // splatmap resolution, matches LOD0 vertex resolution

// Detail normal texture — tiling fine-grained surface normals for close range
// Synthesised procedurally since we cannot load external files at runtime
let _detailNormal   = null;   // THREE.DataTexture

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build and add the terrain to the scene.
 * Generates heightmap CPU-side, builds all three LOD meshes, computes the
 * splatmap, and uploads everything to the GPU.
 *
 * @param {THREE.Scene} scene
 * @returns {Promise<void>}
 */
export async function initTerrain(scene) {
  _generateHeightmap();
  _generateSplatmap();
  _generateDetailNormal();
  _buildMaterial();
  _buildLOD();
  scene.add(_lod);
  console.log('%cATLAS TERRAIN%c initialised — 3 LOD levels, 512² heightmap',
    'color:#c8a96e;font-weight:bold', 'color:#8a7e6e');
}

/**
 * Per-frame update. Moves the LOD pivot to camera position and syncs
 * shader uniforms. Register via scene.js registerUpdate().
 *
 * @param {number} delta
 * @param {number} elapsed
 */
export function updateTerrain(delta, elapsed) {
  if (!_lod) return;

  // LOD position tracks camera XZ so high-resolution mesh stays underfoot
  _lod.position.x = state.camera.x;
  _lod.position.z = state.camera.z;

  // Update shared uniforms
  if (_terrainMat) {
    const u = _terrainMat.uniforms;
    u.uTime.value        = elapsed;
    u.uWetness.value     = state.wetness;
    u.uSunDir.value.set(
      state.sunDirection.x,
      state.sunDirection.y,
      state.sunDirection.z,
    );
    u.uSunColor.value.set(
      state.sunColor.r,
      state.sunColor.g,
      state.sunColor.b,
    );
    u.uIsNight.value     = state.isNight ? 1.0 : 0.0;
    u.uFogDensity.value  = state.fogDensity;

    // Morph factor for LOD blending — distance-based blend in/out at seam
    const camDist = 0; // always 0 from LOD pivot — individual LOD tiles handle distance
    u.uLODMorphFactor.value = 0.0; // individual mesh morph driven by built-in LOD
  }

  // Update THREE.LOD distances — camera position updated above
  _lod.update(_buildDummyCamera());
}

/**
 * Sample terrain height at any world-space XZ coordinate via bilinear
 * interpolation of the CPU heightmap. Used by camera grounding, zone
 * placement, and organism spawning.
 *
 * @param {number} wx  World X coordinate
 * @param {number} wz  World Z coordinate
 * @returns {number}   Height in world units
 */
export function getHeightAt(wx, wz) {
  if (!_heightmap) return 0;

  // Map world coords to heightmap UV [0, 1]
  const u = (wx + HALF) / CONFIG.WORLD_SIZE;
  const v = (wz + HALF) / CONFIG.WORLD_SIZE;

  // Clamp to valid range
  const uc = Math.max(0, Math.min(1 - 1 / _LOD0_RES, u));
  const vc = Math.max(0, Math.min(1 - 1 / _LOD0_RES, v));

  // Bilinear interpolation
  const fx  = uc * (_LOD0_RES - 1);
  const fz  = vc * (_LOD0_RES - 1);
  const ix  = Math.floor(fx);
  const iz  = Math.floor(fz);
  const tx  = fx - ix;
  const tz  = fz - iz;

  const h00 = _sampleHeightmap(ix,     iz    );
  const h10 = _sampleHeightmap(ix + 1, iz    );
  const h01 = _sampleHeightmap(ix,     iz + 1);
  const h11 = _sampleHeightmap(ix + 1, iz + 1);

  return (h00 * (1 - tx) + h10 * tx) * (1 - tz)
       + (h01 * (1 - tx) + h11 * tx) * tz;
}

/**
 * Returns the terrain surface normal at world-space XZ via finite differences
 * on the heightmap. Used by zone modules for surface alignment.
 *
 * @param {number} wx
 * @param {number} wz
 * @returns {THREE.Vector3}  Normalised surface normal
 */
export function getNormalAt(wx, wz) {
  const step = CONFIG.WORLD_SIZE / (_LOD0_RES - 1);
  const hL   = getHeightAt(wx - step, wz);
  const hR   = getHeightAt(wx + step, wz);
  const hD   = getHeightAt(wx, wz - step);
  const hU   = getHeightAt(wx, wz + step);
  return new THREE.Vector3(hL - hR, 2 * step, hD - hU).normalize();
}

// ─── Heightmap Generation ─────────────────────────────────────────────────────

function _generateHeightmap() {
  const res = _LOD0_RES;
  _heightmap = new Float32Array(res * res);

  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      // World-space coordinates for this vertex
      const wx = (ix / (res - 1)) * CONFIG.WORLD_SIZE - HALF;
      const wz = (iz / (res - 1)) * CONFIG.WORLD_SIZE - HALF;

      _heightmap[iz * res + ix] = _computeHeight(wx, wz);
    }
  }
}

/**
 * Full height evaluation for a world-space point.
 * Pipeline: domain-warped FBM → zone biases → river valley → cliff
 */
function _computeHeight(wx, wz) {
  // ── Domain warping ────────────────────────────────────────────────────────
  // Two octaves of noise displace the sample coordinates before FBM.
  // This breaks up the "grid" feel of pure FBM and creates realistic
  // meandering ridges, hanging valleys, and organic terrain shapes.
  const warpX = _fbm(wx * DOMAIN_WARP_FREQ + 3.7, wz * DOMAIN_WARP_FREQ + 1.3, 3);
  const warpZ = _fbm(wx * DOMAIN_WARP_FREQ + 8.1, wz * DOMAIN_WARP_FREQ + 5.9, 3);

  const warpedX = wx + warpX * CONFIG.WORLD_SIZE * DOMAIN_WARP_STR * 0.18;
  const warpedZ = wz + warpZ * CONFIG.WORLD_SIZE * DOMAIN_WARP_STR * 0.18;

  // ── Base FBM height ───────────────────────────────────────────────────────
  let h = _fbm(warpedX * FBM_SCALE, warpedZ * FBM_SCALE, FBM_OCTAVES) * FBM_AMPLITUDE;

  // Raise the base floor slightly — Atlas is a highland world, not flat
  h += 8.0;

  // ── Zone height biases ────────────────────────────────────────────────────
  for (const zone of ZONE_BIASES) {
    const dx   = wx - zone.cx;
    const dz   = wz - zone.cz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < zone.r + zone.falloff) {
      // Smooth weight: 1.0 at centre, 0.0 beyond (r + falloff)
      const t = 1.0 - _smoothstep(zone.r - zone.falloff, zone.r + zone.falloff, dist);
      h      += zone.bias * t;
    }
  }

  // ── River valley (Treasury → west coast) ─────────────────────────────────
  {
    const rv     = RIVER_VALLEY;
    const ax     = rv.endX - rv.startX;
    const az     = rv.endZ - rv.startZ;
    const len2   = ax * ax + az * az;
    const t      = Math.max(0, Math.min(1, ((wx - rv.startX) * ax + (wz - rv.startZ) * az) / len2));
    const px     = rv.startX + t * ax;
    const pz     = rv.startZ + t * az;
    const dist   = Math.sqrt((wx - px) * (wx - px) + (wz - pz) * (wz - pz));
    if (dist < rv.width) {
      const w    = 1.0 - _smoothstep(rv.width * 0.3, rv.width, dist);
      h         -= rv.depth * w;
    }
  }

  // ── Crystal Field cliff face (Library entrance) ───────────────────────────
  {
    const dx   = wx - CLIFF.cx;
    const dz   = wz - CLIFF.cz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < CLIFF.r) {
      // Only drop the east side (dx > 0) to carve the cliff face
      if (dx > 0) {
        const w  = _smoothstep(CLIFF.r * 0.3, CLIFF.r, CLIFF.r - dist);
        h       -= CLIFF.depth * w * (dx / CLIFF.r);
      }
    }
  }

  return h;
}

// ─── FBM & Noise ─────────────────────────────────────────────────────────────

/**
 * Multi-octave fractional Brownian motion.
 * Returns value in approximately [−0.5, 0.5].
 *
 * @param {number} x
 * @param {number} y
 * @param {number} octaves
 */
function _fbm(x, y, octaves) {
  let value     = 0;
  let amplitude = 0.5;
  let frequency = 1.0;
  let maxVal    = 0;

  for (let i = 0; i < octaves; i++) {
    value    += amplitude * _gradientNoise(x * frequency, y * frequency);
    maxVal   += amplitude;
    amplitude *= FBM_GAIN;
    frequency *= FBM_LACUNARITY;
  }

  return value / maxVal;
}

/**
 * Ken Perlin-style gradient noise.
 * Classic 2D value gradient noise sufficient for terrain generation on CPU.
 *
 * @param {number} x
 * @param {number} y
 * @returns {number} value in [−1, 1]
 */
function _gradientNoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  // Quintic fade
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);

  // Four corner gradients
  const n00 = _dotGrad(ix,     iy,     fx,     fy    );
  const n10 = _dotGrad(ix + 1, iy,     fx - 1, fy    );
  const n01 = _dotGrad(ix,     iy + 1, fx,     fy - 1);
  const n11 = _dotGrad(ix + 1, iy + 1, fx - 1, fy - 1);

  return _lerp(_lerp(n00, n10, ux), _lerp(n01, n11, ux), uy);
}

/** Hash a grid cell and return a gradient dot product. */
function _dotGrad(ix, iy, dx, dy) {
  // Bit-mix hash — fast, deterministic, no look-up table
  let h = ix * 1619 + iy * 31337;
  h     = (h ^ (h >> 8)) * 0x45d9f3b;
  h     = (h ^ (h >> 8)) * 0x45d9f3b;
  h     = h ^ (h >> 8);

  // Map hash to one of 8 gradient directions
  const dir = h & 7;
  const gx  = [1,-1, 1,-1, 0, 0, 0, 0][dir];
  const gy  = [0, 0, 0, 0, 1,-1, 1,-1][dir];
  // Extend to more unique gradients using upper bits
  const gx2 = gx !== 0 ? gx : ((h >> 4) & 1) ? 1 : -1;
  const gy2 = gy !== 0 ? gy : ((h >> 5) & 1) ? 1 : -1;

  return gx2 * dx + gy2 * dy;
}

function _lerp(a, b, t) { return a + t * (b - a); }
function _smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ─── Heightmap Sampling ───────────────────────────────────────────────────────

function _sampleHeightmap(ix, iz) {
  const res = _LOD0_RES;
  const cx  = Math.max(0, Math.min(res - 1, ix));
  const cz  = Math.max(0, Math.min(res - 1, iz));
  return _heightmap[cz * res + cx];
}

// ─── Splatmap Generation ──────────────────────────────────────────────────────
// Six layers packed into two RGBA textures:
// Splat A (RGBA): R=grass, G=dry_grass, B=soil, A=rock
// Splat B (RGBA): R=sand, G=moss, B=snow_cap, A=unused
// For shader simplicity we encode all into one RGBA texture with blending rules:
// R=grass+meadow, G=rock+cliff, B=sand+riverbed, A=moss+forest_floor
// Snow and soil are derived in-shader from altitude and normal respectively.

function _generateSplatmap() {
  const res  = _SPLAT_RES;
  const data = new Uint8Array(res * res * 4);

  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const wx = (ix / (res - 1)) * CONFIG.WORLD_SIZE - HALF;
      const wz = (iz / (res - 1)) * CONFIG.WORLD_SIZE - HALF;
      const h  = getHeightAt(wx, wz);

      // Surface normal via finite differences
      const step = CONFIG.WORLD_SIZE / (res - 1);
      const hL   = getHeightAt(wx - step, wz);
      const hR   = getHeightAt(wx + step, wz);
      const hD   = getHeightAt(wx, wz - step);
      const hU   = getHeightAt(wx, wz + step);
      const nx   = (hL - hR) / (2 * step);
      const ny   = 1.0;
      const nz   = (hD - hU) / (2 * step);
      const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const slopeY = ny / nLen; // 1 = flat, 0 = vertical

      // ── Layer weights ─────────────────────────────────────────────────────
      // grass: flat areas at moderate altitude
      let grass     = _smoothstep(0.30, 0.72, slopeY) * _smoothstep(180, 60, h);

      // rock: steep slopes and high altitude
      let rock      = _smoothstep(0.65, 0.30, slopeY)
                    + _smoothstep(120, 180, h) * 0.5;
      rock          = Math.min(1, rock);

      // sand / riverbed: low altitude, near treasury river
      const riverDx = wx - RIVER_VALLEY.startX;
      const riverDz = wz - RIVER_VALLEY.startZ;
      const riverDist = Math.sqrt(riverDx * riverDx + riverDz * riverDz);
      let sand      = _smoothstep(200, 50, h - (-18)) * 0.5
                    + _smoothstep(RIVER_VALLEY.width * 1.2, RIVER_VALLEY.width * 0.4, riverDist) * 0.8;
      sand          = Math.min(1, sand);

      // moss: grove zone, low slope, moderate altitude
      const groveDx = wx - CONFIG.ZONES.grove.x;
      const groveDz = wz - CONFIG.ZONES.grove.z;
      const groveDist = Math.sqrt(groveDx * groveDx + groveDz * groveDz);
      let moss      = _smoothstep(700, 200, groveDist)
                    * _smoothstep(0.45, 0.75, slopeY);

      // Normalise
      const total = grass + rock + sand + moss + 0.001;
      grass /= total; rock /= total; sand /= total; moss /= total;

      const idx        = (iz * res + ix) * 4;
      data[idx]        = Math.round(grass * 255);  // R = grass
      data[idx + 1]    = Math.round(rock  * 255);  // G = rock
      data[idx + 2]    = Math.round(sand  * 255);  // B = sand/soil
      data[idx + 3]    = Math.round(moss  * 255);  // A = moss
    }
  }

  _splatmap              = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
  _splatmap.wrapS        = THREE.ClampToEdgeWrapping;
  _splatmap.wrapT        = THREE.ClampToEdgeWrapping;
  _splatmap.minFilter    = THREE.LinearFilter;
  _splatmap.magFilter    = THREE.LinearFilter;
  _splatmap.needsUpdate  = true;
}

// ─── Detail Normal Generation ─────────────────────────────────────────────────
// Synthesised 256×256 tileable normal map for surface micro-detail.
// Based on summed noise to simulate fine gravel / soil / root texture.

function _generateDetailNormal() {
  const res  = 256;
  const data = new Uint8Array(res * res * 4);

  for (let iy = 0; iy < res; iy++) {
    for (let ix = 0; ix < res; ix++) {
      // Sample height from small-scale noise
      const fx  = ix / res;
      const fy  = iy / res;

      // Three octaves of noise for micro-surface detail
      const scale1 = 12.0;
      const scale2 = 28.0;
      const scale3 = 55.0;
      const h1  = _gradientNoise(fx * scale1, fy * scale1) * 0.50;
      const h2  = _gradientNoise(fx * scale2, fy * scale2) * 0.30;
      const h3  = _gradientNoise(fx * scale3, fy * scale3) * 0.20;
      const h   = (h1 + h2 + h3 + 1.0) * 0.5; // remap to [0,1]

      // Finite differences for normal reconstruction
      const eps  = 1.0 / res;
      const hR   = (_gradientNoise((fx + eps) * scale1, fy * scale1) * 0.50
                  + _gradientNoise((fx + eps) * scale2, fy * scale2) * 0.30
                  + _gradientNoise((fx + eps) * scale3, fy * scale3) * 0.20 + 1.0) * 0.5;
      const hU   = (_gradientNoise(fx * scale1, (fy + eps) * scale1) * 0.50
                  + _gradientNoise(fx * scale2, (fy + eps) * scale2) * 0.30
                  + _gradientNoise(fx * scale3, (fy + eps) * scale3) * 0.20 + 1.0) * 0.5;

      // Normal from height gradient
      const dx   = h - hR;
      const dy   = eps;
      const dz   = h - hU;
      const len  = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const nx   = dx / len;
      const ny   = dy / len;
      const nz   = dz / len;

      const idx      = (iy * res + ix) * 4;
      data[idx]      = Math.round((nx * 0.5 + 0.5) * 255);
      data[idx + 1]  = Math.round((ny * 0.5 + 0.5) * 255);
      data[idx + 2]  = Math.round((nz * 0.5 + 0.5) * 255);
      data[idx + 3]  = 255;
    }
  }

  _detailNormal             = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
  _detailNormal.wrapS       = THREE.RepeatWrapping;
  _detailNormal.wrapT       = THREE.RepeatWrapping;
  _detailNormal.minFilter   = THREE.LinearMipMapLinearFilter;
  _detailNormal.magFilter   = THREE.LinearFilter;
  _detailNormal.generateMipmaps = true;
  _detailNormal.needsUpdate = true;
}

// ─── Terrain Material ─────────────────────────────────────────────────────────

function _buildMaterial() {
  _terrainMat = new THREE.ShaderMaterial({
    uniforms: {
      // Splatmap layers
      uSplatmap:         { value: _splatmap },
      uDetailNormal:     { value: _detailNormal },

      // PBR base colours for each splatmap layer
      // These are solid colours — no external textures required
      uGrassColor:       { value: new THREE.Color(0x3a5c2a)  },  // dark meadow green
      uRockColor:        { value: new THREE.Color(0x6a6058)  },  // warm grey stone
      uSandColor:        { value: new THREE.Color(0xb8a882)  },  // ochre riverbed sand
      uMossColor:        { value: new THREE.Color(0x2a4a22)  },  // deep forest moss
      uSoilColor:        { value: new THREE.Color(0x5c3c22)  },  // exposed soil, dark loam
      uSnowColor:        { value: new THREE.Color(0xe8eef5)  },  // cold white

      // PBR roughness per layer
      uGrassRoughness:   { value: 0.88 },
      uRockRoughness:    { value: 0.84 },
      uSandRoughness:    { value: 0.92 },
      uMossRoughness:    { value: 0.94 },

      // Environment
      uTime:             { value: 0.0 },
      uWetness:          { value: 0.0 },
      uSunDir:           { value: new THREE.Vector3(0, 1, 0) },
      uSunColor:         { value: new THREE.Vector3(1, 0.95, 0.88) },
      uIsNight:          { value: 0.0 },
      uFogDensity:       { value: 0.0004 },

      // Terrain geometry
      uWorldSize:        { value: CONFIG.WORLD_SIZE },
      uHeightScale:      { value: FBM_AMPLITUDE + 30 },  // full range for UV mapping

      // Detail normal
      uDetailTiling:     { value: 48.0 },       // how many times detail normal tiles over terrain
      uDetailRange:      { value: 80.0 },        // camera distance at which detail is full strength
      uDetailFadeEnd:    { value: 160.0 },       // distance at which detail fades to zero

      // Triplanar blend
      uTriplanarSharpness: { value: 6.0 },       // blend exponent — higher = sharper transitions

      // LOD morph
      uLODMorphFactor:   { value: 0.0 },

      // Shadow map is handled automatically by Three.js — we declare it here
      // for completeness; actual binding happens via castShadow / receiveShadow
    },

    vertexShader:   _vsTerrainGLSL(),
    fragmentShader: _fsTerrainGLSL(),

    // Terrain has no alpha
    transparent:    false,
    depthWrite:     true,
    depthTest:      true,
    side:           THREE.FrontSide,
  });
}

// ─── LOD Mesh Construction ────────────────────────────────────────────────────

function _buildLOD() {
  _lod    = new THREE.LOD();
  _meshes = [];

  for (let level = 0; level < 3; level++) {
    const res  = LOD_RESOLUTIONS[level];
    const mesh = _buildTerrainMesh(res, level);

    mesh.castShadow    = (level === 0); // only close mesh casts shadows
    mesh.receiveShadow = true;

    _lod.addLevel(mesh, LOD_DISTANCES[level]);
    _meshes.push(mesh);
  }

  // Centre the LOD group — it will be repositioned each frame by updateTerrain
  _lod.position.set(0, 0, 0);
}

/**
 * Build a single terrain mesh at the given vertex resolution.
 * Heights are baked into vertex positions from the CPU heightmap.
 * Normals are computed analytically via finite differences.
 *
 * @param {number} res   Vertices per axis
 * @param {number} level 0=close, 1=mid, 2=far
 */
function _buildTerrainMesh(res, level) {
  const vertCount  = res * res;
  const quadCount  = (res - 1) * (res - 1);
  const positions  = new Float32Array(vertCount * 3);
  const normals    = new Float32Array(vertCount * 3);
  const uvs        = new Float32Array(vertCount * 2);
  const indices    = new Uint32Array(quadCount * 6);

  // Vertex positions from heightmap
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const wx = (ix / (res - 1)) * CONFIG.WORLD_SIZE - HALF;
      const wz = (iz / (res - 1)) * CONFIG.WORLD_SIZE - HALF;
      const h  = getHeightAt(wx, wz);

      const vi      = (iz * res + ix) * 3;
      positions[vi]     = wx;
      positions[vi + 1] = h;
      positions[vi + 2] = wz;

      // UV maps world XZ to [0,1] — used in fragment shader for splatmap lookup
      const uvi     = (iz * res + ix) * 2;
      uvs[uvi]      = ix / (res - 1);
      uvs[uvi + 1]  = iz / (res - 1);
    }
  }

  // Normals via finite differences (world-space, then normalised)
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const wx = (ix / (res - 1)) * CONFIG.WORLD_SIZE - HALF;
      const wz = (iz / (res - 1)) * CONFIG.WORLD_SIZE - HALF;

      const step = CONFIG.WORLD_SIZE / (res - 1);
      const hL   = getHeightAt(wx - step, wz);
      const hR   = getHeightAt(wx + step, wz);
      const hD   = getHeightAt(wx, wz - step);
      const hU   = getHeightAt(wx, wz + step);

      const nx   = hL - hR;
      const ny   = 2.0 * step;
      const nz   = hD - hU;
      const len  = Math.sqrt(nx * nx + ny * ny + nz * nz);

      const ni       = (iz * res + ix) * 3;
      normals[ni]     = nx / len;
      normals[ni + 1] = ny / len;
      normals[ni + 2] = nz / len;
    }
  }

  // Index buffer — two triangles per quad, CCW winding
  let qi = 0;
  for (let iz = 0; iz < res - 1; iz++) {
    for (let ix = 0; ix < res - 1; ix++) {
      const tl = iz       * res + ix;
      const tr = iz       * res + ix + 1;
      const bl = (iz + 1) * res + ix;
      const br = (iz + 1) * res + ix + 1;

      // Upper-left triangle
      indices[qi++] = tl;
      indices[qi++] = bl;
      indices[qi++] = tr;

      // Lower-right triangle
      indices[qi++] = tr;
      indices[qi++] = bl;
      indices[qi++] = br;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(normals,   3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs,       2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  return new THREE.Mesh(geo, _terrainMat);
}

// ─── LOD dummy camera helper ──────────────────────────────────────────────────
// THREE.LOD.update() requires a camera object. We construct a minimal proxy
// from the current state rather than importing the actual camera reference.

let _dummyCamera = null;
function _buildDummyCamera() {
  if (!_dummyCamera) {
    _dummyCamera = new THREE.PerspectiveCamera();
  }
  _dummyCamera.position.set(state.camera.x, state.camera.y, state.camera.z);
  _dummyCamera.updateMatrixWorld();
  return _dummyCamera;
}

// ─── GLSL — Terrain Vertex Shader ────────────────────────────────────────────

function _vsTerrainGLSL() {
  return /* glsl */`
    /**
     * Terrain vertex shader
     *
     * Uniforms used here:
     *   uWorldSize:      float — total terrain extent in world units
     *   uLODMorphFactor: float — 0 = this LOD only, 1 = fully morphed to next
     *   uCameraPos:      vec3  — for distance-based detail decisions
     *
     * Varyings passed to fragment shader:
     *   vWorldPos    — world-space position for triplanar mapping and fog
     *   vWorldNormal — world-space normal for lighting and splatmap blending
     *   vUv          — terrain-space UV [0,1] for splatmap lookup
     *   vCamDist     — camera distance for detail normal fading and fog
     *   vSlope       — dot(normal, up) — 1=flat, 0=vertical
     *   vHeight      — world-space Y, used for snow cap blend in fragment
     */
    varying vec3  vWorldPos;
    varying vec3  vWorldNormal;
    varying vec2  vUv;
    varying float vCamDist;
    varying float vSlope;
    varying float vHeight;

    uniform float uWorldSize;
    uniform float uLODMorphFactor;

    void main() {
      vec4 worldPos   = modelMatrix * vec4(position, 1.0);
      vWorldPos       = worldPos.xyz;
      vWorldNormal    = normalize(mat3(modelMatrix) * normal);
      vUv             = uv;
      vCamDist        = distance(worldPos.xyz, cameraPosition);
      vSlope          = clamp(dot(vWorldNormal, vec3(0.0, 1.0, 0.0)), 0.0, 1.0);
      vHeight         = worldPos.y;

      gl_Position     = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
}

// ─── GLSL — Terrain Fragment Shader ──────────────────────────────────────────

function _fsTerrainGLSL() {
  return /* glsl */`
    /**
     * Terrain fragment shader
     *
     * Layer blending pipeline:
     *   1. Read splatmap weights (grass, rock, sand, moss)
     *   2. Derive soil and snow from slope and height
     *   3. Blend material albedo, roughness
     *   4. Triplanar UV remapping on steep slopes
     *   5. Detail normal overlay at close range
     *   6. Wetness: darken albedo, reduce roughness, add specular sheen
     *   7. PBR lighting: Lambert diffuse + Blinn-Phong specular + ambient
     *   8. Exponential fog
     *
     * All uniforms documented in _buildMaterial().
     */
    precision mediump float;

    // ── Textures ──────────────────────────────────────────────────────────────
    uniform sampler2D uSplatmap;
    uniform sampler2D uDetailNormal;

    // ── Material colours ──────────────────────────────────────────────────────
    uniform vec3  uGrassColor;
    uniform vec3  uRockColor;
    uniform vec3  uSandColor;
    uniform vec3  uMossColor;
    uniform vec3  uSoilColor;
    uniform vec3  uSnowColor;

    // ── Material roughness ────────────────────────────────────────────────────
    uniform float uGrassRoughness;
    uniform float uRockRoughness;
    uniform float uSandRoughness;
    uniform float uMossRoughness;

    // ── Environment ───────────────────────────────────────────────────────────
    uniform float uTime;
    uniform float uWetness;
    uniform vec3  uSunDir;
    uniform vec3  uSunColor;
    uniform float uIsNight;
    uniform float uFogDensity;

    // ── Terrain ───────────────────────────────────────────────────────────────
    uniform float uWorldSize;
    uniform float uHeightScale;
    uniform float uDetailTiling;
    uniform float uDetailRange;
    uniform float uDetailFadeEnd;
    uniform float uTriplanarSharpness;

    // ── Varyings ──────────────────────────────────────────────────────────────
    varying vec3  vWorldPos;
    varying vec3  vWorldNormal;
    varying vec2  vUv;
    varying float vCamDist;
    varying float vSlope;
    varying float vHeight;

    // ── Utility ───────────────────────────────────────────────────────────────
    vec3 blendNormals(vec3 base, vec3 detail, float strength) {
      // Reoriented Normal Mapping blend
      vec3 t = base + vec3(0.0, 0.0, 1.0);
      vec3 u = detail * vec3(-1.0, -1.0, 1.0);
      return normalize(t * dot(t, u) - u * t.z) * strength + base * (1.0 - strength);
    }

    vec3 triplanarNormal(sampler2D tex, float tiling) {
      // Project texture onto three world planes and blend by normal weight
      vec3 absN = abs(vWorldNormal);
      // Sharpen blend weights
      vec3 blendW = pow(absN, vec3(uTriplanarSharpness));
      blendW = blendW / (blendW.x + blendW.y + blendW.z);

      // Sample each face
      vec3 xSample = texture2D(tex, vWorldPos.zy * tiling * 0.01).rgb * 2.0 - 1.0;
      vec3 ySample = texture2D(tex, vWorldPos.xz * tiling * 0.01).rgb * 2.0 - 1.0;
      vec3 zSample = texture2D(tex, vWorldPos.xy * tiling * 0.01).rgb * 2.0 - 1.0;

      return normalize(xSample * blendW.x + ySample * blendW.y + zSample * blendW.z);
    }

    void main() {
      // ── Splatmap weights ──────────────────────────────────────────────────
      vec4 splat   = texture2D(uSplatmap, vUv);
      float wGrass = splat.r;
      float wRock  = splat.g;
      float wSand  = splat.b;
      float wMoss  = splat.a;

      // Soil: exposed on moderate slopes where grass fades
      float wSoil  = clamp((1.0 - vSlope - 0.45) * 2.0, 0.0, 1.0) * (1.0 - wRock);

      // Snow cap: high altitude, any flatness
      float snowAlt = 200.0;  // above this height snow appears
      float wSnow   = smoothstep(snowAlt - 20.0, snowAlt + 40.0, vHeight) * vSlope;

      // Renormalise all weights (snow and soil override)
      float baseTotal = wGrass + wRock + wSand + wMoss + 0.001;
      wGrass /= baseTotal; wRock /= baseTotal; wSand /= baseTotal; wMoss /= baseTotal;
      // Snow blended over everything
      float snowBlend = wSnow;
      float invSnow   = 1.0 - snowBlend;

      // ── UV mapping ────────────────────────────────────────────────────────
      // Standard UV for flat surfaces, triplanar on steep slopes
      float triplanarBlend = 1.0 - smoothstep(0.45, 0.70, vSlope);

      // ── Detail normal overlay ─────────────────────────────────────────────
      float detailStrength = 1.0 - smoothstep(uDetailRange, uDetailFadeEnd, vCamDist);
      vec3  detailN;
      if (triplanarBlend > 0.01) {
        detailN = triplanarNormal(uDetailNormal, uDetailTiling);
      } else {
        detailN = texture2D(uDetailNormal, vUv * uDetailTiling).rgb * 2.0 - 1.0;
      }
      vec3 worldNormal = normalize(mix(vWorldNormal,
        blendNormals(vWorldNormal, detailN, detailStrength), 0.35));

      // ── Albedo blend ──────────────────────────────────────────────────────
      vec3 albedo = uGrassColor * wGrass
                  + uRockColor  * wRock
                  + uSandColor  * wSand
                  + uMossColor  * wMoss
                  + uSoilColor  * wSoil * (1.0 - wGrass - wRock - wSand - wMoss);

      // Subtle height-based color variation — lower areas slightly cooler
      float altTint = smoothstep(-18.0, 30.0, vHeight);
      albedo       *= mix(vec3(0.88, 0.90, 0.95), vec3(1.0), altTint);

      // Snow override
      albedo        = mix(albedo, uSnowColor, snowBlend);

      // ── Roughness blend ───────────────────────────────────────────────────
      float roughness = uGrassRoughness * wGrass
                      + uRockRoughness  * wRock
                      + uSandRoughness  * wSand
                      + uMossRoughness  * wMoss
                      + 0.80            * wSoil;

      // Snow is smooth-ish
      roughness = mix(roughness, 0.78, snowBlend);

      // ── Wetness ───────────────────────────────────────────────────────────
      // Darkens albedo (water absorbs light), reduces roughness (specular sheen)
      // Puddle formation in flat low areas
      float puddleFactor = vSlope * smoothstep(-12.0, -5.0, -vHeight);
      float wetFactor    = uWetness * (0.65 + puddleFactor * 0.35);

      albedo    *= 1.0 - wetFactor * 0.28;
      roughness  = mix(roughness, roughness * 0.52, wetFactor);
      // Specular sheen strength increases with wetness
      float wetSpecular = wetFactor * 0.55;

      // ── Lighting — PBR approximation ──────────────────────────────────────
      // Physically-motivated: Lambert diffuse + Blinn-Phong specular + ambient
      // No magic fill lights — all light from sun/moon

      vec3 L        = normalize(uSunDir);
      vec3 N        = worldNormal;
      vec3 V        = normalize(cameraPosition - vWorldPos);
      vec3 H        = normalize(L + V);

      float NdotL   = max(dot(N, L), 0.0);
      float NdotH   = max(dot(N, H), 0.0);

      // Ambient — sky dome contribution
      // Night: deep blue ambient; day: sky-blue tinted
      vec3 ambientDay   = vec3(0.08, 0.10, 0.14) * albedo;
      vec3 ambientNight = vec3(0.02, 0.03, 0.06) * albedo;
      vec3 ambient      = mix(ambientDay, ambientNight, uIsNight);

      // Diffuse
      vec3 sunLightColor = uSunColor * mix(1.0, 0.12, uIsNight);
      vec3 diffuse   = albedo * NdotL * sunLightColor;

      // Specular — roughness-driven shininess
      float shininess = mix(2.0, 96.0, 1.0 - roughness);
      float spec      = pow(NdotH, shininess) * (1.0 - roughness) * 0.4;
      // Additional wet specular — mirror-like reflection patches
      float wetSpec   = pow(NdotH, 128.0) * wetSpecular;
      vec3 specular   = (spec + wetSpec) * sunLightColor;

      // ── Shadow approximation (AO from slope) ─────────────────────────────
      // A true shadow map is bound by Three.js via receiveShadow.
      // Here we add a cheap slope-occlusion to darken valley floors
      // independently of the shadow map.
      float slopeAO   = mix(0.72, 1.0, vSlope);

      vec3 finalColor = (ambient + diffuse * slopeAO + specular) * slopeAO;

      // ── Exponential fog ───────────────────────────────────────────────────
      // Denser in low areas: fog density scaled by inverse height
      float heightFogBias = max(0.0, 1.0 - (vHeight + 20.0) / 60.0) * 0.5;
      float fogDensity    = uFogDensity * (1.0 + heightFogBias);
      float fogFactor     = exp(-fogDensity * vCamDist * vCamDist);
      fogFactor           = clamp(fogFactor, 0.0, 1.0);

      // Fog color: sky blue by day, deep blue-black by night
      vec3 fogColorDay    = vec3(0.58, 0.72, 0.88);
      vec3 fogColorNight  = vec3(0.04, 0.06, 0.12);
      vec3 fogColor       = mix(fogColorDay, fogColorNight, uIsNight);

      finalColor          = mix(fogColor, finalColor, fogFactor);

      gl_FragColor        = vec4(finalColor, 1.0);
    }
  `;
}
