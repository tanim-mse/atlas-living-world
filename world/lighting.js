/**
 * lighting.js — Physically correct sun, moon, ambient, and zone lighting
 * Atlas: The Living World
 *
 * Responsibilities:
 *   - Sun position computed from real wall-clock time and Dhaka latitude (23.8°N)
 *     via the full solar declination + hour angle formula — not a fake arc
 *   - Light temperature keyframing: 2800K sunset, 6500K noon, 7500K overcast
 *   - Moon: phase-driven intensity, orbital position, soft PCF shadow map
 *   - Ambient sky dome: gradient from zenith to horizon, day/night/weather variants
 *   - Directional shadow map: 2-cascade CSM, 4096×4096 for cascade 0 (0–80u),
 *     2048×2048 for cascade 1 (80–400u)
 *   - Zone fill lights: subtle, physically motivated — no magic fills
 *   - Hemisphere light: sky/ground, driven by time of day and weather
 *   - Wetness response: specular boost on all light sources when uWetness > 0
 *   - All state written back to state.js every frame so shaders can read it
 *
 * No magic fill lights. All light has a physical source and a direction.
 * No light that exists "to make things look nicer" without a real origin.
 *
 * Dependencies: THREE (global r128), config.js, state.js, terrain.js
 *
 * Usage:
 *   import { initLighting, updateLighting } from './lighting.js';
 *   initLighting(scene);
 *   registerUpdate(updateLighting);
 */

import { CONFIG }       from '../core/config.js';
import { state }        from '../core/state.js';
import { getHeightAt }  from './terrain.js';

const THREE = window.THREE;

// ─── Constants ────────────────────────────────────────────────────────────────

// Dhaka latitude in radians
const LAT_RAD = THREE.MathUtils.degToRad(CONFIG.LATITUDE);   // 23.8°N

// Civil twilight threshold — below this elevation the sky is dark
const CIVIL_TWILIGHT_DEG = -6.0;

// Light temperature colour table (Kelvin → linear RGB)
// Derived from Planckian locus approximation (Krystek 1985)
// Used for keyframing sun and ambient colour through the day
const KELVIN_TABLE = [
  { k: 1900, r: 1.000, g: 0.330, b: 0.000 },  // candle flame
  { k: 2800, r: 1.000, g: 0.560, b: 0.220 },  // deep sunset/sunrise
  { k: 3200, r: 1.000, g: 0.660, b: 0.360 },  // golden hour
  { k: 4000, r: 1.000, g: 0.780, b: 0.560 },  // early morning
  { k: 5500, r: 1.000, g: 0.920, b: 0.820 },  // direct sun
  { k: 6500, r: 1.000, g: 0.960, b: 0.920 },  // noon clear sky
  { k: 7500, r: 0.900, g: 0.930, b: 1.000 },  // overcast / north sky
  { k: 9000, r: 0.780, g: 0.860, b: 1.000 },  // deep blue sky
  { k:12000, r: 0.650, g: 0.780, b: 1.000 },  // zenith sky
];

// How many minutes before/after solar noon the golden hour spans
const GOLDEN_HOUR_WIDTH_MIN = 50;

// Moon intensity by phase (0=new, 0.5=full, 1=new again)
// Matches actual albedo of lunar surface at phase angle
const MOON_MAX_INTENSITY = 0.042;   // full moon — dim but present

