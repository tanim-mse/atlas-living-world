/**
 * wind.glsl — Shared wind animation library
 * Atlas: The Living World
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This file is a GLSL function library, not a standalone shader.
 * It is injected into vertex shaders at build time via string concatenation
 * or fetch-and-prepend before the consuming shader's main() function.
 *
 * Every organism in Atlas that moves with the wind — grass blades, flower
 * stems, tree branches, wisteria vines — uses the functions defined here.
 * No organism reimplements its own wind logic; all consume this file and
 * call the appropriate function for their geometry type.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * PHYSICAL MODEL
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Wind in Atlas is not a simple sine wave oscillating each object. It is a
 * spatially coherent travelling disturbance propagating across the landscape
 * in the current wind direction — the same wave that moves through a real
 * field of grass or a forest canopy.
 *
 * The model has three layers:
 *
 *   1. BASE SWAY — Three superimposed sinusoidal frequencies per organism.
 *      Each frequency targets a distinct mechanical resonance:
 *        Freq 1 (primary):   Structural sway — the whole stem bends
 *        Freq 2 (secondary): Mid-body rustle — upper half oscillates on top
 *        Freq 3 (tertiary):  Tip flutter     — fine rapid tremor at the tip
 *      Amplitudes: 1.00 : 0.28 : 0.10 (consistent with natural damping)
 *
 *   2. SPATIAL TRAVELLING WAVE — The phase of every frequency is offset by
 *      dot(worldXZ, windDir) × waveScale. This means wind arrives at each
 *      point in sequence, never simultaneously — a visible wave crosses the
 *      field. The scale 0.14 gives a wavelength of ~45 world-units (45m),
 *      which reads correctly at Atlas's 1:1 world scale.
 *
 *   3. GUST — A slow low-frequency (≈0.5 Hz) swell that modulates the total
 *      displacement amplitude. The gust is per-instance-phase-offset so no
 *      two organisms receive an identical gust simultaneously. During a gust
 *      the wave amplitude rises abruptly and decays over a few seconds —
 *      matching the signature shape of natural wind gusts.
 *
 * HEIGHT POWER — displacement is multiplied by pow(heightNorm, exponent).
 * Exponent 2.2 is used for grass (strongly anchored roots).
 * Exponent 1.8 is used for flower stems (somewhat stiffer at mid-height).
 * Exponent 1.5 is used for tree branches (stiff trunk, mobile canopy).
 * Exponent 2.8 is used for leaf tips (maximum tip mobility).
 * These exponents are passed as parameters — this library does not hard-code
 * organism-specific values.
 *
 * WETNESS SAG — When uWetness > 0, organisms sag under the weight of
 * accumulated water. Sag is applied as a negative Y displacement at tip
 * vertices, proportional to heightNorm × uWetness. This is physically correct:
 * rain adds mass at the tip where the lever arm is longest.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * UNIFORMS REQUIRED BY CONSUMING SHADERS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every shader that includes this file must declare these uniforms:
 *
 *   uniform float uTime;          // Elapsed seconds since scene start
 *   uniform float uWindStrength;  // 0.0 (dead calm) → 1.0 (gale force)
 *   uniform float uWindGust;      // Instantaneous gust amplitude [0, 1]
 *   uniform vec2  uWindDir;       // Normalised XZ wind direction vector
 *   uniform float uWetness;       // Global wetness [0, 1]
 *
 * The shader may also declare these, which enhance the wind model when present:
 *
 *   attribute float aPhase;       // Per-instance random phase [0, 2π]
 *   (or uniform float uPhase for non-instanced geometry like petals)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * API — FUNCTIONS EXPORTED BY THIS FILE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   windTravellingPhase(worldXZ, instancePhase)
 *     Returns the spatial + instance phase for a point.
 *     Used internally by all displacement functions.
 *     Call directly when building a custom displacement for unusual geometry.
 *
 *   windGustEnvelope(phase)
 *     Returns the current gust multiplier [0, 1+] at a given phase offset.
 *     Encodes the characteristic abrupt-rise / slow-decay gust shape.
 *
 *   windDisplacementGrass(worldPos, instancePhase, heightNorm)
 *     XZ displacement for a grass blade vertex.
 *     Returns vec2(displaceX, displaceZ) in world space.
 *     Caller applies: worldPos.xz += windDisplacementGrass(...) * windDir;
 *
 *   windDisplacementStem(worldPos, instancePhase, heightNorm, stiffness)
 *     XZ displacement for a flower or vine stem vertex.
 *     stiffness: 0.0=flexible, 1.0=rigid. Scales the total amplitude down.
 *     Returns vec2(displaceX, displaceZ).
 *
 *   windDisplacementBranch(worldPos, instancePhase, heightNorm, depth)
 *     XZ displacement for a tree branch vertex.
 *     depth: L-system depth [0=trunk, 1=primary branch, …, N=twig].
 *     Higher depth = lighter branch = more responsive.
 *     Returns vec2(displaceX, displaceZ).
 *
 *   windDisplacementPetal(instancePhase, heightNorm)
 *     Local-space XZ flutter for a petal vertex.
 *     Petals are small and rigid relative to the stem — they don't
 *     travel with the spatial wave, they vibrate in local space.
 *     Returns vec3(displaceX, displaceY, displaceZ) in LOCAL petal space.
 *     Caller applies the result before model matrix transform.
 *
 *   windDisplacementLeaf(worldPos, instancePhase, heightNorm)
 *     XZ displacement for a tree leaf instance.
 *     Higher frequency than branches, additional twist component.
 *     Returns vec3(displaceX, displaceY, displaceZ) — includes a twist.
 *
 *   windWetnessYSag(heightNorm, heightScale)
 *     Downward Y displacement from water weight on tip.
 *     heightScale: the organism's actual height in world units.
 *     Returns float — subtract from worldPos.y.
 *
 *   windSpatialHash(worldXZ)
 *     Low-cost 2D hash returning [0,1]. Useful for breaking up visual
 *     repetition in amplitude: multiply displacement by (0.85 + 0.15 * hash).
 *     Not used internally by displacement functions — offered for callers.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * USAGE PATTERN IN A CONSUMING VERTEX SHADER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   // ── Grass blade example ───────────────────────────────────────────────
 *   // (file is prepended before this shader's main())
 *
 *   void main() {
 *     vec3 pos = position;
 *     pos.y   *= aScaleY;
 *
 *     vec4 worldPos4 = instanceMatrix * vec4(pos, 1.0);
 *     vec3 worldPos  = worldPos4.xyz;
 *
 *     vec2 disp = windDisplacementGrass(worldPos, aPhase, aNormalised);
 *     worldPos.x += disp.x;
 *     worldPos.z += disp.y;
 *     worldPos.y -= windWetnessYSag(aNormalised, aScaleY);
 *
 *     gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
 *   }
 *
 *   // ── Petal example ─────────────────────────────────────────────────────
 *   void main() {
 *     vec3 pos  = position;
 *     float tipT = smoothstep(0.25, 1.0, uv.y);
 *
 *     vec3 flutter = windDisplacementPetal(uPhase, tipT);
 *     pos += flutter;
 *
 *     vec4 worldPos4 = modelMatrix * vec4(pos, 1.0);
 *     gl_Position    = projectionMatrix * viewMatrix * worldPos4;
 *   }
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * PRECISION POLICY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This library uses highp float throughout. Wind displacement involves
 * large world-space coordinates (up to ±5000 units) dotted against direction
 * vectors — mediump would introduce visible quantisation artefacts in the
 * spatial phase. Consuming fragment shaders may use mediump for their own
 * calculations; this library is vertex-only and is never included in fragments.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * FREQUENCY TABLE — all values in Hz, all verified against perceived realism
 * at 1:1 world scale (1 unit = 1 metre)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   GRASS_FREQ_1   0.62  — primary sway  (matches field grass in light wind)
 *   GRASS_FREQ_2   1.38  — mid rustle
 *   GRASS_FREQ_3   2.90  — tip flutter
 *   STEM_FREQ_1    0.55  — slower than grass (stiffer stem, higher mass)
 *   STEM_FREQ_2    1.20
 *   STEM_FREQ_3    2.60
 *   BRANCH_FREQ_1  0.38  — tree branches oscillate slowly
 *   BRANCH_FREQ_2  0.82
 *   BRANCH_FREQ_3  1.75
 *   PETAL_FREQ_1   6.40  — petals are light — very fast flutter
 *   PETAL_FREQ_2   9.80
 *   PETAL_FREQ_3  14.20
 *   LEAF_FREQ_1    1.60  — leaves: between petals and branches
 *   LEAF_FREQ_2    3.40
 *   LEAF_FREQ_3    7.10
 *   GUST_FREQ      0.48  — gust envelope oscillation
 */

