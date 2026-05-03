/**
 * petal.glsl — Petal vertex and fragment shader
 * Atlas: The Living World
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * OVERVIEW
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This file contains the complete GLSL source for Atlas's petal shader —
 * used by all twelve flower species in the Garden zone and any future
 * flowers added to other zones. It is split into two clearly delimited
 * sections: vertex shader and fragment shader.
 *
 * Assembly convention (performed by flower.js at runtime):
 *
 *   const src     = await fetch('shaders/petal.glsl').then(r => r.text());
 *   const windSrc = await fetch('shaders/wind.glsl').then(r => r.text());
 *   const [vertSrc, fragSrc] = src.split('// @@FRAGMENT');
 *   material.vertexShader   = windSrc + '\n' + vertSrc;
 *   material.fragmentShader = fragSrc;
 *
 * wind.glsl is prepended to the vertex shader only — the fragment shader
 * does not call any wind functions and should not include the library.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * GEOMETRY CONTRACT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The geometry this shader operates on is produced by _buildPetalGeo() in
 * flower.js. Key properties guaranteed by that function:
 *
 *   UV layout:
 *     uv.x = 0.0 at left edge, 1.0 at right edge  (across petal width)
 *     uv.y = 0.0 at petal base, 1.0 at petal tip   (along petal length)
 *
 *   Geometry deformations pre-applied in CPU:
 *     Width taper:   vertices narrow toward tip (uv.y → 1)
 *     Saddle curve:  centre depressed, edges lifted (curvature baked in Z)
 *     Tip pinch:     tip curls back slightly in +Z
 *
 *   Normals:
 *     Computed by geo.computeVertexNormals() after vertex manipulation.
 *     They correctly reflect the curved surface — not the flat quad normal.
 *
 *   This shader must NOT re-apply any curvature — it is already in the
 *   geometry. The uCurvature uniform is used ONLY by the fragment shader
 *   to modulate SSS transmittance (thicker cups transmit less light).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * SPECIES VARIANTS — controlled purely through uniforms, no shader branches
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * All twelve species use this single shader. Species-specific visual
 * differences are driven exclusively through uniform values set by flower.js.
 * No #ifdef, no species enum — the GPU never branches on species identity.
 *
 * The only intentional branching in this shader:
 *   - uTissue > 0.5   → poppy semi-transparency path in alpha calculation
 *   - uSpeckled > 0.5 → foxglove throat speckle path in albedo
 * Both are float uniforms read as booleans by the GPU. This is preferable
 * to two separate shader variants because it keeps the draw call pipeline
 * simple (one ShaderMaterial prototype, instanced per petal) and avoids
 * shader recompilation overhead when switching between species.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * UNIFORM TABLE — complete reference
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Vertex shader uniforms (set per-frame by _updatePetalUniforms() in flower.js):
 *
 *   uTime         float   Elapsed seconds since scene start
 *   uWindStrength float   Global wind base strength [0, 1]
 *   uWindGust     float   Current gust amplitude [0, 1]
 *   uWindDir      vec2    Normalised XZ wind direction
 *   uWetness      float   Global wetness [0, 1]; droops wet petals
 *   uPhase        float   Per-petal unique random phase [0, 2π]
 *   uDormancy     float   Dormancy factor [0=alive, 1=dormant]; curls tip
 *
 * Fragment shader uniforms (set at material creation, static per species):
 *
 *   uColorBase    vec3    Linear RGB colour at petal base
 *   uColorTip     vec3    Linear RGB colour at petal tip
 *   uCurvature    float   Petal cup depth [0=flat, 0.45=strongly cupped]
 *   uSpeckled     float   1.0 = foxglove throat speckle, 0.0 = none
 *   uTissue       float   1.0 = poppy tissue semi-transparency, 0.0 = none
 *
 * Fragment shader uniforms (set per-frame by _updatePetalUniforms()):
 *
 *   uSunDir       vec3    World-space normalised direction toward the sun
 *   uSunColor     vec3    Linear RGB sun colour (temperature-driven)
 *   uIsNight      float   0.0 = day, 1.0 = night
 *   uWetness      float   Same as vertex uniform — both shaders need it
 *   uDormancy     float   Same as vertex uniform — desaturates in fragment
 *   uTime         float   Used for grain animation in fragment
 *
 * Three.js automatic uniforms (no manual declaration needed):
 *
 *   modelMatrix       mat4   Object → world transform
 *   viewMatrix        mat4   World → camera transform
 *   projectionMatrix  mat4   Camera → clip transform
 *   cameraPosition    vec3   World-space camera position
 *   normal            vec3   Per-vertex normal attribute
 *   position          vec3   Per-vertex position attribute
 *   uv                vec2   Per-vertex UV attribute
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * VERTEX SHADER — WIND DEPENDENCY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The vertex shader calls windDisplacementPetal() from wind.glsl.
 * wind.glsl must be prepended before this vertex source. It requires these
 * uniforms — all of which are declared in the VERTEX UNIFORMS section below:
 *
 *   uTime, uWindStrength, uWindGust, uWindDir, uWetness
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * LIGHTING MODEL — fragment shader
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * In evaluation order:
 *
 *   1.  Silhouette alpha
 *       Width taper mask (xEdge / taper envelope) removes the rectangular
 *       corners of the PlaneGeometry quad. Tip fade dissolves the final
 *       10% of petal length. Tissue species reduce opacity throughout.
 *
 *   2.  Albedo gradient
 *       mix(uColorBase, uColorTip, t^1.4) where t = uv.y.
 *       The 1.4 exponent concentrates colour change in the upper half —
 *       physically correct because the base of most petals is paler where
 *       the epidermal cells are newer.
 *
 *   3.  Micro-variation noise
 *       Hash2 applied to world XZ position breaks up visible colour
 *       uniformity across adjacent petals without a texture lookup.
 *       Amplitude ±0.03 — subtle, not distracting.
 *
 *   4.  Procedural vein system
 *       Three overlapping vein types:
 *         Primary:   Two symmetric veins at uv.x = 0.32 and 0.68
 *         Midrib:    Central vein fading out above 80% height
 *         Secondary: Branching veins fanning from nodes above 25% height,
 *                    implemented with a fract() ramp (no texture needed)
 *       Total vein darkness: up to 14% reduction in albedo where veins cross.
 *       Veins are visible on lit faces; they become part of the SSS colour
 *       on back-lit faces (real veins are slightly more opaque than mesophyll).
 *
 *   5.  Foxglove speckle (uSpeckled = 1.0)
 *       Hash-based maroon-brown dots in the basal third of the petal face,
 *       concentrated between 4% and 30% along uv.y. Uses floor(uv * vec2)
 *       for cell-aligned spots rather than pure random scatter — matches
 *       the organised row pattern of real foxglove throat markings.
 *
 *   6.  Wetness darkening
 *       Albedo ×(1 − wetFactor × 0.20). Surface water film absorbs more
 *       light, darkening the petal. wetFactor = uWetness × 0.80.
 *
 *   7.  Dormancy desaturation
 *       Luminance-preserving desaturation toward 72% at uDormancy = 1.0,
 *       plus an additional 18% global darkening. The combined effect reads
 *       as wilted: pale, dull, losing colour but retaining form.
 *
 *   8.  Lambert diffuse
 *       albedo × max(dot(N, L), 0) × sunColor × sunIntensity
 *       DoubleSide: N is flipped for back faces. Night dims sunColor × 0.08.
 *
 *   9.  Sky dome ambient
 *       Separate day (0.08, 0.10, 0.13) and night (0.02, 0.03, 0.05)
 *       ambient colour vectors. Both are albedo-multiplied then mixed by
 *       uIsNight. The day ambient is slightly blue — scattering from the
 *       sky dome overhead. No hemisphere light hack — just physically
 *       motivated constant values.
 *
 *   10. Subsurface scattering (SSS) — backlit translucency
 *       sss = pow(max(dot(-N, L), 0), 1.5) × transmittance × (1 − dormancy)
 *       transmittance = mix(0.35, 0.75, tipFactor) × (1 − curvature × 0.45)
 *       Thin tips (tipFactor → 1): high transmittance → strong backlight glow
 *       Thick bases (tipFactor → 0): low transmittance → little backlight
 *       Cupped petals (high curvature): thicker walls → less transmission
 *       SSS colour: sunColor × albedo × vec3(1.10, 1.04, 0.86)
 *         The 1.10/1.04 warm-shift models chlorophyll absorbing blue and
 *         transmitting red-green; 0.86 blue reduction matches observation.
 *
 *   11. Fresnel rim glow
 *       rim = pow(1 − NdotV, 3.8) × 0.26 × (1 − night)
 *       NdotV = max(dot(N, V), 0.0) where V is the view direction.
 *       Exponent 3.8 keeps the rim narrow — a tight bright edge, not a glow.
 *       Rim colour: sunColor × (albedo × 1.35 + 0.10)
 *       The +0.10 bias gives rims a slightly white/overexposed look, as seen
 *       in backlit flower photography where the rim exceeds sensor range.
 *
 *   12. Blinn-Phong specular + wet highlight
 *       Base: pow(NdotH, shininess) × (1 − roughness) × 0.20
 *         roughness = mix(0.72, 0.50, wetFactor)  — wetter = glossier
 *         shininess = mix(4.0, 56.0, 1 − roughness)
 *       Wet film: pow(NdotH, 112.0) × wetFactor × 0.38
 *         A very sharp, very bright narrow highlight from the surface water
 *         film. Exponent 112 gives a specular cone of ~10° half-angle —
 *         the expected size for a water film reflection in diffuse sunlight.
 *
 *   13. Exponential fog
 *       factor = exp(−0.0004 × dist²)
 *       Density constant 0.0004 matches state.fogDensity initial value
 *       and terrain.js fog — petals at distance blend correctly into haze.
 *       Day fog: (0.58, 0.72, 0.88) — hazy blue-grey
 *       Night fog: (0.04, 0.06, 0.12) — deep dark blue
 */


// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  VERTEX SHADER                                                           ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
//
// wind.glsl is prepended before this source block at assembly time.
// All windDisplacementPetal(), windGustEnvelope(), and related functions
// are therefore available without re-declaration.

precision highp float;

// ── Vertex uniforms ──────────────────────────────────────────────────────────
//
// Wind library (wind.glsl) reads: uTime, uWindStrength, uWindGust,
//                                 uWindDir, uWetness — declared here.
// Petal-specific vertex uniforms follow.

uniform highp float uTime;
uniform highp float uWindStrength;
uniform highp float uWindGust;
uniform highp vec2  uWindDir;

// Petal-specific vertex uniforms
uniform highp float uWetness;
uniform highp float uPhase;
uniform highp float uDormancy;

// ── Varyings — vertex → fragment ─────────────────────────────────────────────

varying vec2  vUv;            // UV coordinates: x=width [0,1], y=length [0,1]
varying vec3  vWorldNormal;   // World-space interpolated normal
varying vec3  vWorldPos;      // World-space position (for fog distance, SSS)
varying float vTipFactor;     // smoothstep(0.25, 1.0, uv.y) — tip mobility mask
varying float vWetness;       // Passed through for fragment wetness sag reference

// ── Vertex main ───────────────────────────────────────────────────────────────

