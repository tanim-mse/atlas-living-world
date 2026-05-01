/**
 * composite.glsl — Final post-processing composite pass
 * Atlas: The Living World
 *
 * This is the last shader in the rendering pipeline. It reads three textures
 * produced by earlier passes and composes them into the final LDR image that
 * is written directly to the screen (null render target in scene.js).
 *
 * Pipeline — applied in strict order:
 *
 *   1. Chromatic aberration
 *        Radially offset R, G, B channels outward from screen centre.
 *        Simulates lateral chromatic aberration in a real camera lens.
 *        The offset magnitude grows with distance from centre so corners
 *        are most affected, matching physical lens behaviour.
 *        Applied first, before any tone mapping, so it operates on HDR data
 *        and produces the correct fringing on bloom halos.
 *
 *   2. SSAO multiply
 *        Multiplies the scene colour by the SSAO occlusion map. The map is
 *        at half resolution and bilinearly upscaled by the GPU's sampler.
 *        Applied before tone mapping so occlusion darkens HDR values — this
 *        means deep crevices correctly compress into the ACES toe region.
 *
 *   3. Bloom additive
 *        Adds the dual-Gaussian bloom result to the occluded scene colour.
 *        Applied before tone mapping so bright bloom contributions are tone
 *        mapped together with the scene — they don't blow out to pure white.
 *
 *   4. Exposure
 *        Multiplies the HDR image by uExposure before tone mapping.
 *        Driven by scene.js _computeExposure(): 1.0 at noon, 0.38 at deep
 *        night, slightly raised under overcast sky.
 *
 *   5. ACES filmic tone mapping
 *        Maps HDR [0,∞) to LDR [0,1] using the ACES fitted curve from
 *        Narkowicz 2015. Preserves colour hue under compression (unlike
 *        Reinhard which desaturates highlights). Produces the characteristic
 *        lifted blacks, compressed highlights, and filmic S-curve.
 *
 *   6. 3D LUT colour grade
 *        A 32³ DataTexture3D applies a colour grade on top of the ACES
 *        output. The default LUT is an identity — swapping it for a
 *        real .cube LUT in scene.js requires no shader change.
 *        Tetrahedral interpolation is approximated with trilinear filtering
 *        (GL_LINEAR on the 3D texture sampler), which is accurate to within
 *        ~0.5 LUT units — imperceptible at 32³ resolution.
 *
 *   7. sRGB gamma correction
 *        Applies 1/2.2 power curve. Three.js's sRGBEncoding output is
 *        bypassed because we set toneMapping = NoToneMapping on the renderer
 *        and handle everything manually here. This must be the last numeric
 *        operation before gl_FragColor — all prior steps work in linear light.
 *
 *   8. Vignette
 *        Darkens the corners and edges of the image using a smooth radial
 *        falloff. Applied after gamma so the falloff is perceptually linear.
 *        The aspect-ratio correction (multiply X distance by aspect ratio)
 *        ensures the vignette is circular on all screen proportions, not
 *        an ellipse stretched by the wider horizontal dimension.
 *
 *   9. Film grain
 *        Adds temporally animated screen-space noise after gamma. The noise
 *        is generated from a hash of (UV + animated seed) — no texture fetch.
 *        Applied after gamma so the grain amplitude is perceptually correct:
 *        the same absolute grain value is equally visible everywhere on the
 *        LDR image regardless of scene brightness. Applied after vignette so
 *        dark corners have the same grain as bright centres, matching the
 *        behaviour of real film grain.
 *
 * Uniforms:
 *   uScene            sampler2D   HDR scene colour from main render pass
 *   uSSAO             sampler2D   Greyscale AO map (half-res, GPU upscaled)
 *   uBloom            sampler2D   HDR bloom result (half-res, GPU upscaled)
 *   uLUT              sampler3D   32³ colour lookup table (identity default)
 *   uLUTSize          float       LUT dimension (32.0)
 *   uResolution       vec2        Full screen resolution (for aspect ratio)
 *   uTime             float       Elapsed seconds (grain animation)
 *   uExposure         float       Scene exposure multiplier
 *   uVigStrength      float       Vignette radius — smaller = tighter (0.38)
 *   uVigSoftness      float       Vignette falloff width (0.55)
 *   uCAStrength       float       Chromatic aberration offset scale (0.0006)
 *   uGrainStrength    float       Film grain intensity (0.048)
 *   uBloomStrength    float       Bloom add multiplier (0.32)
 *   uSSAOStrength     float       AO blend weight 0=no AO, 1=full AO (0.80)
 *
 * Varyings:
 *   vUv               vec2        Screen-space UV [0,1]
 *
 * NOTE: The vertex shader for this pass is _vsFullScreen() in scene.js.
 * This file contains only the fragment shader source.
 */