// ─── Required uniforms (declared in consuming shader) ─────────────────────────
//
// The following are NOT re-declared here to avoid duplicate-declaration errors
// when this file is prepended to a shader that already has them:
//
//   uniform float uTime;
//   uniform float uWindStrength;
//   uniform float uWindGust;
//   uniform vec2  uWindDir;
//   uniform float uWetness;
//
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — INTERNAL CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

// Relative amplitude weights for the three frequencies.
// Sum ≈ 1.38 — normalised downstream by the per-function scale factor.
#define WIND_AMP_1  1.00
#define WIND_AMP_2  0.28
#define WIND_AMP_3  0.10

// Travelling wave scale: spatial phase per world-unit along wind direction.
// 0.14 → wavelength of 2π/0.14 ≈ 44.9 units (≈45 metres).
// At walking speed (~1.4 u/s) the camera crosses one full wave in ~32 seconds.
#define WIND_WAVE_SCALE  0.14

// Amplitude normalisation: divides raw three-frequency sum to keep peak
// displacement within a predictable range regardless of amplitude weights.
// Raw peak of (1.00 + 0.28 + 0.10) = 1.38; dividing by 1.38 gives [−1, +1].
#define WIND_AMP_NORM  1.38

// Gust shape constants
#define GUST_RISE_EXP   4.0   // Sharp rise: pow(sin, 4) — narrow attack peak
#define GUST_DECAY_MUL  0.50  // Slow decay: gust envelope multiplied down

