/**
 * sky.js — Complete sky, atmosphere, clouds, stars, rain, and weather system
 * Atlas: The Living World
 *
 * Responsibilities:
 *   - Astronomically-correct sun position for Dhaka, Bangladesh (23.8 °N)
 *     driven by state.localHour and state.dayOfYear
 *   - Moon position and phase computed from J2000 lunar orbital elements
 *   - Atmospheric scattering dome (atmosphere.glsl) rendered into the main scene
 *   - Volumetric cloud layer (cloud.glsl) at half resolution with TAA upscale
 *   - 4 800-star field with atmospheric scintillation and Milky Way band
 *   - Weather state machine: clear → scattered → overcast → rain → storm,
 *     transitions driven by state.moodAvg7 and state.moodTrend
 *   - Wetness system: state.wetness lerps 0→1 over 45 s on rain start,
 *     1→0 over 180 s on rain stop; written to state for all outdoor shaders
 *   - Rain particle system (rain.glsl): two streak layers + splash rings +
 *     lens distortion post pass
 *   - God rays via radial blur when sun is partially occluded by clouds
 *   - Fog colour and density updated each frame from sky colour at horizon
 *   - Light temperature written to state.lightTemperature each frame
 *   - Aerial perspective: fog colour lerped toward sky horizon colour
 *
 * Dependencies:
 *   Three.js r128 (global THREE), scene.js, state.js, config.js
 *   Shader sources: atmosphere.glsl, cloud.glsl, rain.glsl  (loaded by fetch)
 *
 * Usage (world.html):
 *   import { initSky, disposeSky } from './world/sky.js';
 *   await initSky();   // called after initScene()
 */

import { CONFIG }                                    from '../core/config.js';
import { state }                                     from '../core/state.js';
import { getScene, getCamera, getRenderer,
         registerUpdate, deregisterUpdate }          from './scene.js';

const THREE = window.THREE;

// ─── Module-private state ─────────────────────────────────────────────────────

// Render targets
let _rtAtmos   = null;   // half-res atmosphere (written by dome, read by clouds)
let _rtCloud   = null;   // half-res cloud layer
let _rtCloudB  = null;   // half-res cloud TAA history (previous frame)
let _rtRain    = null;   // full-res rain streak layer
let _rtGodRay  = null;   // half-res god ray accumulation

// Scene objects
let _domeMesh    = null;   // atmosphere sky dome (large sphere)
let _starPoints  = null;   // star field (Points)
let _milkyWay    = null;   // Milky Way band (Points, separate buffer)
let _rainNear    = null;   // InstancedMesh — near streak layer
let _rainFar     = null;   // InstancedMesh — far streak layer
let _splashMesh  = null;   // InstancedMesh — splash rings

// Full-screen quad helpers (reuse pattern from scene.js)
let _fsScene     = null;
let _fsQuad      = null;
let _orthoCamera = null;

// Materials
let _atmosMat    = null;
let _cloudMat    = null;
let _taaMat      = null;
let _rainNearMat = null;
let _rainFarMat  = null;
let _splashMat   = null;
let _lensMat     = null;
let _godRayMat   = null;
let _godComposMat= null;

// Shader source strings (loaded once at init)
let _atmosSrc    = null;
let _cloudSrc    = null;
let _rainSrc     = null;

// Weather state machine
const WEATHER_STATES = ['clear', 'scattered', 'overcast', 'rain', 'storm'];
const WEATHER_INDEX  = { clear: 0, scattered: 1, overcast: 2, rain: 3, storm: 4 };

let _currentWeatherIndex  = 1;   // start scattered
let _targetWeatherIndex   = 1;
let _weatherTransitionT   = 0.0; // 0→1 during transition
let _weatherTransitionDur = 120; // seconds for full weather transition
let _weatherHoldTimer     = 0;   // seconds to hold current state before re-evaluate

// Cloud coverage per weather state
const CLOUD_COVERAGE_BY_WEATHER = [0.04, 0.28, 0.62, 0.82, 0.96];

// Wind speed (m/s analogue) per weather state
const WIND_SPEED_BY_WEATHER = [1.2, 2.8, 4.5, 7.0, 12.0];

// Horizon haze per weather state (Dhaka — always some haze)
const HORIZON_HAZE_BY_WEATHER = [0.35, 0.42, 0.55, 0.60, 0.65];

// Aerial density per weather state
const AERIAL_DENSITY_BY_WEATHER = [0.25, 0.32, 0.48, 0.55, 0.62];

// Rain density per weather state
const RAIN_DENSITY_BY_WEATHER = [0.0, 0.0, 0.0, 0.55, 1.0];

// Sun intensity per weather state (reduced by cloud cover)
const SUN_INTENSITY_BY_WEATHER = [22.0, 18.5, 12.0, 8.0, 5.5];

// Wetness timers
let _wetnessTarget  = 0.0;   // 0 or 1
let _wetnessCurrent = 0.0;   // lerped each frame

// Rain velocity (world-space, updated from wind state each frame)
let _rainVelocity = new THREE.Vector3(0, -14, 0);

// TAA Halton sequence index
let _taaFrame = 0;
const _haltonSeq = _buildHalton(16);

// God ray state
let _godRayActive    = false;
let _godRayStrength  = 0.0;

// Astronomy cache (updated every 10 seconds)
let _lastAstroUpdate = -999;
let _sunDir    = new THREE.Vector3(0, 1, 0);
let _moonDir   = new THREE.Vector3(0, 0.7, 0.7).normalize();
let _moonPhase = 0.25;

// Spawn grids for rain particles (pre-computed, camera-relative)
const RAIN_NEAR_COUNT   = 4000;
const RAIN_FAR_COUNT    = 6000;
const RAIN_SPLASH_COUNT = 1200;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the entire sky system.
 * Must be called after initScene() has completed.
 * @returns {Promise<void>}
 */
export async function initSky() {
  try {
    await _loadShaders();

    _buildFullScreenHelper();
    _buildRenderTargets();
    _buildAtmosphereDome();
    _buildStarField();
    _buildMilkyWay();
    _buildCloudPass();
    _buildTAAPass();
    _buildRainSystem();
    _buildGodRayPass();

    // Prime weather state from mood data
    _evaluateWeatherTarget();

    registerUpdate(_tick);

    console.log('%cATLAS SKY%c initialised — atmosphere, stars, clouds, rain',
      'color:#c8a96e;font-weight:bold', 'color:#8a7e6e');

  } catch (err) {
    console.error('[ATLAS SKY] init failed:', err);
    throw err;
  }
}

/**
 * Dispose all sky GPU resources and deregister from the render loop.
 */
export function disposeSky() {
  deregisterUpdate(_tick);
  _disposeAll();
}

// ─── Shader loading ───────────────────────────────────────────────────────────

async function _loadShaders() {
  const [atmos, cloud, rain] = await Promise.all([
    fetch('./shaders/atmosphere.glsl').then(r => r.text()),
    fetch('./shaders/cloud.glsl').then(r => r.text()),
    fetch('./shaders/rain.glsl').then(r => r.text()),
  ]);
  _atmosSrc = atmos;
  _cloudSrc = cloud;
  _rainSrc  = rain;
}

/**
 * Split a shader source file on a sentinel comment line.
 * Returns { vertex, fragment } strings.
 * Works for atmosphere.glsl (// === VERTEX === / // === FRAGMENT ===).
 */
function _splitShader(src, vertexSentinel, fragmentSentinel) {
  const vIdx = src.indexOf(vertexSentinel);
  const fIdx = src.indexOf(fragmentSentinel);
  if (vIdx === -1 || fIdx === -1) {
    throw new Error(`[Sky] Missing sentinels "${vertexSentinel}" / "${fragmentSentinel}"`);
  }
  const vertex   = src.slice(vIdx + vertexSentinel.length, fIdx).trim();
  const fragment = src.slice(fIdx + fragmentSentinel.length).trim();
  return { vertex, fragment };
}

