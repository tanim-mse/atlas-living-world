/**
 * cloud.glsl — Volumetric ray-marched clouds, half-resolution with TAA upscale
 * Atlas: The Living World
 *
 * Renders a physically-plausible volumetric cloud layer via ray marching
 * through a pair of nested spherical shells (inner base, outer top).
 * The cloud volume occupies altitudes 1500 m – 4500 m above sea level,
 * appropriate for tropical cumulus and stratocumulus over Dhaka (23.8 °N).
 *
 * Rendering strategy:
 *   - Executed at half resolution by sky.js, which renders it into a
 *     dedicated half-res render target.
 *   - sky.js blends the result over the atmosphere colour using the cloud
 *     alpha channel, then upscales with TAA (temporal anti-aliasing) using
 *     a jittered sample offset per frame (uTAAJitter) before the composite
 *     pass receives the final sky texture.
 *   - This file is a fragment-only shader.  sky.js re-uses the same
 *     full-screen vertex shader (_vsFullScreen) that all post passes share.
 *
 * Noise construction:
 *   FBM (fractal Brownian motion) built from 4 octaves of value noise
 *   for the large-scale shape, combined with 3 octaves of Worley (cellular)
 *   noise for internal billowing detail.  A curl-noise-derived wind offset
 *   distorts UV lookup positions to eliminate the axis-aligned tiling
 *   artifacts that plague simpler cloud implementations.  The combined
 *   density field is eroded at the base (flatter bottoms) and rounded at
 *   the top (cumuliform silhouette).
 *
 * Lighting model:
 *   Each sample point accumulates:
 *     1. Single-scattering toward the sun (Beer–Lambert + HG phase).
 *     2. Powder effect (darkening near cloud base — in-scattering shadow).
 *     3. Ambient term from sky and ground albedo.
 *   Beer–Lambert transmittance is tracked along the view ray for
 *   early-exit once accumulated alpha exceeds 0.98.
 *
 * Weather modulation:
 *   uWeather (0–4) and uCloudCoverage (0–1) jointly drive:
 *     - Base density multiplier (more coverage = denser field)
 *     - Vertical extent (storms grow the cloud ceiling)
 *     - Sun illumination colour (storm: colder, overcast: grey-white)
 *
 * Performance (RTX 2050 target, half-res 960×540, 60 fps):
 *   PRIMARY_STEPS    16   — view ray march steps through cloud layer
 *   LIGHT_STEPS       6   — steps toward sun per primary sample
 *   Early exit at alpha 0.98 cuts average step count significantly.
 *   Estimated cost: ~1.8 ms per frame at half resolution.
 *
 * Split convention: this file is fragment-only.
 *   sky.js loads it as fragmentShader and uses _vsFullScreen() for vertex.
 *   The shader writes cloud colour + alpha into a RGBA half-float target.
 *   Alpha is pre-multiplied: rgb already multiplied by alpha.
 *
 * ─── Uniforms ──────────────────────────────────────────────────────────────
 *   uSkyTex          sampler2D   Atmosphere render target (half-res)
 *                                Used for ambient scatter from the sky dome
 *   uTime            float       Elapsed seconds — drives cloud drift
 *   uSunDirection    vec3        Normalised world-space direction toward sun
 *   uSunColor        vec3        Sun light colour (weather-modulated in sky.js)
 *   uSunIntensity    float       Solar irradiance scale (matches atmosphere.glsl)
 *   uMoonDirection   vec3        Normalised direction toward moon
 *   uMoonColor       vec3        Moon light tint (cool blue-grey)
 *   uIsNight         float       0 day / 1 night, for ambient switching
 *   uWeather         int         0 clear · 1 scattered · 2 overcast · 3 rain · 4 storm
 *   uCloudCoverage   float       0–1, primary density driver
 *   uWindSpeed       float       Horizontal cloud drift speed (m/s analogue)
 *   uWindDirection   vec2        Normalised XZ wind direction
 *   uTAAJitter       vec2        Sub-pixel jitter for temporal upscale (±0.5 texel)
 *   uResolution      vec2        Half-resolution render target size
 *   uCameraPos       vec3        World-space camera position
 *   uCameraDir       vec3        World-space camera forward direction
 *   uPlanetRadius    float       6371000.0 m
 *   uCloudBaseAlt    float       Cloud layer base altitude in m (1500.0)
 *   uCloudTopAlt     float       Cloud layer top altitude in m (4500.0)
 *
 * ─── Varyings ──────────────────────────────────────────────────────────────
 *   vUv              vec2        Full-screen UV [0,1]
 */