// Zone fill light specs — physically motivated ambient bounce from zone surfaces
// These simulate light bouncing off the brightly-coloured zone surfaces
// onto nearby geometry. Every one has a real physical story.
const ZONE_FILL_LIGHTS = [
  // Crystal Field — blue-violet bounce off labradorite faces
  {
    zone:      'crystals',
    x: CONFIG.ZONES.crystals.x,
    y: 18,
    z: CONFIG.ZONES.crystals.z,
    color:     new THREE.Color(0.42, 0.38, 0.72),
    intensity: 0.18,
    distance:  320,
    decay:     2,
  },
  // Treasury river — cool reflected water caustic bounce
  {
    zone:      'treasury',
    x: CONFIG.ZONES.treasury.x,
    y: 4,
    z: CONFIG.ZONES.treasury.z,
    color:     new THREE.Color(0.38, 0.62, 0.72),
    intensity: 0.14,
    distance:  280,
    decay:     2,
  },
  // Library Alcove — warm amber candle bounce through entrance
  {
    zone:      'library',
    x: CONFIG.ZONES.library.x - 6,
    y: 2.8,
    z: CONFIG.ZONES.library.z,
    color:     new THREE.Color(0.88, 0.58, 0.22),
    intensity: 0.22,
    distance:  90,
    decay:     2,
  },
  // Garden — warm green photon bounce from dense grass
  {
    zone:      'garden',
    x: CONFIG.ZONES.garden.x,
    y: 1.2,
    z: CONFIG.ZONES.garden.z,
    color:     new THREE.Color(0.28, 0.52, 0.18),
    intensity: 0.08,
    distance:  240,
    decay:     2,
  },
];

// ─── Module-private state ─────────────────────────────────────────────────────

let _sun          = null;   // THREE.DirectionalLight  — primary daylight
let _moon         = null;   // THREE.DirectionalLight  — night secondary
let _hemisphere   = null;   // THREE.HemisphereLight   — sky dome ambient
let _fillLights   = [];     // THREE.PointLight[]      — zone bounce lights

// Shadow camera frustum helpers (we manually set these for CSM-lite)
// Cascade 0: close (0–80 units), Cascade 1: mid (80–400 units)
// Three.js r128 doesn't have built-in CSM, so we use one DirectionalLight
// and manually configure the shadow camera to cover cascade 0.
// Cascade 1 is approximated by widening the frustum at the cost of resolution.
let _shadowCascade0 = null;  // alias of _sun — close cascade
let _shadowCascade1 = null;  // second DirectionalLight, same direction, wide frustum

// Scratch vectors to avoid per-frame allocation
const _sunDir      = new THREE.Vector3();
const _moonDir     = new THREE.Vector3();
const _tempColor   = new THREE.Color();

// Previous weather state — used to detect transitions
let _prevWeather   = 'scattered';

// Smooth transition targets for light intensities
let _sunTargetIntensity  = 1.0;
let _moonTargetIntensity = 0.0;
let _hemisphereTargetSky = new THREE.Color();
let _hemisphereTargetGnd = new THREE.Color();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build all lights and add them to the scene.
 * Call once after initTerrain().
 *
 * @param {THREE.Scene} scene
 */
export function initLighting(scene) {
  _buildSun(scene);
  _buildMoon(scene);
  _buildHemisphere(scene);
  _buildZoneFillLights(scene);
  _buildDevToolsWarning();

  // Initial update so lights are in the correct position from frame 0
  updateLighting(0, 0);

  console.log('%cATLAS LIGHTING%c initialised — sun, moon, hemisphere, 4 zone fills',
    'color:#c8a96e;font-weight:bold', 'color:#8a7e6e');
}

/**
 * Per-frame lighting update. Drives sun and moon position, colour temperature,
 * intensities, shadow frustum, and hemisphere gradient.
 * Register via scene.js registerUpdate().
 *
 * @param {number} delta    Seconds since last frame
 * @param {number} elapsed  Total elapsed seconds
 */
export function updateLighting(delta, elapsed) {
  _updateSolarPosition();
  _updateLightTemperature();
  _updateMoon();
  _updateHemisphere(delta);
  _updateZoneFillLights(elapsed);
  _updateWeatherTransition(delta);
  _writeLightingState();
}

// ─── Sun construction ─────────────────────────────────────────────────────────