/**
 * Extract a named shader block from rain.glsl.
 * Rain file has 6 sentinels; each block runs until the next sentinel.
 */
function _extractRainShader(src, startSentinel, endSentinel) {
  const start = src.indexOf(startSentinel);
  if (start === -1) throw new Error(`[Sky] Missing rain sentinel "${startSentinel}"`);
  const contentStart = start + startSentinel.length;
  const end = endSentinel ? src.indexOf(endSentinel, contentStart) : src.length;
  return src.slice(contentStart, end === -1 ? undefined : end).trim();
}

// ─── Full-screen quad (mirrors scene.js pattern exactly) ─────────────────────

function _buildFullScreenHelper() {
  const geo    = new THREE.PlaneGeometry(2, 2);
  const mat    = new THREE.MeshBasicMaterial({ color: 0xffffff });
  _fsQuad      = new THREE.Mesh(geo, mat);
  _fsScene     = new THREE.Scene();
  _fsScene.add(_fsQuad);
  _orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
}

function _renderFSQ(material, target) {
  const renderer = getRenderer();
  _fsQuad.material = material;
  renderer.setRenderTarget(target);
  renderer.clear(true, false, false);
  renderer.render(_fsScene, _orthoCamera);
}

// ─── Render targets ───────────────────────────────────────────────────────────

function _buildRenderTargets() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const hw = Math.floor(w / 2);
  const hh = Math.floor(h / 2);

  const halfOpts = {
    minFilter:     THREE.LinearFilter,
    magFilter:     THREE.LinearFilter,
    format:        THREE.RGBAFormat,
    type:          THREE.HalfFloatType,
    depthBuffer:   false,
    stencilBuffer: false,
  };

  _rtAtmos  = new THREE.WebGLRenderTarget(hw, hh, halfOpts);
  _rtCloud  = new THREE.WebGLRenderTarget(hw, hh, halfOpts);
  _rtCloudB = new THREE.WebGLRenderTarget(hw, hh, halfOpts);  // TAA history

  _rtRain = new THREE.WebGLRenderTarget(w, h, {
    ...halfOpts,
    depthBuffer: true,
    depthTexture: new THREE.DepthTexture(w, h, THREE.FloatType),
  });

  _rtGodRay = new THREE.WebGLRenderTarget(hw, hh, halfOpts);

  // Listen for resize
  window.addEventListener('resize', _onResize);
}

function _onResize() {
  const w  = window.innerWidth;
  const h  = window.innerHeight;
  const hw = Math.floor(w / 2);
  const hh = Math.floor(h / 2);

  _rtAtmos.setSize(hw, hh);
  _rtCloud.setSize(hw, hh);
  _rtCloudB.setSize(hw, hh);
  _rtRain.setSize(w, h);
  if (_rtRain.depthTexture) _rtRain.depthTexture.dispose();
  _rtRain.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
  _rtGodRay.setSize(hw, hh);

  // Update resolution uniforms
  if (_cloudMat) {
    _cloudMat.uniforms.uResolution.value.set(hw, hh);
    _cloudMat.uniforms.uAspect.value = w / h;
  }
  if (_godRayMat)   _godRayMat.uniforms.uResolution.value.set(hw, hh);
  if (_lensMat)     _lensMat.uniforms.uResolution.value.set(w, h);
  if (_taaMat)      _taaMat.uniforms.uResolution.value.set(hw, hh);
}

// ─── Atmosphere dome ──────────────────────────────────────────────────────────

function _buildAtmosphereDome() {
  // Large sphere — camera always inside, so faces rendered inward
  const geo = new THREE.SphereGeometry(9000, 32, 16);

  const { vertex, fragment } = _splitShader(
    _atmosSrc,
    '// === VERTEX ===',
    '// === FRAGMENT ===',
  );

  _atmosMat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDirection:   { value: _sunDir.clone() },
      uSunIntensity:   { value: 22.0 },
      uRayleighCoeff:  { value: new THREE.Vector3(5.802e-6, 13.558e-6, 33.1e-6) },
      uMieCoeff:       { value: 21e-6 },
      uMieDirectional: { value: 0.76 },
      uPlanetRadius:   { value: 6371000.0 },
      uAtmosRadius:    { value: 6471000.0 },
      uRayleighScale:  { value: 8000.0 },
      uMieScale:       { value: 1200.0 },
      uTime:           { value: 0.0 },
      uMoonDirection:  { value: _moonDir.clone() },
      uMoonPhase:      { value: _moonPhase },
      uExposure:       { value: 1.0 },
      uWetness:        { value: 0.0 },
      uWeather:        { value: 1 },
      uCloudCoverage:  { value: 0.28 },
      uHorizonHaze:    { value: 0.42 },
      uAerialDensity:  { value: 0.32 },
    },
    vertexShader:   vertex,
    fragmentShader: fragment,
    side:           THREE.BackSide,  // render inside of sphere
    depthWrite:     false,
    depthTest:      false,
  });

  _domeMesh = new THREE.Mesh(geo, _atmosMat);
  _domeMesh.frustumCulled = false;
  _domeMesh.renderOrder   = -100;   // render before everything else

  getScene().add(_domeMesh);
}

// ─── Star field ───────────────────────────────────────────────────────────────