precision highp float;

// ─── Uniforms ─────────────────────────────────────────────────────────────────

uniform sampler2D uSkyTex;
uniform float     uTime;
uniform vec3      uSunDirection;
uniform vec3      uSunColor;
uniform float     uSunIntensity;
uniform vec3      uMoonDirection;
uniform vec3      uMoonColor;
uniform float     uIsNight;
uniform int       uWeather;
uniform float     uCloudCoverage;
uniform float     uWindSpeed;
uniform vec2      uWindDirection;
uniform vec2      uTAAJitter;
uniform vec2      uResolution;
uniform vec3      uCameraPos;
uniform vec3      uCameraDir;
uniform float     uPlanetRadius;
uniform float     uCloudBaseAlt;
uniform float     uCloudTopAlt;

// ─── Varyings ─────────────────────────────────────────────────────────────────

varying vec2 vUv;

// ─── Constants ────────────────────────────────────────────────────────────────

const float PI             = 3.14159265358979;
const int   PRIMARY_STEPS  = 16;
const int   LIGHT_STEPS    = 6;
const float ALPHA_CUTOFF   = 0.98;   // early exit threshold
const float CLOUD_ABSORB   = 0.08;   // absorption coefficient (per-metre equivalent)
const float CLOUD_SCATTER  = 0.80;   // scattering albedo

// ─── Ray–sphere intersection ───────────────────────────────────────────────────

vec2 raySphere(vec3 orig, vec3 dir, float r) {
  float a = dot(dir, dir);
  float b = 2.0 * dot(orig, dir);
  float c = dot(orig, orig) - r * r;
  float disc = b * b - 4.0 * a * c;
  if (disc < 0.0) return vec2(-1.0);
  float sq = sqrt(disc);
  return vec2((-b - sq) / (2.0 * a),
              (-b + sq) / (2.0 * a));
}

// ─── Hash & noise primitives ───────────────────────────────────────────────────

// Fast hash — no trig, no texture lookup needed
float hash1(vec3 p) {
  p  = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float hash1_2d(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p.yx, p + 19.19);
  return fract(p.x * p.y);
}

// Smooth value noise — trilinear interpolation of lattice hashes
float valueNoise(vec3 p) {
  vec3 i  = floor(p);
  vec3 f  = fract(p);
  vec3 u  = f * f * (3.0 - 2.0 * f);  // smoothstep

  float v000 = hash1(i + vec3(0,0,0));
  float v100 = hash1(i + vec3(1,0,0));
  float v010 = hash1(i + vec3(0,1,0));
  float v110 = hash1(i + vec3(1,1,0));
  float v001 = hash1(i + vec3(0,0,1));
  float v101 = hash1(i + vec3(1,0,1));
  float v011 = hash1(i + vec3(0,1,1));
  float v111 = hash1(i + vec3(1,1,1));

  return mix(
    mix(mix(v000, v100, u.x), mix(v010, v110, u.x), u.y),
    mix(mix(v001, v101, u.x), mix(v011, v111, u.x), u.y),
    u.z
  );
}

// 4-octave FBM — large-scale cloud shape
float fbm4(vec3 p) {
  float v  = 0.0;
  float a  = 0.5;
  float t  = 0.0;
  mat3  rot = mat3(
     0.00,  0.80,  0.60,
    -0.80,  0.36, -0.48,
    -0.60, -0.48,  0.64
  );
  for (int i = 0; i < 4; i++) {
    v += a * valueNoise(p);
    p  = rot * p * 2.02;
    t += a;
    a *= 0.5;
  }
  return v / t;
}

// Worley (cellular) noise — distance to nearest feature point
// Returns 0 near feature centres, 1 in space between (inverted for cloud detail)
float worley(vec3 p) {
  vec3  cell  = floor(p);
  float minD  = 1e10;
  for (int dz = -1; dz <= 1; dz++) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec3 neighbour = cell + vec3(float(dx), float(dy), float(dz));
        vec3 feature   = neighbour + vec3(
          hash1_2d(neighbour.xy + neighbour.z * 17.3),
          hash1_2d(neighbour.yz + neighbour.x * 23.7),
          hash1_2d(neighbour.zx + neighbour.y * 31.1)
        );
        float d = length(p - feature);
        minD    = min(minD, d);
      }
    }
  }
  return clamp(minD, 0.0, 1.0);
}

