/**
 * rain.glsl — Rain streak particle system with splash rings and lens distortion
 * Atlas: The Living World
 *
 * Renders rain as a two-layer instanced billboard system.  Each billboard is
 * a tall thin quad oriented along the rain velocity vector, textured with a
 * procedural streak that includes:
 *   - Core opaque streak body (motion-blurred droplet column)
 *   - Refraction fringe (thin prismatic shift at leading edge)
 *   - Intensity falloff toward the tail (trailing fade)
 *
 * Two layers are rendered at different distances and speeds to create
 * visual parallax depth without geometry cost:
 *   Layer A — near layer:   droplets 12–30 m from camera, faster, more opaque
 *   Layer B — far layer:    droplets 60–200 m from camera, slower, translucent
 *
 * Particle count and intensity driven by uWeather:
 *   clear (0):     particles disabled entirely (sky.js skips draw call)
 *   scattered (1): uRainDensity 0.0  — no rain
 *   overcast (2):  uRainDensity 0.0  — no rain
 *   rain (3):      uRainDensity 0.55 — steady moderate rain
 *   storm (4):     uRainDensity 1.0  — tropical downpour
 *
 * sky.js manages the InstancedMesh.  This shader controls the per-particle
 * visual.  Instance transform matrices encode world position; the vertex
 * shader derives streak orientation from uRainVelocity and camera vectors.
 *
 * Splash rings:
 *   A second draw call renders splash geometry — flat circles on the terrain
 *   surface that ripple outward on droplet impact.  Each splash is a
 *   PlaneGeometry quad, alpha-tested against a procedural ripple ring.
 *   Splash shader appended below, split by // === SPLASH VERTEX === and
 *   // === SPLASH FRAGMENT ===.
 *
 * Wetness feedback:
 *   The main fragment shader samples uWetness each frame and darkens streak
 *   colour accordingly — wet rain on wet terrain looks heavier and more
 *   reflective than the same rain on dry ground, because the visual contrast
 *   of fresh streaks against a darkened wet surface is higher.
 *
 * Lens effect:
 *   A screen-space distortion pass (separate from the particle draw) is
 *   applied in sky.js as a final blit.  It reads uRainStreak (the rain
 *   particle render target) and offsets UV coordinates by a small vertical
 *   vector scaled by rain intensity and the streak alpha.  This simulates
 *   the refractive distortion of a rain-wet camera lens or glass surface.
 *   The lens distortion shader is appended below after // === LENS VERTEX ===
 *   and // === LENS FRAGMENT ===.
 *
 * Split convention:
 *   sky.js reads this entire file as a string and splits on the sentinel
 *   comment lines to extract four shader pairs:
 *     // === VERTEX ===            rain streak vertex
 *     // === FRAGMENT ===          rain streak fragment
 *     // === SPLASH VERTEX ===     splash ring vertex
 *     // === SPLASH FRAGMENT ===   splash ring fragment
 *     // === LENS VERTEX ===       screen lens distortion vertex
 *     // === LENS FRAGMENT ===     screen lens distortion fragment
 *
 * Performance (RTX 2050, 1080p, 60 fps target):
 *   Near layer:  4 000 instances × 2 triangles  =   8 000 triangles
 *   Far layer:   6 000 instances × 2 triangles  =  12 000 triangles
 *   Splashes:    1 200 instances × 2 triangles  =   2 400 triangles
 *   Total rain triangles: ~22 400  (negligible vs grass at 80 000 blades)
 *   All draw calls use InstancedMesh — 3 total draw calls for full rain.
 *
 * ─── Uniforms (streak vertex) ───────────────────────────────────────────────
 *   uTime          float    Elapsed seconds
 *   uRainVelocity  vec3     Rain fall direction × speed (world space, m/s)
 *                           Default: (wind.x * 2.0, −14.0, wind.z * 2.0)
 *                           Storm: (wind.x * 5.0, −22.0, wind.z * 5.0)
 *   uCameraPos     vec3     World-space camera position
 *   uLayer         float    0.0 = near layer, 1.0 = far layer
 *   uRainDensity   float    0–1, scales opacity and respawn rate
 *
 * ─── Uniforms (streak fragment) ─────────────────────────────────────────────
 *   uTime          float    Elapsed seconds
 *   uRainDensity   float    0–1
 *   uWetness       float    0–1 global wetness (state.wetness)
 *   uSunDirection  vec3     Normalised — for specular glint on streaks
 *   uSunColor      vec3     Sun colour
 *   uIsNight       float    0 day / 1 night
 *   uWeather       int      0–4 (used for storm streak colour shift)
 *
 * ─── Uniforms (splash fragment) ─────────────────────────────────────────────
 *   uTime          float    Elapsed seconds
 *   uRainDensity   float    0–1, scales ring opacity
 *   uWetness       float    Global wetness
 *
 * ─── Uniforms (lens fragment) ───────────────────────────────────────────────
 *   uSceneTex      sampler2D  Main scene render target
 *   uRainTex       sampler2D  Rain streak render target (alpha only needed)
 *   uRainDensity   float      0–1
 *   uTime          float      Elapsed seconds
 *   uResolution    vec2       Full-resolution screen size
 *
 * ─── Varyings (streak) ──────────────────────────────────────────────────────
 *   vUv            vec2   Billboard UV: U across streak width, V along length
 *   vAlpha         float  Per-instance alpha (distance fade + density)
 *   vLifetime      float  0 (just spawned) → 1 (about to respawn)
 *   vLayer         float  Passed through from uLayer
 *   vWorldPos      vec3   World position of this vertex
 *
 * ─── Varyings (splash) ──────────────────────────────────────────────────────
 *   vSplashUv      vec2   Splash quad UV [0,1]
 *   vSplashAge     float  0 (just hit) → 1 (fully faded ring)
 *   vSplashAlpha   float  Per-instance fade
 */


