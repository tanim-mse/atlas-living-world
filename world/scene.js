/**
 * scene.js — Core scene, renderer, camera, post-processing & render loop
 * Atlas: The Living World
 *
 * Responsibilities:
 *   - WebGLRenderer creation and configuration
 *   - PerspectiveCamera at eye height with head-bob and mouse look
 *   - Multi-pass post-processing: SSAO → Bloom → ACES → LUT → Vignette →
 *     Chromatic aberration → Film grain
 *   - Main render loop with delta time, FPS tracking, inactivity events
 *   - GPU tier detection
 *   - Public hooks for terrain.js, lighting.js, and zone modules to register
 *     themselves into the scene graph and update loop
 *
 * Dependencies: three.js r128 (global THREE), config.js, state.js
 *
 * Usage (world.html):
 *   import { initScene, registerZoneUpdate, getScene, getCamera } from './scene.js';
 *   await initScene();
 */

import { CONFIG } from '../core/config.js';
import { state }  from '../core/state.js';
import { requireAuth, resetInactivityTimer } from '../core/auth.js';

// ─── Three.js is loaded as a global from CDN in world.html ───────────────────
const THREE = window.THREE;

// ─── Module-private renderer state ───────────────────────────────────────────

let _renderer   = null;
let _scene      = null;
let _camera     = null;
let _clock      = null;
let _rafHandle  = null;

// Post-processing render targets and materials
let _rtMain     = null;   // main scene colour + depth
let _rtSSAO     = null;   // screen-space ambient occlusion
let _rtBloomH   = null;   // horizontal bloom blur
let _rtBloomV   = null;   // vertical bloom blur
let _rtComposite= null;   // ACES + LUT + vignette + CA + grain

// Full-screen quad used for all post passes
let _fsQuad      = null;
let _fsScene     = null;
let _orthoCamera = null;

// Post-processing shader materials (one per pass)
let _ssaoMat      = null;
let _bloomHMat    = null;
let _bloomVMat    = null;
let _compositeMat = null;

// Registered per-frame callbacks from zone modules and terrain/lighting
const _updateCallbacks = new Set();

// Head-bob state
const _headBob = {
  phase:     0.0,
  amplitude: 0.025,
  frequency: 1.15,   // Hz
  active:    false,
};

// Mouse-look state (angles in radians)
const _look = {
  yaw:         0,
  pitch:       0,
  targetYaw:   0,
  targetPitch: 0,
  lerpSpeed:   0.04,
  maxYaw:      THREE.MathUtils.degToRad(18),
  maxPitch:    THREE.MathUtils.degToRad(10),
};

// FPS tracking
let _frameCount   = 0;
let _fpsAccum     = 0;
let _lastFpsCheck = 0;

// Motion blur velocity accumulation (screen-space, for composite pass)
const _prevViewProj = new THREE.Matrix4();
const _currViewProj = new THREE.Matrix4();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the entire rendering pipeline and start the render loop.
 * Must be called once from world.html after DOM is ready and auth confirmed.
 *
 * @returns {Promise<void>}
 */
export async function initScene() {
  if (!requireAuth()) return;

  _buildRenderer();
  _buildCamera();
  _buildScene();
  _buildClock();
  _detectGPUTier();
  _buildPostProcessing();
  _buildFullScreenQuad();
  _bindInputEvents();

  _startRenderLoop();
}

/** Returns the live THREE.Scene — zone modules add their objects here. */
export function getScene()    { return _scene; }

/** Returns the live THREE.PerspectiveCamera. */
export function getCamera()   { return _camera; }

/** Returns the live THREE.WebGLRenderer. */
export function getRenderer() { return _renderer; }

/**
 * Register a callback to be called every frame inside the render loop.
 * Callback signature: (deltaTime: number, elapsedTime: number) => void
 *
 * @param {function} fn
 */
export function registerUpdate(fn) {
  _updateCallbacks.add(fn);
}

/**
 * Deregister a previously registered update callback.
 *
 * @param {function} fn
 */
export function deregisterUpdate(fn) {
  _updateCallbacks.delete(fn);
}

/**
 * Cleanly stop the render loop and dispose GPU resources.
 * Called by auth.js on logout.
 */
export function disposeScene() {
  if (_rafHandle !== null) {
    cancelAnimationFrame(_rafHandle);
    _rafHandle = null;
  }

  _disposeRenderTargets();
  _disposePostMaterials();
  _disposeFullScreenQuad();

  _scene.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        obj.material.forEach(m => m.dispose());
      } else {
        obj.material.dispose();
      }
    }
  });

  _renderer.dispose();

  const canvas = _renderer.domElement;
  if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);

  _unbindInputEvents();
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