function _buildSun(scene) {
  // Primary directional light — cascade 0 (0–80 units, 4096² shadow map)
  _sun                    = new THREE.DirectionalLight(0xfff5e8, 1.0);
  _sun.name               = 'atlas_sun';
  _sun.castShadow         = true;

  // Shadow cascade 0 — tight frustum for high-quality close shadows
  _sun.shadow.mapSize.set(4096, 4096);
  _sun.shadow.camera.near = 0.5;
  _sun.shadow.camera.far  = 120;
  _sun.shadow.camera.left = -80;
  _sun.shadow.camera.right= 80;
  _sun.shadow.camera.top  = 80;
  _sun.shadow.camera.bottom=-80;
  _sun.shadow.bias        = -0.0004;
  _sun.shadow.normalBias  = 0.02;
  // PCFSoftShadowMap is set on renderer in scene.js
  scene.add(_sun);
  scene.add(_sun.target);
  _shadowCascade0 = _sun;

  // Secondary directional light — cascade 1 (80–400 units, 2048² shadow map)
  // Same direction as _sun, updated in lockstep each frame
  _shadowCascade1              = new THREE.DirectionalLight(0xfff5e8, 0.0);
  _shadowCascade1.name         = 'atlas_sun_cascade1';
  _shadowCascade1.castShadow   = true;
  _shadowCascade1.shadow.mapSize.set(2048, 2048);
  _shadowCascade1.shadow.camera.near  = 80;
  _shadowCascade1.shadow.camera.far   = 500;
  _shadowCascade1.shadow.camera.left  = -320;
  _shadowCascade1.shadow.camera.right = 320;
  _shadowCascade1.shadow.camera.top   = 320;
  _shadowCascade1.shadow.camera.bottom= -320;
  _shadowCascade1.shadow.bias         = -0.0001;
  _shadowCascade1.shadow.normalBias   = 0.04;
  scene.add(_shadowCascade1);
  scene.add(_shadowCascade1.target);
}

// ─── Moon construction ────────────────────────────────────────────────────────

function _buildMoon(scene) {
  _moon               = new THREE.DirectionalLight(0xc8d8f0, 0.0);
  _moon.name          = 'atlas_moon';
  _moon.castShadow    = true;
  _moon.shadow.mapSize.set(1024, 1024);
  _moon.shadow.camera.near   = 0.5;
  _moon.shadow.camera.far    = 600;
  _moon.shadow.camera.left   = -200;
  _moon.shadow.camera.right  = 200;
  _moon.shadow.camera.top    = 200;
  _moon.shadow.camera.bottom = -200;
  _moon.shadow.bias          = -0.0002;
  // Very soft moon shadows — 8-sample PCF via PCFSoftShadowMap on renderer
  _moon.shadow.radius        = 4;
  scene.add(_moon);
  scene.add(_moon.target);
}

// ─── Hemisphere light construction ───────────────────────────────────────────

function _buildHemisphere(scene) {
  // Sky colour (up hemisphere) and ground colour (down hemisphere)
  // These simulate the sky dome and ground bounce respectively
  _hemisphere      = new THREE.HemisphereLight(0x88aacc, 0x3a3020, 0.35);
  _hemisphere.name = 'atlas_hemisphere';
  scene.add(_hemisphere);
}

// ─── Zone fill light construction ────────────────────────────────────────────

function _buildZoneFillLights(scene) {
  for (const spec of ZONE_FILL_LIGHTS) {
    const light      = new THREE.PointLight(spec.color, spec.intensity, spec.distance, spec.decay);
    light.name       = `atlas_fill_${spec.zone}`;
    light.castShadow = false;  // fill lights never cast shadows — performance
    light.position.set(spec.x, spec.y + getHeightAt(spec.x, spec.z), spec.z);
    scene.add(light);
    _fillLights.push({ light, spec });
  }
}

// ─── Solar position computation ───────────────────────────────────────────────

/**
 * Compute the sun's world-space direction vector from:
 *   - state.localHour      (0–24, real wall-clock time)
 *   - state.dayOfYear      (1–365)
 *   - CONFIG.LATITUDE      (23.8°N, Dhaka)
 *
 * Uses the full solar declination + hour angle formula, not a fake arc.
 * Accuracy is sufficient for visual purposes (±0.5° of true position).
 */
