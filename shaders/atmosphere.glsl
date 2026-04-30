/**
 * atmosphere.glsl — Physically-based atmospheric scattering sky dome
 * Atlas: The Living World
 *
 * Implements a Bruneton-inspired single-scattering atmosphere model rendered
 * on a full-sky dome mesh.  Rayleigh and Mie scattering are computed
 * analytically along each view ray with numerical integration (8 primary
 * samples × 4 transmittance samples per step).  The result drives all
 * sky-colour, horizon-haze, and aerial-perspective effects.
 *
 * Calibrated for Dhaka, Bangladesh (23.8 °N latitude).  The sun declination
 * and azimuth are set each frame by sky.js based on state.localHour and
 * state.dayOfYear — they arrive here as uSunDirection.
 *
 * This file contains both vertex and fragment shaders separated by the
 * sentinel comment lines that sky.js uses to split the source string:
 *   // === VERTEX ===
 *   // === FRAGMENT ===
 *
 * ─── Uniforms (vertex) ─────────────────────────────────────────────────────
 *   (none beyond built-ins — all interpolation done in fragment)
 *
 * ─── Uniforms (fragment) ───────────────────────────────────────────────────
 *   uSunDirection    vec3    Normalised world-space direction toward the sun
 *   uSunIntensity    float   Solar irradiance scale (default 22.0)
 *   uRayleighCoeff   vec3    Rayleigh scattering coefficients (per wavelength)
 *   uMieCoeff        float   Mie scattering coefficient
 *   uMieDirectional  float   Mie directional g parameter (0.76)
 *   uPlanetRadius    float   Earth radius in km (6371.0)
 *   uAtmosRadius     float   Atmosphere top radius in km (6471.0)
 *   uRayleighScale   float   Rayleigh scale height km (8.0)
 *   uMieScale        float   Mie scale height km (1.2)
 *   uTime            float   Elapsed seconds — drives star twinkle
 *   uStarSeed        float   Per-star random seed texture not used here;
 *                            stars rendered as a separate pass in sky.js
 *   uMoonDirection   vec3    Normalised direction toward moon
 *   uMoonPhase       float   0 (new) → 0.5 (full) → 1 (new)
 *   uExposure        float   HDR exposure before passing to composite
 *   uWetness         float   Global wetness (not used by sky, kept for parity)
 *   uWeather         int     0 clear · 1 scattered · 2 overcast · 3 rain · 4 storm
 *   uCloudCoverage   float   0–1, blended with weather state
 *   uHorizonHaze     float   Additional haze near horizon (fog, humidity)
 *   uAerialDensity   float   Aerial-perspective strength for distant terrain
 *
 * ─── Varyings ──────────────────────────────────────────────────────────────
 *   vWorldDir   vec3   Normalised ray direction from camera through this fragment
 *   vUv         vec2   UV on sky dome (for procedural moon disc sampling)
 */

// === VERTEX ===

precision highp float;

varying vec3 vWorldDir;
varying vec2 vUv;

void main() {
  // The sky dome is a large sphere centred at origin in local space.
  // Passing position directly gives the ray direction after normalisation in frag.
  vWorldDir = normalize(position);
  vUv       = uv;

  // Keep the dome rendered at maximum depth so it sits behind everything.
  // We write gl_Position with w == z so the depth always evaluates to 1.0.
  vec4 mvp  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = mvp.xyww;
}


// === FRAGMENT ===

precision highp float;

// ─── Uniforms ──────────────────────────────────────────────────────────────────

uniform vec3  uSunDirection;     // normalised, world-space, points toward sun
uniform float uSunIntensity;     // 22.0 nominal
uniform vec3  uRayleighCoeff;    // (5.802e-6, 13.558e-6, 33.1e-6) m^-1
uniform float uMieCoeff;         // 21e-6 m^-1
uniform float uMieDirectional;   // 0.76
uniform float uPlanetRadius;     // 6371000.0 m
uniform float uAtmosRadius;      // 6471000.0 m
uniform float uRayleighScale;    // 8000.0 m  (scale height)
uniform float uMieScale;         // 1200.0 m  (scale height)
uniform float uTime;             // elapsed seconds
uniform vec3  uMoonDirection;    // normalised
uniform float uMoonPhase;        // 0–1
uniform float uExposure;         // composite pass exposure mirror
uniform int   uWeather;          // 0–4
uniform float uCloudCoverage;    // 0–1
uniform float uHorizonHaze;      // 0–1
uniform float uAerialDensity;    // 0–1

// ─── Varyings ──────────────────────────────────────────────────────────────────

varying vec3 vWorldDir;
varying vec2 vUv;

// ─── Constants ─────────────────────────────────────────────────────────────────