// 3-octave Worley FBM for billowing internal detail
float worleyFbm3(vec3 p) {
  float v = 0.0;
  float a = 0.625;
  float t = 0.0;
  for (int i = 0; i < 3; i++) {
    // Invert Worley so bright = interior of cloud cells
    v += a * (1.0 - worley(p));
    p *= 2.1;
    t += a;
    a *= 0.5;
  }
  return v / t;
}

// ─── Curl-noise wind distortion ────────────────────────────────────────────────
//
// Approximates curl noise by taking finite differences of a scalar potential.
// Prevents grid-aligned tiling artifacts and simulates turbulent advection.

vec3 curlDistort(vec3 p, float strength) {
  const float eps = 0.05;
  float n0 = valueNoise(p + vec3(eps, 0.0, 0.0));
  float n1 = valueNoise(p - vec3(eps, 0.0, 0.0));
  float n2 = valueNoise(p + vec3(0.0, eps, 0.0));
  float n3 = valueNoise(p - vec3(0.0, eps, 0.0));
  float n4 = valueNoise(p + vec3(0.0, 0.0, eps));
  float n5 = valueNoise(p - vec3(0.0, 0.0, eps));
  vec3 curl = vec3(
    (n2 - n3) - (n4 - n5),
    (n4 - n5) - (n0 - n1),
    (n0 - n1) - (n2 - n3)
  ) / (2.0 * eps);
  return p + curl * strength;
}

// ─── Cloud density at a world-space point ──────────────────────────────────────
//
// Returns density in [0, 1] — 0 is clear air, 1 is opaque cloud interior.
//
// The density field is built in three stages:
//   1. Coverage threshold: FBM shape erased below uCloudCoverage
//   2. Vertical profile: flat base, rounded top (cumuliform)
//   3. Detail erosion: Worley noise hollows out the interior billows

float cloudDensity(vec3 worldPos) {

  // ── Altitude above sea level (approximate, flat earth ok at this scale) ──
  float altitude = worldPos.y;  // world Y = altitude in metres

  // Outside the cloud layer → zero density immediately
  if (altitude < uCloudBaseAlt || altitude > uCloudTopAlt) return 0.0;

  // ── Normalised height within layer [0, 1]: 0 = base, 1 = top ────────────
  float h = (altitude - uCloudBaseAlt) / (uCloudTopAlt - uCloudBaseAlt);

  // ── Weather-driven vertical extent multiplier ─────────────────────────────
  // Storms push clouds taller; scattered clouds stay low and flat
  float verticalScale = 1.0;
  if (uWeather == 4) verticalScale = 1.0;       // storm: full height
  else if (uWeather == 3) verticalScale = 0.82; // rain: slightly compressed
  else if (uWeather == 2) verticalScale = 0.6;  // overcast: stratus, flat
  else if (uWeather == 1) verticalScale = 0.55; // scattered: low cumulus
  else verticalScale = 0.35;                    // clear: thin wisps only

  // Remap h through vertical scale — clamp above compressed ceiling
  if (h > verticalScale) return 0.0;
  h /= verticalScale;

  // ── Vertical profile: flat base, rounded top (cumuliform) ─────────────────
  // SRb: base ramp — sharp lower boundary (flat cloud bottoms)
  float SRb = smoothstep(0.0, 0.08, h);
  // SRt: top ramp — gradual falloff (rounded tops)
  float SRt = smoothstep(1.0, 0.4, h);
  float profile = SRb * SRt;

  // ── Horizontal position in noise space ────────────────────────────────────
  // Scale: 1 world unit = 1 metre → clouds are 1500-4500 m altitude,
  // so we scale down to noise frequency that gives 5-50 km cloud sizes.
  float noiseScale = 0.000055;   // ~1 noise unit per 18 km
  float detailScale = 0.00038;   // ~1 noise unit per 2.6 km

  // Wind drift: advect noise position over time
  vec2  windDrift   = uWindDirection * uWindSpeed * uTime * 0.001;
  vec3  noisePos    = vec3(
    worldPos.x * noiseScale + windDrift.x,
    h * 0.8,                                    // compressed Y — flat clouds
    worldPos.z * noiseScale + windDrift.y
  );

  // Apply curl distortion to break tiling
  noisePos = curlDistort(noisePos * 3.2, 0.12) / 3.2;

  // ── Large-scale shape (FBM) ────────────────────────────────────────────────
  float shape = fbm4(noisePos * 3.0);

  // Coverage remapping: shift shape by (1 - coverage) so at coverage=0
  // almost no cloud passes threshold, at coverage=1 everything does
  float coverageRemap = uCloudCoverage * 0.82 + 0.02;
  shape = remap(shape, 1.0 - coverageRemap, 1.0, 0.0, 1.0);
  shape = clamp(shape, 0.0, 1.0);

  if (shape < 0.001) return 0.0;  // early exit

  // ── Detail erosion (Worley) ────────────────────────────────────────────────
  // Detail is stronger at the base (more billowing) and fades toward top
  vec3 detailPos = vec3(
    worldPos.x * detailScale + windDrift.x * 0.85,
    h * 1.2,
    worldPos.z * detailScale + windDrift.y * 0.85
  );
  float detail = worleyFbm3(detailPos * 2.5);

  // Erosion: at the base detail erodes aggressively (bumpy bottoms),
  // near the top it barely touches (smooth tops)
  float detailErosion = mix(0.65, 0.18, h);
  float density = shape - detail * detailErosion;

  // ── Apply vertical profile ─────────────────────────────────────────────────
  density *= profile;

  return clamp(density * 2.2, 0.0, 1.0);
}