function _buildStarField() {
  const STAR_COUNT = 4800;

  const positions  = new Float32Array(STAR_COUNT * 3);
  const colors     = new Float32Array(STAR_COUNT * 3);
  const sizes      = new Float32Array(STAR_COUNT);
  const phases     = new Float32Array(STAR_COUNT);  // scintillation phase offset

  // Stellar spectral classes: O B A F G K M
  // Colour table (linear sRGB approximate)
  const SPECTRAL_COLORS = [
    [0.75, 0.82, 1.00],  // O — blue-white   (very rare)
    [0.80, 0.87, 1.00],  // B — blue-white
    [0.95, 0.96, 1.00],  // A — white
    [1.00, 0.98, 0.92],  // F — yellow-white
    [1.00, 0.94, 0.80],  // G — yellow  (Sun-like)
    [1.00, 0.80, 0.55],  // K — orange
    [1.00, 0.60, 0.35],  // M — red-orange  (common)
  ];
  // Approximate frequency of spectral classes in real sky (biased toward dim M)
  const SPECTRAL_WEIGHTS = [0.00, 0.01, 0.06, 0.12, 0.12, 0.18, 0.51];

  function pickSpectral(rng) {
    let acc = 0;
    for (let i = 0; i < SPECTRAL_WEIGHTS.length; i++) {
      acc += SPECTRAL_WEIGHTS[i];
      if (rng < acc) return SPECTRAL_COLORS[i];
    }
    return SPECTRAL_COLORS[6];
  }

  for (let i = 0; i < STAR_COUNT; i++) {
    // Uniform distribution on sphere surface via rejection-free spherical coords
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    const r     = 8800;  // slightly larger than dome

    // Bias toward upper hemisphere — few stars near horizon (obscured by atmos)
    const y = r * Math.cos(phi);
    if (y < -r * 0.25) {
      // Below −15° elevation — skip (horizon haze would make them invisible)
      i--;
      continue;
    }

    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

    const spectralRng = Math.random();
    const col = pickSpectral(spectralRng);
    colors[i * 3]     = col[0];
    colors[i * 3 + 1] = col[1];
    colors[i * 3 + 2] = col[2];

    // Star apparent size: 0.8–2.6 px, magnitude-weighted
    // Brighter stars (lower magnitude) are slightly larger in the buffer
    sizes[i]  = 0.8 + Math.pow(Math.random(), 2.5) * 1.8;
    phases[i] = Math.random() * Math.PI * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',  new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',     new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('size',      new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aPhase',    new THREE.BufferAttribute(phases, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:       { value: 0.0 },
      uNightBlend: { value: 0.0 },   // 0=day 1=night — fades stars in at dusk
      uIsNight:    { value: 0.0 },
    },
    vertexShader: /* glsl */`
      attribute float size;
      attribute float aPhase;
      varying vec3  vColor;
      varying float vPhase;
      varying float vSize;
      uniform float uNightBlend;

      void main() {
        vColor = color;
        vPhase = aPhase;
        vSize  = size;

        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        // Point size: scale with distance so stars stay crisp at any FOV
        gl_PointSize = size * (800.0 / -mvPos.z) * uNightBlend;
        gl_Position  = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: /* glsl */`
      precision mediump float;
      uniform float uTime;
      uniform float uNightBlend;
      varying vec3  vColor;
      varying float vPhase;
      varying float vSize;

      void main() {
        // Circular point — discard outside unit circle
        vec2  pc   = gl_PointCoord - 0.5;
        float dist = length(pc);
        if (dist > 0.5) discard;

        // Soft disc edge
        float alpha = 1.0 - smoothstep(0.30, 0.50, dist);

        // Atmospheric scintillation: multi-frequency oscillation per star
        // Fast component (thermal turbulence) + slow component (seeing)
        float twinkle = 0.85
          + 0.10 * sin(uTime * 3.8 + vPhase)
          + 0.05 * sin(uTime * 7.1 + vPhase * 2.3);

        // Scintillation is stronger for smaller (dimmer) stars and
        // suppressed for very large (bright) stars
        float scintillationStrength = 1.0 - smoothstep(1.0, 2.5, vSize);
        float brightness = mix(1.0, twinkle, scintillationStrength * 0.7);

        vec3 col = vColor * brightness * uNightBlend;
        gl_FragColor = vec4(col * alpha, alpha * uNightBlend);
      }
    `,
    vertexColors:  true,
    transparent:   true,
    depthWrite:    false,
    blending:      THREE.AdditiveBlending,
  });

  _starPoints = new THREE.Points(geo, mat);
  _starPoints.frustumCulled = false;
  _starPoints.renderOrder   = -99;

  getScene().add(_starPoints);
}

// ─── Milky Way band ───────────────────────────────────────────────────────────

function _buildMilkyWay() {
  // The Milky Way is rendered as a dense belt of ~2 400 very dim, very small
  // points distributed along a great circle band tilted at ~63° to the
  // celestial equator.  At Dhaka latitude, the galactic centre (Sagittarius)
  // rises high in the south during summer nights.

  const MW_COUNT = 2400;
  const positions = new Float32Array(MW_COUNT * 3);
  const colors    = new Float32Array(MW_COUNT * 3);
  const sizes     = new Float32Array(MW_COUNT);

  // Galactic plane tilt relative to equatorial: ~63°
  // We approximate the band with a parametric great-circle arc
  const TILT       = THREE.MathUtils.degToRad(63);
  const BAND_WIDTH = THREE.MathUtils.degToRad(18);  // Milky Way apparent width
  const R          = 8900;

  for (let i = 0; i < MW_COUNT; i++) {
    // Longitude along galactic plane
    const lon   = Math.random() * Math.PI * 2;
    // Latitude within band (gaussian distribution around equator)
    const lat   = (Math.random() - 0.5) * 2 * BAND_WIDTH;

    // Galactic plane is tilted by TILT around the X axis
    const x0 = R * Math.cos(lat) * Math.cos(lon);
    const y0 = R * Math.sin(lat);
    const z0 = R * Math.cos(lat) * Math.sin(lon);

    // Rotate around X axis by TILT
    positions[i * 3]     = x0;
    positions[i * 3 + 1] = y0 * Math.cos(TILT) - z0 * Math.sin(TILT);
    positions[i * 3 + 2] = y0 * Math.sin(TILT) + z0 * Math.cos(TILT);

    // Galactic centre region (lon ≈ 0) is brighter and more yellow-white;
    // outer arms are dimmer and bluer
    const centreness = 1.0 - Math.abs(Math.sin(lon * 0.5));  // 1 at lon=0, 0 at lon=π
    const baseGlow   = 0.08 + centreness * 0.14;

    // Colour: warm cream toward centre, cool blue-white at edges
    colors[i * 3]     = baseGlow * (0.85 + centreness * 0.15);
    colors[i * 3 + 1] = baseGlow * (0.80 + centreness * 0.10);
    colors[i * 3 + 2] = baseGlow * (0.90 - centreness * 0.10);

    sizes[i] = 0.4 + Math.random() * 0.5;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('size',     new THREE.BufferAttribute(sizes, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uNightBlend: { value: 0.0 },
    },
    vertexShader: /* glsl */`
      attribute float size;
      varying vec3  vColor;
      uniform float uNightBlend;
      void main() {
        vColor = color;
        vec4 mvPos   = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (600.0 / -mvPos.z) * uNightBlend;
        gl_Position  = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: /* glsl */`
      precision mediump float;
      uniform float uNightBlend;
      varying vec3  vColor;
      void main() {
        vec2  pc   = gl_PointCoord - 0.5;
        float d    = length(pc);
        if (d > 0.5) discard;
        float a    = (1.0 - smoothstep(0.20, 0.50, d)) * uNightBlend * 0.55;
        gl_FragColor = vec4(vColor, a);
      }
    `,
    vertexColors: true,
    transparent:  true,
    depthWrite:   false,
    blending:     THREE.AdditiveBlending,
  });

  _milkyWay = new THREE.Points(geo, mat);
  _milkyWay.frustumCulled = false;
  _milkyWay.renderOrder   = -98;

  getScene().add(_milkyWay);
}

// ─── Cloud pass ───────────────────────────────────────────────────────────────

function _buildCloudPass() {
  const hw = Math.floor(window.innerWidth  / 2);
  const hh = Math.floor(window.innerHeight / 2);

  _cloudMat = new THREE.ShaderMaterial({
    uniforms: {
      uSkyTex:       { value: _rtAtmos.texture },
      uTime:         { value: 0.0 },
      uSunDirection: { value: _sunDir.clone() },
      uSunColor:     { value: new THREE.Vector3(1.0, 0.95, 0.88) },
      uSunIntensity: { value: 22.0 },
      uMoonDirection:{ value: _moonDir.clone() },
      uMoonColor:    { value: new THREE.Vector3(0.62, 0.65, 0.74) },
      uIsNight:      { value: 0.0 },
      uWeather:      { value: 1 },
      uCloudCoverage:{ value: 0.28 },
      uWindSpeed:    { value: 2.8 },
      uWindDirection:{ value: new THREE.Vector2(state.wind.direction.x, state.wind.direction.z) },
      uTAAJitter:    { value: new THREE.Vector2(0, 0) },
      uResolution:   { value: new THREE.Vector2(hw, hh) },
      uCameraPos:    { value: new THREE.Vector3() },
      uCameraDir:    { value: new THREE.Vector3(0, 0, -1) },
      uPlanetRadius: { value: 6371000.0 },
      uCloudBaseAlt: { value: 1500.0 },
      uCloudTopAlt:  { value: 4500.0 },
      uAspect:       { value: window.innerWidth / window.innerHeight },
      uFovTan:       { value: Math.tan(THREE.MathUtils.degToRad(CONFIG.CAMERA_FOV) / 2) },
    },
    vertexShader:   _vsFullScreen(),
    fragmentShader: _cloudSrc,
    depthTest:      false,
    depthWrite:     false,
    transparent:    true,
  });
}

// ─── TAA (Temporal Anti-Aliasing) accumulation pass for clouds ────────────────