void main() {

    // ── Local position ────────────────────────────────────────────────────────
    // Geometry arrives from _buildPetalGeo() with curvature already baked in.
    // We work in local space first — wind displacement is LOCAL for petals
    // (see wind.glsl §6 for the physical justification).
    vec3 pos = position;

    // ── Tip factor ────────────────────────────────────────────────────────────
    // Anchors the base (uv.y = 0) with zero mobility; allows tips (uv.y = 1)
    // to move freely. The smoothstep edge at 0.25 means the first quarter of
    // the petal is completely rigid — the attachment point at the flower disk.
    float tipT = smoothstep(0.25, 1.0, uv.y);

    // ── Wind flutter — via wind.glsl windDisplacementPetal() ─────────────────
    //
    // Returns vec3(displaceX, displaceY, displaceZ) in LOCAL petal space.
    // Three frequencies: 6.4 Hz (slow roll), 9.8 Hz (ripple), 14.2 Hz (tremor).
    // Each axis has a different frequency to avoid "nodding" artefact.
    // Gust swell added inside the function via windGustEnvelope().
    // All motion gated by tipT — base stays pinned.
    vec3 flutter = windDisplacementPetal(uPhase, tipT);
    pos += flutter;

    // ── Wetness droop ─────────────────────────────────────────────────────────
    // Rain accumulates on petal surfaces, adding mass to the tip. This pulls
    // the tip downward in local Y (which becomes downward in world Y after the
    // model matrix rotation, since petals are oriented with local Y ≈ world Y
    // after their rotation.x tilt). The sag increases quadratically toward the
    // tip (tipT²) because the lever arm grows with distance from the base.
    //
    // The factor 0.038 is calibrated so a fully soaked (uWetness=1.0) petal
    // of maximum size (≈0.09m long) droops its tip by ≈3.4mm — just visible
    // but not cartoonishly heavy. Combined with stem wetness sag in wind.glsl,
    // the whole flower tilts convincingly in rain.
    float wetDroop = uWetness * tipT * tipT * 0.038;
    pos.y -= wetDroop;

    // ── Dormancy tip curl ─────────────────────────────────────────────────────
    // When a habit has not been checked in for 3+ days, uDormancy → 1.
    // Tips curl forward (+Z in local petal space, which rotates to downward
    // after the petal's rotation.x tilt is applied by the model matrix).
    // The tipT² concentration ensures only the outermost vertices curl —
    // the base remains attached to the disk. Combined with the JS-side
    // headPivot.rotation.x += 0.62 (applied to the whole head), the visual
    // result is: entire flower head drooping + each petal tip individually
    // curling inward, like a real wilted flower.
    float dormantCurl = uDormancy * tipT * tipT * 0.042;
    pos.z += dormantCurl;

    // ── World space transform ─────────────────────────────────────────────────
    // Apply model matrix after all local deformations.
    // The model matrix encodes: petal rotation (outward fan angle + tilt),
    // head pivot position (at stem tip), and root world position.
    vec4 worldPos4 = modelMatrix * vec4(pos, 1.0);

    // ── Normal transform ──────────────────────────────────────────────────────
    // mat3(modelMatrix) is the upper-left 3×3 rotation/scale submatrix.
    // For non-uniform scale this should be the inverse-transpose, but petal
    // geometry has uniform scale, so mat3(modelMatrix) is correct and cheaper.
    vWorldNormal = normalize(mat3(modelMatrix) * normal);

    // ── Output varyings ───────────────────────────────────────────────────────
    vWorldPos  = worldPos4.xyz;
    vUv        = uv;
    vTipFactor = tipT;
    vWetness   = uWetness;

    gl_Position = projectionMatrix * viewMatrix * worldPos4;
}