// ─── remap() — GLSL doesn't have it built in ──────────────────────────────────
// Returns v remapped from [inMin,inMax] to [outMin,outMax]

float remap(float v, float inMin, float inMax, float outMin, float outMax) {
  return outMin + (outMax - outMin) * clamp((v - inMin) / (inMax - inMin), 0.0, 1.0);
}

// ─── Henyey–Greenstein phase function ─────────────────────────────────────────

float phaseHG(float cosTheta, float g) {
  float g2  = g * g;
  float num = 1.0 - g2;
  float den = 4.0 * PI * pow(abs(1.0 + g2 - 2.0 * g * cosTheta), 1.5);
  return num / max(den, 1e-7);
}

// Two-lobe cloud phase: forward scatter (g=0.85) blended with back scatter (g=-0.1)
float cloudPhase(float cosTheta) {
  return mix(phaseHG(cosTheta, 0.85), phaseHG(cosTheta, -0.10), 0.25);
}

// ─── Beer–Lambert transmittance toward the sun ─────────────────────────────────
//
// Marches LIGHT_STEPS from samplePos toward the sun through the cloud volume.
// Returns single-float transmittance [0,1] — 1 is fully lit, 0 is fully shadowed.

float sunTransmittance(vec3 samplePos, vec3 sunDir) {
  // Find exit from cloud layer top shell
  float planetR  = uPlanetRadius;
  vec3  origin   = vec3(0.0, planetR + samplePos.y, 0.0);
  // Re-use raySphere with a flat-earth approximation: step vertically
  // until we exit the cloud top altitude.
  float distToTop = (uCloudTopAlt - samplePos.y) / max(sunDir.y, 0.001);
  distToTop       = max(distToTop, 0.0);

  float stepLen   = distToTop / float(LIGHT_STEPS);
  float optDepth  = 0.0;

  for (int i = 0; i < LIGHT_STEPS; i++) {
    float t       = stepLen * (float(i) + 0.5);
    vec3  pos     = samplePos + sunDir * t;
    float d       = cloudDensity(pos);
    optDepth     += d * stepLen * CLOUD_ABSORB;
  }

  // Beer–Lambert: transmittance = exp(-optical_depth)
  // Powder sugar effect: multiply by (1 - exp(-2 * optical_depth))
  // This simulates the darkening near cloud base where forward scatter
  // hasn't yet fully developed (in-scatter shadow).
  float transmit = exp(-optDepth);
  float powder   = 1.0 - exp(-optDepth * 2.0);
  return transmit * mix(1.0, powder, 0.5);
}

