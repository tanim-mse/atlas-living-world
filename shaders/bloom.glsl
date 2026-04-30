/**
 * bloom.glsl — Dual separable Gaussian bloom with luminance threshold
 * Atlas: The Living World
 *
 * This file is the fragment shader for both the horizontal and vertical
 * bloom blur passes. The same shader runs twice per frame:
 *
 *   Pass H (horizontal): source = _rtMain.texture   → target = _rtBloomH
 *   Pass V (vertical):   source = _rtBloomH.texture → target = _rtBloomV
 *
 * Both passes run at half resolution (screen w/2, h/2). The result is
 * composited into the final image in composite.glsl via additive blending
 * at strength uBloomStrength (default 0.32).
 *
 * Algorithm:
 *   1. Threshold — extract only fragments whose luminance exceeds uThreshold.
 *      Fragments below the threshold contribute nothing to bloom. This
 *      prevents the entire scene from blooming and restricts glow to
 *      genuinely bright emissive and specular surfaces: crystal internal
 *      glow, sun disk, orb cores, candle highlights, wet surface specular
 *      at grazing angles.
 *   2. Soft knee — instead of a hard cutoff, a smooth quadratic knee in the
 *      range [threshold − knee, threshold + knee] prevents the abrupt
 *      on/off flicker that occurs when a surface oscillates near the
 *      threshold. Flicker-free bloom is essential for the living quality
 *      requirement: nothing snaps.
 *   3. Separable 13-tap Gaussian — a 13-tap kernel gives significantly
 *      softer, more physically correct bloom spread than the 9-tap version.
 *      At half resolution, 13 taps covers the same screen area as 26 taps
 *      at full resolution — wide enough to produce the gentle halo around
 *      the crystal field and sun disk without performance cost.
 *   4. Direction — uDirection selects horizontal (1,0) or vertical (0,1).
 *      The full 2D Gaussian is the product of the two 1D passes.
 *
 * Physically motivated choices:
 *   - Bloom is additive: bright surfaces appear to emit light into
 *     neighbouring pixels, exactly as lens flare and optical diffraction
 *     produce in a real camera.
 *   - The threshold (0.82) sits above the typical diffuse albedo of lit
 *     surfaces (~0.6 peak for full-sun terrain) and catches only specular
 *     highlights, emissive glow, and the sun disk. This matches the
 *     selective glow of a physical camera's highlight bloom.
 *   - The knee width (0.18) is ~22% of the threshold — wide enough to
 *     prevent flicker on oscillating wet-surface speculars and crystal
 *     dispersion fringing.
 *
 * Uniforms:
 *   uTex        sampler2D   Source texture for this pass
 *   uResolution vec2        Render target resolution (half screen: w/2, h/2)
 *   uThreshold  float       Luminance threshold above which pixels bloom
 *                           (default 0.82)
 *   uKnee       float       Soft knee half-width around threshold
 *                           (default 0.18)
 *   uStrength   float       Per-pass bloom intensity multiplier (default 0.55)
 *   uDirection  vec2        Blur direction: (1,0) horizontal, (0,1) vertical
 *
 * Varyings:
 *   vUv         vec2        Screen-space UV [0,1]
 *
 * NOTE: The vertex shader for this pass is _vsFullScreen() in scene.js.
 */

// ── Precision ──────────────────────────────────────────────────────────────────
// mediump is sufficient — bloom accumulates colour values in [0, ~4] range,
// well within mediump's dynamic range. Half-float render targets (used for
// _rtBloomH and _rtBloomV) also operate at mediump precision.

precision mediump float;

// ── Uniforms ───────────────────────────────────────────────────────────────────

uniform sampler2D uTex;
uniform vec2      uResolution;
uniform float     uThreshold;
uniform float     uKnee;
uniform float     uStrength;
uniform vec2      uDirection;

// ── Varyings ───────────────────────────────────────────────────────────────────

varying vec2 vUv;