function _buildTAAPass() {
  const hw = Math.floor(window.innerWidth  / 2);
  const hh = Math.floor(window.innerHeight / 2);

  _taaMat = new THREE.ShaderMaterial({
    uniforms: {
      uCurrent:    { value: _rtCloud.texture },
      uHistory:    { value: _rtCloudB.texture },
      uResolution: { value: new THREE.Vector2(hw, hh) },
      uBlend:      { value: 0.1 },   // 10% current, 90% history → smooth accumulation
    },
    vertexShader: _vsFullScreen(),
    fragmentShader: /* glsl */`
      precision mediump float;
      uniform sampler2D uCurrent;
      uniform sampler2D uHistory;
      uniform vec2      uResolution;
      uniform float     uBlend;
      varying vec2      vUv;

      // Constrain history sample to current neighbourhood (AABB clamping)
      // Prevents ghosting when the camera moves fast.
      vec4 aabbClamp(vec4 hist, vec2 uv) {
        vec2 texel = 1.0 / uResolution;
        vec4 minC = vec4(1e9);
        vec4 maxC = vec4(-1e9);
        for (int dy = -1; dy <= 1; dy++) {
          for (int dx = -1; dx <= 1; dx++) {
            vec4 s = texture2D(uCurrent,
              uv + vec2(float(dx), float(dy)) * texel);
            minC = min(minC, s);
            maxC = max(maxC, s);
          }
        }
        return clamp(hist, minC, maxC);
      }

      void main() {
        vec4 current = texture2D(uCurrent, vUv);
        vec4 history = aabbClamp(texture2D(uHistory, vUv), vUv);
        gl_FragColor = mix(history, current, uBlend);
      }
    `,
    depthTest:  false,
    depthWrite: false,
  });
}

// ─── Rain system ──────────────────────────────────────────────────────────────

function _buildRainSystem() {
  // Extract the six shader blocks from rain.glsl
  const rainVertSrc    = _extractRainShader(_rainSrc,
    '// === VERTEX ===',       '// === FRAGMENT ===');
  const rainFragSrc    = _extractRainShader(_rainSrc,
    '// === FRAGMENT ===',     '// === SPLASH VERTEX ===');
  const splashVertSrc  = _extractRainShader(_rainSrc,
    '// === SPLASH VERTEX ===','// === SPLASH FRAGMENT ===');
  const splashFragSrc  = _extractRainShader(_rainSrc,
    '// === SPLASH FRAGMENT ===','// === LENS VERTEX ===');
  const lensVertSrc    = _extractRainShader(_rainSrc,
    '// === LENS VERTEX ===',  '// === LENS FRAGMENT ===');
  const lensFragSrc    = _extractRainShader(_rainSrc,
    '// === LENS FRAGMENT ===', null);

  // ── Streak geometry: a single tall thin quad ─────────────────────────────
  // Width 1.0, height 1.0 — the vertex shader scales it per instance
  const streakGeo = new THREE.PlaneGeometry(1.0, 1.0, 1, 1);

  // ── Shared streak uniforms factory ───────────────────────────────────────
  const _streakUniforms = (layer) => ({
    uTime:         { value: 0.0 },
    uRainVelocity: { value: _rainVelocity.clone() },
    uCameraPos:    { value: new THREE.Vector3() },
    uLayer:        { value: layer },
    uRainDensity:  { value: 0.0 },
    // Fragment
    uWetness:      { value: 0.0 },
    uSunDirection: { value: _sunDir.clone() },
    uSunColor:     { value: new THREE.Vector3(1.0, 0.95, 0.88) },
    uIsNight:      { value: 0.0 },
    uWeather:      { value: 1 },
  });

  // ── Near layer ────────────────────────────────────────────────────────────
  _rainNearMat = new THREE.ShaderMaterial({
    uniforms:       _streakUniforms(0.0),
    vertexShader:   rainVertSrc,
    fragmentShader: rainFragSrc,
    transparent:    true,
    depthWrite:     false,
    blending:       THREE.NormalBlending,
    side:           THREE.DoubleSide,
  });

  _rainNear = new THREE.InstancedMesh(streakGeo, _rainNearMat, RAIN_NEAR_COUNT);
  _rainNear.frustumCulled = false;
  _rainNear.renderOrder   = 50;
  _rainNear.visible       = false;  // enabled when rain starts
  _spawnRainInstances(_rainNear, RAIN_NEAR_COUNT, 30, 12);
  getScene().add(_rainNear);

  // ── Far layer ─────────────────────────────────────────────────────────────
  _rainFarMat = new THREE.ShaderMaterial({
    uniforms:       _streakUniforms(1.0),
    vertexShader:   rainVertSrc,
    fragmentShader: rainFragSrc,
    transparent:    true,
    depthWrite:     false,
    blending:       THREE.NormalBlending,
    side:           THREE.DoubleSide,
  });

  _rainFar = new THREE.InstancedMesh(streakGeo, _rainFarMat, RAIN_FAR_COUNT);
  _rainFar.frustumCulled = false;
  _rainFar.renderOrder   = 49;
  _rainFar.visible       = false;
  _spawnRainInstances(_rainFar, RAIN_FAR_COUNT, 200, 60);
  getScene().add(_rainFar);

  // ── Splash rings ──────────────────────────────────────────────────────────
  const splashGeo = new THREE.PlaneGeometry(1.0, 1.0, 1, 1);
  splashGeo.rotateX(-Math.PI / 2);   // flat on XZ plane

  _splashMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:        { value: 0.0 },
      uRainDensity: { value: 0.0 },
      uWetness:     { value: 0.0 },
    },
    vertexShader:   splashVertSrc,
    fragmentShader: splashFragSrc,
    transparent:    true,
    depthWrite:     false,
    blending:       THREE.NormalBlending,
    side:           THREE.DoubleSide,
  });

  _splashMesh = new THREE.InstancedMesh(splashGeo, _splashMat, RAIN_SPLASH_COUNT);
  _splashMesh.frustumCulled = false;
  _splashMesh.renderOrder   = 51;
  _splashMesh.visible       = false;
  _spawnSplashInstances(_splashMesh, RAIN_SPLASH_COUNT);
  getScene().add(_splashMesh);

  // ── Lens distortion material (full-screen blit, applied in _tick) ─────────
  _lensMat = new THREE.ShaderMaterial({
    uniforms: {
      uSceneTex:    { value: null },   // set each frame to main scene RT
      uRainTex:     { value: _rtRain.texture },
      uRainDensity: { value: 0.0 },
      uTime:        { value: 0.0 },
      uResolution:  { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
    },
    vertexShader:   lensVertSrc,
    fragmentShader: lensFragSrc,
    depthTest:      false,
    depthWrite:     false,
  });
}

/**
 * Scatter rain instances in a camera-centred horizontal disc.
 * @param {THREE.InstancedMesh} mesh
 * @param {number} count
 * @param {number} outerRadius  — max horizontal distance from origin (m)
 * @param {number} innerRadius  — min horizontal distance (avoids clipping)
 */
