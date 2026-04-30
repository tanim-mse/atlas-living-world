/**
 * ssao.glsl — Screen-Space Ambient Occlusion
 * Atlas: The Living World
 *
 * Full-pass SSAO shader. Renders at half resolution; result is bilinearly
 * upscaled in composite.glsl. Outputs a single greyscale occlusion value
 * in gl_FragColor.r — 1.0 = fully unoccluded, 0.0 = fully occluded.
 *
 * Algorithm:
 *   1. Reconstruct view-space position from depth buffer
 *   2. Reconstruct view-space normal from depth gradient (no G-buffer required)
 *   3. Build a random TBN rotation per fragment from a tiled 4×4 noise texture
 *   4. Cast 32 hemisphere samples in view space, transformed by TBN
 *   5. Project each sample back to screen space, read its depth, compare
 *   6. Accumulate occlusion with a range check to suppress distant false hits
 *   7. Apply power contrast curve and output
 *
 * Uniforms:
 *   uDepth          sampler2D   Linear depth buffer from main scene pass
 *   uNoise          sampler2D   4×4 random rotation vectors, tiled over screen
 *   uKernel[32]     vec3        Hemisphere sample kernel, view-space,
 *                               importance-sampled toward surface normal
 *   uProjection     mat4        Camera projection matrix
 *   uProjectionInv  mat4        Inverse camera projection matrix
 *   uResolution     vec2        This pass resolution (half of screen: w/2, h/2)
 *   uKernelRadius   float       World-space hemisphere radius (default 1.6 units)
 *   uBias           float       Depth bias to prevent self-occlusion (default 0.025)
 *   uPower          float       Contrast exponent — higher = darker AO (default 1.8)
 *   uCameraNear     float       Camera near plane distance
 *   uCameraFar      float       Camera far plane distance
 *
 * Varyings:
 *   vUv             vec2        Screen-space UV [0,1]
 */

// ── Precision ──────────────────────────────────────────────────────────────────
// Vertex shader uses highp for position accuracy.
// Fragment shader uses mediump — sufficient for occlusion accumulation and
// saves bandwidth on the RTX 2050's memory bus at half resolution.

// NOTE: The vertex shader for this pass is _vsFullScreen() in scene.js.
// This file contains only the fragment shader source.

// ── Fragment shader ────────────────────────────────────────────────────────────

precision mediump float;

// ── Uniforms ───────────────────────────────────────────────────────────────────

uniform sampler2D uDepth;
uniform sampler2D uNoise;
uniform vec3      uKernel[32];
uniform mat4      uProjection;
uniform mat4      uProjectionInv;
uniform vec2      uResolution;
uniform float     uKernelRadius;
uniform float     uBias;
uniform float     uPower;
uniform float     uCameraNear;
uniform float     uCameraFar;

// ── Varyings ───────────────────────────────────────────────────────────────────

varying vec2 vUv;

// ── Constants ──────────────────────────────────────────────────────────────────

// Number of kernel samples. Must match the array size declared above and the
// CPU-side kernel generation loop in scene.js.
const int KERNEL_SIZE = 32;

// ── Depth reconstruction ───────────────────────────────────────────────────────

/**
 * Convert a raw depth buffer value [0,1] to a linear view-space depth.
 * Three.js writes a standard OpenGL depth buffer: NDC z maps to [0,1].
 *
 * Formula derived from the perspective projection:
 *   z_linear = (2 * near * far) / (far + near - (d * 2 - 1) * (far - near))
 *
 * @param  d  Raw depth sample from uDepth texture, range [0,1]
 * @return    Linear depth in view space (positive, camera-space Z)
 */
float linearizeDepth(float d) {
  float ndc = d * 2.0 - 1.0;
  return (2.0 * uCameraNear * uCameraFar)
       / (uCameraFar + uCameraNear - ndc * (uCameraFar - uCameraNear));
}

// ── View-space position reconstruction ────────────────────────────────────────