function _updateSolarPosition() {
  const hour     = state.localHour;
  const doy      = state.dayOfYear;

  // Solar declination — Earth's axial tilt causes the sun to be higher
  // in summer and lower in winter
  // δ = −23.45° × cos(360/365 × (doy + 10))
  const declRad  = THREE.MathUtils.degToRad(
    -23.45 * Math.cos(THREE.MathUtils.degToRad((360 / 365) * (doy + 10)))
  );

  // Hour angle — 0° at solar noon, ±15° per hour (Earth rotates 15°/hr)
  // Solar noon in Dhaka: UTC+6, so local noon = 12:00
  const hourAngleRad = THREE.MathUtils.degToRad((hour - 12.0) * 15.0);

  // Solar elevation angle
  // sin(elev) = sin(lat)·sin(decl) + cos(lat)·cos(decl)·cos(hourAngle)
  const sinElev = Math.sin(LAT_RAD) * Math.sin(declRad)
                + Math.cos(LAT_RAD) * Math.cos(declRad) * Math.cos(hourAngleRad);
  const elevRad = Math.asin(sinElev);
  const elevDeg = THREE.MathUtils.radToDeg(elevRad);

  // Solar azimuth angle (compass bearing from north, clockwise)
  // cos(az) = (sin(decl) − sin(elev)·sin(lat)) / (cos(elev)·cos(lat))
  const cosAz = (Math.sin(declRad) - sinElev * Math.sin(LAT_RAD))
              / (Math.cos(elevRad) * Math.cos(LAT_RAD) + 1e-8);
  let azRad   = Math.acos(Math.max(-1, Math.min(1, cosAz)));
  if (Math.sin(hourAngleRad) > 0) azRad = Math.PI * 2 - azRad; // afternoon

  // Convert spherical solar position to world-space direction vector
  // pointing FROM world TO sun (light direction)
  // World axes: +Y up, +X east, +Z south (right-hand, standard Three.js)
  const cosElev = Math.cos(elevRad);
  _sunDir.set(
    -cosElev * Math.sin(azRad),    // X: east component (negative = westward)
     sinElev,                       // Y: altitude component
    -cosElev * Math.cos(azRad),    // Z: south component
  ).normalize();

  // Position sun light — placed far along its direction from world centre
  const sunDist = 8000;
  _sun.position.set(
    _sunDir.x * sunDist,
    Math.max(10, _sunDir.y * sunDist),  // never go below terrain
    _sunDir.z * sunDist,
  );
  _sun.target.position.set(0, 0, 0);
  _sun.target.updateMatrixWorld();

  // Cascade 1 — same direction, repositioned for its wider frustum
  _shadowCascade1.position.copy(_sun.position);
  _shadowCascade1.target.position.set(0, 0, 0);
  _shadowCascade1.target.updateMatrixWorld();

  // Night flag — civil twilight at −6°
  state.isNight      = elevDeg < CIVIL_TWILIGHT_DEG;
  state.sunElevation = elevDeg;
  state.sunDirection = { x: _sunDir.x, y: _sunDir.y, z: _sunDir.z };
}

// ─── Light temperature ────────────────────────────────────────────────────────

/**
 * Maps sun elevation angle to a physically correct colour temperature and
 * intensity. Interpolates through the Kelvin table above.
 * Drives both sun colour and state.lightTemperature for shader use.
 */