// Two-Pi — cached to avoid repeated literal in phase computations
#define TWO_PI  6.28318530718

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * windSpatialHash — fast 2D hash, returns [0, 1].
 *
 * Used by callers to break amplitude uniformity across the field.
 * Not used internally by any displacement function (performance critical path).
 *
 * @param worldXZ  vec2  XZ world-space position
 * @returns        float  [0, 1]
 */
float windSpatialHash(vec2 worldXZ) {
    return fract(sin(dot(worldXZ, vec2(127.1, 311.7))) * 43758.5453);
}

/**
 * windTravellingPhase — compute the composite phase for a point in the world.
 *
 * Phase = spatialPhase + instancePhase
 *   spatialPhase = dot(worldXZ, uWindDir) × WIND_WAVE_SCALE
 *     → Creates the travelling wave: points upwind receive the oscillation
 *       first; points downwind receive it later, in sequence.
 *   instancePhase = aPhase (per-blade / per-stem random offset)
 *     → Prevents all organisms from being in phase sync even if spatially close.
 *
 * This is the single most important function in this library. Every displacement
 * function calls it. Getting this phase right is what makes the field look like
 * it moves together instead of every blade doing its own private oscillation.
 *
 * @param worldXZ       vec2   XZ component of world-space position
 * @param instancePhase float  Per-instance random phase [0, 2π]
 * @returns             float  Combined phase value
 */
float windTravellingPhase(vec2 worldXZ, float instancePhase) {
    float spatial = dot(worldXZ, uWindDir) * WIND_WAVE_SCALE;
    return spatial + instancePhase;
}

/**
 * windGustEnvelope — return the gust amplitude multiplier at a given phase.
 *
 * The gust envelope is designed to feel like a natural wind gust:
 *   - Abrupt attack: pow(max(sin(gustOsc), 0), GUST_RISE_EXP) produces a
 *     narrow, sharp positive half-cycle with a flat zero baseline between gusts.
 *   - The gust frequency (0.48 Hz) means approximately one gust every 2 seconds.
 *   - Instance phase offsets ensure gusts arrive at different moments per plant.
 *
 * Return value is added to the normalised base displacement, so a gust of
 * strength 1.0 at peak doubles the effective wind strength momentarily.
 *
 * @param instancePhase  float  Per-instance phase [0, 2π]
 * @returns              float  Gust multiplier [0, ~1]
 */