// @@FRAGMENT
// ─────────────────────────────────────────────────────────────────────────────
// Everything above this marker is the vertex shader.
// Everything below is the fragment shader.
// flower.js splits on '// @@FRAGMENT' to get the two source strings.
// ─────────────────────────────────────────────────────────────────────────────


// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  FRAGMENT SHADER                                                         ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

precision mediump float;
// highp is used for position arithmetic in the vertex shader.
// mediump is sufficient for colour arithmetic in the fragment shader and
// reduces ALU pressure on mobile-class GPUs. The RTX 2050 has full fp32
// throughout, so this is a no-op on the target hardware — but it is correct
// practice and avoids precision warnings on stricter WebGL implementations.

// ── Fragment uniforms ─────────────────────────────────────────────────────────

// Appearance — set at material creation time (static per species per petal)
uniform highp vec3  uColorBase;
uniform highp vec3  uColorTip;
uniform highp float uCurvature;
uniform highp float uSpeckled;
uniform highp float uTissue;
uniform highp float uDormancy;
uniform highp vec3  uSunDir;
uniform highp vec3  uSunColor;
uniform highp float uIsNight;
uniform highp float uWetness;
uniform highp float uTime;

// Three.js provides cameraPosition as a built-in uniform — no declaration needed.

// ── Varyings — from vertex ────────────────────────────────────────────────────

varying vec2  vUv;
varying vec3  vWorldNormal;
varying vec3  vWorldPos;
varying float vTipFactor;
varying float vWetness;

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION F1 — UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * hash2 — deterministic 2D hash, returns [0, 1].
 *
 * Classic sin-fract hash. Fast, uniform distribution, no visible pattern
 * at the scales used here (world XZ × 20.0 for micro-variation).
 * Not suitable for cryptography or security — used purely for visual noise.
 */
float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

/**
 * luminance — perceptual luminance of a linear RGB colour.
 *
 * Coefficients: ITU-R BT.709 primaries (same as sRGB).
 * Used for desaturation — preserves perceived brightness while removing chroma.
 */
float luminance(vec3 col) {
    return dot(col, vec3(0.2126, 0.7152, 0.0722));
}

/**
 * desaturate — luminance-preserving desaturation.
 *
 * amount = 0.0 → no change
 * amount = 1.0 → pure greyscale at the original luminance
 * Values above 1.0 are valid but invert chroma — not used here.
 */