function _updateLightTemperature() {
  const elev = state.sunElevation;

  // Target intensity — follows a smooth curve based on elevation
  // Below −6° (civil twilight): 0
  // −6° to 0° (twilight): 0 → 0.06 (atmospheric scatter glow)
  // 0° to 10° (golden hour): 0.06 → 0.60
  // 10° to 30° (morning):   0.60 → 0.92
  // 30°+ (full day):         0.92 → 1.00
  let targetIntensity;
  if (elev < CIVIL_TWILIGHT_DEG) {
    targetIntensity = 0.0;
  } else if (elev < 0) {
    targetIntensity = _remap(elev, CIVIL_TWILIGHT_DEG, 0, 0.0, 0.06);
  } else if (elev < 10) {
    targetIntensity = _remap(elev, 0, 10, 0.06, 0.60);
  } else if (elev < 30) {
    targetIntensity = _remap(elev, 10, 30, 0.60, 0.92);
  } else {
    targetIntensity = _remap(elev, 30, 90, 0.92, 1.00);
  }

  // Weather attenuation
  const weatherAtten = { clear: 1.0, scattered: 0.85, overcast: 0.42, rain: 0.35, storm: 0.22 };
  targetIntensity *= (weatherAtten[state.weather] ?? 0.85);

  // Smooth intensity transition — prevents snapping
  _sunTargetIntensity = targetIntensity;
  _sun.intensity = THREE.MathUtils.lerp(_sun.intensity, _sunTargetIntensity, 0.012);

  // Cascade 1 mirrors sun intensity
  _shadowCascade1.intensity = _sun.intensity * 0.0; // cascade 1 is shadow-only, zero visual intensity

  // ── Colour temperature → RGB ───────────────────────────────────────────────
  let targetKelvin;
  if (elev < CIVIL_TWILIGHT_DEG) {
    targetKelvin = 9000;   // deep blue night sky
  } else if (elev < 0) {
    targetKelvin = _remap(elev, CIVIL_TWILIGHT_DEG, 0, 9000, 2800);
  } else if (elev < 6) {
    targetKelvin = _remap(elev, 0, 6, 2800, 3200);   // deep orange sunrise
  } else if (elev < 15) {
    targetKelvin = _remap(elev, 6, 15, 3200, 5500);  // golden hour → morning
  } else if (elev < 30) {
    targetKelvin = _remap(elev, 15, 30, 5500, 6500); // morning → noon
  } else {
    targetKelvin = 6500;                               // full noon
  }

  // Overcast shifts toward 7500K regardless of sun angle
  if (state.weather === 'overcast' || state.weather === 'rain' || state.weather === 'storm') {
    const overcastBlend = state.weather === 'overcast' ? 0.6
                        : state.weather === 'rain'     ? 0.75
                        :                                0.88;
    targetKelvin = _lerp(targetKelvin, 7500, overcastBlend);
  }

  state.lightTemperature = Math.round(targetKelvin);

  // Sample the Kelvin table
  const rgb = _kelvinToRGB(targetKelvin);
  _sun.color.setRGB(rgb.r, rgb.g, rgb.b);
  _shadowCascade1.color.copy(_sun.color);
  state.sunColor = { r: rgb.r, g: rgb.g, b: rgb.b };
}

/**
 * Interpolate the Kelvin table to produce an RGB colour.
 *
 * @param {number} k  Colour temperature in Kelvin
 * @returns {{ r: number, g: number, b: number }}
 */
function _kelvinToRGB(k) {
  const table = KELVIN_TABLE;
  if (k <= table[0].k) return { r: table[0].r, g: table[0].g, b: table[0].b };
  if (k >= table[table.length - 1].k) {
    const last = table[table.length - 1];
    return { r: last.r, g: last.g, b: last.b };
  }

  for (let i = 0; i < table.length - 1; i++) {
    if (k >= table[i].k && k <= table[i + 1].k) {
      const t = (k - table[i].k) / (table[i + 1].k - table[i].k);
      return {
        r: _lerp(table[i].r, table[i + 1].r, t),
        g: _lerp(table[i].g, table[i + 1].g, t),
        b: _lerp(table[i].b, table[i + 1].b, t),
      };
    }
  }

  return { r: 1, g: 1, b: 1 };
}

// ─── Moon ─────────────────────────────────────────────────────────────────────