// ══════════════════════════════════════════════════════════════════════════════
// RAIN STREAK — VERTEX
// ══════════════════════════════════════════════════════════════════════════════

// === VERTEX ===

precision highp float;

// ─── Uniforms ─────────────────────────────────────────────────────────────────

uniform float uTime;
uniform vec3  uRainVelocity;   // fall direction × speed, world-space m/s
uniform vec3  uCameraPos;
uniform float uLayer;          // 0.0 = near, 1.0 = far
uniform float uRainDensity;    // 0–1

// ─── Varyings ─────────────────────────────────────────────────────────────────

varying vec2  vUv;
varying float vAlpha;
varying float vLifetime;
varying float vLayer;
varying vec3  vWorldPos;

// ─── Utility ──────────────────────────────────────────────────────────────────

float hash1(float n) {
  return fract(sin(n) * 43758.5453123);
}

float hash1_v3(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

void main() {

  // ── Retrieve instance index from the instance transform matrix ─────────────
  // Three.js encodes instance index via the translation component of
  // instanceMatrix.  We derive a stable per-instance seed from it.
  vec3 instanceOrigin = vec3(
    instanceMatrix[3][0],
    instanceMatrix[3][1],
    instanceMatrix[3][2]
  );
  float seed = hash1_v3(instanceOrigin);

  // ── Layer parameters ──────────────────────────────────────────────────────
  // Near layer:  shorter streaks, faster fall, closer to camera, more opaque
  // Far layer:   longer streaks, slower fall, further away, more transparent
  float isNear       = 1.0 - uLayer;
  float isFar        = uLayer;

  // Streak dimensions (world units = metres at Atlas scale)
  float streakLength = mix(0.45, 0.80, hash1(seed * 3.7));  // near: 0.45m, far: 0.80m
  streakLength      *= mix(1.0, 1.55, isFar);
  float streakWidth  = mix(0.006, 0.012, hash1(seed * 5.1));
  streakWidth       *= mix(1.0, 0.7, isFar);

  // Fall speed variance per droplet (±15%)
  float speedFactor  = 0.88 + hash1(seed * 2.3) * 0.24;
  vec3  velocity     = uRainVelocity * speedFactor;

  // ── Lifetime / respawn ────────────────────────────────────────────────────
  // Each droplet has a fall period.  At the end it teleports back to the top.
  // Period is proportional to how far it needs to fall (near: short, far: long).
  float fallHeight = mix(18.0, 120.0, isFar);   // metres to fall before respawn
  float fallPeriod = fallHeight / max(abs(velocity.y), 0.5);

  // Stagger start phase so all droplets don't arrive at the same time
  float phaseOffset  = hash1(seed * 7.9) * fallPeriod;
  float t            = mod(uTime * speedFactor + phaseOffset, fallPeriod);
  vLifetime          = t / fallPeriod;           // 0 → 1

  // ── World position of instance base (top of streak) ──────────────────────
  // The instanceMatrix carries the spawn position set by sky.js each frame.
  // We apply the physics offset on top of it.
  vec3 spawnPos = instanceOrigin;
  vec3 basePos  = spawnPos + velocity * t;

  // ── Billboard orientation ─────────────────────────────────────────────────
  // Streak aligned with velocity direction (not screen-space — true 3D).
  // Width is perpendicular to both velocity and the view direction.
  vec3 velDir   = normalize(velocity);
  vec3 toCamera = normalize(uCameraPos - basePos);
  vec3 right    = normalize(cross(velDir, toCamera));

  // ── Vertex expansion ──────────────────────────────────────────────────────
  // position.x: −0.5 or +0.5 (left/right edge of billboard quad)
  // position.y:  0.0 or 1.0  (bottom / top of streak)
  vec3 worldPos = basePos
    + right   * position.x * streakWidth
    - velDir  * position.y * streakLength;   // top of streak at y=0, tail at y=1

  vWorldPos = worldPos;

  // ── Alpha: distance fade + density + lifetime fade-in/out ─────────────────
  float dist        = length(worldPos - uCameraPos);
  float nearFade    = smoothstep(3.0,  10.0, dist);         // too-close clip
  float farFade     = smoothstep(250.0, 150.0, dist);       // far fade
  float lifeFade    = smoothstep(0.0, 0.06, vLifetime)      // spawn fade-in
                    * smoothstep(1.0, 0.88, vLifetime);     // despawn fade-out
  float baseAlpha   = mix(0.55, 0.22, isFar);               // near more opaque

  vAlpha = nearFade * farFade * lifeFade * baseAlpha * uRainDensity;

  // ── UV ────────────────────────────────────────────────────────────────────
  vUv    = vec2(position.x + 0.5, position.y);   // U: 0→1 across, V: 0→1 down
  vLayer = uLayer;

  // ── Project ───────────────────────────────────────────────────────────────
  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}


// ══════════════════════════════════════════════════════════════════════════════
// RAIN STREAK — FRAGMENT
// ══════════════════════════════════════════════════════════════════════════════

// === FRAGMENT ===

precision mediump float;

// ─── Uniforms ─────────────────────────────────────────────────────────────────

uniform float uTime;
uniform float uRainDensity;
uniform float uWetness;
uniform vec3  uSunDirection;
uniform vec3  uSunColor;
uniform float uIsNight;
uniform int   uWeather;

// ─── Varyings ─────────────────────────────────────────────────────────────────

varying vec2  vUv;
varying float vAlpha;
varying float vLifetime;
varying float vLayer;
varying vec3  vWorldPos;

// ─── Utility ──────────────────────────────────────────────────────────────────

float hash1_f(float n) {
  return fract(sin(n) * 43758.5453123);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

void main() {
  if (vAlpha < 0.004) discard;

  // ── Streak shape ──────────────────────────────────────────────────────────
  // U = 0→1 across streak width:  gaussian profile, bright centre, dim edges
  // V = 0→1 along streak length:  bright leading edge (bottom), dim tail (top)

  // Gaussian width profile
  float uCentered    = vUv.x - 0.5;                          // −0.5 → +0.5
  float widthProfile = exp(-uCentered * uCentered * 28.0);   // tight gaussian

  // V profile: leading edge at V=1 (tail at V=0, head at V=1)
  // Rain streaks are brighter at the leading (falling) tip
  float lengthProfile = smoothstep(0.0, 0.12, vUv.y)          // tail fade-in
                      * (0.4 + 0.6 * vUv.y);                  // brighten toward head

  float streakMask = widthProfile * lengthProfile;

  if (streakMask < 0.01) discard;

  // ── Base streak colour ────────────────────────────────────────────────────
  // Rain streaks are near-white with a very faint blue-grey tint from sky.
  // During storms, shift cooler (heavier precipitation = more scattering).
  vec3 streakBase;
  if (uWeather == 4) {
    // Storm: cold blue-grey streaks, almost silver
    streakBase = vec3(0.72, 0.76, 0.82);
  } else {
    // Rain: warm-neutral near-white
    streakBase = vec3(0.80, 0.82, 0.86);
  }

  // Night: streaks catch moonlight — subtle blue tint, lower overall brightness
  streakBase = mix(streakBase, streakBase * vec3(0.62, 0.65, 0.74), uIsNight);

  // ── Specular glint on leading edge ────────────────────────────────────────
  // The leading tip of each falling droplet acts as a tiny specular surface.
  // This gives rain that characteristic brief shimmer as it passes light sources.
  float glintMask  = pow(vUv.y, 4.0) * widthProfile;
  // View-independent approximation — glint strength based on sun elevation
  float sunUp      = max(uSunDirection.y, 0.0);
  float glintStr   = sunUp * glintMask * 0.45 * (1.0 - uIsNight);
  vec3  glintColor = uSunColor * glintStr;

  // ── Refraction fringe at leading edge (chromatic) ─────────────────────────
  // The meniscus of a falling droplet refracts light, creating a faint
  // prismatic fringe.  Simulated as a lateral colour shift at the head.
  float fringe     = pow(vUv.y, 6.0) * abs(uCentered) * 2.0;
  vec3  fringeAdd  = vec3(0.0, fringe * 0.018, fringe * 0.035) * (1.0 - uIsNight);

  // ── Wetness modulation ────────────────────────────────────────────────────
  // On a wet-surfaced world, rain streaks appear slightly higher-contrast
  // (darker immediate surround makes the bright streak more visible).
  // We multiply up slightly with wetness.
  float wetBoost   = 1.0 + uWetness * 0.18;

  // ── Far layer attenuation ─────────────────────────────────────────────────
  // Far-layer streaks should be more diffuse — reduce contrast
  float layerSoft  = mix(1.0, 0.55, vLayer);

  // ── Final colour and alpha ────────────────────────────────────────────────
  vec3 colour  = (streakBase + glintColor + fringeAdd) * wetBoost * layerSoft;
  float alpha   = streakMask * vAlpha;

  // Clamp to prevent HDR overshoot on the streak render target
  colour = clamp(colour, 0.0, 1.2);

  gl_FragColor = vec4(colour * alpha, alpha);   // pre-multiplied
}


// ══════════════════════════════════════════════════════════════════════════════
// SPLASH RING — VERTEX
// ══════════════════════════════════════════════════════════════════════════════

// === SPLASH VERTEX ===

precision highp float;

// ─── Uniforms ─────────────────────────────────────────────────────────────────

uniform float uTime;
uniform float uRainDensity;

// ─── Varyings ─────────────────────────────────────────────────────────────────

varying vec2  vSplashUv;
varying float vSplashAge;
varying float vSplashAlpha;

// ─── Main ─────────────────────────────────────────────────────────────────────

void main() {

  // ── Per-instance seed from position ──────────────────────────────────────
  vec3  instanceOrigin = vec3(
    instanceMatrix[3][0],
    instanceMatrix[3][1],
    instanceMatrix[3][2]
  );
  float seed     = fract(sin(dot(instanceOrigin.xz, vec2(127.1, 311.7))) * 43758.5453);

  // ── Splash lifecycle ──────────────────────────────────────────────────────
  // Each splash ring expands and fades over its lifetime (0.55–0.90 seconds)
  float lifetime = mix(0.55, 0.90, fract(seed * 3.7));
  float phase    = fract(seed * 9.13);                           // stagger
  float t        = mod(uTime + phase * lifetime, lifetime);
  vSplashAge     = t / lifetime;                                 // 0 → 1

  // ── Scale ring outward as it ages ────────────────────────────────────────
  // Max radius: 0.08–0.14 world units (8–14 cm) — a real water ripple radius
  float maxRadius = mix(0.08, 0.14, fract(seed * 5.5));
  float ringScale = mix(0.02, maxRadius, vSplashAge);

  // Apply ring scale to the unit-plane geometry (−0.5..+0.5 in XZ plane)
  vec3 scaledPos = vec3(
    instanceOrigin.x + position.x * ringScale,
    instanceOrigin.y,                            // flat on terrain surface
    instanceOrigin.z + position.z * ringScale
  );

  // ── Alpha: fade in quickly, fade out slowly ───────────────────────────────
  float fadeIn  = smoothstep(0.0, 0.08, vSplashAge);
  float fadeOut = smoothstep(1.0, 0.65, vSplashAge);
  vSplashAlpha  = fadeIn * fadeOut * uRainDensity * 0.55;

  vSplashUv   = uv;   // built-in PlaneGeometry UV [0,1]

  gl_Position = projectionMatrix * viewMatrix * vec4(scaledPos, 1.0);
}


// ══════════════════════════════════════════════════════════════════════════════
// SPLASH RING — FRAGMENT
// ══════════════════════════════════════════════════════════════════════════════

// === SPLASH FRAGMENT ===

precision mediump float;

// ─── Uniforms ─────────────────────────────────────────────────────────────────

uniform float uTime;
uniform float uRainDensity;
uniform float uWetness;

// ─── Varyings ─────────────────────────────────────────────────────────────────

varying vec2  vSplashUv;
varying float vSplashAge;
varying float vSplashAlpha;

// ─── Main ─────────────────────────────────────────────────────────────────────

void main() {
  if (vSplashAlpha < 0.004) discard;

  // ── Ring shape: annular band around centre ────────────────────────────────
  // UV centred on [0.5, 0.5]
  vec2  centred  = vSplashUv - 0.5;
  float dist     = length(centred);              // 0 = centre, 0.5 = outer edge

  // Ring: thin band at radius driven by age (ring expands outward)
  float ringR    = mix(0.02, 0.45, vSplashAge); // ring radius in UV space
  float ringW    = mix(0.06, 0.03, vSplashAge); // ring narrows as it expands

  // Signed distance from ring edge — positive inside band
  float ringMask = 1.0 - smoothstep(0.0, ringW, abs(dist - ringR));

  if (ringMask < 0.01) discard;

  // ── Secondary inner ripple ────────────────────────────────────────────────
  // A second, smaller, faster ring inside the primary (physically: the
  // capillary wave that runs inward after the droplet impact).
  float innerR   = ringR * 0.55;
  float innerW   = ringW * 0.7;
  float innerAge = clamp(vSplashAge * 1.6 - 0.3, 0.0, 1.0);
  float innerR2  = mix(0.0, innerR, innerAge);
  float innerMask = (1.0 - smoothstep(0.0, innerW, abs(dist - innerR2)))
                  * smoothstep(0.3, 0.0, innerAge);   // fades out earlier

  // ── Colour ────────────────────────────────────────────────────────────────
  // Splash rings are the terrain surface material becoming briefly lighter
  // (disturbed water surface) before settling back to wet terrain colour.
  // Near-white with a very faint blue tint (reflected sky).
  vec3 ringColor  = vec3(0.78, 0.82, 0.88);

  // Wetness tints the splash slightly darker (wet surface, not dry)
  ringColor *= (1.0 - uWetness * 0.15);

  // ── Combine masks ─────────────────────────────────────────────────────────
  float combinedMask = clamp(ringMask + innerMask * 0.45, 0.0, 1.0);
  float finalAlpha   = combinedMask * vSplashAlpha;

  gl_FragColor = vec4(ringColor * finalAlpha, finalAlpha);   // pre-multiplied
}


// ══════════════════════════════════════════════════════════════════════════════
// LENS DISTORTION — VERTEX
// ══════════════════════════════════════════════════════════════════════════════

// === LENS VERTEX ===

precision highp float;

varying vec2 vUv;

void main() {
  vUv         = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}


// ══════════════════════════════════════════════════════════════════════════════
// LENS DISTORTION — FRAGMENT
// ══════════════════════════════════════════════════════════════════════════════

// === LENS FRAGMENT ===

precision mediump float;

// ─── Uniforms ─────────────────────────────────────────────────────────────────

uniform sampler2D uSceneTex;    // Main scene render target (composite input)
uniform sampler2D uRainTex;     // Rain streak render target — alpha channel used
uniform float     uRainDensity; // 0–1
uniform float     uTime;
uniform vec2      uResolution;

// ─── Varyings ─────────────────────────────────────────────────────────────────

varying vec2 vUv;

// ─── Utility ──────────────────────────────────────────────────────────────────

// Fast pseudo-random for per-frame noise flicker on lens drops
float hash2d(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

void main() {
  if (uRainDensity < 0.01) {
    // No rain — pass scene through unchanged
    gl_FragColor = texture2D(uSceneTex, vUv);
    return;
  }

  // ── Base distortion: vertical streak from rain on lens ────────────────────
  // Sample the rain render target at this UV — brighter = more streaks nearby
  float rainAlpha  = texture2D(uRainTex, vUv).a;

  // Distortion magnitude: very subtle — real lens rain effect is small
  // Maximum pixel offset: 2.5 px at full density + full rain coverage
  float maxOffset  = 2.5 / uResolution.y;    // normalised to UV space
  float distortAmt = rainAlpha * uRainDensity * maxOffset;

  // Distortion direction: slightly downward (rain falls) + tiny lateral flicker
  // The lateral flicker simulates the lens drop trembling in wind.
  float lateralNoise = (hash2d(vUv + fract(uTime * 0.33)) - 0.5) * 0.35;
  vec2  distortDir   = vec2(lateralNoise, -1.0) * distortAmt;

  // ── Lens drop accumulation regions ────────────────────────────────────────
  // Lens drops create persistent localised distortion zones.  At high
  // uRainDensity, 3–5 drops cluster at random screen positions and create
  // magnifying-glass-like circular distortion patches.
  //
  // Implemented as a small number of radial distortion centres hard-coded
  // relative to screen, their positions driven by time-sliced random hashes.
  // Five potential drop sites — only active when density is high enough.

  vec2 accumulatedDrop = vec2(0.0);

  for (int i = 0; i < 5; i++) {
    float fi       = float(i);
    // Each drop has a slow drift trajectory + periodic respawn
    float dropSeed = hash2d(vec2(fi * 3.7, 2.1));
    float respawn  = floor(uTime / mix(4.0, 9.0, dropSeed));    // respawn every 4–9 s
    float dropX    = hash2d(vec2(dropSeed + respawn, fi + 0.3));
    float dropY    = hash2d(vec2(dropSeed + respawn, fi + 0.7));

    // Slight drift during life (the drop slides slowly down the lens)
    float dropAge  = fract(uTime / mix(4.0, 9.0, dropSeed));
    dropY         -= dropAge * 0.12;   // slide 12% of screen height over lifetime

    vec2  dropCenter = vec2(dropX, dropY);
    float dropDist   = length(vUv - dropCenter);

    // Drop radius: 3–6% of screen height
    float dropRadius = mix(0.03, 0.06, hash2d(vec2(fi * 7.1, 5.3)));

    // Only apply distortion if this drop is "active" (density threshold)
    float dropActive = step(0.5 - uRainDensity * 0.5, dropSeed);

    if (dropDist < dropRadius && dropActive > 0.5) {
      // Radial lens distortion inside the drop circle
      // Magnifying: UV pulled toward drop centre (converging)
      float dropStrength = (1.0 - dropDist / dropRadius);
      dropStrength       = pow(dropStrength, 2.0) * 0.025;
      vec2  toCenter     = normalize(dropCenter - vUv) * dropStrength;
      accumulatedDrop   += toCenter;

      // Chromatic aberration inside drop: R channel offset outward slightly
      // (handled implicitly by sampling offset per channel below)
    }
  }

  // ── Chromatic aberration from rain distortion ──────────────────────────────
  // The lens distortion is slightly wavelength-dependent — R channel barely
  // displaced, B channel most displaced (water has a mild chromatic refractive
  // spread in the visible range).
  vec2 totalDistort = distortDir + accumulatedDrop;

  vec2 uvR = vUv + totalDistort * 0.92;
  vec2 uvG = vUv + totalDistort;
  vec2 uvB = vUv + totalDistort * 1.08;

  // Clamp to prevent edge bleeding
  uvR = clamp(uvR, 0.001, 0.999);
  uvG = clamp(uvG, 0.001, 0.999);
  uvB = clamp(uvB, 0.001, 0.999);

  float r = texture2D(uSceneTex, uvR).r;
  float g = texture2D(uSceneTex, uvG).g;
  float b = texture2D(uSceneTex, uvB).b;
  float a = texture2D(uSceneTex, uvG).a;

  // ── Overall brightness reduction during heavy rain ─────────────────────────
  // Heavy precipitation scatters light forward — the world dims very slightly
  // through a curtain of rain (aerosol effect, not post-processed fog which
  // is handled separately in scene.js).
  float scatterDim = 1.0 - uRainDensity * 0.07;

  gl_FragColor = vec4(vec3(r, g, b) * scatterDim, a);
}