// ── Precision ──────────────────────────────────────────────────────────────────
// mediump throughout — all values are LDR [0,1] after tone mapping, and HDR
// values before tone mapping are in the range [0, ~8] at most (exposure × bloom).
// mediump (minimum 10-bit mantissa, ~3.3 decimal digits) is sufficient.
// The 3D LUT sampler requires mediump or higher — satisfied here.

precision mediump float;

// ── Uniforms ───────────────────────────────────────────────────────────────────

uniform sampler2D uScene;
uniform sampler2D uSSAO;
uniform sampler2D uBloom;
uniform sampler3D uLUT;
uniform float     uLUTSize;
uniform vec2      uResolution;
uniform float     uTime;
uniform float     uExposure;
uniform float     uVigStrength;
uniform float     uVigSoftness;
uniform float     uCAStrength;
uniform float     uGrainStrength;
uniform float     uBloomStrength;
uniform float     uSSAOStrength;

// ── Varyings ───────────────────────────────────────────────────────────────────

varying vec2 vUv;

// ── 1. Chromatic aberration ────────────────────────────────────────────────────

/**
 * Radial lateral chromatic aberration.
 *
 * In a real camera lens, different wavelengths of light refract by different
 * amounts. Red refracts least, blue most. This causes colour fringes at high-
 * contrast edges, particularly toward the corners of the frame where light
 * hits the lens at steeper angles.
 *
 * We model this by offsetting the R and B channel samples radially away from
 * the screen centre by different amounts. G remains at the true UV. The offset
 * direction is outward from centre, and the magnitude is:
 *
 *   offset = normalize(centre_vector) * uCAStrength * length(centre_vector)
 *
 * The length() term makes the effect grow with distance from centre:
 * zero at the exact centre, maximum at screen corners — exactly matching
 * the physical falloff of a real lens.
 *
 * Applied to the HDR scene texture so that bloom halos around bright emissive
 * surfaces (crystal glow, sun disk) show the correct chromatic fringing.
 *
 * @param  uv          Screen UV of the current fragment
 * @return             RGB with CA-separated channel samples
 */
vec3 chromaticAberration(vec2 uv) {
  // Vector from screen centre to this fragment, range [-0.5, 0.5]
  vec2 centre    = uv - 0.5;

  // Radial offset grows with distance from centre
  // R shifts outward more, B shifts outward less (red refracts least)
  // In a real camera the spread is R > G > B, but we keep G fixed at
  // the original UV as the reference channel for sharpness.
  float dist     = length(centre);
  vec2  radial   = normalize(centre + vec2(0.0001)); // safe normalise

  // R channel: displaced outward (red aberrates most in lens systems
  // that are under-corrected for chromatic aberration — this includes
  // all photographic lenses to some degree)
  vec2  uvR = uv + radial * dist * uCAStrength * 1.0;

  // G channel: no displacement (reference)
  vec2  uvG = uv;

  // B channel: displaced inward (opposite direction, smaller magnitude)
  // Blue aberrates most in terms of focal length but the lateral component
  // moves inward relative to red in the standard lens model
  vec2  uvB = uv - radial * dist * uCAStrength * 0.72;

  // Clamp all UVs to [0,1] — avoids edge wrapping artefacts at screen border
  uvR = clamp(uvR, vec2(0.0), vec2(1.0));
  uvB = clamp(uvB, vec2(0.0), vec2(1.0));

  return vec3(
    texture2D(uScene, uvR).r,
    texture2D(uScene, uvG).g,
    texture2D(uScene, uvB).b
  );
}