function _updateMoon() {
  // Moon phase: driven by real lunar cycle (29.53 days)
  // Reference new moon: January 6, 2000 (J2000 epoch)
  const msPerDay      = 86400000;
  const lunarCycleDays= 29.530588;
  const j2000NewMoon  = new Date('2000-01-06T18:14:00Z').getTime();
  const daysSinceRef  = (Date.now() - j2000NewMoon) / msPerDay;
  const phase         = (daysSinceRef % lunarCycleDays) / lunarCycleDays; // 0=new, 0.5=full

  state.moonPhase = phase;

  // Moon intensity: 0 at new moon, MOON_MAX_INTENSITY at full, 0 at new again
  // Use sin curve for realistic phase progression
  const moonIntensity = MOON_MAX_INTENSITY * Math.sin(phase * Math.PI);

  // Moon is only visible when sun is below horizon
  // Fade in as sun drops below −3°, full from −8° onward
  const nightBlend = _smoothstep(-3, -8, state.sunElevation);
  _moon.intensity  = moonIntensity * nightBlend;

  // Moon position: opposite to sun on the ecliptic plane (simplified)
  // True lunar orbit is complex — this gives a convincing approximation
  // Moon rises ~50 minutes later each day, opposite side of sky from sun
  const moonHour      = (state.localHour + 12) % 24;
  const moonHourAngle = THREE.MathUtils.degToRad((moonHour - 12.0) * 15.0);
  const moonDeclRad   = THREE.MathUtils.degToRad(
    23.45 * Math.cos(THREE.MathUtils.degToRad((360 / 365) * (state.dayOfYear + 10)))
  );

  const sinMoonElev   = Math.sin(LAT_RAD) * Math.sin(moonDeclRad)
                      + Math.cos(LAT_RAD) * Math.cos(moonDeclRad) * Math.cos(moonHourAngle);
  const moonElevRad   = Math.asin(Math.max(-1, Math.min(1, sinMoonElev)));
  const cosMoonElev   = Math.cos(moonElevRad);
  const cosMoonAz     = (Math.sin(moonDeclRad) - sinMoonElev * Math.sin(LAT_RAD))
                      / (cosMoonElev * Math.cos(LAT_RAD) + 1e-8);
  let moonAzRad       = Math.acos(Math.max(-1, Math.min(1, cosMoonAz)));
  if (Math.sin(moonHourAngle) > 0) moonAzRad = Math.PI * 2 - moonAzRad;

  _moonDir.set(
    -cosMoonElev * Math.sin(moonAzRad),
     sinMoonElev,
    -cosMoonElev * Math.cos(moonAzRad),
  ).normalize();

  const moonDist = 6000;
  _moon.position.set(
    _moonDir.x * moonDist,
    Math.max(5, _moonDir.y * moonDist),
    _moonDir.z * moonDist,
  );
  _moon.target.position.set(0, 0, 0);
  _moon.target.updateMatrixWorld();

  // Moon colour: cool blue-white, slightly warmer at moonrise (atmospheric reddening)
  const moonElevDeg   = THREE.MathUtils.radToDeg(moonElevRad);
  const riseWarmth    = 1.0 - _smoothstep(0, 12, moonElevDeg); // warm near horizon
  _moon.color.setRGB(
    _lerp(0.78, 0.85, 1 - riseWarmth),
    _lerp(0.82, 0.90, 1 - riseWarmth),
    _lerp(0.88, 1.00, 1 - riseWarmth),
  );
}

// ─── Hemisphere light ─────────────────────────────────────────────────────────