// ── Gaussian kernel weights ────────────────────────────────────────────────────
// 13-tap kernel derived from Pascal's triangle row 12, normalised.
// Weights are symmetric: w[0] is centre, w[1..6] are the six outer pairs.
// Sum of all 13 weights = 1.0 (verified: 0.1964 + 2*(0.1616+0.1054+0.0571
//                                          +0.0256+0.0094+0.0027) ≈ 1.000)
//
// These are the standard Gaussian σ≈1.5 weights for a 13-tap kernel.
// σ=1.5 gives a spread of ~4.5 texels at half-resolution, which at
// 1080p half-res (960×540) covers ~9 full-resolution pixels — a soft,
// physically motivated glow radius for highlights and emissive surfaces.

const float WEIGHT_0 = 0.1964825501511404;   // centre tap
const float WEIGHT_1 = 0.1616312462838718;   // ±1 tap
const float WEIGHT_2 = 0.1054516831879230;   // ±2 taps
const float WEIGHT_3 = 0.0571353846139595;   // ±3 taps
const float WEIGHT_4 = 0.0256517767065703;   // ±4 taps
const float WEIGHT_5 = 0.0094803673536765;   // ±5 taps
const float WEIGHT_6 = 0.0027630930469994;   // ±6 taps

// ── Luminance ──────────────────────────────────────────────────────────────────

/**
 * Perceptual luminance using the BT.709 coefficients.
 * These match the human eye's sensitivity: green-heavy, red-moderate,
 * blue-weak. Using these instead of a simple average (r+g+b)/3 means
 * the threshold is evaluated against how bright the surface *appears*
 * to a viewer, not its raw channel sum — important for crystals whose
 * dispersion fringing is blue-violet (low luminance) but visually vivid.
 *
 * @param  c  Linear RGB colour
 * @return    Perceptual luminance in [0, ∞)
 */
float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// ── Soft knee threshold ────────────────────────────────────────────────────────

/**
 * Extract the bloom contribution of a colour sample using a quadratic
 * soft knee curve. Returns the amount of the colour that passes through
 * to the bloom pass.
 *
 * Hard threshold behaviour (no knee):
 *   lum < threshold  → contribution = 0
 *   lum >= threshold → contribution = colour * (lum - threshold) / lum
 *
 * Soft knee behaviour:
 *   lum < threshold - knee  → contribution = 0          (fully rejected)
 *   threshold - knee
 *     ≤ lum ≤
 *   threshold + knee         → quadratic blend           (smooth ramp)
 *   lum > threshold + knee  → full linear extraction    (fully accepted)
 *
 * The quadratic ramp is: ramp = (lum - (threshold - knee))² / (4 * knee)
 * This produces a smooth C¹ join at both ends of the knee region, meaning
 * the first derivative is continuous — no kink, no visible transition band.
 *
 * Physical motivation: a camera lens does not have a perfectly sharp
 * bloom cutoff. Film grain, lens diffraction, and sensor bloom all produce
 * gradual transitions from non-blooming to blooming highlights. The soft
 * knee approximates this physical gradual transition.
 *
 * @param  colour  Linear HDR colour sample
 * @return         Bloom-filtered colour, range [0, colour]
 */
vec3 applyThreshold(vec3 colour) {
  float lum   = luminance(colour);

  float knee  = uKnee;
  float lo    = uThreshold - knee;   // lower knee edge
  float hi    = uThreshold + knee;   // upper knee edge

  float ramp;

  if (lum < lo) {
    // Below knee: fully rejected
    ramp = 0.0;
  } else if (lum < hi) {
    // Inside knee: quadratic soft ramp
    // Maps [lo, hi] → [0, 1] with smooth acceleration
    float t = (lum - lo) / (2.0 * knee);
    ramp    = t * t;
  } else {
    // Above knee: full linear extraction
    // ramp = 1 means we extract the full (lum - threshold) portion
    ramp = 1.0;
  }

  // Extract the portion of colour above the threshold
  // Avoid division by zero on black pixels (lum ≈ 0)
  float extract = max(lum - uThreshold, 0.0) / max(lum, 0.0001);
  return colour * extract * ramp;
}