// ─── Ambient cloud lighting ────────────────────────────────────────────────────
//
// Two terms:
//   - Sky ambient: isotropic scatter from the sky hemisphere
//   - Ground bounce: faint warm-grey reflected upward from terrain

vec3 cloudAmbient(float h, vec3 skyColor) {
  // h = normalised height in cloud layer [0,1]
  vec3 skyAmb    = skyColor * 0.28;
  // Ground bounce is warmer and attenuated at the top
  vec3 groundBounce = vec3(0.32, 0.28, 0.24) * 0.08 * (1.0 - h);
  return skyAmb + groundBounce;
}

// ─── Reconstruct world-space ray direction from UV ─────────────────────────────
//
// sky.js sets the cloud shader to run as a full-screen pass at half resolution.
// We need a world-space ray direction per fragment.  sky.js also passes the
// camera frustum corners as uniforms, but to keep the shader self-contained
// we reconstruct from FOV and aspect ratio instead.
//
// The camera forward, right and up vectors are derived from uCameraDir and
// the world up vector (0,1,0).  FOV is fixed at 58° (CONFIG.CAMERA_FOV).

uniform float uAspect;   // window.innerWidth / window.innerHeight at half-res
uniform float uFovTan;   // tan(radians(58.0) / 2.0)

vec3 reconstructRayDir(vec2 uv) {
  // Apply TAA jitter (sub-pixel offset) before reconstruction
  vec2 jitteredUv = uv + uTAAJitter / uResolution;
  vec2 ndc = jitteredUv * 2.0 - 1.0;

  vec3 forward = normalize(uCameraDir);
  vec3 right   = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
  vec3 up      = cross(right, forward);

  return normalize(
    forward
    + right * ndc.x * uFovTan * uAspect
    - up    * ndc.y * uFovTan
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

void main() {

  // ─── Ray setup ─────────────────────────────────────────────────────────────

  vec3 rayDir    = reconstructRayDir(vUv);
  vec3 rayOrigin = uCameraPos;

  // Rays looking downward cannot intersect the cloud layer above — early exit
  // (Allow a tiny tolerance for nearly-horizontal rays)
  if (rayDir.y < -0.01) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // ─── Find ray entry / exit in cloud shell (spherical approximation) ─────────
  //
  // We treat the cloud layer as two nested spheres above the flat-earth
  // origin.  Since the world units are metres and the camera Y is at ~1.72 m,
  // the planet radius is enormous, allowing a flat-earth approximation:
  // we simply intersect two horizontal slabs via parametric ray equations.

  float tBase, tTop;

  if (rayOrigin.y < uCloudBaseAlt) {
    // Camera below cloud base — ray enters at base, exits at top
    tBase = (uCloudBaseAlt - rayOrigin.y) / max(rayDir.y, 1e-6);
    tTop  = (uCloudTopAlt  - rayOrigin.y) / max(rayDir.y, 1e-6);
  } else if (rayOrigin.y < uCloudTopAlt) {
    // Camera inside cloud layer (shouldn't happen in practice — camera at 1.72 m)
    tBase = 0.0;
    tTop  = (uCloudTopAlt - rayOrigin.y) / max(rayDir.y, 1e-6);
  } else {
    // Camera above cloud layer (won't happen with current setup)
    gl_FragColor = vec4(0.0);
    return;
  }

  // Clamp to a sane maximum march distance to prevent cost spikes near horizon
  float maxDist = 80000.0;   // 80 km — beyond this, aerial perspective dominates
  tTop  = min(tTop,  maxDist);
  tBase = max(tBase, 0.0);

  if (tBase >= tTop) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // ─── Ray march through cloud layer ─────────────────────────────────────────

  float stepLen = (tTop - tBase) / float(PRIMARY_STEPS);

  // Dither start position (blue-noise-like offset per pixel) to hide banding
  // Use a per-pixel hash based on fragment coordinates and time for temporal variety
  vec2  fragCoord   = vUv * uResolution;
  float ditherOffset = hash1_2d(fragCoord + fract(uTime * 7.3)) * stepLen;

  // Accumulated colour and transmittance
  vec3  cloudColor   = vec3(0.0);
  float transmittance = 1.0;   // starts fully transparent

  // Sun / moon lighting state
  vec3  lightDir     = normalize(mix(uSunDirection, uMoonDirection, uIsNight));
  vec3  lightColor   = mix(uSunColor * uSunIntensity, uMoonColor * 0.15, uIsNight);
  float cosTheta     = dot(rayDir, lightDir);
  float phase        = cloudPhase(cosTheta);

  // Sky colour at horizon for ambient estimate (sample atmosphere tex)
  vec3  skyAmbColor  = texture2D(uSkyTex, vec2(0.5, 0.02)).rgb;

  for (int i = 0; i < PRIMARY_STEPS; i++) {
    float t       = tBase + ditherOffset + stepLen * float(i);
    vec3  pos     = rayOrigin + rayDir * t;

    float density = cloudDensity(pos);
    if (density < 0.001) continue;  // skip empty space

    // Normalised height for this sample (lighting and ambient)
    float h = clamp(
      (pos.y - uCloudBaseAlt) / (uCloudTopAlt - uCloudBaseAlt),
      0.0, 1.0
    );

    // ── Transmittance toward sun ─────────────────────────────────────────────
    float sunTrans  = sunTransmittance(pos, lightDir);

    // ── Single-scatter toward camera ─────────────────────────────────────────
    // Energy from this step: scatter * phase * in-transmittance * density * stepLen
    vec3  scatter    = lightColor * phase * sunTrans;

    // ── Ambient ──────────────────────────────────────────────────────────────
    vec3  ambient    = cloudAmbient(h, skyAmbColor);

    // ── Combined radiance for this sample ────────────────────────────────────
    vec3  sampleRadiance = (scatter * CLOUD_SCATTER + ambient) * density;

    // Beer–Lambert: how much of this sample's light reaches the camera
    float sampleOptDepth = density * stepLen * CLOUD_ABSORB;
    float sampleTrans    = exp(-sampleOptDepth);

    // Accumulate using the standard scattering integration formula
    // (Frostbite 2015 slide 89: energy-conserving integration)
    vec3  sampleContrib = sampleRadiance * (1.0 - sampleTrans) * transmittance;
    cloudColor         += sampleContrib;
    transmittance      *= sampleTrans;

    // Early exit once cloud is nearly opaque
    if (transmittance < (1.0 - ALPHA_CUTOFF)) break;
  }

  // ─── Weather colour tinting ─────────────────────────────────────────────────
  //
  // Overcast / rain / storm clouds are colder and darker.
  // Clear / scattered clouds are warmer and brighter.

  vec3 weatherTint;
  if (uWeather >= 4) {
    // Storm: heavy dark grey-blue
    weatherTint = vec3(0.62, 0.64, 0.70);
  } else if (uWeather == 3) {
    // Rain: medium grey
    weatherTint = vec3(0.70, 0.71, 0.74);
  } else if (uWeather == 2) {
    // Overcast: uniform light grey-white
    weatherTint = vec3(0.88, 0.88, 0.90);
  } else if (uWeather == 1) {
    // Scattered: warm white cumulus
    weatherTint = vec3(0.96, 0.95, 0.93);
  } else {
    // Clear: thin wispy cirrus, very bright
    weatherTint = vec3(0.98, 0.97, 0.96);
  }

  cloudColor *= weatherTint;

  // ─── Horizon fade ──────────────────────────────────────────────────────────
  //
  // Fade cloud alpha toward the horizon to prevent the hard edge where the
  // ray-marched layer terminates at maxDist.  Also reduces cost naturally
  // because thin horizon clouds are barely visible anyway.

  float horizonFade = smoothstep(0.0, 0.08, rayDir.y);
  float cloudAlpha  = (1.0 - transmittance) * horizonFade;

  // ─── Night darkening ───────────────────────────────────────────────────────
  //
  // At night the clouds receive only moon ambient.  Already handled by
  // lightColor/lightDir mix above, but add a global darkening to ensure
  // night clouds don't appear over-bright.

  float nightDark = mix(1.0, 0.08, uIsNight);
  cloudColor *= nightDark;

  // ─── Pre-multiply alpha ────────────────────────────────────────────────────
  //
  // sky.js composites clouds over the atmosphere using pre-multiplied alpha:
  //   finalSky = cloudRGBA.rgb + atmosphereRGB * (1 - cloudRGBA.a)

  gl_FragColor = vec4(cloudColor * cloudAlpha, cloudAlpha);
}