/**
 * Reconstruct the view-space position of a fragment from its screen UV and
 * raw depth value. Uses the inverse projection matrix — no assumptions about
 * projection type.
 *
 * @param  uv     Screen-space UV [0,1]
 * @param  depth  Raw depth buffer value [0,1]
 * @return        View-space position (Z is negative in OpenGL convention)
 */
vec3 getViewPos(vec2 uv, float depth) {
  // Reconstruct NDC position
  vec4 ndcPos  = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  // Unproject to view space
  vec4 viewPos = uProjectionInv * ndcPos;
  return viewPos.xyz / viewPos.w;
}

// ── View-space normal reconstruction ──────────────────────────────────────────

/**
 * Reconstruct a view-space surface normal from depth gradient using
 * central differences. No normal G-buffer required.
 *
 * The method computes finite differences of the reconstructed view-space
 * position in both X and Y screen directions, then takes their cross product.
 *
 * This produces normals that are accurate on flat and gently curved surfaces.
 * On hard silhouette edges (where depth discontinuities occur), the normal
 * may be noisy — but those edges will receive high occlusion anyway and the
 * noise is invisible in the final composited image.
 *
 * @param  uv  Screen-space UV of the current fragment
 * @return     Normalised view-space surface normal
 */
vec3 getViewNormal(vec2 uv) {
  vec2 step = 1.0 / uResolution;

  // Depth at the four neighbours
  float dC  = texture2D(uDepth, uv).r;
  float dR  = texture2D(uDepth, uv + vec2(step.x, 0.0)).r;
  float dU  = texture2D(uDepth, uv + vec2(0.0, step.y)).r;
  float dL  = texture2D(uDepth, uv - vec2(step.x, 0.0)).r;
  float dD  = texture2D(uDepth, uv - vec2(0.0, step.y)).r;

  // Choose the neighbour that produces the smaller depth jump (forward vs
  // backward difference). This avoids using samples across a hard depth edge,
  // which would produce a wildly wrong normal at silhouettes.
  float dX  = abs(dR - dC) < abs(dL - dC) ? dR : dL;
  float dY  = abs(dU - dC) < abs(dD - dC) ? dU : dD;

  // View-space positions at centre, X-neighbour, Y-neighbour
  vec3 posC = getViewPos(uv, dC);
  vec3 posX = getViewPos(uv + (abs(dR - dC) < abs(dL - dC) ? vec2(step.x, 0.0) : vec2(-step.x, 0.0)), dX);
  vec3 posY = getViewPos(uv + (abs(dU - dC) < abs(dD - dC) ? vec2(0.0, step.y) : vec2(0.0, -step.y)), dY);

  // Surface tangent vectors and cross product for normal
  vec3 tangentX = posX - posC;
  vec3 tangentY = posY - posC;

  // Normal faces toward camera (negative Z in view space)
  return normalize(cross(tangentY, tangentX));
}

// ── Main ───────────────────────────────────────────────────────────────────────