function _buildRenderer() {
  _renderer = new THREE.WebGLRenderer({
    antialias:              false,  // MSAA disabled — we do post-AA in composite
    alpha:                  false,
    depth:                  true,
    stencil:                false,
    powerPreference:        'high-performance',
    preserveDrawingBuffer:  false,
  });

  _renderer.setSize(window.innerWidth, window.innerHeight);
  _renderer.setPixelRatio(CONFIG.PIXEL_RATIO);

  // Physical rendering
  _renderer.physicallyCorrectLights = true;
  _renderer.outputEncoding          = THREE.sRGBEncoding;
  _renderer.toneMapping             = THREE.NoToneMapping; // ACES done manually in composite
  _renderer.toneMappingExposure     = 1.0;

  // Shadows
  _renderer.shadowMap.enabled = true;
  _renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
  _renderer.shadowMap.autoUpdate = true;

  // Attach canvas
  const container = document.getElementById('atlas-canvas-container');
  if (!container) {
    document.body.appendChild(_renderer.domElement);
  } else {
    container.appendChild(_renderer.domElement);
  }
  _renderer.domElement.style.display = 'block';

  // Resize handler
  window.addEventListener('resize', _onResize);
}

function _onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;

  _camera.aspect = w / h;
  _camera.updateProjectionMatrix();

  _renderer.setSize(w, h);

  _disposeRenderTargets();
  _buildPostProcessing();
}

// ─── Camera ───────────────────────────────────────────────────────────────────

function _buildCamera() {
  _camera = new THREE.PerspectiveCamera(
    CONFIG.CAMERA_FOV,
    window.innerWidth / window.innerHeight,
    CONFIG.CAMERA_NEAR,
    CONFIG.CAMERA_FAR,
  );

  _camera.position.set(
    state.camera.x,
    state.camera.y,
    state.camera.z,
  );

  _camera.rotation.order = 'YXZ'; // yaw → pitch, prevents gimbal lock
}

// ─── Scene ────────────────────────────────────────────────────────────────────

function _buildScene() {
  _scene = new THREE.Scene();

  // Fog — exponential, density driven by state.fogDensity each frame
  _scene.fog = new THREE.FogExp2(0x000000, state.fogDensity);

  // Background stays black — sky.js will render atmospheric scattering separately
  _scene.background = null;
}

// ─── Clock ────────────────────────────────────────────────────────────────────

function _buildClock() {
  _clock = new THREE.Clock();
  _clock.start();
}

// ─── GPU tier detection ───────────────────────────────────────────────────────

function _detectGPUTier() {
  try {
    const gl        = _renderer.getContext();
    const dbgRender = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbgRender) {
      const rendererStr = gl.getParameter(dbgRender.UNMASKED_RENDERER_WEBGL).toLowerCase();
      if (rendererStr.includes('rtx') || rendererStr.includes('rx 6') ||
          rendererStr.includes('rx 7') || rendererStr.includes('gtx 1080') ||
          rendererStr.includes('gtx 1070')) {
        state.gpuTier = 'high';
      } else if (rendererStr.includes('gtx') || rendererStr.includes('rx 5') ||
                 rendererStr.includes('intel iris')) {
        state.gpuTier = 'medium';
      } else {
        state.gpuTier = 'low';
      }
      console.log(`%cATLAS GPU%c ${rendererStr} → tier: ${state.gpuTier}`,
        'color:#c8a96e;font-weight:bold', 'color:#8a7e6e');
    }
  } catch (_) {
    state.gpuTier = 'medium';
  }
}

// ─── Post-Processing — Render Targets ─────────────────────────────────────────