const float PI     = 3.14159265358979323846;
const float TWO_PI = 6.28318530717958647692;
const int   PRIMARY_STEPS        = 8;   // ray march steps along view ray
const int   TRANSMITTANCE_STEPS  = 4;   // steps toward sun per primary sample

// ─── Utility: ray–sphere intersection ──────────────────────────────────────────
//
// Returns the two t-values where the ray (orig + t * dir) intersects a sphere
// of radius r centred at origin.  Returns vec2(-1.0) on miss.

vec2 raySphere(vec3 orig, vec3 dir, float r) {
  float a = dot(dir, dir);
  float b = 2.0 * dot(orig, dir);
  float c = dot(orig, orig) - r * r;
  float d = b * b - 4.0 * a * c;
  if (d < 0.0) return vec2(-1.0);
  float sq = sqrt(d);
  return vec2((-b - sq) / (2.0 * a),
              (-b + sq) / (2.0 * a));
}

// ─── Density functions (Rayleigh and Mie) ──────────────────────────────────────
//
// Exponential decay with altitude above planet surface.

float densityRayleigh(float h) {
  return exp(-h / uRayleighScale);
}

float densityMie(float h) {
  return exp(-h / uMieScale);
}

// ─── Phase functions ───────────────────────────────────────────────────────────