vec3 desaturate(vec3 col, float amount) {
    return mix(col, vec3(luminance(col)), amount);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION F2 — PROCEDURAL VEIN SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * veinPrimary — two symmetric veins running from base to tip.
 *
 * Positioned at uv.x = 0.32 and 0.68 — symmetric around the 0.5 centreline,
 * at ±0.18 of full width. These correspond to the main lateral veins of a
 * dicot petal (the two veins branching from the midrib nearest to the margins).
 *
 * Width: smoothstep over 0.022 uv units — in a 90mm wide petal this is ~2mm,
 * which matches the visible width of major veins in real petals under diffuse
 * light. Narrower than 0.015 becomes invisible; wider than 0.03 looks coarse.
 *
 * @param uvX  float  uv.x [0, 1] — normalised position across petal width
 * @returns    float  [0, 1] where 1 = on a primary vein
 */
float veinPrimary(float uvX) {
    float v1 = 1.0 - smoothstep(0.0, 0.022, abs(uvX - 0.32));
    float v2 = 1.0 - smoothstep(0.0, 0.022, abs(uvX - 0.68));
    return max(v1, v2);
}

/**
 * veinMidrib — central longitudinal vein, strongest at base.
 *
 * The midrib runs from the base attachment point and fades out at ~80% height,
 * where the petal tissue thins enough that the vein is no longer distinguishable.
 * Width: 0.014 uv units — narrower than the primary veins, reflecting the
 * visible width of a midrib in species like anemone and cosmos.
 *
 * @param uvX  float  uv.x
 * @param uvY  float  uv.y [0, 1] — normalised position along petal length
 * @returns    float  [0, 1]
 */
float veinMidrib(float uvX, float uvY) {
    float along  = 1.0 - smoothstep(0.0, 0.80, uvY);       // fade out at 80%
    float across = 1.0 - smoothstep(0.0, 0.014, abs(uvX - 0.50));
    return along * across;
}

/**
 * veinSecondary — branching veins fanning outward from nodes above 25% height.
 *
 * Implementation: a fract() ramp at 3.5× the uv.y frequency creates evenly
 * spaced branch nodes along the petal length. At each node, the branch angle
 * fans outward from the centreline proportionally to height and node position.
 * This produces the characteristic herringbone pattern of real lateral venation.
 *
 * The secondary veins fade to zero above 55% height — in reality the veins
 * become too fine to see past the midpoint of most petals.
 *
 * @param uvX  float
 * @param uvY  float
 * @returns    float  [0, ~0.55]
 */
float veinSecondary(float uvX, float uvY) {
    if (uvY < 0.25) return 0.0;

    // Node position within the current 3.5-cycle period
    float node    = fract(uvY * 3.5);

    // Branch position: fans outward from centreline with height and node
    float branchX = abs(uvX - 0.5) - node * 0.20 * (uvY - 0.25);

    // Width and fade envelope
    float width = 1.0 - smoothstep(0.0, 0.018, abs(branchX));
    float fade  = 1.0 - smoothstep(0.40, 0.58, uvY);

    return width * fade * 0.55;
}

/**
 * veinMask — combined vein coverage [0, 1].
 *
 * Weighted sum of all three vein types:
 *   Primary:    × 0.60 — visible but not dominant; real primary veins are
 *                         subtle in diffuse light
 *   Midrib:     × 0.80 — strongest single vein, deserves full weight at base
 *   Secondary:  weight already baked in (× 0.55 inside veinSecondary)
 *
 * Return value is used to lerp albedo toward a darker value — not to draw
 * a literal line. This keeps veins physically plausible rather than
 * graphic-design-styled.
 *
 * @param uv  vec2  Full UV coordinate
 * @returns   float [0, 1]
 */
float veinMask(vec2 uv) {
    float p = veinPrimary(uv.x)             * 0.60;
    float m = veinMidrib(uv.x, uv.y)       * 0.80;
    float s = veinSecondary(uv.x, uv.y);
    return clamp(p + m + s, 0.0, 1.0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION F3 — FOXGLOVE SPECKLE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * foxgloveSpeckle — maroon-brown dot pattern for the foxglove throat.
 *
 * Real foxglove (Digitalis purpurea) has dark spots arranged in rough rows
 * on the lower interior surface of the flower bell. This pattern warns
 * pollinators to land correctly — it is not random but semi-organised.
 *
 * Implementation: floor(uv × resolution) creates a cell grid. hash2 on the
 * cell index gives a per-cell value. step(threshold, hash) produces 0 or 1
 * per cell — approximately 28% of cells become spots (1 − 0.72 threshold).
 *
 * The spotZone mask restricts speckle to the basal 4%–50% of petal length,
 * with the densest concentration between 4%–30%, matching observation of
 * real foxglove throat anatomy.
 *
 * Returns a mixing weight [0, 1] — caller mixes albedo toward the speckle colour.
 *
 * @param uv  vec2  Full UV coordinate
 * @returns   float  [0, 1] spot weight
 */
float foxgloveSpeckle(vec2 uv) {
    // Zone: basal third of petal interior only
    float zone = smoothstep(0.04, 0.30, uv.y)
               * (1.0 - smoothstep(0.30, 0.50, uv.y));

    // Cell-based spots: 5 columns × 9 rows — gives spot density close to real
    float spotVal = step(0.72, hash2(floor(uv * vec2(5.0, 9.0))));

    return spotVal * zone;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION F4 — SILHOUETTE ALPHA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * petalAlpha — compute the silhouette alpha for this petal fragment.
 *
 * The underlying PlaneGeometry is a rectangle. We need to remove its
 * corners to produce a tapered petal silhouette. Two components:
 *
 *   Width taper:
 *     The geometry _buildPetalGeo() applies a vertex-level width taper
 *     (vertices × (1 − t × 0.70) in X). But the GPU interpolates UVs
 *     across the original, untapered quad — so uv.x still runs 0→1 even
 *     at the tip where the geometry is narrower. This means the UV-based
 *     alpha mask must replicate the taper mathematically:
 *
 *       effectiveEdge = |uv.x − 0.5| × 2.0       (0=centre, 1=edge)
 *       envelope = 1 − uv.y × 0.70 + ε           (matches geometry taper)
 *       widthAlpha = 1 − smoothstep(0.50, 1.0, effectiveEdge / envelope)
 *
 *     This removes the rectangular corners exactly in sync with the vertex
 *     taper. The ε = 0.001 prevents division by zero at the very tip.
 *
 *   Tip fade:
 *     The final 12% of petal length (uv.y 0.88→1.0) dissolves via
 *     smoothstep — avoids a hard clipped edge at the tip, which would
 *     look cut rather than grown.
 *
 *   Tissue modifier (poppy):
 *     Poppy petals are crumpled silk — they transmit light throughout,
 *     not just at the edges. uTissue = 1.0 scales the final alpha down
 *     to 0.70, giving a uniformly semi-transparent appearance distinct
 *     from species with opaque petals. No alpha test is applied to
 *     tissue petals (depthWrite = false, alphaTest = 0 in the material).
 *
 * @param uvX  float  vUv.x
 * @param uvY  float  vUv.y
 * @returns    float  alpha [0, 1]
 */
float petalAlpha(float uvX, float uvY) {
    float xEdge    = abs(uvX - 0.5) * 2.0;
    float envelope = 1.0 - uvY * 0.70 + 0.001;
    float widthA   = 1.0 - smoothstep(0.50, 1.0, xEdge / envelope);
    float tipA     = 1.0 - smoothstep(0.88, 1.0, uvY);
    float alpha    = widthA * tipA;

    // Tissue petals (poppy): uniformly semi-transparent
    if (uTissue > 0.5) {
        alpha *= 0.70;
    }

    return alpha;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION F5 — FRAGMENT MAIN
// ═══════════════════════════════════════════════════════════════════════════════

void main() {

    // ── 1. Silhouette alpha ────────────────────────────────────────────────────
    float alpha = petalAlpha(vUv.x, vUv.y);

    // Discard fragments below threshold — avoids rendering fully transparent
    // fragments that would still write to the depth buffer.
    // Tissue petals: threshold 0.0 (material alphaTest = 0) — they need
    // sorted alpha blending, not alpha testing.
    if (alpha < 0.04) discard;

    // ── 2. Albedo gradient ────────────────────────────────────────────────────
    // Colour transitions from uColorBase at the petal attachment point to
    // uColorTip at the free end. The t^1.4 exponent concentrates the colour
    // shift in the upper half, leaving a wide base of the base colour before
    // the gradient picks up — matching observation of real petals.
    float colorT = pow(vUv.y, 1.4);
    vec3  albedo = mix(uColorBase, uColorTip, colorT);

    // ── 3. Micro-variation noise ───────────────────────────────────────────────
    // hash2 on world XZ × 20 gives a unique noise value per world position.
    // Adjacent petals on the same flower are at different world positions, so
    // they get different variation values — breaking the colour uniformity that
    // would otherwise make them look stamped from a template.
    // Scaling by 20 sets spatial frequency: at 1:1 scale, one noise cell ≈ 5cm
    // — smaller than a petal, larger than a cell. Correct granularity.
    // A very slow time offset (uTime × 0.004) adds imperceptible drift —
    // the surface looks alive without visibly changing.
    float vary  = hash2(vWorldPos.xz * 20.0 + uTime * 0.004) * 0.06 - 0.03;
    albedo     += vec3(vary);
    albedo      = clamp(albedo, 0.0, 1.0);

    // ── 4. Vein overlay ───────────────────────────────────────────────────────
    // Veins are visible as slightly darker channels in the petal tissue.
    // The 14% darkening (multiply by 0.86) and blend weight of 0.60 gives
    // veins that read as real structure rather than painted-on lines.
    // On backlit petals the SSS term will carry the vein pattern through —
    // veins are slightly less transmissive than surrounding mesophyll.
    float vein  = veinMask(vUv);
    albedo      = mix(albedo, albedo * 0.86, vein * 0.60);

    // ── 5. Foxglove speckle ───────────────────────────────────────────────────
    // Only runs when uSpeckled = 1.0 (foxglove species).
    // Speckle colour: deep maroon-brown (0.28, 0.12, 0.10) applied as a
    // multiplicative tint on the base albedo — keeps speckles tonally
    // consistent across the pink colour range of foxglove petals.
    if (uSpeckled > 0.5) {
        float spot = foxgloveSpeckle(vUv);
        albedo     = mix(albedo, albedo * vec3(0.28, 0.12, 0.10), spot);
    }

    // ── 6. Wetness darkening ──────────────────────────────────────────────────
    // Surface water film absorbs a portion of incident light before it
    // reaches the petal pigment. The 20% maximum darkening at full wetness
    // is calibrated against photographs of rain-soaked petals.
    float wetFactor = uWetness * 0.80;
    albedo         *= 1.0 - wetFactor * 0.20;

    // ── 7. Dormancy desaturation ──────────────────────────────────────────────
    // Two-stage effect:
    //   Desaturation: removes chroma as the petal's chlorophyll and anthocyanins
    //                 break down. 72% at full dormancy — still slightly coloured,
    //                 not completely grey (real wilted petals retain some hue).
    //   Darkening:    overall 18% dimming as the petal surface dries and becomes
    //                 less reflective (desiccated tissue absorbs more diffusely).
    albedo  = desaturate(albedo, uDormancy * 0.72);
    albedo *= 1.0 - uDormancy * 0.18;

    // ── Lighting vectors ──────────────────────────────────────────────────────
    vec3 N = normalize(vWorldNormal);

    // DoubleSide: back-facing fragments have their normal flipped.
    // This is essential for correct diffuse on back faces — without it,
    // back faces would be lit as if facing the sun even when they face away.
    // The SSS term uses the un-flipped normal (dot(-N_front, L)) to compute
    // light coming through from the other side — which is correct.
    // So we save the front-face normal before flipping for back faces.
    vec3 N_front = N;
    if (!gl_FrontFacing) N = -N;

    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 H = normalize(L + V);

    // Sun colour scaled by night factor
    // Night: sunColor remains set by lighting.js to its night value, but
    // uIsNight additionally dims the direct contribution by × 0.08 — this
    // handles the transition between directional sun and ambient night sky
    // without a hard switch.
    vec3 sunCol = uSunColor * mix(1.0, 0.08, uIsNight);

    // ── 8. Lambert diffuse ────────────────────────────────────────────────────
    float NdotL   = max(dot(N, L), 0.0);
    vec3  diffuse = albedo * NdotL * sunCol;

    // ── 9. Sky dome ambient ───────────────────────────────────────────────────
    // Constant ambient derived from observed sky radiance at Dhaka latitude.
    // Day:   slight blue shift (sky overhead), warm lower hemisphere absorbed
    // Night: deep blue (moonlight + sky glow from city), very low intensity
    vec3 ambDay   = vec3(0.08, 0.10, 0.13) * albedo;
    vec3 ambNight = vec3(0.02, 0.03, 0.05) * albedo;
    vec3 ambient  = mix(ambDay, ambNight, uIsNight);

    // ── 10. SSS — subsurface light transmission ───────────────────────────────
    //
    // When the sun is behind the petal relative to the camera, light passes
    // through the thin petal tissue and reaches the viewer as a warm glow.
    // This is the defining visual quality of flowers in sunlight — the
    // characteristic luminous appearance that distinguishes real flowers
    // from opaque plastic replicas.
    //
    // We use N_front (not the flipped N) because backlit transmission happens
    // through the front face from behind — the front face normal points away
    // from the light source in this configuration.
    //
    // Transmittance model:
    //   mix(0.35, 0.75, tipFactor):
    //     Tip (tipFactor=1): 0.75 transmittance — thinnest tissue, most light through
    //     Base (tipFactor=0): 0.35 transmittance — thicker, attached to vascular tissue
    //   × (1 − curvature × 0.45):
    //     Flat petals (curvature=0.05): ×0.977 — very little reduction
    //     Cupped petals (curvature=0.45): ×0.797 — thicker walls reduce transmission
    //     This correctly models the peony's opaque-looking layered cups vs the
    //     poppy's tissue-paper translucency.
    //
    // SSS colour: sunlight filtered by petal pigment
    //   × vec3(1.10, 1.04, 0.86) — chlorophyll passes red and green, absorbs blue.
    //   × 0.88 — further attenuate to prevent over-bright backlit areas.
    //   × (1 − uDormancy × 0.80) — dormant petals have degraded chlorophyll;
    //                               backlight glow almost completely disappears.

    float backFace  = max(dot(-N_front, L), 0.0);
    float transmit  = mix(0.35, 0.75, vTipFactor) * (1.0 - uCurvature * 0.45);
    float sss       = pow(backFace, 1.5) * transmit * (1.0 - uDormancy * 0.80);
    vec3  sssCol    = sunCol * albedo * vec3(1.10, 1.04, 0.86) * sss * 0.88;

    // ── 11. Fresnel rim glow ──────────────────────────────────────────────────
    //
    // At grazing angles the petal edge appears bright — light skims across
    // the very thin cross-section and bounces toward the viewer. This is most
    // dramatic in backlit conditions (sun behind flower, camera in front).
    //
    // Exponent 3.8 keeps the rim narrow: the glow covers only the outermost
    // 8° or so of the viewing angle range — a crisp bright line, not a halo.
    // Amplitude 0.26 keeps it physically plausible; real petal rims are bright
    // but not white-hot (unlike water or glass Fresnel rims).
    //
    // Rim colour: slightly over-driven albedo (×1.35) plus a white bias (+0.10)
    // matches the saturated, slightly blown-out rim appearance in flower
    // photography where the sensor clips at the petal edge.
    //
    // Night: rim is suppressed by (1 − uIsNight). At night there is no sun to
    // create rim lighting; only ambient light, which doesn't produce strong rims.

    float NdotV  = max(dot(N, V), 0.0);
    float rim    = pow(1.0 - NdotV, 3.8) * 0.26 * (1.0 - uIsNight);
    vec3  rimCol = sunCol * rim * (albedo * 1.35 + vec3(0.10));

    // ── 12. Blinn-Phong specular + wet surface highlight ──────────────────────
    //
    // Petals are soft, matte surfaces — roughness 0.72 at baseline.
    // The shininess exponent (4.0 at roughness 0.72) gives a very broad,
    // low-intensity specular lobe — appropriate for the micro-rough,
    // waxy surface of petal epidermis.
    //
    // Wet surface film:
    //   The water film on a wet petal is smooth (roughness ≈ 0 on the film
    //   itself). This creates a very sharp, very bright specular spike on top
    //   of the base specular. Exponent 112 corresponds to ~10° half-angle —
    //   the expected size of a direct-sun specular on flat water.
    //   This spike is what makes wet flowers look visibly wet even to the
    //   untrained eye — it's the water reflection, not just darkening.

    float roughness = mix(0.72, 0.50, wetFactor);
    float shininess = mix(4.0, 56.0, 1.0 - roughness);
    float NdotH     = max(dot(N, H), 0.0);

    // Base petal surface specular
    float spec      = pow(NdotH, shininess) * (1.0 - roughness) * 0.20;
    // Water film specular (only present when wet)
    float wetSpec   = pow(NdotH, 112.0) * wetFactor * 0.38;

    vec3  specular  = sunCol * (spec + wetSpec);

    // ── Composite ─────────────────────────────────────────────────────────────
    vec3 finalColor = ambient + diffuse + sssCol + rimCol + specular;

    // ── 13. Exponential fog ───────────────────────────────────────────────────
    //
    // exp(−density × dist²) — quadratic (Gaussian) falloff.
    // Density 0.0004 matches state.fogDensity default and terrain.js fog.
    // Important: using distance from camera, not from origin, so petals
    // at the edge of the garden zone fade to haze at the same rate as terrain.
    //
    // Fog is applied last — after all lighting — so it correctly mixes the
    // final lit colour with the atmosphere colour, not the unlit albedo.
    //
    // Day fog colour: (0.58, 0.72, 0.88) — the characteristic hazy blue-grey
    //   of tropical humid atmosphere at Dhaka (23.8°N, high moisture).
    // Night fog: (0.04, 0.06, 0.12) — deep dark blue, city sky glow in haze.

    float camDist   = length(vWorldPos - cameraPosition);
    float fogFactor = clamp(exp(-0.0004 * camDist * camDist), 0.0, 1.0);
    vec3  fogDay    = vec3(0.58, 0.72, 0.88);
    vec3  fogNight  = vec3(0.04, 0.06, 0.12);
    vec3  fogColor  = mix(fogDay, fogNight, uIsNight);
    finalColor      = mix(fogColor, finalColor, fogFactor);

    // ── Output ────────────────────────────────────────────────────────────────
    gl_FragColor = vec4(finalColor, alpha);
}