function _buildPostProcessing() {
  const w = window.innerWidth;
  const h = window.innerHeight;

  const rtOptions = {
    minFilter:     THREE.LinearFilter,
    magFilter:     THREE.LinearFilter,
    format:        THREE.RGBAFormat,
    type:          THREE.HalfFloatType,
    depthBuffer:   false,
    stencilBuffer: false,
  };

  // Main scene target — requires depth texture for SSAO
  _rtMain = new THREE.WebGLRenderTarget(w, h, {
    ...rtOptions,
    depthBuffer:   true,
    depthTexture:  new THREE.DepthTexture(w, h, THREE.FloatType),
  });

  // SSAO — half resolution for performance, upscaled in composite
  _rtSSAO = new THREE.WebGLRenderTarget(
    Math.floor(w / 2),
    Math.floor(h / 2),
    rtOptions,
  );

  // Bloom — half resolution, two passes (horizontal + vertical gaussian)
  _rtBloomH = new THREE.WebGLRenderTarget(Math.floor(w / 2), Math.floor(h / 2), rtOptions);
  _rtBloomV = new THREE.WebGLRenderTarget(Math.floor(w / 2), Math.floor(h / 2), rtOptions);

  // Final composite — full resolution, output to screen
  _rtComposite = new THREE.WebGLRenderTarget(w, h, rtOptions);

  _buildSSAOMaterial();
  _buildBloomMaterials();
  _buildCompositeMaterial();
}

// ─── Post-Processing — SSAO Pass ─────────────────────────────────────────────

function _buildSSAOMaterial() {
  // SSAO kernel — 32 hemisphere samples, importance-sampled toward surface
  const kernelSize = 32;
  const kernel     = [];
  for (let i = 0; i < kernelSize; i++) {
    const sample = new THREE.Vector3(
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
      Math.random(),
    ).normalize();
    const scale = i / kernelSize;
    sample.multiplyScalar(THREE.MathUtils.lerp(0.1, 1.0, scale * scale));
    kernel.push(sample.x, sample.y, sample.z);
  }

  // SSAO noise texture — 4×4 random rotation vectors (tiled over screen)
  const noiseSize = 16;
  const noiseData = new Float32Array(noiseSize * 4);
  for (let i = 0; i < noiseSize; i++) {
    noiseData[i * 4]     = Math.random() * 2 - 1;
    noiseData[i * 4 + 1] = Math.random() * 2 - 1;
    noiseData[i * 4 + 2] = 0;
    noiseData[i * 4 + 3] = 0;
  }
  const noiseTex          = new THREE.DataTexture(noiseData, 4, 4, THREE.RGBAFormat, THREE.FloatType);
  noiseTex.wrapS          = THREE.RepeatWrapping;
  noiseTex.wrapT          = THREE.RepeatWrapping;
  noiseTex.needsUpdate    = true;

  _ssaoMat = new THREE.ShaderMaterial({
    uniforms: {
      uDepth:          { value: _rtMain.depthTexture },
      uSceneColor:     { value: _rtMain.texture },
      uNoise:          { value: noiseTex },
      uKernel:         { value: kernel },
      uProjection:     { value: new THREE.Matrix4() },
      uProjectionInv:  { value: new THREE.Matrix4() },
      uResolution:     { value: new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2) },
      uKernelRadius:   { value: 1.6 },
      uBias:           { value: 0.025 },
      uPower:          { value: 1.8 },
      uCameraNear:     { value: CONFIG.CAMERA_NEAR },
      uCameraFar:      { value: CONFIG.CAMERA_FAR },
    },
    vertexShader: _vsFullScreen(),
    fragmentShader: _fsSSAO(),
    depthTest:  false,
    depthWrite: false,
  });
}

// ─── Post-Processing — Bloom Pass (Dual Gaussian) ────────────────────────────

function _buildBloomMaterials() {
  // Horizontal blur
  _bloomHMat = new THREE.ShaderMaterial({
    uniforms: {
      uTex:        { value: _rtMain.texture },
      uResolution: { value: new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2) },
      uThreshold:  { value: 0.82 },
      uStrength:   { value: 0.55 },
      uDirection:  { value: new THREE.Vector2(1, 0) },
    },
    vertexShader:   _vsFullScreen(),
    fragmentShader: _fsBloom(),
    depthTest:  false,
    depthWrite: false,
  });

  // Vertical blur
  _bloomVMat = new THREE.ShaderMaterial({
    uniforms: {
      uTex:        { value: _rtBloomH.texture },
      uResolution: { value: new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2) },
      uThreshold:  { value: 0.82 },
      uStrength:   { value: 0.55 },
      uDirection:  { value: new THREE.Vector2(0, 1) },
    },
    vertexShader:   _vsFullScreen(),
    fragmentShader: _fsBloom(),
    depthTest:  false,
    depthWrite: false,
  });
}

// ─── Post-Processing — Composite Pass ────────────────────────────────────────