float windGustEnvelope(float instancePhase) {
    // 0.48 Hz base gust oscillation, per-instance offset
    float gustOsc = sin(uTime * 0.48 * TWO_PI + instancePhase * 0.7);
    // Only positive half-cycles become gusts; negatives are clamped to 0
    float gustPeak = pow(max(gustOsc, 0.0), GUST_RISE_EXP);
    // uWindGust is the current gust strength from state.wind.gustStrength [0,1]
    return gustPeak * uWindGust;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — GRASS DISPLACEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * windDisplacementGrass — XZ displacement for a grass blade vertex.
 *
 * Three sinusoidal frequencies with spatial travelling phase:
 *   0.62 Hz — primary sway: the whole blade bends with the field wave
 *   1.38 Hz — secondary rustle: the upper half oscillates on top of primary
 *   2.90 Hz — tip flutter: rapid small-amplitude tremor at tips
 *
 * heightNorm controls how much each vertex moves. It should be
 * aNormalised^2.2 — the 2.2 exponent means:
 *   - Ground-level vertices (norm=0): zero displacement (roots are anchored)
 *   - Mid-blade (norm=0.5): 0.5^2.2 ≈ 0.22 of full amplitude
 *   - Tip (norm=1.0): full amplitude
 * This power curve is what makes grass look physically rooted rather than
 * swinging rigidly from a fixed base.
 *
 * The gust envelope is added on top, providing an amplitude swell that
 * sweeps across the field coherently (same travelling phase, same timing).
 *
 * @param worldPos      vec3   World-space vertex position (post-instance-matrix)
 * @param instancePhase float  Per-blade unique phase from aPhase [0, 2π]
 * @param heightNorm    float  pow(aNormalised, 2.2) — height power curve
 * @returns             vec2   World-space XZ displacement (apply along uWindDir)
 */
vec2 windDisplacementGrass(vec3 worldPos, float instancePhase, float heightNorm) {
    float phase = windTravellingPhase(worldPos.xz, instancePhase);

    // Three overlapping frequencies — identical phase base, different freq multipliers
    // and slight phase offsets to prevent harmonic locking (which would look artificial)
    float d1 = WIND_AMP_1 * sin(0.62 * uTime * TWO_PI + phase);
    float d2 = WIND_AMP_2 * sin(1.38 * uTime * TWO_PI + phase * 1.30 + 0.80);
    float d3 = WIND_AMP_3 * sin(2.90 * uTime * TWO_PI + phase * 2.10 + 1.60);

    // Normalised three-frequency sum, scaled by base wind strength
    float baseDisp = (d1 + d2 + d3) / WIND_AMP_NORM * uWindStrength;

    // Gust swell — abrupt amplitude peak, decays over ~2 seconds
    float gust = windGustEnvelope(instancePhase);

    // Total displacement along wind direction, height-powered
    float totalDisp = (baseDisp + gust) * heightNorm;

    // Return the 2D displacement — caller applies: pos.xz += disp * uWindDir
    // Returning vec2 rather than pre-applying wind direction gives the caller
    // control over the scaling axis (useful for organisms that lean differently).
    return vec2(totalDisp * uWindDir.x, totalDisp * uWindDir.y);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — STEM DISPLACEMENT (flowers, vines)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * windDisplacementStem — XZ displacement for a flower stem or vine segment.
 *
 * Stems are stiffer than grass blades (larger cross-section, higher second
 * moment of area relative to their mass) — they sway more slowly and with
 * less overall amplitude at the same wind strength.
 *
 * Compared to grass:
 *   - Primary frequency 0.55 Hz (vs 0.62): slower structural resonance
 *   - Stiffness parameter [0,1] linearly scales total amplitude down
 *   - Height exponent is passed as heightNorm (caller computes the power)
 *     Typical: pow(aNormalised, 1.8) for flower stems
 *
 * The lateral displacement (perpendicular to wind) is added as a smaller
 * secondary component — stems also wobble slightly sideways, especially
 * during gusts. This prevents stems from swinging in a single plane, which
 * looks mechanical and false.
 *
 * @param worldPos      vec3   World-space vertex position
 * @param instancePhase float  Per-stem unique phase [0, 2π]
 * @param heightNorm    float  Height power value (caller applies pow())
 * @param stiffness     float  0.0=flexible (tall thin stems), 1.0=rigid (short woody stems)
 * @returns             vec2   World-space XZ displacement
 */
vec2 windDisplacementStem(vec3 worldPos, float instancePhase, float heightNorm, float stiffness) {
    float phase = windTravellingPhase(worldPos.xz, instancePhase);

    // Primary sway — slower than grass
    float d1 = WIND_AMP_1 * sin(0.55 * uTime * TWO_PI + phase);
    float d2 = WIND_AMP_2 * sin(1.20 * uTime * TWO_PI + phase * 1.25 + 0.65);
    float d3 = WIND_AMP_3 * sin(2.60 * uTime * TWO_PI + phase * 2.05 + 1.45);

    float baseDisp = (d1 + d2 + d3) / WIND_AMP_NORM * uWindStrength;
    float gust     = windGustEnvelope(instancePhase);

    // Stiffness reduces amplitude: stiff=1 → amplitude×0.4; flex=0 → amplitude×1.0
    float stiffScale = mix(1.0, 0.40, stiffness);

    // Lateral wobble — perpendicular to wind direction, lower amplitude
    // Computed using the wind direction's perpendicular: (-windDir.y, windDir.x)
    float lateralPhase = phase * 0.73 + 1.22;
    float lateral = WIND_AMP_2 * sin(0.68 * uTime * TWO_PI + lateralPhase)
                  * uWindStrength * 0.22;

    // Combine: primary along wind, lateral across wind
    float mainDisp    = (baseDisp + gust) * heightNorm * stiffScale;
    float latDisp     = lateral           * heightNorm * stiffScale;

    // Wind direction perpendicular (rotate 90°): (-uWindDir.y, uWindDir.x)
    vec2 windPerp = vec2(-uWindDir.y, uWindDir.x);

    return vec2(mainDisp * uWindDir.x + latDisp * windPerp.x,
                mainDisp * uWindDir.y + latDisp * windPerp.y);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — BRANCH DISPLACEMENT (trees)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * windDisplacementBranch — XZ displacement for a tree branch vertex.
 *
 * Trees respond to wind through two distinct mechanisms:
 *
 *   1. Canopy sway — the whole canopy mass oscillates at the tree's natural
 *      frequency, which for a tree of 6–15 metres is approximately 0.2–0.5 Hz.
 *      This is the slow, majestic back-and-forth of a tree in a strong wind.
 *
 *   2. Branch flutter — individual branches oscillate at their own frequency,
 *      which increases with L-system depth (shallower branches = longer,
 *      heavier, slower; deeper branches = shorter, lighter, faster).
 *
 * The `depth` parameter encodes L-system depth [0=trunk, 1=primary, …, N=twig].
 * A normalised depth (0–1) is passed; depth 0 means trunk, depth 1 means
 * the finest twigs. This drives:
 *   - Frequency scaling: higher depth → higher frequency
 *   - Amplitude scaling: higher depth → more displacement (less structural stiffness)
 *   - Phase individuality: higher depth → more phase randomisation relative to trunk
 *
 * Trunk vertices (depth=0) barely move — they just transmit force to branches.
 * Primary branches (depth≈0.25) sway gently with the canopy.
 * Twigs (depth≈1.0) flutter rapidly and independently.
 *
 * @param worldPos      vec3   World-space vertex position
 * @param instancePhase float  Per-tree unique phase [0, 2π]
 * @param heightNorm    float  Normalised height within the tree [0, 1]
 * @param depth         float  Normalised L-system depth [0=trunk, 1=finest twig]
 * @returns             vec2   World-space XZ displacement
 */
vec2 windDisplacementBranch(vec3 worldPos, float instancePhase, float heightNorm, float depth) {
    // Blend phase: trunk phase is purely spatial; twigs add depth-based offset
    // This makes every branch diverge from the main canopy sway progressively.
    float depthPhaseOffset = depth * instancePhase * 0.62;
    float phase = windTravellingPhase(worldPos.xz, instancePhase + depthPhaseOffset);

    // Canopy sway — low frequency, driven by total tree mass (all branches share it)
    float canopyF1 = WIND_AMP_1 * sin(0.38 * uTime * TWO_PI + phase);
    float canopyF2 = WIND_AMP_2 * sin(0.82 * uTime * TWO_PI + phase * 1.18 + 0.55);

    // Branch flutter — frequency scales with depth
    // At depth=0 (trunk): flutter frequency = 0.38 Hz (same as canopy, adds nothing extra)
    // At depth=1 (twig):  flutter frequency = 1.75 Hz (rapid independent flutter)
    float branchFreq = mix(0.38, 1.75, depth);
    float branchF3   = WIND_AMP_3 * sin(branchFreq * uTime * TWO_PI + phase * 1.88 + 1.30);

    // Canopy and flutter combined
    float canopyDisp  = (canopyF1 + canopyF2) / WIND_AMP_NORM * uWindStrength;
    float flutterDisp = branchF3 * uWindStrength;

    // Gust strongly affects canopy; twigs are already moving fast so gust adds less
    float gust = windGustEnvelope(instancePhase) * mix(1.0, 0.4, depth);

    // Depth-dependent amplitude scaling:
    //   Trunk (depth=0): very little movement → amplitudes × 0.05
    //   Primary branches (depth≈0.3): moderate → × 0.30
    //   Twigs (depth=1): full → × 1.00
    float depthAmp = mix(0.05, 1.00, smoothstep(0.0, 1.0, depth));

    // Height also matters — lower trunk moves less than upper canopy
    float heightAmp = mix(0.02, 1.00, pow(heightNorm, 1.5));

    float totalDisp = (canopyDisp + flutterDisp + gust) * depthAmp * heightAmp;

    // Lateral wobble — proportional to gust strength and depth
    float latPhase   = phase * 0.68 + 2.10;
    float lateral    = 0.18 * sin(0.55 * uTime * TWO_PI + latPhase) * uWindStrength * depth;
    vec2  windPerp   = vec2(-uWindDir.y, uWindDir.x);

    return vec2(totalDisp * uWindDir.x + lateral * windPerp.x,
                totalDisp * uWindDir.y + lateral * windPerp.y);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — PETAL FLUTTER (flowers)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * windDisplacementPetal — local-space flutter for a petal vertex.
 *
 * Petals are fundamentally different from stems and grass:
 *   - They are rigid relative to their own size — they don't bend along their
 *     length; the whole petal rotates slightly around its attachment point.
 *   - They don't travel with the landscape-scale spatial wave —
 *     they are too small for the 45-metre wavelength to be meaningful.
 *   - Instead they respond to turbulent micro-fluctuations close to the flower
 *     head, which are modelled as high-frequency local flutter.
 *
 * The three flutter frequencies (6.4, 9.8, 14.2 Hz) are much higher than
 * stem or grass frequencies. Each axis (X, Z, Y) uses a different frequency
 * to avoid the motion looking like a single oscillation:
 *   X — lateral flutter (petal swings sideways around its Y-axis base)
 *   Z — fore-aft ripple (petal rocks around its X-axis base)
 *   Y — slight lift/drop at tip (changes apparent length of petal from camera)
 *
 * The `heightNorm` parameter is the petal's own tip factor — smoothstep
 * from 0 (base) to 1 (tip). Petal bases are pinned at the disk; only tips move.
 *
 * IMPORTANT: This function returns a LOCAL-space displacement.
 * The caller must apply it BEFORE the model matrix transform:
 *   pos += windDisplacementPetal(uPhase, tipFactor);
 *   gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(pos, 1.0);
 *
 * @param instancePhase  float  Per-petal unique phase (uPhase uniform) [0, 2π]
 * @param heightNorm     float  Tip factor: smoothstep(0.25, 1.0, uv.y)
 * @returns              vec3   Local-space displacement (X, Y, Z)
 */
vec3 windDisplacementPetal(float instancePhase, float heightNorm) {
    // High-frequency flutter: small displacements, large frequency differences
    // so X and Z motions are visually independent (avoid "nodding" artifact)
    float fX = WIND_AMP_1 * sin(6.40 * uTime * TWO_PI + instancePhase)
             * 0.010 * uWindStrength;
    float fZ = WIND_AMP_2 * sin(9.80 * uTime * TWO_PI + instancePhase * 1.70)
             * 0.007 * uWindStrength;
    float fY = WIND_AMP_3 * sin(14.2 * uTime * TWO_PI + instancePhase * 0.85)
             * 0.005 * uWindStrength;

    // Gust adds a brief larger flutter as turbulence increases
    float gust  = windGustEnvelope(instancePhase) * 0.015;
    float gustX = gust * sin(uTime * 3.10 + instancePhase);
    float gustZ = gust * cos(uTime * 2.70 + instancePhase * 1.3);

    // All motion gated by height: base is pinned, tip flutters freely
    return vec3(
        (fX + gustX) * heightNorm,
        fY           * heightNorm * heightNorm,   // Y: quadratic — only very tips lift
        (fZ + gustZ) * heightNorm
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — LEAF DISPLACEMENT (tree leaves)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * windDisplacementLeaf — world-space flutter for a tree leaf instance.
 *
 * Tree leaves sit at the intersection of branch motion and petal-like flutter.
 * They travel with the branch spatial wave (much wider influence than petals),
 * but they also twist and flicker rapidly because of their flat geometry and
 * low mass.
 *
 * The twist component is unique to leaves: the leaf petiole allows the leaf
 * blade to rotate around its long axis in wind. This is modelled as a small
 * Y-axis displacement that makes the leaf appear to rotate when accumulated
 * with the branch's rotation in the tree.js shader.
 *
 * Frequencies (1.6, 3.4, 7.1 Hz) are between petal flutter and branch sway —
 * appropriate for the mass of a single leaf.
 *
 * @param worldPos      vec3   World-space leaf position
 * @param instancePhase float  Per-leaf unique phase [0, 2π]
 * @param heightNorm    float  Normalised height of attachment point on tree [0,1]
 * @returns             vec3   World-space displacement (XYZ)
 */
vec3 windDisplacementLeaf(vec3 worldPos, float instancePhase, float heightNorm) {
    // Leaf participates in the spatial travelling wave at branch scale
    float phase = windTravellingPhase(worldPos.xz, instancePhase);

    // Three frequencies — leaf is lighter than branch so frequencies are higher
    float d1 = WIND_AMP_1 * sin(1.60 * uTime * TWO_PI + phase);
    float d2 = WIND_AMP_2 * sin(3.40 * uTime * TWO_PI + phase * 1.40 + 0.90);
    float d3 = WIND_AMP_3 * sin(7.10 * uTime * TWO_PI + phase * 2.20 + 1.80);

    float baseDisp = (d1 + d2 + d3) / WIND_AMP_NORM * uWindStrength;
    float gust     = windGustEnvelope(instancePhase) * 1.20; // leaves respond strongly to gusts

    float totalXZ  = (baseDisp + gust) * mix(0.3, 1.0, heightNorm);

    // Twist component — Y displacement creates apparent petiole rotation.
    // Uses a different phase multiplier to decouple from XZ motion.
    float twistPhase = phase * 0.55 + instancePhase * 0.38;
    float twist      = sin(2.80 * uTime * TWO_PI + twistPhase)
                     * uWindStrength * 0.008;

    vec2 windPerp = vec2(-uWindDir.y, uWindDir.x);

    // XZ: primary along wind, small component across wind for leaf twist effect
    return vec3(
        totalXZ * uWindDir.x + twist * windPerp.x,
        twist * 0.5,
        totalXZ * uWindDir.y + twist * windPerp.y
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — WETNESS SAG
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * windWetnessYSag — downward Y displacement from water weight accumulation.
 *
 * When rain falls (uWetness > 0), water accumulates on surfaces. The mass
 * of this water pulls tips downward. The effect is:
 *   - Proportional to uWetness: more rain = heavier tips
 *   - Proportional to heightNorm: tips carry the most accumulated water
 *     (rain hits them first) and have the longest moment arm
 *   - Proportional to heightScale: taller organisms sag more absolutely
 *     because their tips are farther from the ground
 *
 * Sag is a static offset, not an oscillation — it adds to the equilibrium
 * position of the organism. Wind still oscillates around the sagged position.
 *
 * Application:
 *   worldPos.y -= windWetnessYSag(heightNorm, stemHeight);
 *
 * Values are calibrated so a fully soaked (uWetness=1.0) grass blade
 * at its tip (heightNorm=1.0) with height 0.5m sags by 0.03 metres —
 * a visible but not exaggerated droop matching observed behaviour.
 *
 * @param heightNorm   float  Per-vertex normalised height [0=root, 1=tip]
 * @param heightScale  float  Organism height in world units (e.g. stem height)
 * @returns            float  Positive magnitude to subtract from worldPos.y
 */
float windWetnessYSag(float heightNorm, float heightScale) {
    // 0.06 is the calibrated sag coefficient for Atlas's world scale.
    // At uWetness=1.0, tipNorm=1.0, height=1.0m: sag = 0.06m (6cm tip drop).
    // Grass at 0.5m max height: 0.06 × 1.0 × 0.5 = 0.03m. Correct.
    // Sunflower at 1.2m: 0.06 × 1.0 × 1.2 = 0.072m. Slightly dramatic but
    // sunflowers with wet heads do droop visibly — accepted.
    return uWetness * heightNorm * heightScale * 0.06;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — COMPOSITE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * windApplyToWorldPos — apply grass wind displacement and wetness sag together.
 *
 * Convenience function for the common case of a grass blade or similar vertical
 * organism: compute displacement, apply it to worldPos, and return the result.
 * Keeps grass.js vertex shader main() free of wind boilerplate.
 *
 * @param worldPos      vec3   Input world-space position (modified in-place)
 * @param instancePhase float  aPhase
 * @param heightPow     float  pow(aNormalised, 2.2)
 * @param heightNorm    float  aNormalised (for wetness sag)
 * @param heightScale   float  aScaleY (for wetness sag magnitude)
 * @returns             vec3   Modified world position
 */
vec3 windApplyToWorldPos(vec3 worldPos,
                         float instancePhase,
                         float heightPow,
                         float heightNorm,
                         float heightScale)
{
    // XZ displacement
    vec2 disp    = windDisplacementGrass(worldPos, instancePhase, heightPow);
    worldPos.x  += disp.x;
    worldPos.z  += disp.y;

    // Y sag from wet weight
    worldPos.y  -= windWetnessYSag(heightNorm, heightScale);

    return worldPos;
}

/**
 * windApplyToStem — apply stem wind displacement and wetness sag together.
 *
 * @param worldPos      vec3
 * @param instancePhase float
 * @param heightPow     float  pow(heightNorm, 1.8) — pre-computed by caller
 * @param heightNorm    float  Raw normalised height [0,1]
 * @param heightScale   float  Stem height in world units
 * @param stiffness     float  [0=flexible, 1=rigid]
 * @returns             vec3   Modified world position
 */
vec3 windApplyToStem(vec3 worldPos,
                     float instancePhase,
                     float heightPow,
                     float heightNorm,
                     float heightScale,
                     float stiffness)
{
    vec2 disp   = windDisplacementStem(worldPos, instancePhase, heightPow, stiffness);
    worldPos.x += disp.x;
    worldPos.z += disp.y;
    worldPos.y -= windWetnessYSag(heightNorm, heightScale);
    return worldPos;
}

/**
 * windApplyToBranch — apply branch wind displacement and wetness sag together.
 *
 * @param worldPos      vec3
 * @param instancePhase float
 * @param heightNorm    float  [0=base, 1=top of tree]
 * @param depth         float  [0=trunk, 1=finest twig]
 * @param heightScale   float  Full tree height
 * @returns             vec3   Modified world position
 */
vec3 windApplyToBranch(vec3 worldPos,
                       float instancePhase,
                       float heightNorm,
                       float depth,
                       float heightScale)
{
    vec2 disp   = windDisplacementBranch(worldPos, instancePhase, heightNorm, depth);
    worldPos.x += disp.x;
    worldPos.z += disp.y;
    // Branches: wet sag amplified by depth (twigs hang more than trunk)
    worldPos.y -= windWetnessYSag(heightNorm, heightScale) * mix(0.2, 1.0, depth);
    return worldPos;
}

// ═══════════════════════════════════════════════════════════════════════════════
// END OF wind.glsl
// ═══════════════════════════════════════════════════════════════════════════════
//
// Consuming vertex shader template (copy and fill in organism-specific parts):
//
//   // [prepend wind.glsl content here at shader assembly time]
//
//   precision highp float;
//
//   // Wind uniforms — required by wind.glsl
//   uniform float uTime;
//   uniform float uWindStrength;
//   uniform float uWindGust;
//   uniform vec2  uWindDir;
//   uniform float uWetness;
//
//   // Organism-specific uniforms...
//   attribute float aPhase;
//
//   void main() {
//     // 1. Get local position
//     vec3 pos = position;
//
//     // 2. Scale / instance transform to world space
//     vec4 worldPos4 = instanceMatrix * vec4(pos, 1.0);
//     vec3 worldPos  = worldPos4.xyz;
//
//     // 3. Compute height factor
//     float heightNorm = aNormalised;
//     float heightPow  = pow(heightNorm, 2.2);
//
//     // 4. Apply wind (choose the appropriate helper)
//     worldPos = windApplyToWorldPos(worldPos, aPhase, heightPow, heightNorm, aScaleY);
//
//     // 5. Project
//     gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
//   }