// Rayleigh phase — rotationally symmetric around scattering angle.
float phaseRayleigh(float cosTheta) {
  return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

// Henyey–Greenstein Mie phase — forward-peaked, g = uMieDirectional.
float phaseMie(float cosTheta) {
  float g  = uMieDirectional;
  float g2 = g * g;
  float num = (1.0 - g2) * (1.0 + cosTheta * cosTheta);
  float den = (2.0 + g2) * pow(abs(1.0 + g2 - 2.0 * g * cosTheta), 1.5);
  return (3.0 / (8.0 * PI)) * (num / max(den, 1e-7));
}

// ─── Transmittance (optical depth toward the sun) ──────────────────────────────
//
// Marches 'TRANSMITTANCE_STEPS' steps from 'pos' toward the sun and
// integrates the optical depth.  Returns extinction vec3 (Rayleigh + Mie).

vec2 opticalDepthToSun(vec3 pos, vec3 sunDir) {
  vec2 atmos = raySphere(pos, sunDir, uAtmosRadius);
  if (atmos.x < 0.0 && atmos.y < 0.0) return vec2(0.0);
  float tMax    = max(atmos.y, 0.0);
  float stepLen = tMax / float(TRANSMITTANCE_STEPS);
  float odR     = 0.0;
  float odM     = 0.0;

  for (int i = 0; i < TRANSMITTANCE_STEPS; i++) {
    vec3  samplePos = pos + sunDir * (stepLen * (float(i) + 0.5));
    float height    = length(samplePos) - uPlanetRadius;
    height          = max(height, 0.0);
    odR += densityRayleigh(height) * stepLen;
    odM += densityMie(height)      * stepLen;
  }

  return vec2(odR, odM);
}

// ─── Main scatter integration ──────────────────────────────────────────────────
//
// Integrates in-scattered light along the view ray from the camera to
// the atmosphere top (or planet surface if ray hits earth).
// Returns HDR RGB colour (linear, no tone mapping).

vec3 scatter(vec3 rayOrigin, vec3 rayDir, vec3 sunDir, float sunIntensity) {

  // Ray vs. atmosphere
  vec2 atmosHit = raySphere(rayOrigin, rayDir, uAtmosRadius);
  if (atmosHit.y < 0.0) return vec3(0.0);  // ray misses atmosphere entirely

  // Ray vs. planet — terminate ray if it hits the ground
  vec2 groundHit = raySphere(rayOrigin, rayDir, uPlanetRadius);
  float tMax = atmosHit.y;
  if (groundHit.x > 0.0) tMax = min(tMax, groundHit.x);
  float tMin = max(atmosHit.x, 0.0);
  if (tMin >= tMax) return vec3(0.0);

  float stepLen = (tMax - tMin) / float(PRIMARY_STEPS);

  // Accumulated optical depth along view ray
  float odViewR = 0.0;
  float odViewM = 0.0;

  // Accumulated in-scatter
  vec3 inScatterR = vec3(0.0);
  vec3 inScatterM = vec3(0.0);

  float cosTheta = dot(rayDir, sunDir);

  for (int i = 0; i < PRIMARY_STEPS; i++) {
    float t         = tMin + stepLen * (float(i) + 0.5);
    vec3  samplePos = rayOrigin + rayDir * t;
    float height    = length(samplePos) - uPlanetRadius;
    height          = max(height, 0.0);

    float dR = densityRayleigh(height) * stepLen;
    float dM = densityMie(height)      * stepLen;
    odViewR += dR;
    odViewM += dM;

    // Transmittance toward sun from this sample
    vec2 odSun = opticalDepthToSun(samplePos, sunDir);

    // Combined optical depth: view + sun
    vec3 tau = uRayleighCoeff * (odViewR + odSun.x)
             + vec3(uMieCoeff * 1.1) * (odViewM + odSun.y);

    // Transmittance (Beer–Lambert law)
    vec3 T = exp(-tau);

    inScatterR += dR * T;
    inScatterM += dM * T;
  }

  vec3 colour = sunIntensity * (
    phaseRayleigh(cosTheta) * uRayleighCoeff * inScatterR
  + phaseMie(cosTheta)      * uMieCoeff      * inScatterM
  );

  return max(colour, vec3(0.0));
}

// ─── Sun disc ─────────────────────────────────────────────────────────────────
//
// Adds a limb-darkened solar disc of angular radius ~0.53°.
// Only contributes when the sun is above −2° (partially below horizon ok).

vec3 sunDisc(vec3 rayDir, vec3 sunDir, vec3 skyColour) {
  float cosAngle   = dot(rayDir, sunDir);
  float sunAngRad  = cos(radians(0.53));          // angular radius of disc

  if (cosAngle < sunAngRad - 0.002) return vec3(0.0);

  // Limb darkening — μ = cos(angle from disc centre)
  float mu     = smoothstep(sunAngRad - 0.002, sunAngRad + 0.001, cosAngle);
  float mu5    = pow(mu, 5.0);
  // Limb darkening coefficients (Eddington approximation)
  float limb   = 1.0 - 0.6 * (1.0 - mu5);

  // Solar colour at Dhaka noon: ~5800 K
  // Colour shifts warmer (lower colour temp) toward horizon as atmosphere reddens
  float elevation  = sunDir.y;                    // sin of elevation angle
  float warmFactor = smoothstep(0.0, 0.15, elevation);
  vec3  sunColour  = mix(
    vec3(1.0, 0.45, 0.12),                        // deep red at horizon
    vec3(1.0, 0.98, 0.92),                        // near-white at noon
    warmFactor
  );

  // Bloom glow halo just outside disc (contributes to atmospheric corona)
  float coronaAngle = smoothstep(sunAngRad * 0.5, sunAngRad * 0.2, abs(cosAngle - 1.0));
  float corona      = pow(max(cosAngle - (sunAngRad - 0.12), 0.0), 8.0) * 0.28;

  return mu * limb * sunColour * uSunIntensity * 0.08
       + sunColour * corona;
}

// ─── Moon disc ────────────────────────────────────────────────────────────────
//
// Renders a simple moon disc with phase-correct illumination.
// Angular radius ~0.52° (nearly same as sun).
// Moon colour: cool grey-white, slightly blue-tinted.

vec3 moonDisc(vec3 rayDir, vec3 moonDir) {
  float cosAngle  = dot(rayDir, moonDir);
  float moonRad   = cos(radians(0.52));
  if (cosAngle < moonRad - 0.001) return vec3(0.0);

  // μ inside disc [0,1]
  float mu = smoothstep(moonRad - 0.001, moonRad + 0.0005, cosAngle);

  // Phase: 0 (new) → 0.5 (full) → 1 (new)
  // Visible illumination is maximum at uMoonPhase = 0.5
  float phase        = 1.0 - abs(uMoonPhase * 2.0 - 1.0);  // 0 (new/new) → 1 (full)
  float moonBright   = phase * 0.045;                        // HDR brightness

  // Simple terminator shadow — the dark side of the moon
  // Uses a tangent-plane approximation: project rayDir onto moonDir's
  // perpendicular plane and compare with phase-driven terminator plane.
  vec3  right        = normalize(cross(moonDir, vec3(0.0, 1.0, 0.0)));
  vec3  up           = cross(right, moonDir);
  float moonU        = dot(rayDir - moonDir * dot(rayDir, moonDir), right);
  float terminator   = smoothstep(
    (uMoonPhase * 2.0 - 1.0) - 0.1,
    (uMoonPhase * 2.0 - 1.0) + 0.1,
    moonU
  );

  // Limb darkening on the moon (subtler than sun)
  float limbM = mix(0.72, 1.0, mu * mu);

  vec3 moonColour = vec3(0.72, 0.74, 0.80) * moonBright * limbM * terminator * mu;
  return moonColour;
}

// ─── Night sky tint ───────────────────────────────────────────────────────────
//
// When sun is below horizon the sky should darken to deep navy/indigo rather
// than pure black, with a subtle gradient — the residual atmospheric glow.

vec3 nightBaseTint(vec3 rayDir) {
  // Zenith: very dark navy.  Horizon: slightly lighter and warmer.
  float horizonMix = smoothstep(0.0, 0.35, 1.0 - abs(rayDir.y));
  vec3  zenith     = vec3(0.002, 0.003, 0.010);
  vec3  horizon    = vec3(0.008, 0.008, 0.018);
  return mix(zenith, horizon, horizonMix);
}

// ─── Horizon haze ─────────────────────────────────────────────────────────────
//
// Adds a soft band of extra scattering near the horizon — simulates
// humidity, dust, and light pollution (Dhaka context).
// uHorizonHaze: 0 = pristine, 1 = maximum smog.

vec3 horizonHaze(vec3 rayDir, vec3 sunDir) {
  float horizon    = smoothstep(0.18, 0.0, abs(rayDir.y));
  // Warm near sun direction, cooler away
  float sunAngle   = max(dot(normalize(vec2(rayDir.x, rayDir.z)),
                             normalize(vec2(sunDir.x, sunDir.z))), 0.0);
  vec3  hazeTint   = mix(
    vec3(0.38, 0.45, 0.55),   // neutral grey haze (away from sun)
    vec3(0.72, 0.52, 0.28),   // warm amber (toward sun)
    pow(sunAngle, 3.0)
  );
  return hazeTint * horizon * uHorizonHaze * 0.35;
}

// ─── Weather overcast layer ───────────────────────────────────────────────────
//
// In overcast / rain / storm modes the upper sky is replaced by a flat
// thick cloud cover.  Achieved by lerping toward a desaturated grey
// proportional to uCloudCoverage.

vec3 applyOvercast(vec3 skyColour, float coverage) {
  float elevation = max(vWorldDir.y, 0.0);
  // Only suppress upper sky — keep horizon tones
  float mask       = smoothstep(0.0, 0.2, elevation);
  float overcastLum = dot(skyColour, vec3(0.2126, 0.7152, 0.0722));
  vec3  overcastGrey = vec3(overcastLum * 0.92, overcastLum * 0.94, overcastLum);
  return mix(skyColour, overcastGrey, coverage * mask * 0.85);
}

// ─── Atmospheric chromatic gradient (zenith) ──────────────────────────────────
//
// Near zenith during daytime the sky is the deepest azure.  This is
// mostly captured by the scatter() integration but we add a subtle
// tint to ensure the deep-blue zenith at solar noon 23.8°N.

vec3 zenithalAzure(vec3 rayDir) {
  float zenith = smoothstep(0.55, 1.0, rayDir.y);
  return vec3(0.0, 0.005, 0.012) * zenith;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

void main() {

  vec3 rayDir = normalize(vWorldDir);

  // Camera origin is at planet surface (uPlanetRadius above centre)
  vec3 rayOrigin = vec3(0.0, uPlanetRadius + 1.72, 0.0);

  // ── Daytime scatter ─────────────────────────────────────────────────────────
  vec3 sky = scatter(rayOrigin, rayDir, normalize(uSunDirection), uSunIntensity);

  // ── Zenith azure correction ─────────────────────────────────────────────────
  sky += zenithalAzure(rayDir);

  // ── Sun disc ────────────────────────────────────────────────────────────────
  // Only render disc when sun is up (or barely below horizon)
  if (uSunDirection.y > -0.04) {
    sky += sunDisc(rayDir, normalize(uSunDirection), sky);
  }

  // ── Moon disc (night) ───────────────────────────────────────────────────────
  // Fade in as sun descends below horizon
  float nightBlend = smoothstep(-0.02, -0.12, uSunDirection.y);
  if (nightBlend > 0.0) {
    sky += moonDisc(rayDir, normalize(uMoonDirection)) * nightBlend;
  }

  // ── Night base tint ─────────────────────────────────────────────────────────
  // As sun sets, lerp scatter result toward the night tint.
  // Use sunElevation sign: at −6° (astronomical twilight) transition complete.
  float nightFactor = smoothstep(0.05, -0.12, uSunDirection.y);
  sky = mix(sky, nightBaseTint(rayDir) + moonDisc(rayDir, normalize(uMoonDirection)),
            nightFactor);

  // ── Horizon haze (always present, modulated by weather / uHorizonHaze) ─────
  sky += horizonHaze(rayDir, normalize(uSunDirection));

  // ── Overcast blending ───────────────────────────────────────────────────────
  sky = applyOvercast(sky, uCloudCoverage);

  // ── Aerial perspective output ───────────────────────────────────────────────
  // sky.js reads the sky colour at the horizon direction for terrain LOD haze.
  // No additional work needed here — composite.glsl applies aerial perspective
  // as a depth-based fog using the fog colour derived from this shader's output.

  // ── Tone mapping: the sky renders into the HDR main render target.
  // composite.glsl applies ACES and exposure.  We output linear HDR here.
  // Clamp bottom to prevent NaN / negative values from scatter underflow.
  sky = max(sky, vec3(0.0));

  gl_FragColor = vec4(sky, 1.0);
}