// ── 5. ACES filmic tone mapping ────────────────────────────────────────────────

/**
 * ACES filmic tone mapping curve — Narkowicz 2015 fitted approximation.
 *
 * Maps HDR linear light [0, ∞) to LDR [0, 1] with a filmic S-curve:
 *   - Toe: gently lifts near-black values (avoids crushed blacks)
 *   - Shoulder: softly compresses highlights (avoids blow-out)
 *   - Mid: approximately linear in the middle grey range
 *
 * Constants: a=2.51, b=0.03, c=2.43, d=0.59, e=0.14
 * These are the fitted ACES RRT+ODT coefficients.
 *
 * Per-channel application preserves colour hue better than luminance-only
 * application. Slight hue shift toward warm tones in the shoulder is a
 * characteristic of ACES and matches the look of real film stock.
 *
 * Input should be pre-multiplied by exposure before calling.
 *
 * @param  x  Linear HDR colour, per-channel
 * @return    Tone-mapped LDR colour [0,1]
 */
vec3 acesFilmic(vec3 x) {
  return clamp(
    (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14),
    0.0, 1.0
  );
}

// ── 6. 3D LUT colour grade ─────────────────────────────────────────────────────

/**
 * Apply a 32³ 3D colour lookup table.
 *
 * The LUT maps each (R,G,B) input to an (R,G,B) output, enabling arbitrary
 * colour grading: hue rotation, selective saturation, cross-processing,
 * split-toning, etc. All in one texture lookup.
 *
 * Addressing:
 *   A 32³ LUT has 32 entries per channel. To map a colour value in [0,1]
 *   to the correct texel, we remap to account for the half-texel offset
 *   at the edges of the texture:
 *
 *     scale  = (LUT_SIZE - 1) / LUT_SIZE   = 31/32  ≈ 0.9688
 *     offset = 0.5 / LUT_SIZE              = 0.5/32 ≈ 0.0156
 *     uvw    = colour * scale + offset
 *
 *   This centres the sample within each LUT cell rather than at the cell
 *   boundary, which is required for GL_LINEAR trilinear filtering to
 *   interpolate correctly between adjacent entries.
 *
 * The default LUT in scene.js is a 32³ identity (R→R, G→G, B→B) so this
 * function is a no-op until a real LUT is loaded. The shader needs no change
 * when a real LUT is swapped in.
 *
 * @param  colour  LDR linear colour in [0,1], post-ACES
 * @return         Colour-graded output in [0,1]
 */
vec3 applyLUT(vec3 colour) {
  float scale  = (uLUTSize - 1.0) / uLUTSize;
  float offset = 0.5 / uLUTSize;
  vec3  uvw    = colour * scale + offset;
  return texture(uLUT, uvw).rgb;
}

// ── 9. Film grain ──────────────────────────────────────────────────────────────

/**
 * Hash-based film grain — no texture fetch required.
 *
 * Uses a two-stage multiplicative hash to produce a pseudo-random value in
 * [0, 1] for each (UV, time) pair. The time component is animated at a
 * fractional rate so consecutive frames use different grain patterns —
 * static grain is far more noticeable and distracting than animated grain.
 *
 * The specific multipliers (443.8975, 397.2973, 19.19) are chosen to
 * produce visually uniform distribution with no visible grid structure at
 * the pixel scale. They have no closed-form derivation — they are
 * empirically validated constants from the graphics community.
 *
 * Output is centred at 0.0 (additive, symmetric) by subtracting 0.5,
 * so the grain neither brightens nor darkens the image on average.
 *
 * @param  uv    Fragment UV
 * @param  time  Animation seed (changes each frame)
 * @return       Grain value in [-0.5, 0.5]
 */