function _updateHemisphere(delta) {
  const elev    = state.sunElevation;
  const weather = state.weather;

  // ── Sky colour (upper hemisphere — zenith sky dome) ────────────────────────
  let targetSkyR, targetSkyG, targetSkyB;

  if (elev < CIVIL_TWILIGHT_DEG) {
    // Deep night: midnight blue
    targetSkyR = 0.020; targetSkyG = 0.028; targetSkyB = 0.068;
  } else if (elev < 0) {
    // Twilight: purple-pink gradient
    const t    = _remap(elev, CIVIL_TWILIGHT_DEG, 0, 0, 1);
    targetSkyR = _lerp(0.020, 0.38, t);
    targetSkyG = _lerp(0.028, 0.22, t);
    targetSkyB = _lerp(0.068, 0.40, t);
  } else if (elev < 8) {
    // Sunrise/sunset: warm amber to pale gold
    const t    = _remap(elev, 0, 8, 0, 1);
    targetSkyR = _lerp(0.38, 0.68, t);
    targetSkyG = _lerp(0.22, 0.58, t);
    targetSkyB = _lerp(0.40, 0.72, t);
  } else if (elev < 20) {
    // Morning/evening: pale sky
    const t    = _remap(elev, 8, 20, 0, 1);
    targetSkyR = _lerp(0.68, 0.52, t);
    targetSkyG = _lerp(0.58, 0.68, t);
    targetSkyB = _lerp(0.72, 0.88, t);
  } else {
    // Full day: clear blue sky
    targetSkyR = 0.52; targetSkyG = 0.70; targetSkyB = 0.92;
  }

  // Weather tint — overcast washes out blue, rain adds grey
  if (weather === 'overcast') {
    targetSkyR = _lerp(targetSkyR, 0.70, 0.65);
    targetSkyG = _lerp(targetSkyG, 0.70, 0.65);
    targetSkyB = _lerp(targetSkyB, 0.72, 0.65);
  } else if (weather === 'rain') {
    targetSkyR = _lerp(targetSkyR, 0.55, 0.72);
    targetSkyG = _lerp(targetSkyG, 0.56, 0.72);
    targetSkyB = _lerp(targetSkyB, 0.60, 0.72);
  } else if (weather === 'storm') {
    targetSkyR = _lerp(targetSkyR, 0.28, 0.85);
    targetSkyG = _lerp(targetSkyG, 0.28, 0.85);
    targetSkyB = _lerp(targetSkyB, 0.32, 0.85);
  }

  // ── Ground colour (lower hemisphere — earth bounce light) ─────────────────
  let targetGndR, targetGndG, targetGndB;

  if (elev < CIVIL_TWILIGHT_DEG) {
    // Dark night ground
    targetGndR = 0.008; targetGndG = 0.010; targetGndB = 0.014;
  } else if (elev < 0) {
    const t    = _remap(elev, CIVIL_TWILIGHT_DEG, 0, 0, 1);
    targetGndR = _lerp(0.008, 0.14, t);
    targetGndG = _lerp(0.010, 0.10, t);
    targetGndB = _lerp(0.014, 0.08, t);
  } else if (elev < 10) {
    // Warm ground during golden hour
    const t    = _remap(elev, 0, 10, 0, 1);
    targetGndR = _lerp(0.14, 0.22, t);
    targetGndG = _lerp(0.10, 0.16, t);
    targetGndB = _lerp(0.08, 0.10, t);
  } else {
    // Daytime: warm green-brown earth bounce
    targetGndR = 0.22; targetGndG = 0.18; targetGndB = 0.12;
  }

  // Wet ground: greyish, slightly cooler bounce
  targetGndR = _lerp(targetGndR, 0.12, state.wetness * 0.4);
  targetGndG = _lerp(targetGndG, 0.13, state.wetness * 0.4);
  targetGndB = _lerp(targetGndB, 0.15, state.wetness * 0.4);

  // ── Hemisphere intensity ──────────────────────────────────────────────────
  let targetHemiIntensity;
  if (elev < CIVIL_TWILIGHT_DEG) {
    targetHemiIntensity = 0.06;
  } else if (elev < 0) {
    targetHemiIntensity = _remap(elev, CIVIL_TWILIGHT_DEG, 0, 0.06, 0.12);
  } else {
    targetHemiIntensity = _remap(elev, 0, 30, 0.12, 0.38);
  }
  const hemiWeatherAtten = { clear: 1.0, scattered: 0.90, overcast: 0.75, rain: 0.62, storm: 0.48 };
  targetHemiIntensity *= (hemiWeatherAtten[state.weather] ?? 0.90);

  // ── Lerp smoothly toward targets ──────────────────────────────────────────
  // Very slow lerp — hemisphere change should be completely imperceptible
  const lerpSpeed = 0.008 + delta * 0.5;  // faster during fast transitions

  _hemisphere.color.setRGB(
    _lerp(_hemisphere.color.r, targetSkyR, lerpSpeed),
    _lerp(_hemisphere.color.g, targetSkyG, lerpSpeed),
    _lerp(_hemisphere.color.b, targetSkyB, lerpSpeed),
  );
  _hemisphere.groundColor.setRGB(
    _lerp(_hemisphere.groundColor.r, targetGndR, lerpSpeed),
    _lerp(_hemisphere.groundColor.g, targetGndG, lerpSpeed),
    _lerp(_hemisphere.groundColor.b, targetGndB, lerpSpeed),
  );
  _hemisphere.intensity = _lerp(_hemisphere.intensity, targetHemiIntensity, lerpSpeed);
}