function _buildCompositeMaterial() {
  // Build a 32-entry identity LUT as a DataTexture3D placeholder.
  // In production the LUT atlas is replaced by an actual .cube file parsed at startup.
  const LUT_SIZE  = 32;
  const lutData   = new Uint8Array(LUT_SIZE * LUT_SIZE * LUT_SIZE * 4);
  for (let b = 0; b < LUT_SIZE; b++) {
    for (let g = 0; g < LUT_SIZE; g++) {
      for (let r = 0; r < LUT_SIZE; r++) {
        const idx       = (b * LUT_SIZE * LUT_SIZE + g * LUT_SIZE + r) * 4;
        lutData[idx]     = Math.round((r / (LUT_SIZE - 1)) * 255);
        lutData[idx + 1] = Math.round((g / (LUT_SIZE - 1)) * 255);
        lutData[idx + 2] = Math.round((b / (LUT_SIZE - 1)) * 255);
        lutData[idx + 3] = 255;
      }
    }
  }
  const lutTex      = new THREE.DataTexture3D(lutData, LUT_SIZE, LUT_SIZE, LUT_SIZE);
  lutTex.format     = THREE.RGBAFormat;
  lutTex.type       = THREE.UnsignedByteType;
  lutTex.minFilter  = THREE.LinearFilter;
  lutTex.magFilter  = THREE.LinearFilter;
  lutTex.needsUpdate = true;

  _compositeMat = new THREE.ShaderMaterial({
    uniforms: {
      uScene:        { value: _rtMain.texture },
      uSSAO:         { value: _rtSSAO.texture },
      uBloom:        { value: _rtBloomV.texture },
      uLUT:          { value: lutTex },
      uLUTSize:      { value: LUT_SIZE },
      uResolution:   { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
      uTime:         { value: 0.0 },
      uExposure:     { value: 1.0 },
      uVigStrength:  { value: 0.38 },
      uVigSoftness:  { value: 0.55 },
      uCAStrength:   { value: 0.0006 },
      uGrainStrength:{ value: 0.048 },
      uBloomStrength:{ value: 0.32 },
      uSSAOStrength: { value: 0.80 },
      uMotionBlur:   { value: 0.3 },
      uPrevViewProj: { value: _prevViewProj },
      uCurrViewProjInv: { value: new THREE.Matrix4() },
    },
    vertexShader:   _vsFullScreen(),
    fragmentShader: _fsComposite(),
    depthTest:  false,
    depthWrite: false,
  });
}

// ─── Full-Screen Quad ─────────────────────────────────────────────────────────

function _buildFullScreenQuad() {
  const geo    = new THREE.PlaneGeometry(2, 2);
  const mat    = new THREE.MeshBasicMaterial({ color: 0xffffff });
  _fsQuad      = new THREE.Mesh(geo, mat);
  _fsScene     = new THREE.Scene();
  _fsScene.add(_fsQuad);
  _orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
}

// ─── Render Loop ──────────────────────────────────────────────────────────────

function _startRenderLoop() {
  _clock.start();

  function loop() {
    _rafHandle = requestAnimationFrame(loop);
    _tick();
  }

  loop();
}

function _tick() {
  const delta   = Math.min(_clock.getDelta(), 0.05); // cap at 50ms to survive tab switching
  const elapsed = _clock.getElapsedTime();

  state.deltaTime = delta;

  // ── FPS tracking ──────────────────────────────────────────────────────────
  _frameCount++;
  _fpsAccum += delta;
  if (_fpsAccum >= 1.0) {
    state.fps    = Math.round(_frameCount / _fpsAccum);
    _frameCount  = 0;
    _fpsAccum    = 0;
  }

  // ── Update local hour from real wall clock ────────────────────────────────
  const now    = new Date();
  state.localHour = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  state.dayOfYear = _getDayOfYear(now);

  // ── Sync fog density from state ───────────────────────────────────────────
  if (_scene.fog) _scene.fog.density = state.fogDensity;

  // ── Camera: head-bob + mouse look + position lerp ────────────────────────
  _updateCamera(delta, elapsed);

  // ── Run all registered zone/terrain/lighting updates ─────────────────────
  for (const fn of _updateCallbacks) {
    try { fn(delta, elapsed); }
    catch (e) { console.error('[Atlas] update callback error:', e); }
  }

  // ── Post-processing composite uniforms ────────────────────────────────────
  if (_compositeMat) {
    _compositeMat.uniforms.uTime.value     = elapsed;
    _compositeMat.uniforms.uExposure.value = _computeExposure();

    // Motion blur matrices
    _camera.updateMatrixWorld();
    const vp = new THREE.Matrix4()
      .multiplyMatrices(_camera.projectionMatrix, _camera.matrixWorldInverse);
    _compositeMat.uniforms.uCurrViewProjInv.value.copy(vp).invert();
    _prevViewProj.copy(vp);
    _compositeMat.uniforms.uPrevViewProj.value.copy(_prevViewProj);
  }

  // ── Render passes ─────────────────────────────────────────────────────────
  _renderPasses(elapsed);
}

function _renderPasses(elapsed) {
  const autoClear = _renderer.autoClear;
  _renderer.autoClear = false;

  // ── Pass 1: Scene → _rtMain ──────────────────────────────────────────────
  _renderer.setRenderTarget(_rtMain);
  _renderer.clear(true, true, false);
  _renderer.render(_scene, _camera);

  // ── Pass 2: SSAO (half-res) ───────────────────────────────────────────────
  _ssaoMat.uniforms.uProjection.value.copy(_camera.projectionMatrix);
  _ssaoMat.uniforms.uProjectionInv.value.copy(_camera.projectionMatrixInverse);
  _renderFSQ(_ssaoMat, _rtSSAO);

  // ── Pass 3: Bloom — threshold + horizontal gaussian ───────────────────────
  _bloomHMat.uniforms.uTex.value = _rtMain.texture;
  _renderFSQ(_bloomHMat, _rtBloomH);

  // ── Pass 4: Bloom — vertical gaussian ─────────────────────────────────────
  _bloomVMat.uniforms.uTex.value = _rtBloomH.texture;
  _renderFSQ(_bloomVMat, _rtBloomV);

  // ── Pass 5: Composite — ACES + LUT + vignette + CA + grain → screen ───────
  _compositeMat.uniforms.uScene.value = _rtMain.texture;
  _compositeMat.uniforms.uSSAO.value  = _rtSSAO.texture;
  _compositeMat.uniforms.uBloom.value = _rtBloomV.texture;
  _renderFSQ(_compositeMat, null); // null = render to screen

  _renderer.autoClear = autoClear;
}

/** Render a full-screen quad with given material into target (null = screen). */
function _renderFSQ(material, target) {
  _fsQuad.material = material;
  _renderer.setRenderTarget(target);
  _renderer.clear(true, false, false);
  _renderer.render(_fsScene, _orthoCamera);
}


// ─── Camera Update ────────────────────────────────────────────────────────────

function _updateCamera(delta, elapsed) {
  // ── Position lerp toward target ───────────────────────────────────────────
  const lerpT = 1.0 - Math.pow(0.001, delta);
  _camera.position.x = THREE.MathUtils.lerp(_camera.position.x, state.camera.targetX, lerpT);
  _camera.position.z = THREE.MathUtils.lerp(_camera.position.z, state.camera.targetZ, lerpT);

  // Base Y = eye height above terrain
  const baseY = state.camera.targetY;

  // ── Head-bob ──────────────────────────────────────────────────────────────
  let bobOffset = 0;
  if (_headBob.active) {
    _headBob.phase += delta * _headBob.frequency * Math.PI * 2;
    bobOffset       = Math.sin(_headBob.phase) * _headBob.amplitude;
  }
  _camera.position.y = THREE.MathUtils.lerp(_camera.position.y, baseY + bobOffset, lerpT);

  // ── Mouse look — lerp toward target angles ────────────────────────────────
  _look.yaw   = THREE.MathUtils.lerp(_look.yaw,   _look.targetYaw,   _look.lerpSpeed);
  _look.pitch = THREE.MathUtils.lerp(_look.pitch, _look.targetPitch, _look.lerpSpeed);

  _camera.rotation.y = _look.yaw;
  _camera.rotation.x = _look.pitch;

  // Sync state
  state.camera.x = _camera.position.x;
  state.camera.y = _camera.position.y;
  state.camera.z = _camera.position.z;
}

// ─── Input Bindings ───────────────────────────────────────────────────────────

let _boundMouseMove = null;
let _boundClick     = null;
let _boundKeyDown   = null;

function _bindInputEvents() {
  _boundMouseMove = _onMouseMove.bind(null);
  _boundClick     = _onUserActivity.bind(null);
  _boundKeyDown   = _onKeyDown.bind(null);

  window.addEventListener('mousemove', _boundMouseMove, { passive: true });
  window.addEventListener('click',     _boundClick,     { passive: true });
  window.addEventListener('keydown',   _boundKeyDown,   { passive: true });
  window.addEventListener('touchstart',_boundClick,     { passive: true });
}

function _unbindInputEvents() {
  window.removeEventListener('resize',     _onResize);
  if (_boundMouseMove) window.removeEventListener('mousemove', _boundMouseMove);
  if (_boundClick)     window.removeEventListener('click',     _boundClick);
  if (_boundKeyDown)   window.removeEventListener('keydown',   _boundKeyDown);
}

function _onMouseMove(e) {
  resetInactivityTimer();

  // Map mouse position to ±1 across screen
  const nx =  (e.clientX / window.innerWidth  - 0.5) * 2;
  const ny = -(e.clientY / window.innerHeight - 0.5) * 2;

  _look.targetYaw   = nx * _look.maxYaw;
  _look.targetPitch = ny * _look.maxPitch;
}

function _onUserActivity() {
  resetInactivityTimer();
  _headBob.active = true;
  setTimeout(() => { _headBob.active = false; }, 500);
}

function _onKeyDown() {
  resetInactivityTimer();
}

// ─── Exposure computation ─────────────────────────────────────────────────────

/** Auto-exposure: darker at night, slightly brighter in overcast conditions. */
function _computeExposure() {
  if (state.isNight) {
    return THREE.MathUtils.lerp(1.0, 0.38, Math.abs(state.sunElevation) / 40);
  }
  const weatherBrightness = { clear: 1.0, scattered: 1.02, overcast: 1.12, rain: 1.08, storm: 1.14 };
  return weatherBrightness[state.weather] ?? 1.0;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function _getDayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff  = date - start + (start.getTimezoneOffset() - date.getTimezoneOffset()) * 60000;
  return Math.floor(diff / 86400000);
}

// ─── Dispose helpers ──────────────────────────────────────────────────────────

function _disposeRenderTargets() {
  [_rtMain, _rtSSAO, _rtBloomH, _rtBloomV, _rtComposite].forEach(rt => {
    if (rt) {
      if (rt.depthTexture) rt.depthTexture.dispose();
      rt.dispose();
    }
  });
  _rtMain = _rtSSAO = _rtBloomH = _rtBloomV = _rtComposite = null;
}

function _disposePostMaterials() {
  [_ssaoMat, _bloomHMat, _bloomVMat, _compositeMat].forEach(m => {
    if (m) {
      Object.values(m.uniforms).forEach(u => {
        if (u.value && u.value.dispose) u.value.dispose();
      });
      m.dispose();
    }
  });
  _ssaoMat = _bloomHMat = _bloomVMat = _compositeMat = null;
}

function _disposeFullScreenQuad() {
  if (_fsQuad) {
    _fsQuad.geometry.dispose();
    _fsQuad = null;
  }
  if (_fsScene) {
    _fsScene.clear();
    _fsScene = null;
  }
  _orthoCamera = null;
}

// ─── GLSL — Full-Screen Vertex Shader ────────────────────────────────────────

function _vsFullScreen() {
  return /* glsl */`
    precision highp float;
    attribute vec3 position;
    attribute vec2 uv;
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;
}

// ─── GLSL — SSAO Fragment Shader ─────────────────────────────────────────────

function _fsSSAO() {
  return /* glsl */`
    /**
     * ssao.glsl — Screen-Space Ambient Occlusion
     *
     * Uniforms:
     *   uDepth:         sampler2D  — linear depth buffer from main pass
     *   uSceneColor:    sampler2D  — unused in this pass (available for future HBAO)
     *   uNoise:         sampler2D  — 4×4 random rotation texture, tiled
     *   uKernel[32]:    vec3       — hemisphere sample kernel, view-space
     *   uProjection:    mat4       — camera projection matrix
     *   uProjectionInv: mat4       — inverse projection
     *   uResolution:    vec2       — half-resolution (this pass renders at w/2, h/2)
     *   uKernelRadius:  float      — world-space sample radius
     *   uBias:          float      — self-occlusion offset
     *   uPower:         float      — contrast exponent
     *   uCameraNear:    float
     *   uCameraFar:     float
     */
    precision mediump float;

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

    varying vec2 vUv;

    float linearizeDepth(float d) {
      float near = uCameraNear;
      float far  = uCameraFar;
      return (2.0 * near * far) / (far + near - (d * 2.0 - 1.0) * (far - near));
    }

    vec3 getViewPos(vec2 uv, float depth) {
      vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 view = uProjectionInv * clip;
      return view.xyz / view.w;
    }

    // Reconstruct view-space normal from depth gradient
    vec3 getViewNormal(vec2 uv) {
      vec2 step = 1.0 / uResolution;
      float depthC = texture2D(uDepth, uv).r;
      float depthR = texture2D(uDepth, uv + vec2(step.x, 0.0)).r;
      float depthU = texture2D(uDepth, uv + vec2(0.0, step.y)).r;
      vec3 posC = getViewPos(uv, depthC);
      vec3 posR = getViewPos(uv + vec2(step.x, 0.0), depthR);
      vec3 posU = getViewPos(uv + vec2(0.0, step.y), depthU);
      return normalize(cross(posU - posC, posR - posC));
    }

    void main() {
      float rawDepth = texture2D(uDepth, vUv).r;
      if (rawDepth >= 0.9999) { gl_FragColor = vec4(1.0); return; } // sky

      vec3 fragPos  = getViewPos(vUv, rawDepth);
      vec3 normal   = getViewNormal(vUv);

      // Random rotation from noise texture (tiled 4×4)
      vec2 noiseScale = uResolution / 4.0;
      vec3 randomVec  = normalize(texture2D(uNoise, vUv * noiseScale).xyz * 2.0 - 1.0);

      // Gram-Schmidt TBN
      vec3 tangent   = normalize(randomVec - normal * dot(randomVec, normal));
      vec3 bitangent = cross(normal, tangent);
      mat3 TBN       = mat3(tangent, bitangent, normal);

      float occlusion = 0.0;
      const int KERNEL_SIZE = 32;

      for (int i = 0; i < KERNEL_SIZE; i++) {
        vec3 samplePos = TBN * uKernel[i];
        samplePos      = fragPos + samplePos * uKernelRadius;

        // Project sample to screen space
        vec4 offset = uProjection * vec4(samplePos, 1.0);
        offset.xyz /= offset.w;
        offset.xyz  = offset.xyz * 0.5 + 0.5;

        float sampleDepth = texture2D(uDepth, offset.xy).r;
        vec3  sampleView  = getViewPos(offset.xy, sampleDepth);

        // Range check — prevent far-away occlusion contributing
        float rangeCheck = smoothstep(0.0, 1.0,
          uKernelRadius / abs(fragPos.z - sampleView.z));

        occlusion += (sampleView.z >= samplePos.z + uBias ? 1.0 : 0.0) * rangeCheck;
      }

      occlusion  = 1.0 - (occlusion / float(KERNEL_SIZE));
      occlusion  = pow(occlusion, uPower);

      gl_FragColor = vec4(vec3(occlusion), 1.0);
    }
  `;
}

// ─── GLSL — Bloom Fragment Shader ────────────────────────────────────────────

function _fsBloom() {
  return /* glsl */`
    /**
     * bloom.glsl — Dual separable Gaussian bloom with luminance threshold
     *
     * Uniforms:
     *   uTex:        sampler2D — source texture (main scene or H-pass result)
     *   uResolution: vec2      — render target resolution (half-res)
     *   uThreshold:  float     — luminance below which pixels don't bloom
     *   uStrength:   float     — overall bloom intensity
     *   uDirection:  vec2      — (1,0) for horizontal pass, (0,1) for vertical
     */
    precision mediump float;

    uniform sampler2D uTex;
    uniform vec2      uResolution;
    uniform float     uThreshold;
    uniform float     uStrength;
    uniform vec2      uDirection;

    varying vec2 vUv;

    // 9-tap Gaussian weights
    const float WEIGHT[5] = float[5](
      0.227027, 0.194595, 0.121622, 0.054054, 0.016216
    );

    float luminance(vec3 c) {
      return dot(c, vec3(0.2126, 0.7152, 0.0722));
    }

    void main() {
      vec2 texel = 1.0 / uResolution;
      vec4 col   = texture2D(uTex, vUv);

      // Threshold: only bright areas bloom
      float lum    = luminance(col.rgb);
      float thresh = max(0.0, lum - uThreshold) / max(lum, 0.0001);
      col.rgb     *= thresh;

      // Separable Gaussian — centre tap
      vec3  result = col.rgb * WEIGHT[0];

      for (int i = 1; i < 5; i++) {
        vec2 offset = float(i) * texel * uDirection;
        result += texture2D(uTex, vUv + offset).rgb * thresh * WEIGHT[i];
        result += texture2D(uTex, vUv - offset).rgb * thresh * WEIGHT[i];
      }

      gl_FragColor = vec4(result * uStrength, 1.0);
    }
  `;
}

// ─── GLSL — Composite Fragment Shader ────────────────────────────────────────

function _fsComposite() {
  return /* glsl */`
    /**
     * composite.glsl — Final post-processing composite pass
     *
     * Passes applied in order:
     *   1. SSAO multiply
     *   2. Bloom additive
     *   3. ACES filmic tone mapping
     *   4. 3D LUT color grade
     *   5. Vignette
     *   6. Chromatic aberration
     *   7. Film grain
     *
     * Uniforms:
     *   uScene:           sampler2D   — HDR scene colour
     *   uSSAO:            sampler2D   — SSAO occlusion map (half-res, bilinear upscale)
     *   uBloom:           sampler2D   — bloom result (half-res, bilinear upscale)
     *   uLUT:             sampler3D   — 32³ colour lookup table
     *   uLUTSize:         float       — LUT dimension (32.0)
     *   uResolution:      vec2        — full-resolution screen size
     *   uTime:            float       — elapsed seconds, for grain animation
     *   uExposure:        float       — scene exposure multiplier
     *   uVigStrength:     float       — vignette darkness at corners
     *   uVigSoftness:     float       — vignette falloff
     *   uCAStrength:      float       — chromatic aberration pixel offset
     *   uGrainStrength:   float       — film grain intensity
     *   uBloomStrength:   float       — final bloom mix weight
     *   uSSAOStrength:    float       — AO contribution
     *   uMotionBlur:      float       — velocity-based motion blur intensity (future)
     *   uPrevViewProj:    mat4
     *   uCurrViewProjInv: mat4
     */
    precision mediump float;

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

    varying vec2 vUv;

    // ── ACES filmic tone mapping ──────────────────────────────────────────────
    vec3 acesFilmic(vec3 x) {
      float a = 2.51;
      float b = 0.03;
      float c = 2.43;
      float d = 0.59;
      float e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
    }

    // ── 3D LUT lookup (tetrahedral interpolation approximated with linear) ────
    vec3 applyLUT(vec3 colour) {
      float scale  = (uLUTSize - 1.0) / uLUTSize;
      float offset = 0.5 / uLUTSize;
      vec3  uvw    = colour * scale + offset;
      return texture(uLUT, uvw).rgb;
    }

    // ── Hash-based noise for film grain ────────────────────────────────────────
    float hash(vec2 p) {
      p  = fract(p * vec2(443.8975, 397.2973));
      p += dot(p.xy, p.yx + 19.19);
      return fract(p.x * p.y);
    }

    void main() {
      // ── Chromatic aberration — radial offset per channel ──────────────────
      vec2  center     = vUv - 0.5;
      float aberration = uCAStrength * length(center);
      vec2  caOffset   = normalize(center) * aberration;

      float r = texture2D(uScene, vUv + caOffset).r;
      float g = texture2D(uScene, vUv).g;
      float b = texture2D(uScene, vUv - caOffset).b;

      vec3 hdrColour = vec3(r, g, b);

      // ── SSAO multiply ─────────────────────────────────────────────────────
      float ao      = texture2D(uSSAO, vUv).r;
      float aoMix   = mix(1.0, ao, uSSAOStrength);
      hdrColour    *= aoMix;

      // ── Bloom additive ────────────────────────────────────────────────────
      vec3 bloom    = texture2D(uBloom, vUv).rgb;
      hdrColour    += bloom * uBloomStrength;

      // ── Exposure ──────────────────────────────────────────────────────────
      hdrColour    *= uExposure;

      // ── ACES tone mapping ─────────────────────────────────────────────────
      vec3 ldrColour = acesFilmic(hdrColour);

      // ── LUT color grade ───────────────────────────────────────────────────
      ldrColour      = applyLUT(ldrColour);

      // ── sRGB gamma correction ─────────────────────────────────────────────
      ldrColour      = pow(ldrColour, vec3(1.0 / 2.2));

      // ── Vignette ──────────────────────────────────────────────────────────
      float vigDist  = length(center * vec2(uResolution.x / uResolution.y, 1.0));
      float vignette = smoothstep(uVigStrength, uVigStrength - uVigSoftness, vigDist);
      vignette        = pow(vignette, 1.2);
      ldrColour      *= vignette;

      // ── Film grain (temporal — different every frame) ─────────────────────
      float grain    = (hash(vUv + fract(uTime * 0.017) * 13.73) - 0.5) * uGrainStrength;
      ldrColour     += vec3(grain);

      gl_FragColor   = vec4(ldrColour, 1.0);
    }
  `;
}