void main() {

  // ── Early-out: sky pixels ──────────────────────────────────────────────────
  // The depth buffer is 1.0 at the far plane (sky). Sky cannot be occluded.
  // Returning 1.0 (no occlusion) skips all computation for sky fragments,
  // which covers a large portion of the screen at wide FOV.
  float rawDepth = texture2D(uDepth, vUv).r;
  if (rawDepth >= 0.9999) {
    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
    return;
  }

  // ── Fragment position and normal in view space ─────────────────────────────
  vec3 fragPos = getViewPos(vUv, rawDepth);
  vec3 normal  = getViewNormal(vUv);

  // ── Random rotation from tiled noise texture ───────────────────────────────
  // The 4×4 noise texture contains random rotation vectors in XY, Z=0.
  // Tiling it over the screen at (resolution / 4) means every 4×4 block of
  // screen pixels shares a rotation vector. This is the standard SSAO noise
  // approach — it distributes sample directions to reduce banding without
  // requiring a unique random value per pixel (which would be too noisy).
  vec2  noiseScale  = uResolution / 4.0;
  vec3  randomVec   = texture2D(uNoise, vUv * noiseScale).xyz;
  randomVec         = normalize(randomVec * 2.0 - 1.0);

  // ── Build TBN matrix (Gram-Schmidt orthonormalisation) ────────────────────
  // The TBN matrix rotates the kernel hemisphere to align with the surface
  // normal. Each fragment has a different random tangent (from noise), so
  // the kernel is rotated differently at every fragment — this is what
  // eliminates the banding pattern that would appear from a fixed kernel.
  vec3 tangent   = normalize(randomVec - normal * dot(randomVec, normal));
  vec3 bitangent = cross(normal, tangent);
  mat3 TBN       = mat3(tangent, bitangent, normal);

  // ── Sample the hemisphere ─────────────────────────────────────────────────
  float occlusion = 0.0;

  for (int i = 0; i < KERNEL_SIZE; i++) {

    // Transform kernel sample from tangent space to view space
    // uKernel[i] is a point on the unit hemisphere above the Z axis.
    // TBN aligns that hemisphere with the surface normal at this fragment.
    vec3 samplePos = TBN * uKernel[i];
    samplePos      = fragPos + samplePos * uKernelRadius;

    // ── Project sample to screen space ─────────────────────────────────────
    // We need the screen UV of this sample position so we can read its depth.
    vec4 offset    = vec4(samplePos, 1.0);
    offset         = uProjection * offset;         // clip space
    offset.xyz    /= offset.w;                     // perspective divide → NDC
    offset.xyz     = offset.xyz * 0.5 + 0.5;      // NDC → UV [0,1]

    // Clamp UV to valid range — samples that project outside the screen
    // are simply ignored (they contribute 0 to occlusion)
    if (offset.x < 0.0 || offset.x > 1.0 ||
        offset.y < 0.0 || offset.y > 1.0) {
      continue;
    }

    // ── Read depth at sample position ───────────────────────────────────────
    float sampleRawDepth = texture2D(uDepth, offset.xy).r;
    vec3  sampleViewPos  = getViewPos(offset.xy, sampleRawDepth);

    // ── Range check ─────────────────────────────────────────────────────────
    // Without this, samples from far-away surfaces at the same projected UV
    // would falsely occlude the current fragment. The range check weights
    // each sample by how close the occluder is, relative to the kernel radius.
    // Samples farther than uKernelRadius contribute nothing.
    // smoothstep gives a soft falloff rather than a hard cutoff.
    float rangeCheck = smoothstep(
      0.0, 1.0,
      uKernelRadius / (abs(fragPos.z - sampleViewPos.z) + 0.001)
    );

    // ── Occlusion contribution ───────────────────────────────────────────────
    // A sample is an occluder if its depth (sampleViewPos.z) is greater than
    // the test position (samplePos.z + uBias).
    // In OpenGL view space, Z is negative toward the camera, so "greater Z"
    // means "further from camera" (i.e., behind the surface).
    // uBias prevents self-occlusion on flat surfaces.
    float isOccluded = sampleViewPos.z >= samplePos.z + uBias ? 1.0 : 0.0;
    occlusion       += isOccluded * rangeCheck;
  }

  // ── Normalise and invert ───────────────────────────────────────────────────
  // Divide by kernel size to get [0,1] range, then invert:
  // 0.0 = fully occluded (dark corner), 1.0 = fully unoccluded (open sky)
  occlusion = 1.0 - (occlusion / float(KERNEL_SIZE));

  // ── Contrast curve ─────────────────────────────────────────────────────────
  // Power function pulls mid-values toward darker occlusion.
  // uPower = 1.8 by default — enough to deepen crevices without crushing
  // open surfaces. Higher values produce the characteristic "cavity darkening"
  // look of physically based scenes.
  occlusion = pow(occlusion, uPower);

  // ── Output ─────────────────────────────────────────────────────────────────
  // Greyscale occlusion factor. composite.glsl reads the R channel.
  // Alpha is 1.0 — this target does not use alpha blending.
  gl_FragColor = vec4(occlusion, occlusion, occlusion, 1.0);
}