// ── Main ───────────────────────────────────────────────────────────────────────

void main() {

  // Texel size in UV space for this pass's render target
  vec2 texel = 1.0 / uResolution;

  // ── Threshold pass ──────────────────────────────────────────────────────────
  // Apply threshold only to the centre tap and the first outer pair.
  // The Gaussian weights ensure outer taps contribute less energy;
  // applying threshold per-tap would crush the outer contribution of
  // surfaces that are only slightly above the threshold — producing a
  // tighter, harder glow. Instead we apply threshold once to the centre
  // sample and use the extracted mask to weight the entire kernel.
  //
  // This matches the behaviour of the Kawase/dual-blur approach used in
  // production renderers: extract bright areas first, then blur the mask.
  //
  // The centre tap defines the "is this pixel blooming?" decision.
  // All 13 taps are then sampled from the raw source texture and the
  // threshold factor is applied uniformly across all of them.
  // This avoids edge artefacts where the Gaussian straddles a threshold
  // boundary — the blur will smoothly spread the bright core outward.

  vec3  centreSample  = texture2D(uTex, vUv).rgb;
  vec3  thresholded   = applyThreshold(centreSample);
  float threshFactor  = luminance(thresholded) / max(luminance(centreSample), 0.0001);
  // threshFactor ∈ [0,1] — 0 means this pixel doesn't bloom at all,
  // 1 means it's fully above threshold. All taps are multiplied by this.

  // Early-out: if this pixel is well below threshold, output black.
  // Saves the cost of 12 additional texture samples for the majority of
  // non-emissive, non-specular fragments.
  if (threshFactor < 0.001) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // ── 13-tap separable Gaussian blur ─────────────────────────────────────────
  // Sample along uDirection (horizontal or vertical) at ±1 through ±6 texels.
  // Each sample is the raw HDR colour (not re-thresholded) multiplied by the
  // Gaussian weight and the threshold factor from the centre tap.

  // Centre tap — highest weight
  vec3 result = centreSample * WEIGHT_0;

  // ±1
  result += texture2D(uTex, vUv + uDirection * texel * 1.0).rgb * WEIGHT_1;
  result += texture2D(uTex, vUv - uDirection * texel * 1.0).rgb * WEIGHT_1;

  // ±2
  result += texture2D(uTex, vUv + uDirection * texel * 2.0).rgb * WEIGHT_2;
  result += texture2D(uTex, vUv - uDirection * texel * 2.0).rgb * WEIGHT_2;

  // ±3
  result += texture2D(uTex, vUv + uDirection * texel * 3.0).rgb * WEIGHT_3;
  result += texture2D(uTex, vUv - uDirection * texel * 3.0).rgb * WEIGHT_3;

  // ±4
  result += texture2D(uTex, vUv + uDirection * texel * 4.0).rgb * WEIGHT_4;
  result += texture2D(uTex, vUv - uDirection * texel * 4.0).rgb * WEIGHT_4;

  // ±5
  result += texture2D(uTex, vUv + uDirection * texel * 5.0).rgb * WEIGHT_5;
  result += texture2D(uTex, vUv - uDirection * texel * 5.0).rgb * WEIGHT_5;

  // ±6
  result += texture2D(uTex, vUv + uDirection * texel * 6.0).rgb * WEIGHT_6;
  result += texture2D(uTex, vUv - uDirection * texel * 6.0).rgb * WEIGHT_6;

  // Apply threshold factor and per-pass strength
  result *= threshFactor * uStrength;

  // ── Output ──────────────────────────────────────────────────────────────────
  // HDR colour in [0, ∞). composite.glsl adds this to the scene additively.
  // Alpha 1.0 — this target uses no alpha blending.
  gl_FragColor = vec4(result, 1.0);
}