float filmGrain(vec2 uv, float time) {
  // Animate the UV seed so grain changes frame to frame
  // fract() keeps the seed small to avoid precision loss
  vec2 animatedUV = uv + fract(time * 0.017324) * vec2(13.7381, 7.4291);

  // Two-stage hash
  vec2 p = fract(animatedUV * vec2(443.8975, 397.2973));
  p     += dot(p.xy, p.yx + 19.19);
  return fract(p.x * p.y) - 0.5;
}

// ── Main ───────────────────────────────────────────────────────────────────────

void main() {

  // ──────────────────────────────────────────────────────────────────────────
  // 1. CHROMATIC ABERRATION (HDR, pre tone-mapping)
  // ──────────────────────────────────────────────────────────────────────────
  // Read scene colour with per-channel radial offsets.
  // This is the primary scene colour for all subsequent steps.
  vec3 hdr = chromaticAberration(vUv);

  // ──────────────────────────────────────────────────────────────────────────
  // 2. SSAO MULTIPLY (HDR)
  // ──────────────────────────────────────────────────────────────────────────
  // The SSAO texture is at half resolution. The GPU sampler bilinearly
  // upscales it for free — no explicit upscale pass required.
  // We read the R channel (greyscale: 1.0 = no occlusion, 0.0 = full occlusion).
  //
  // uSSAOStrength controls how much AO is applied:
  //   0.0 → no AO at all  (mix(1.0, ao, 0.0) = 1.0 always)
  //   1.0 → full AO       (mix(1.0, ao, 1.0) = ao)
  // Default 0.80 — strong enough to deepen crevices, not so strong that
  // open surfaces look grey.
  float ao    = texture2D(uSSAO, vUv).r;
  float aoMix = mix(1.0, ao, uSSAOStrength);
  hdr        *= aoMix;

  // ──────────────────────────────────────────────────────────────────────────
  // 3. BLOOM ADDITIVE (HDR)
  // ──────────────────────────────────────────────────────────────────────────
  // Bloom texture is at half resolution — bilinearly upscaled by the sampler.
  // Additive blend: bright halos add to the scene energy, never subtract.
  // uBloomStrength = 0.32 — visible but not overpowering.
  // Applied before tone mapping so the combined HDR value is mapped through
  // the ACES shoulder together — prevents bloom from blowing out to pure white
  // independently of the scene.
  vec3 bloom  = texture2D(uBloom, vUv).rgb;
  hdr        += bloom * uBloomStrength;

  // ──────────────────────────────────────────────────────────────────────────
  // 4. EXPOSURE
  // ──────────────────────────────────────────────────────────────────────────
  // Multiply HDR scene by the exposure value before tone mapping.
  // Driven by scene.js _computeExposure():
  //   Noon clear:    1.00
  //   Overcast:      1.12  (slightly brighter to compensate diffuse scatter)
  //   Deep night:    0.38  (moon and stars visible but dark)
  // Exposure here is physically equivalent to ISO/aperture adjustment on a
  // real camera — it scales the scene's recorded luminance before the
  // film response (ACES) compresses it.
  hdr *= uExposure;

  // ──────────────────────────────────────────────────────────────────────────
  // 5. ACES FILMIC TONE MAPPING
  // ──────────────────────────────────────────────────────────────────────────
  // Maps HDR [0,∞) → LDR [0,1]. Applied per-channel.
  // After this point all values are in [0,1] and we are in LDR space.
  vec3 ldr = acesFilmic(hdr);

  // ──────────────────────────────────────────────────────────────────────────
  // 6. 3D LUT COLOUR GRADE
  // ──────────────────────────────────────────────────────────────────────────
  // Applied on the ACES output in [0,1]. The LUT operates in LDR because
  // colour grading tools (DaVinci Resolve, etc.) work in display-referred
  // space. Applying a LUT to HDR data before tone mapping would require an
  // HDR-native LUT format — unsupported in WebGL DataTexture3D without
  // custom packing.
  ldr = applyLUT(ldr);

  // ──────────────────────────────────────────────────────────────────────────
  // 7. sRGB GAMMA CORRECTION
  // ──────────────────────────────────────────────────────────────────────────
  // Convert linear light to the sRGB display encoding. Monitors expect
  // gamma-encoded values — without this, the image would look washed out
  // and too bright in the shadows.
  //
  // We use the simplified 1/2.2 power curve rather than the full IEC 61966
  // piecewise sRGB transfer function. The difference is only visible below
  // value 0.0031308 (nearly black) — negligible for this application.
  //
  // This is the last numeric transform before output. Vignette and grain
  // are applied after, in display-referred space, so their perceptual
  // strength is consistent regardless of scene brightness.
  ldr = pow(ldr, vec3(1.0 / 2.2));

  // ──────────────────────────────────────────────────────────────────────────
  // 8. VIGNETTE
  // ──────────────────────────────────────────────────────────────────────────
  // Darkens the image toward the corners with a smooth radial falloff.
  // Models the natural light falloff of a real camera lens ("cos⁴ law").
  //
  // Centre vector: vUv − 0.5 maps the screen to [−0.5, 0.5].
  // Aspect ratio correction: multiplying the X component by (width/height)
  // ensures the vignette is circular, not an ellipse that is wider than tall
  // on a 16:9 screen.
  //
  // The smoothstep falloff:
  //   smoothstep(uVigStrength, uVigStrength − uVigSoftness, dist)
  //   → 1.0 (no darkening) at screen centre
  //   → 0.0 (full darkening) at the corners
  //   uVigStrength = 0.38 positions the onset ring
  //   uVigSoftness = 0.55 controls how gradually it falls off
  //
  // pow(vignette, 1.2) adds a slight extra contrast push in the falloff zone.
  // Applied after gamma so the perceptual darkness is consistent.
  vec2  centre    = vUv - 0.5;
  float aspect    = uResolution.x / uResolution.y;
  float vigDist   = length(centre * vec2(aspect, 1.0));
  float vignette  = smoothstep(uVigStrength, uVigStrength - uVigSoftness, vigDist);
  vignette        = pow(vignette, 1.2);
  ldr            *= mix(0.96, 1.0, vignette);

  // ──────────────────────────────────────────────────────────────────────────
  // 9. FILM GRAIN
  // ──────────────────────────────────────────────────────────────────────────
  // Adds temporally animated noise after gamma and vignette.
  //
  // uGrainStrength = 0.048: subtle — visible in dark areas and on still
  // surfaces but not distracting during motion. In the Library Alcove and
  // night-time scenes where the image is darker, the grain will be more
  // perceptually apparent, which correctly mimics the look of high-ISO
  // photography in low light.
  //
  // The grain is applied uniformly across the frame regardless of local
  // brightness. This matches the behaviour of digital sensor noise, which
  // is additive and signal-independent (in contrast to film grain which is
  // multiplicative). For Atlas the distinction is imperceptible and the
  // simpler additive model is used.
  float grain = filmGrain(vUv, uTime) * uGrainStrength;
  ldr        += vec3(grain);

  // ──────────────────────────────────────────────────────────────────────────
  // OUTPUT
  // ──────────────────────────────────────────────────────────────────────────
  // Final clamp to [0,1] — grain can push values slightly outside.
  // Alpha is 1.0 — the screen render target has no alpha channel.
  gl_FragColor = vec4(clamp(ldr, 0.0, 1.0), 1.0);
}