function _spawnRainInstances(mesh, count, outerRadius, innerRadius) {
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    // Uniform disc distribution via sqrt of uniform radius sample
    const r     = innerRadius + Math.sqrt(Math.random()) * (outerRadius - innerRadius);
    const theta = Math.random() * Math.PI * 2;
    // Vertical spawn range: above camera eye height
    const y     = state.camera.y + 2.0 + Math.random() * 25.0;

    dummy.position.set(r * Math.cos(theta), y, r * Math.sin(theta));
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

/**
 * Scatter splash instances on the terrain surface (Y ≈ 0) in a disc.
 */
function _spawnSplashInstances(mesh, count) {
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    const r     = Math.sqrt(Math.random()) * 80;
    const theta = Math.random() * Math.PI * 2;
    dummy.position.set(r * Math.cos(theta), 0.02, r * Math.sin(theta));
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

// ─── God ray pass ─────────────────────────────────────────────────────────────

function _buildGodRayPass() {
  const hw = Math.floor(window.innerWidth  / 2);
  const hh = Math.floor(window.innerHeight / 2);

  // Radial blur toward projected sun screen position
  _godRayMat = new THREE.ShaderMaterial({
    uniforms: {
      uSceneTex:    { value: null },     // set each frame to _rtAtmos
      uSunPos:      { value: new THREE.Vector2(0.5, 0.5) },  // NDC sun screen pos
      uExposure:    { value: 0.18 },
      uDecay:       { value: 0.96 },
      uDensity:     { value: 0.92 },
      uWeight:      { value: 0.40 },
      uStrength:    { value: 0.0 },     // animated 0→1 when rays active
      uResolution:  { value: new THREE.Vector2(hw, hh) },
    },
    vertexShader: _vsFullScreen(),
    fragmentShader: /* glsl */`
      /**
       * God rays — radial blur toward sun screen position.
       * Based on Crytek 2007 technique (Shafts of Light, GPU Gems 3 Ch. 13).
       * NUM_SAMPLES reduced to 60 for RTX 2050 performance at half resolution.
       */
      precision mediump float;

      uniform sampler2D uSceneTex;
      uniform vec2      uSunPos;       // sun screen UV [0,1]
      uniform float     uExposure;
      uniform float     uDecay;
      uniform float     uDensity;
      uniform float     uWeight;
      uniform float     uStrength;
      uniform vec2      uResolution;

      varying vec2 vUv;

      const int NUM_SAMPLES = 60;

      void main() {
        if (uStrength < 0.002) {
          gl_FragColor = vec4(0.0);
          return;
        }

        vec2  uv      = vUv;
        vec2  delta   = (uv - uSunPos) * (1.0 / float(NUM_SAMPLES)) * uDensity;
        float illum   = 1.0;
        vec3  colour  = vec3(0.0);

        for (int i = 0; i < NUM_SAMPLES; i++) {
          uv        -= delta;
          vec3 samp  = texture2D(uSceneTex, uv).rgb;
          // Isolate bright areas (sun disc, horizon glow) — threshold at 0.7
          samp       = max(samp - 0.70, 0.0);
          colour    += samp * illum * uWeight;
          illum     *= uDecay;
        }

        colour *= uExposure * uStrength;
        gl_FragColor = vec4(colour, 1.0);
      }
    `,
    depthTest:  false,
    depthWrite: false,
    transparent: true,
    blending: THREE.AdditiveBlending,
  });

  // God ray composite — additive blend of god ray RT over the main scene
  _godComposMat = new THREE.ShaderMaterial({
    uniforms: {
      uBase:     { value: null },
      uGodRays:  { value: _rtGodRay.texture },
      uStrength: { value: 0.0 },
    },
    vertexShader: _vsFullScreen(),
    fragmentShader: /* glsl */`
      precision mediump float;
      uniform sampler2D uBase;
      uniform sampler2D uGodRays;
      uniform float     uStrength;
      varying vec2      vUv;
      void main() {
        vec4 base = texture2D(uBase, vUv);
        vec3 rays = texture2D(uGodRays, vUv).rgb * uStrength;
        gl_FragColor = vec4(base.rgb + rays, base.a);
      }
    `,
    depthTest:  false,
    depthWrite: false,
  });
}

// ─── Astronomy ────────────────────────────────────────────────────────────────

/**
 * Compute physically-correct sun direction for Dhaka (23.8°N, 90.4°E).
 * Uses the Spencer (1971) solar declination approximation and the
 * equation of time for true solar hour angle.
 *
 * @param {number} localHour   — 0–24 real wall-clock hour (Bangladesh Standard Time, UTC+6)
 * @param {number} dayOfYear   — 1–365
 * @returns {THREE.Vector3}    — normalised world-space direction toward sun
 */
function _computeSunDirection(localHour, dayOfYear) {
  const LAT_RAD  = THREE.MathUtils.degToRad(23.8);   // Dhaka latitude
  const LON_DEG  = 90.4;                             // Dhaka longitude

  // Bangladesh Standard Time = UTC+6 — convert local to UTC
  const utcHour = ((localHour - 6) % 24 + 24) % 24;

  // Solar declination (Spencer 1971)
  const B   = THREE.MathUtils.degToRad((360 / 365) * (dayOfYear - 81));
  const dec = THREE.MathUtils.degToRad(
    23.45 * Math.sin(B)
  );

  // Equation of time (minutes) — corrects solar noon offset
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);

  // True solar time
  const solarTime = utcHour * 60 + LON_DEG * 4 + eot;  // minutes

  // Hour angle: 0 at solar noon, negative morning, positive afternoon
  const hourAngle = THREE.MathUtils.degToRad((solarTime / 4) - 180);

  // Solar elevation (altitude above horizon)
  const sinEl = Math.sin(LAT_RAD) * Math.sin(dec)
              + Math.cos(LAT_RAD) * Math.cos(dec) * Math.cos(hourAngle);
  const elevation = Math.asin(THREE.MathUtils.clamp(sinEl, -1, 1));

  // Solar azimuth (measured from North, clockwise)
  const cosAz  = (Math.sin(dec) - Math.sin(LAT_RAD) * sinEl)
               / (Math.cos(LAT_RAD) * Math.cos(elevation));
  let azimuth  = Math.acos(THREE.MathUtils.clamp(cosAz, -1, 1));
  if (solarTime > 720) azimuth = Math.PI * 2 - azimuth;  // afternoon

  // Convert to world-space direction (Y-up: X=East, Z=South)
  const el  = elevation;
  const az  = azimuth;
  return new THREE.Vector3(
     Math.sin(az) * Math.cos(el),   // X — east/west
     Math.sin(el),                   // Y — up
    -Math.cos(az) * Math.cos(el),   // Z — north/south (−Z = north in Three.js)
  ).normalize();
}

/**
 * Compute moon direction and phase.
 * Uses a simplified mean-longitude J2000 approximation
 * (accurate to ±2° for visual purposes).
 *
 * @param {number} dayOfYear
 * @param {number} localHour
 * @returns {{ direction: THREE.Vector3, phase: number }}
 */
function _computeMoon(dayOfYear, localHour) {
  // Julian day from J2000.0 (2000-01-01 12:00 UT)
  // Approximate: this is visually sufficient
  const jd = dayOfYear + localHour / 24.0;

  // Lunar mean longitude (degrees)
  const L0 = 218.316 + 13.176396 * jd;
  // Lunar mean anomaly
  const M  = 134.963 + 13.064993 * jd;
  // Lunar argument of latitude
  const F  = 93.272  + 13.229350 * jd;

  // Ecliptic longitude (simplified, dominant term only)
  const lon = THREE.MathUtils.degToRad(L0 + 6.289 * Math.sin(THREE.MathUtils.degToRad(M)));
  // Ecliptic latitude
  const lat = THREE.MathUtils.degToRad(5.128 * Math.sin(THREE.MathUtils.degToRad(F)));

  // Obliquity of ecliptic (approx)
  const obl = THREE.MathUtils.degToRad(23.439);

  // Convert ecliptic → equatorial → world-space (Y-up)
  // RA and Dec from ecliptic lon/lat
  const ra  = Math.atan2(
    Math.sin(lon) * Math.cos(obl) - Math.tan(lat) * Math.sin(obl),
    Math.cos(lon)
  );
  const dec = Math.asin(
    Math.sin(lat) * Math.cos(obl) + Math.cos(lat) * Math.sin(obl) * Math.sin(lon)
  );

  // Local hour angle for moon (simplified — using solar time offset)
  const LAT_RAD  = THREE.MathUtils.degToRad(23.8);
  const hourAngle = THREE.MathUtils.degToRad((localHour - 12) * 15) - ra;

  const sinEl = Math.sin(LAT_RAD) * Math.sin(dec)
              + Math.cos(LAT_RAD) * Math.cos(dec) * Math.cos(hourAngle);
  const el    = Math.asin(THREE.MathUtils.clamp(sinEl, -1, 1));
  const cosAz = (Math.sin(dec) - Math.sin(LAT_RAD) * sinEl)
              / (Math.cos(LAT_RAD) * Math.cos(el));
  let az      = Math.acos(THREE.MathUtils.clamp(cosAz, -1, 1));
  if (localHour > 12) az = Math.PI * 2 - az;

  const direction = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
   -Math.cos(az) * Math.cos(el),
  ).normalize();

  // Moon phase: angle between sun and moon elongation (0=new, 0.5=full, 1=new)
  // Simplified: use difference in mean longitudes
  const sunLon  = THREE.MathUtils.degToRad(280.460 + 0.9856474 * jd);
  const elongation = ((lon - sunLon) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  const phase = elongation / (Math.PI * 2);   // 0→1

  return { direction, phase };
}

// ─── Light temperature ────────────────────────────────────────────────────────

/**
 * Compute colour-temperature-based sun colour from elevation.
 * Returns vec3 (linear RGB) appropriate for uSunColor uniforms.
 */
function _sunColorFromElevation(elDeg) {
  // Kelvin → linear RGB (Tanner Helland approximation, simplified)
  // Elevation clamped: deep red at horizon, near-white at noon
  const t = THREE.MathUtils.clamp((elDeg + 5) / 50, 0, 1);

  // Interpolate through sunset colours:
  // Deep red (2 200 K) → orange (2 800 K) → warm white (5 500 K) → white (6 500 K)
  const r = 1.0;
  const g = THREE.MathUtils.lerp(0.38, 0.95, t);
  const b = THREE.MathUtils.lerp(0.10, 0.88, t);

  return new THREE.Vector3(r, g, b);
}

/**
 * Map sun elevation to light temperature (Kelvin) and write to state.
 */
function _updateLightTemperature(elDeg) {
  if (state.isNight) {
    state.lightTemperature = 4200;  // moonlight: cool blue-white
    return;
  }
  if (elDeg < 5)  { state.lightTemperature = Math.round(THREE.MathUtils.lerp(2200, 2800, (elDeg + 5) / 10)); return; }
  if (elDeg < 20) { state.lightTemperature = Math.round(THREE.MathUtils.lerp(2800, 5000, (elDeg - 5) / 15)); return; }
  const weatherK = { clear: 6500, scattered: 6200, overcast: 7200, rain: 7500, storm: 7800 };
  state.lightTemperature = weatherK[state.weather] ?? 6500;
}

// ─── Weather state machine ────────────────────────────────────────────────────

/**
 * Evaluate which weather state Atlas should target based on mood data.
 * Called once at init and after each transition settles.
 *
 * Mapping:
 *   moodAvg7 > 0.72  + positive trend  → clear
 *   moodAvg7 > 0.55                    → scattered
 *   moodAvg7 > 0.40                    → overcast
 *   moodAvg7 > 0.25                    → rain
 *   moodAvg7 ≤ 0.25                    → storm
 */
function _evaluateWeatherTarget() {
  const avg   = state.moodAvg7;
  const trend = state.moodTrend;

  let target;
  if (avg > 0.72 && trend >= 0)      target = 0;  // clear
  else if (avg > 0.55)               target = 1;  // scattered
  else if (avg > 0.40)               target = 2;  // overcast
  else if (avg > 0.25)               target = 3;  // rain
  else                               target = 4;  // storm

  _targetWeatherIndex  = target;
  _weatherTransitionT  = 0.0;
  _weatherHoldTimer    = 0;

  state.weather = WEATHER_STATES[_currentWeatherIndex];
}

/**
 * Advance the weather state machine each frame.
 * Transitions are gradual — linear lerp of all weather-driven parameters.
 *
 * @param {number} delta — frame delta time (seconds)
 */
function _tickWeather(delta) {
  _weatherHoldTimer += delta;

  // Re-evaluate target every 5 minutes of real time
  if (_weatherHoldTimer >= 300) {
    _evaluateWeatherTarget();
  }

  if (_currentWeatherIndex === _targetWeatherIndex) return;

  // Advance transition
  _weatherTransitionT += delta / _weatherTransitionDur;

  if (_weatherTransitionT >= 1.0) {
    _weatherTransitionT   = 1.0;
    _currentWeatherIndex  = _targetWeatherIndex;
    state.weather         = WEATHER_STATES[_currentWeatherIndex];
  }

  // Lerp all weather parameters
  const from = _currentWeatherIndex;
  const to   = _targetWeatherIndex;
  const t    = _weatherTransitionT;

  const coverage = THREE.MathUtils.lerp(
    CLOUD_COVERAGE_BY_WEATHER[from],
    CLOUD_COVERAGE_BY_WEATHER[to], t
  );
  const windSpd = THREE.MathUtils.lerp(
    WIND_SPEED_BY_WEATHER[from],
    WIND_SPEED_BY_WEATHER[to], t
  );
  const haze = THREE.MathUtils.lerp(
    HORIZON_HAZE_BY_WEATHER[from],
    HORIZON_HAZE_BY_WEATHER[to], t
  );
  const aerial = THREE.MathUtils.lerp(
    AERIAL_DENSITY_BY_WEATHER[from],
    AERIAL_DENSITY_BY_WEATHER[to], t
  );
  const rainDensity = THREE.MathUtils.lerp(
    RAIN_DENSITY_BY_WEATHER[from],
    RAIN_DENSITY_BY_WEATHER[to], t
  );
  const sunInt = THREE.MathUtils.lerp(
    SUN_INTENSITY_BY_WEATHER[from],
    SUN_INTENSITY_BY_WEATHER[to], t
  );

  // Write to atmosphere
  _atmosMat.uniforms.uCloudCoverage.value = coverage;
  _atmosMat.uniforms.uHorizonHaze.value   = haze;
  _atmosMat.uniforms.uAerialDensity.value = aerial;
  _atmosMat.uniforms.uSunIntensity.value  = sunInt;
  _atmosMat.uniforms.uWeather.value       = from;   // integer — use current

  // Write to clouds
  _cloudMat.uniforms.uCloudCoverage.value = coverage;
  _cloudMat.uniforms.uWindSpeed.value     = windSpd;
  _cloudMat.uniforms.uWeather.value       = from;
  _cloudMat.uniforms.uSunIntensity.value  = sunInt;

  // Write to state (fog density driven by weather)
  state.fogDensity = THREE.MathUtils.lerp(0.00018, 0.00065,
    coverage * 0.6 + (to === 4 ? 0.4 : 0));

  // Wind target
  state.wind.targetStrength = windSpd / 12.0;  // normalise to [0,1]

  // Rain particle visibility
  const isRaining = rainDensity > 0.01;
  if (_rainNear)  _rainNear.visible  = isRaining;
  if (_rainFar)   _rainFar.visible   = isRaining;
  if (_splashMesh) _splashMesh.visible = isRaining;

  // Rain density to materials
  if (_rainNearMat) _rainNearMat.uniforms.uRainDensity.value = rainDensity;
  if (_rainFarMat)  _rainFarMat.uniforms.uRainDensity.value  = rainDensity;
  if (_splashMat)   _splashMat.uniforms.uRainDensity.value   = rainDensity;
  if (_lensMat)     _lensMat.uniforms.uRainDensity.value     = rainDensity;

  // Wetness target
  _wetnessTarget = isRaining ? 1.0 : 0.0;
}

/**
 * Advance the wetness simulation.
 * Lerp rates: 0→1 in 45 s (rain start), 1→0 in 180 s (rain stop).
 *
 * @param {number} delta
 */
function _tickWetness(delta) {
  const rate = _wetnessTarget > _wetnessCurrent
    ? delta / 45.0    // wetting: 45 seconds to fully wet
    : -delta / 180.0; // drying:  180 seconds to fully dry

  _wetnessCurrent = THREE.MathUtils.clamp(_wetnessCurrent + rate, 0.0, 1.0);
  state.wetness   = _wetnessCurrent;

  // Broadcast to rain shaders
  if (_rainNearMat) _rainNearMat.uniforms.uWetness.value = _wetnessCurrent;
  if (_rainFarMat)  _rainFarMat.uniforms.uWetness.value  = _wetnessCurrent;
  if (_splashMat)   _splashMat.uniforms.uWetness.value   = _wetnessCurrent;
}

// ─── God ray evaluation ───────────────────────────────────────────────────────

/**
 * Determine god ray strength and sun screen position.
 * God rays are active when:
 *   - sun is between 2° and 35° elevation (rays most visible at low sun)
 *   - weather is clear or scattered (not overcast/rain/storm)
 *
 * @param {THREE.Camera} camera
 * @returns {{ screenPos: THREE.Vector2, strength: number }}
 */
function _evaluateGodRays(camera) {
  const elDeg = state.sunElevation;

  // Only show rays when sun is in the right elevation band
  const elevOk = elDeg > 1.5 && elDeg < 38;

  // Suppress in heavy cloud cover
  const cloudSuppression = THREE.MathUtils.clamp(
    1.0 - (CLOUD_COVERAGE_BY_WEATHER[_currentWeatherIndex] - 0.3) / 0.5,
    0.0, 1.0
  );

  const targetStrength = elevOk ? cloudSuppression * 0.7 : 0.0;
  _godRayStrength = THREE.MathUtils.lerp(_godRayStrength, targetStrength, 0.02);

  // Project sun position to screen
  const sunWorld = _sunDir.clone().multiplyScalar(8000);
  sunWorld.add(camera.position);
  const sunNDC = sunWorld.clone().project(camera);
  const screenPos = new THREE.Vector2(
    sunNDC.x * 0.5 + 0.5,
    sunNDC.y * 0.5 + 0.5,
  );

  return { screenPos, strength: _godRayStrength };
}

// ─── Main per-frame tick ──────────────────────────────────────────────────────

function _tick(delta, elapsed) {
  const camera   = getCamera();
  const renderer = getRenderer();

  // ── Astronomy (expensive — update every 10 real seconds) ─────────────────
  if (elapsed - _lastAstroUpdate > 10.0) {
    _lastAstroUpdate = elapsed;
    _sunDir  = _computeSunDirection(state.localHour, state.dayOfYear);
    const moon = _computeMoon(state.dayOfYear, state.localHour);
    _moonDir  = moon.direction;
    _moonPhase = moon.phase;

    // Write to state
    state.sunDirection.x = _sunDir.x;
    state.sunDirection.y = _sunDir.y;
    state.sunDirection.z = _sunDir.z;
    state.sunElevation   = THREE.MathUtils.radToDeg(Math.asin(_sunDir.y));
    state.isNight        = _sunDir.y < Math.sin(THREE.MathUtils.degToRad(-6));
    state.moonPhase      = _moonPhase;

    _updateLightTemperature(state.sunElevation);
  }

  // ── Weather & wetness ─────────────────────────────────────────────────────
  _tickWeather(delta);
  _tickWetness(delta);

  // ── TAA jitter ────────────────────────────────────────────────────────────
  _taaFrame = (_taaFrame + 1) % _haltonSeq.length;
  const jitter = _haltonSeq[_taaFrame];

  // ── Sun colour from elevation ─────────────────────────────────────────────
  const sunColor = _sunColorFromElevation(state.sunElevation);

  // ── Night blend: 0=day, 1=night (smooth transition −2° to −8°) ───────────
  const nightBlend = smoothstep(-2, -8, state.sunElevation);

  // ── Update dome position to follow camera (always centred) ───────────────
  _domeMesh.position.copy(camera.position);

  // ── Atmosphere dome uniforms ──────────────────────────────────────────────
  _atmosMat.uniforms.uSunDirection.value.copy(_sunDir);
  _atmosMat.uniforms.uMoonDirection.value.copy(_moonDir);
  _atmosMat.uniforms.uMoonPhase.value  = _moonPhase;
  _atmosMat.uniforms.uTime.value       = elapsed;
  _atmosMat.uniforms.uWetness.value    = _wetnessCurrent;
  // uWeather, uCloudCoverage, uHorizonHaze updated by _tickWeather

  // ── Star / Milky Way uniforms ─────────────────────────────────────────────
  if (_starPoints) {
    const starMat = _starPoints.material;
    starMat.uniforms.uTime.value       = elapsed;
    starMat.uniforms.uNightBlend.value = nightBlend;
    starMat.uniforms.uIsNight.value    = nightBlend;
  }
  if (_milkyWay) {
    _milkyWay.material.uniforms.uNightBlend.value = nightBlend * 0.85;
  }

  // Stars and Milky Way follow camera
  if (_starPoints) _starPoints.position.copy(camera.position);
  if (_milkyWay)   _milkyWay.position.copy(camera.position);

  // ── Cloud uniforms ────────────────────────────────────────────────────────
  _cloudMat.uniforms.uTime.value           = elapsed;
  _cloudMat.uniforms.uSunDirection.value.copy(_sunDir);
  _cloudMat.uniforms.uSunColor.value.copy(sunColor);
  _cloudMat.uniforms.uMoonDirection.value.copy(_moonDir);
  _cloudMat.uniforms.uIsNight.value        = nightBlend;
  _cloudMat.uniforms.uTAAJitter.value.set(jitter.x, jitter.y);
  _cloudMat.uniforms.uWindDirection.value.set(
    state.wind.direction.x, state.wind.direction.z
  );
  _cloudMat.uniforms.uCameraPos.value.copy(camera.position);
  // Derive forward direction from camera matrix
  const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  _cloudMat.uniforms.uCameraDir.value.copy(camDir);

  // ── Rain uniforms ─────────────────────────────────────────────────────────
  // Update rain velocity from wind state
  const wStr = state.weather === 'storm' ? 5.0 : 2.0;
  const fallSpd = state.weather === 'storm' ? -22.0 : -14.0;
  _rainVelocity.set(
    state.wind.direction.x * state.wind.strength * wStr,
    fallSpd,
    state.wind.direction.z * state.wind.strength * wStr,
  );

  const isNightF = state.isNight ? 1.0 : 0.0;
  const weatherI = WEATHER_INDEX[state.weather] ?? 1;

  [_rainNearMat, _rainFarMat].forEach(mat => {
    if (!mat) return;
    mat.uniforms.uTime.value             = elapsed;
    mat.uniforms.uRainVelocity.value.copy(_rainVelocity);
    mat.uniforms.uCameraPos.value.copy(camera.position);
    mat.uniforms.uSunDirection.value.copy(_sunDir);
    mat.uniforms.uSunColor.value.copy(sunColor);
    mat.uniforms.uIsNight.value          = isNightF;
    mat.uniforms.uWeather.value          = weatherI;
  });

  if (_splashMat) {
    _splashMat.uniforms.uTime.value = elapsed;
  }

  // Re-centre rain instances on camera every frame (seamless respawn disc)
  _recentreRainInstances(camera);

  // ── Fog colour — sample sky at horizon direction ──────────────────────────
  // We use a cheap heuristic: lerp between night fog colour and day fog colour
  // rather than actually sampling the render target (which requires a readback).
  const dayFogR   = THREE.MathUtils.lerp(0.62, 0.72, sunColor.y);
  const dayFogG   = THREE.MathUtils.lerp(0.68, 0.76, sunColor.y);
  const dayFogB   = THREE.MathUtils.lerp(0.72, 0.85, sunColor.z);
  const nightFogR = 0.04; const nightFogG = 0.05; const nightFogB = 0.10;

  const scene = getScene();
  if (scene.fog) {
    scene.fog.color.setRGB(
      THREE.MathUtils.lerp(dayFogR, nightFogR, nightBlend),
      THREE.MathUtils.lerp(dayFogG, nightFogG, nightBlend),
      THREE.MathUtils.lerp(dayFogB, nightFogB, nightBlend),
    );
  }

  // ── God ray evaluation ────────────────────────────────────────────────────
  const { screenPos, strength } = _evaluateGodRays(camera);
  if (_godRayMat) {
    _godRayMat.uniforms.uSunPos.value.copy(screenPos);
    _godRayMat.uniforms.uStrength.value = strength;
  }
  if (_godComposMat) {
    _godComposMat.uniforms.uStrength.value = strength;
  }
  _godRayActive = strength > 0.01;
}

// ─── Rain instance re-centring ────────────────────────────────────────────────

/**
 * Move rain instance matrices so the disc is always centred on the camera.
 * Only updates Y-axis position; XZ is fixed relative to camera in the shader.
 * We do a lightweight bulk-shift of all instance translations.
 */
function _recentreRainInstances(camera) {
  if (!_rainNear || !_rainNear.visible) return;

  // The streak shader positions particles relative to instanceOrigin (spawn pos).
  // We shift the spawn disc XZ centre to follow the camera.
  // Strategy: decompose each matrix, update XZ translation, recompose.
  // Only do this every 8 frames to save CPU.
  if (Math.round(performance.now() / 16) % 8 !== 0) return;

  const dummy = new THREE.Object3D();
  const pos   = new THREE.Vector3();
  const quat  = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  const meshes = [
    { mesh: _rainNear, outer: 30,  inner: 12  },
    { mesh: _rainFar,  outer: 200, inner: 60  },
  ];

  meshes.forEach(({ mesh, outer, inner }) => {
    const count = mesh.count;
    for (let i = 0; i < count; i++) {
      mesh.getMatrixAt(i, dummy.matrix);
      dummy.matrix.decompose(pos, quat, scale);

      // Only update instances that have drifted more than outerRadius from camera
      const dx = pos.x - camera.position.x;
      const dz = pos.z - camera.position.z;
      const r2 = dx * dx + dz * dz;
      if (r2 > outer * outer * 1.44) {  // 1.2× outer radius
        // Teleport back to a random position in the disc around camera
        const r     = inner + Math.sqrt(Math.random()) * (outer - inner);
        const theta = Math.random() * Math.PI * 2;
        pos.set(
          camera.position.x + r * Math.cos(theta),
          camera.position.y + 2.0 + Math.random() * 25.0,
          camera.position.z + r * Math.sin(theta),
        );
        dummy.position.copy(pos);
        dummy.quaternion.copy(quat);
        dummy.scale.copy(scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
  });
}

// ─── Render passes (called by world.html between scene and composite) ─────────

/**
 * Execute all sky-specific render passes.
 * Called by world.html after initScene() main render but before composite.
 *
 * Render order:
 *   1. Atmosphere dome → _rtAtmos (half-res)
 *   2. Cloud ray march → _rtCloud (half-res)
 *   3. TAA accumulate  → _rtCloudB (half-res, stable result)
 *   4. God rays        → _rtGodRay (half-res, additive)
 *   (Rain streaks rendered in main scene pass as InstancedMesh — no extra RT)
 *   5. Lens distortion — applied as a final blit before composite hand-off
 *
 * @param {THREE.WebGLRenderTarget|null} sceneRT — the main scene render target
 *   from scene.js (_rtMain) — passed in so the lens distortion can read it.
 * @returns {THREE.WebGLRenderTarget} — the lens-distorted scene RT to hand to
 *   composite.glsl instead of the raw sceneRT.
 */
export function renderSkyPasses(sceneRT) {
  const renderer = getRenderer();

  // ── 1. Atmosphere dome at half resolution ────────────────────────────────
  // Temporarily render only the dome mesh into _rtAtmos
  _domeMesh.visible       = true;
  if (_starPoints) _starPoints.visible = true;
  if (_milkyWay)   _milkyWay.visible   = true;

  renderer.setRenderTarget(_rtAtmos);
  renderer.clear(true, true, false);
  renderer.render(getScene(), getCamera());

  // ── 2. Cloud ray march at half resolution ────────────────────────────────
  _cloudMat.uniforms.uSkyTex.value = _rtAtmos.texture;
  _renderFSQ(_cloudMat, _rtCloud);

  // ── 3. TAA accumulate clouds ─────────────────────────────────────────────
  _taaMat.uniforms.uCurrent.value = _rtCloud.texture;
  _taaMat.uniforms.uHistory.value = _rtCloudB.texture;
  _renderFSQ(_taaMat, _rtCloudB);

  // ── 4. God rays (if active) ───────────────────────────────────────────────
  if (_godRayActive && _godRayMat) {
    _godRayMat.uniforms.uSceneTex.value = _rtAtmos.texture;
    _renderFSQ(_godRayMat, _rtGodRay);
  }

  // ── 5. Lens distortion blit ───────────────────────────────────────────────
  // Lens distortion reads the main scene RT and the rain streak RT.
  // The rain streaks are already rendered into sceneRT as InstancedMesh objects.
  // We apply the lens effect and return the modified scene to composite.
  if (_lensMat && _lensMat.uniforms.uRainDensity.value > 0.01) {
    _lensMat.uniforms.uSceneTex.value = sceneRT.texture;
    _lensMat.uniforms.uTime.value     = getCamera().userData.elapsed || 0;
    _renderFSQ(_lensMat, null);   // render to screen — composite reads screen
    return null;  // signal: already rendered to screen
  }

  return sceneRT;  // no lens — composite reads raw sceneRT
}

/**
 * Returns the final composited sky texture (TAA-stable clouds + atmosphere).
 * Composite pass can overlay this on top of the scene.
 * @returns {THREE.Texture}
 */
export function getSkyTexture()    { return _rtCloudB.texture; }
export function getGodRayTexture() { return _rtGodRay.texture; }
export function getGodRayActive()  { return _godRayActive; }
export function getSunDirection()  { return _sunDir; }
export function getMoonPhase()     { return _moonPhase; }

// ─── Halton low-discrepancy sequence (for TAA jitter) ────────────────────────

function _buildHalton(count) {
  const seq = [];
  for (let i = 1; i <= count; i++) {
    seq.push(new THREE.Vector2(
      _haltonBase(i, 2),
      _haltonBase(i, 3),
    ));
  }
  return seq;
}

function _haltonBase(index, base) {
  let result = 0;
  let f      = 1;
  let i      = index;
  while (i > 0) {
    f      = f / base;
    result = result + f * (i % base);
    i      = Math.floor(i / base);
  }
  return result - 0.5;   // centre around zero (±0.5)
}

// ─── Full-screen vertex shader (mirrors scene.js _vsFullScreen) ───────────────

function _vsFullScreen() {
  return /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv         = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;
}

// ─── smoothstep (JS equivalent for lighting computations) ────────────────────

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ─── Dispose ──────────────────────────────────────────────────────────────────

function _disposeAll() {
  window.removeEventListener('resize', _onResize);

  const scene = getScene();

  // Remove scene objects
  [_domeMesh, _starPoints, _milkyWay, _rainNear, _rainFar, _splashMesh].forEach(obj => {
    if (!obj) return;
    scene.remove(obj);
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });

  // Dispose render targets
  [_rtAtmos, _rtCloud, _rtCloudB, _rtRain, _rtGodRay].forEach(rt => {
    if (!rt) return;
    if (rt.depthTexture) rt.depthTexture.dispose();
    rt.dispose();
  });

  // Dispose materials
  [_atmosMat, _cloudMat, _taaMat, _rainNearMat, _rainFarMat,
   _splashMat, _lensMat, _godRayMat, _godComposMat].forEach(m => {
    if (!m) return;
    Object.values(m.uniforms).forEach(u => {
      if (u.value && typeof u.value.dispose === 'function') u.value.dispose();
    });
    m.dispose();
  });

  // Dispose full-screen quad
  if (_fsQuad) {
    _fsQuad.geometry.dispose();
    _fsQuad = null;
  }
  if (_fsScene) { _fsScene.clear(); _fsScene = null; }
  _orthoCamera = null;

  // Null all module refs
  _rtAtmos = _rtCloud = _rtCloudB = _rtRain = _rtGodRay = null;
  _domeMesh = _starPoints = _milkyWay = null;
  _rainNear = _rainFar = _splashMesh = null;
  _atmosMat = _cloudMat = _taaMat = null;
  _rainNearMat = _rainFarMat = _splashMat = _lensMat = null;
  _godRayMat = _godComposMat = null;
}