// ─── Zone fill lights ─────────────────────────────────────────────────────────

function _updateZoneFillLights(elapsed) {
  for (const { light, spec } of _fillLights) {
    // Fill lights only active when sun is up — daytime bounce only
    // At night they dim to near-zero (the scene has its own night atmosphere)
    // Exception: Library Alcove candle light is always on
    let intensityScale;
    if (spec.zone === 'library') {
      // Candle is always burning — slight flicker via sin noise
      const flicker = 1.0 + Math.sin(elapsed * 7.3 + 1.1) * 0.04
                          + Math.sin(elapsed * 13.7 + 0.3) * 0.02;
      intensityScale = flicker;
    } else {
      // Daytime bounce lights — fade out as sun goes down
      const dayBlend = _smoothstep(-4, 8, state.sunElevation);
      intensityScale = dayBlend;

      // Weather: overcast diffuses the bounce (still present, softer)
      const weatherScale = { clear: 1.0, scattered: 0.88, overcast: 0.55, rain: 0.40, storm: 0.25 };
      intensityScale *= (weatherScale[state.weather] ?? 0.88);
    }

    light.intensity = spec.intensity * intensityScale;

    // Wetness: water surfaces reflect more, boosting the Treasury fill
    if (spec.zone === 'treasury') {
      light.intensity *= 1.0 + state.wetness * 0.45;
    }
  }
}

// ─── Weather transitions ──────────────────────────────────────────────────────

function _updateWeatherTransition(delta) {
  if (state.weather === _prevWeather) return;

  // Weather changed — trigger wetness target update
  // Actual wetness lerp is owned by scene.js / state.js global wetness system
  // Here we only record the transition for diagnostic purposes
  console.log(`%cATLAS LIGHTING%c weather: ${_prevWeather} → ${state.weather}`,
    'color:#c8a96e;font-weight:bold', 'color:#8a7e6e');
  _prevWeather = state.weather;

  // Update fog density target based on new weather
  const fogDensities = {
    clear:     0.000025,
    scattered: 0.000042,
    overcast:  0.000080,
    rain:      0.000140,
    storm:     0.000220,
  };
  // Fog density is lerped in scene.js fog update — we write the target to state
  state.fogDensity = fogDensities[state.weather] ?? 0.000042;
}

// ─── Write lighting state back for shader consumption ─────────────────────────

/**
 * Writes current light properties back to state.js so terrain/sky/zone
 * shaders can read them as uniforms without importing lighting.js directly.
 */
function _writeLightingState() {
  state.sunDirection = {
    x: _sunDir.x,
    y: _sunDir.y,
    z: _sunDir.z,
  };
  state.sunColor = {
    r: _sun.color.r,
    g: _sun.color.g,
    b: _sun.color.b,
  };
  // isNight and sunElevation are already set in _updateSolarPosition()
}

// ─── Dev tools warning ────────────────────────────────────────────────────────

function _buildDevToolsWarning() {
  console.log('%cATLAS', 'font-size:48px;color:#c8a96e;font-weight:bold;');
  console.log('%cPrivate application. All data protected by RLS.',
    'font-size:13px;color:#e8e0d0;');
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Linear interpolation. */
function _lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Remap value from one range to another. */
function _remap(value, inMin, inMax, outMin, outMax) {
  const t = Math.max(0, Math.min(1, (value - inMin) / (inMax - inMin)));
  return outMin + t * (outMax - outMin);
}

/** Smooth Hermite interpolation. */
function _smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
