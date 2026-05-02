/**
 * garden.js — The Garden zone orchestrator
 * Atlas: The Living World
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * RESPONSIBILITIES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The Garden is Segment 4 — the Habits zone. It owns:
 *
 *   Organisms
 *   ├─ 80,000 grass blades  (grass.js InstancedMesh system, 3 LOD levels)
 *   └─ N flowers            (flower.js Flower class, one per habit row)
 *
 *   Environment
 *   ├─ Stone entry path from world center clearing to garden center
 *   ├─ Perimeter boundary stone markers (8 rounded boulders)
 *   └─ Garden ambient point light (warm, low-intensity, always-on fill)
 *
 *   UI — CSS3D check-in panel
 *   ├─ CSS3DRenderer overlaid on the WebGL canvas (pointer-events: none overlay,
 *   │  pointer-events: auto on the panel element itself)
 *   ├─ Opens on flower click, closes on E / Escape / × button
 *   ├─ Panel positioned at flower head, facing camera, tracked every frame
 *   └─ Form contents driven by ui/habit-checkin.js
 *
 *   Interaction
 *   ├─ Raycaster against all flower pick targets, throttled to 40 ms intervals
 *   ├─ Hover → Flower.setHovered(true) → phototropism tilt + cursor: pointer
 *   └─ Click → _openPanel(hoveredFlower)
 *
 *   Per-frame (registered via scene.js registerUpdate)
 *   ├─ updateGrass(delta, elapsed)
 *   ├─ flower.update(delta, elapsed) for every Flower instance
 *   ├─ _doRaycast(now)              throttled hover detection
 *   ├─ _positionPanel(flower)       CSS3D panel tracks open flower head
 *   ├─ _css3dRenderer.render(...)   CSS3D render pass
 *   └─ _syncFog()                   keeps scene.fog.density = state.fogDensity
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ZONE GEOMETRY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   Center:      CONFIG.ZONES.garden.x (−1600),  CONFIG.ZONES.garden.z (+1400)
 *   Size:        700 × 700 world units
 *   Terrain:     −8 unit height bias applied by terrain.js
 *   Stone path:  10 slabs from world center (0, 0) to garden center, 2.4 u wide
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * SHADER LOADING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * garden.js fetches wind.glsl and petal.glsl at startup and installs them
 * into Flower.vertexShaderOverride / Flower.fragmentShaderOverride. The Flower
 * class checks these static slots in _buildPetalMat(); if they are set it uses
 * the external files, otherwise it falls back to its own inline GLSL strings.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEPENDENCIES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   THREE (global r128)
 *   core/config.js, core/state.js, core/auth.js
 *   world/scene.js    — getScene, getCamera, registerUpdate, deregisterUpdate
 *   world/terrain.js  — getHeightAt
 *   organisms/grass.js  — initGrass, updateGrass, disposeGrass
 *   organisms/flower.js — Flower class
 *   ui/habit-checkin.js — openCheckin, closeCheckin, onCheckinSubmit
 *
 * Usage (world.html entry point after auth + scene + terrain are ready):
 *   import { initGarden, disposeGarden } from './zones/garden.js';
 *   await initGarden();
 */

import { CONFIG }                             from '../core/config.js';
import { state }                              from '../core/state.js';
import { resetInactivityTimer }               from '../core/auth.js';
import { getScene, getCamera,
         registerUpdate, deregisterUpdate }   from '../world/scene.js';
import { getHeightAt }                        from '../world/terrain.js';
import { initGrass, updateGrass,
         disposeGrass }                       from '../organisms/grass.js';
import { Flower }                             from '../organisms/flower.js';
import { openCheckin, closeCheckin,
         onCheckinSubmit }                    from '../ui/habit-checkin.js';

const THREE = window.THREE;

// ─── Zone constants ───────────────────────────────────────────────────────────

/** Garden zone center X coordinate (world units). */
const GARDEN_X = CONFIG.ZONES.garden.x;   // −1600
/** Garden zone center Z coordinate (world units). */
const GARDEN_Z = CONFIG.ZONES.garden.z;   // +1400
/** Usable spawn radius for flowers and perimeter markers (half of 700 u). */
const GARDEN_RADIUS = 350;

// Stone path geometry
const PATH_SEGMENTS  = 10;    // number of stone slabs
const PATH_WIDTH     = 2.4;   // slab width (world units)
const PATH_STONE_H   = 0.08;  // slab protrusion above terrain (world units)

// Raycaster — only cast every RAYCAST_INTERVAL_MS to limit CPU cost
const RAYCAST_INTERVAL_MS = 40;

// CSS3D panel
/** Distance the panel is offset from flower head toward camera. */
const PANEL_CAM_OFFSET = 0.55;
/** Panel DOM element width in pixels (before CSS3D world-scale). */
const PANEL_W_PX = 480;
/** Panel DOM element height in pixels. */
const PANEL_H_PX = 360;
/**
 * CSS3DObject scale: maps CSS pixels into world units.
 * At 0.0022 u/px a 480 px-wide element is 1.056 world units wide — roughly
 * 1 metre, readable at close flower distance (~2 m from camera).
 */
const CSS3D_SCALE = 0.0022;

// Garden fill light
const GARDEN_LIGHT_COLOR     = 0xffe8c8;   // warm cream-amber
const GARDEN_LIGHT_INTENSITY = 0.18;
const GARDEN_LIGHT_DISTANCE  = 900;
const GARDEN_LIGHT_HEIGHT    = 12;         // units above ground

// ─── Module state ─────────────────────────────────────────────────────────────

/** All live Flower instances, one per habit row. @type {Flower[]} */
const _flowers = [];

/** Group holding all static environment geometry. @type {THREE.Group|null} */
let _envGroup = null;

/** Garden ambient fill light. @type {THREE.PointLight|null} */
let _gardenLight = null;

// CSS3D infrastructure
/** @type {THREE.CSS3DRenderer|null} */
let _css3dRenderer = null;
/** @type {THREE.Scene|null} Dedicated scene for CSS3D objects. */
let _css3dScene    = null;
/** @type {THREE.CSS3DObject|null} The active check-in panel object. */
let _panelObject   = null;
/** @type {HTMLElement|null} DOM element inside the CSS3DObject. */
let _panelEl       = null;
/** @type {Flower|null} The flower whose panel is currently open. */
let _panelFlower   = null;

// Raycaster
const _raycaster = new THREE.Raycaster();
const _mouse     = new THREE.Vector2(-9999, -9999);
let   _lastRaycastMs = 0;
/** @type {Flower|null} The currently hovered flower. */
let   _hoveredFlower = null;

// Bound event handlers stored for clean removal on dispose
let _boundPointerMove = null;
let _boundClick       = null;
let _boundKeyDown     = null;
let _boundCSS3DResize = null;

/** The update function registered with scene.js — stored for deregistration. */
let _updateFn = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the Garden zone.
 *
 * Call order requirements:
 *   1. initScene()   must have completed (renderer, camera, scene exist)
 *   2. initTerrain() must have completed (getHeightAt returns valid values)
 *   3. auth.js must have populated state.habits
 *
 * @returns {Promise<void>}
 */
export async function initGarden() {
  const scene = getScene();

  // Load external shader files and install into Flower class
  await _loadShaders();

  // Organisms
  await initGrass(scene);
  _buildFlowers(scene);

  // Environment
  _buildEnvironment(scene);
  _buildGardenLight(scene);

  // CSS3D check-in panel infrastructure
  _buildCSS3DRenderer();

  // Input events
  _bindEvents();

  // Per-frame update (registered last so everything is ready on first tick)
  _updateFn = _update;
  registerUpdate(_updateFn);

  // Expose live camera for grass.js billboard shader
  window._atlasCamera = getCamera();

  console.log(
    '%cATLAS GARDEN%c ready — %d habits → %d flowers, 80,000 grass blades',
    'color:#4a8c5c;font-weight:bold', 'color:#8a7e6e',
    state.habits ? state.habits.length : 0,
    _flowers.length
  );
}

/**
 * Tear down the Garden zone and release all GPU resources.
 * Called by navigation.js when transitioning away from the Garden.
 */
export function disposeGarden() {
  if (_updateFn) {
    deregisterUpdate(_updateFn);
    _updateFn = null;
  }

  _unbindEvents();
  _closePanel();

  // Flowers
  for (const flower of _flowers) {
    flower.dispose();
  }
  _flowers.length = 0;

  // Grass
  disposeGrass();

  // Environment geometry
  if (_envGroup) {
    const scene = getScene();
    _envGroup.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
    scene.remove(_envGroup);
    _envGroup = null;
  }

  // Garden light
  if (_gardenLight) {
    getScene().remove(_gardenLight);
    _gardenLight = null;
  }

  // CSS3D renderer
  if (_css3dRenderer) {
    const el = _css3dRenderer.domElement;
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
  _css3dRenderer = null;
  _css3dScene    = null;
  _panelObject   = null;
  _panelEl       = null;
  _panelFlower   = null;
  _hoveredFlower = null;

  window._atlasCamera = null;
}

/**
 * Notify the Garden that a habit check-in was recorded externally
 * (e.g. via the HUD quick-log or a Supabase Realtime event).
 * Forwards the notification to the corresponding Flower instance.
 *
 * @param {string} habitId
 */
export function notifyCheckin(habitId) {
  const flower = _flowers.find(f => f._habit.id === habitId);
  if (flower) flower.checkin();
}

// ─── Shader loading ───────────────────────────────────────────────────────────

/**
 * Fetch wind.glsl and petal.glsl, split petal.glsl on '// @@FRAGMENT',
 * and install the assembled vertex + fragment sources into the Flower class's
 * static override slots. The Flower class checks these slots in _buildPetalMat()
 * and uses them in preference to its inline strings when set.
 *
 * Failure is non-fatal: the Flower class will use its inline GLSL fallbacks.
 */
async function _loadShaders() {
  try {
    const [windResp, petalResp] = await Promise.all([
      fetch('shaders/wind.glsl'),
      fetch('shaders/petal.glsl'),
    ]);

    if (!windResp.ok || !petalResp.ok) {
      console.warn('[garden] Shader files could not be fetched — using inline fallbacks.');
      return;
    }

    const windSrc  = await windResp.text();
    const petalSrc = await petalResp.text();

    const SPLIT = '// @@FRAGMENT';
    const idx   = petalSrc.indexOf(SPLIT);

    if (idx === -1) {
      console.warn('[garden] petal.glsl missing @@FRAGMENT marker — using inline fallbacks.');
      return;
    }

    // Vertex source: wind library prepended so windDisplacementPetal() is available
    Flower.vertexShaderOverride   = windSrc + '\n' + petalSrc.slice(0, idx);
    // Fragment source: standalone, does not need wind.glsl
    Flower.fragmentShaderOverride = petalSrc.slice(idx + SPLIT.length);

    console.log('%cATLAS GARDEN%c External petal shaders installed.',
      'color:#4a8c5c;font-weight:bold', 'color:#8a7e6e');

  } catch (err) {
    console.warn('[garden] Shader load error — using inline fallbacks:', err.message);
  }
}

// ─── Flower construction ──────────────────────────────────────────────────────

/**
 * Instantiate one Flower per entry in state.habits.
 * Each Flower adds itself to the scene in its constructor.
 * Failed flowers are logged but do not prevent others from being built.
 *
 * @param {THREE.Scene} scene
 */
function _buildFlowers(scene) {
  if (!Array.isArray(state.habits) || state.habits.length === 0) {
    console.log('%cATLAS GARDEN%c state.habits is empty — no flowers.',
      'color:#4a8c5c;font-weight:bold', 'color:#8a7e6e');
    return;
  }

  for (const habit of state.habits) {
    try {
      const flower = new Flower(habit, scene);
      _flowers.push(flower);
    } catch (err) {
      console.warn(
        `[garden] Could not build flower for habit "${habit.name || habit.id}":`, err
      );
    }
  }
}

// ─── Environment geometry ─────────────────────────────────────────────────────

/**
 * Build all static environment geometry and add it to the scene.
 * All geometry lives inside _envGroup for easy batch disposal.
 *
 * @param {THREE.Scene} scene
 */
function _buildEnvironment(scene) {
  _envGroup      = new THREE.Group();
  _envGroup.name = 'garden-environment';

  _buildStonePath();
  _buildPerimeterMarkers();

  scene.add(_envGroup);
}

/**
 * Stone entry path.
 *
 * A series of PATH_SEGMENTS sandstone slabs running from world center
 * (0, 0) to garden center (GARDEN_X, GARDEN_Z). Each slab sits flat on
 * the terrain surface sampled from getHeightAt(). Slight positional and
 * rotational irregularity makes the path feel hand-laid rather than
 * procedurally stamped.
 *
 * Material: warm ochre-grey MeshStandardMaterial (roughness 0.88).
 * No cast shadow — the path is ground-level and the contribution is negligible.
 */
function _buildStonePath() {
  // Vector from world origin to garden center
  const totalDX = GARDEN_X;
  const totalDZ = GARDEN_Z;
  const pathLen = Math.sqrt(totalDX * totalDX + totalDZ * totalDZ);

  // Normalised direction and perpendicular (for lateral meander)
  const dirX  = totalDX / pathLen;
  const dirZ  = totalDZ / pathLen;
  const perpX = -dirZ;
  const perpZ =  dirX;

  const segLen = pathLen / PATH_SEGMENTS;

  const stoneMat = new THREE.MeshStandardMaterial({
    color:     new THREE.Color(0.62, 0.56, 0.46),
    roughness: 0.88,
    metalness: 0.00,
  });

  // Seeded LCG — identical path every session
  let seed = 0x5a3a1a;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xFFFFFFFF;
  };

  for (let i = 0; i < PATH_SEGMENTS; i++) {
    const t = (i + 0.5) / PATH_SEGMENTS;

    // Slab centre along path axis
    const baseCX = totalDX * t;
    const baseCZ = totalDZ * t;

    // Meander: lateral offset ± half PATH_WIDTH, slight forward/back jitter
    const latOff  = (rand() - 0.5) * PATH_WIDTH * 0.50;
    const longOff = (rand() - 0.5) * segLen      * 0.20;

    const sx = baseCX + perpX * latOff + dirX * longOff;
    const sz = baseCZ + perpZ * latOff + dirZ * longOff;
    const sy = getHeightAt(sx, sz) + PATH_STONE_H * 0.5;

    // Slab dimensions with slight random variation
    const sw = PATH_WIDTH * (0.80 + rand() * 0.35);
    const sl = segLen     * (0.70 + rand() * 0.30);
    const sh = PATH_STONE_H * (0.65 + rand() * 0.70);

    const geo  = new THREE.BoxGeometry(sw, sh, sl);
    const mesh = new THREE.Mesh(geo, stoneMat);

    mesh.position.set(sx, sy, sz);

    // Align slab with path direction ± subtle random twist
    const rotY = Math.atan2(dirX, dirZ) + (rand() - 0.5) * 0.18;
    mesh.rotation.y = rotY;
    // Very slight tilt to suggest settling into terrain
    mesh.rotation.x = (rand() - 0.5) * 0.035;
    mesh.rotation.z = (rand() - 0.5) * 0.020;

    mesh.castShadow    = false;
    mesh.receiveShadow = true;

    _envGroup.add(mesh);
  }
}

/**
 * Perimeter boundary markers.
 *
 * Eight low rounded boulders at the garden perimeter, evenly spaced in angle
 * with slight radius and angular variation so they read as naturally placed
 * rather than algorithmically arranged. They subtly define the zone without
 * functioning as a visible barrier.
 *
 * Material: darker than path stones, very rough (mossy field rocks).
 */
function _buildPerimeterMarkers() {
  const COUNT = 8;

  const markerMat = new THREE.MeshStandardMaterial({
    color:     new THREE.Color(0.38, 0.34, 0.28),
    roughness: 0.94,
    metalness: 0.00,
  });

  let seed = 0x2a6b2a;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xFFFFFFFF;
  };

  for (let i = 0; i < COUNT; i++) {
    const angle = (i / COUNT) * Math.PI * 2 + 0.24;
    const r     = GARDEN_RADIUS - 10 + rand() * 20;

    const mx = GARDEN_X + Math.sin(angle) * r;
    const mz = GARDEN_Z + Math.cos(angle) * r;
    const my = getHeightAt(mx, mz);

    const boulderR = 0.42 + rand() * 0.52;    // 0.42–0.94 world units

    const geo  = new THREE.SphereGeometry(boulderR, 8, 6);
    const mesh = new THREE.Mesh(geo, markerMat);

    // Flatten vertically to look like a resting field stone
    const flattenY = 0.48 + rand() * 0.30;
    mesh.scale.y   = flattenY;

    mesh.position.set(mx, my + boulderR * flattenY * 0.5, mz);
    mesh.rotation.y = rand() * Math.PI * 2;
    // Slight random lean
    mesh.rotation.x = (rand() - 0.5) * 0.10;
    mesh.rotation.z = (rand() - 0.5) * 0.10;

    mesh.castShadow    = true;
    mesh.receiveShadow = true;

    _envGroup.add(mesh);
  }
}

// ─── Garden ambient light ─────────────────────────────────────────────────────

/**
 * Warm point light centred above the garden.
 * Provides a gentle fill that keeps the garden readable after sunset
 * without competing with the scene's directional sun/moon from lighting.js.
 * No shadow — fill lights at this intensity don't warrant the shadow map cost.
 *
 * @param {THREE.Scene} scene
 */
function _buildGardenLight(scene) {
  _gardenLight = new THREE.PointLight(
    GARDEN_LIGHT_COLOR,
    GARDEN_LIGHT_INTENSITY,
    GARDEN_LIGHT_DISTANCE
  );
  _gardenLight.position.set(
    GARDEN_X,
    getHeightAt(GARDEN_X, GARDEN_Z) + GARDEN_LIGHT_HEIGHT,
    GARDEN_Z
  );
  _gardenLight.castShadow = false;
  scene.add(_gardenLight);
}

// ─── CSS3D check-in panel ─────────────────────────────────────────────────────

/**
 * Build the CSS3DRenderer, its dedicated THREE.Scene, and the panel DOM element.
 *
 * Architecture notes:
 *   • The CSS3DRenderer renders its own Scene using the same PerspectiveCamera
 *     as the main WebGL scene — this is what makes DOM elements appear to exist
 *     in 3D world space with correct perspective.
 *   • The renderer's DOM element sits absolutely on top of the WebGL canvas
 *     with pointer-events: none so it doesn't intercept mouse events globally.
 *   • The panel DIV itself has pointer-events: auto — clicks on it work normally.
 *   • The CSS3DRenderer.render() call happens inside _update() every frame so
 *     the panel tracks the flower's animated head position continuously.
 */
function _buildCSS3DRenderer() {
  // CSS3DRenderer is available on global THREE when the example script is loaded
  if (typeof THREE.CSS3DRenderer !== 'function') {
    console.warn(
      '[garden] THREE.CSS3DRenderer is not available. ' +
      'Add examples/js/renderers/CSS3DRenderer.js to world.html. ' +
      'Check-in panel will be disabled.'
    );
    return;
  }

  _css3dRenderer = new THREE.CSS3DRenderer();
  _css3dRenderer.setSize(window.innerWidth, window.innerHeight);

  const el = _css3dRenderer.domElement;
  el.style.position      = 'absolute';
  el.style.top           = '0';
  el.style.left          = '0';
  el.style.width         = '100%';
  el.style.height        = '100%';
  el.style.pointerEvents = 'none';
  el.style.zIndex        = '10';
  el.setAttribute('aria-hidden', 'true');

  const container = document.getElementById('atlas-canvas-container') || document.body;
  container.appendChild(el);

  _css3dScene = new THREE.Scene();

  _buildPanelElement();
}

/**
 * Build the panel DOM element and wrap it in a CSS3DObject.
 *
 * The panel is pre-built at zone initialisation and reused across multiple
 * check-in sessions — only its contents change per flower (via habit-checkin.js).
 * This avoids layout thrash from repeatedly creating/destroying large DOM trees.
 */
function _buildPanelElement() {
  // Outer container
  _panelEl = document.createElement('div');
  Object.assign(_panelEl.style, {
    position:              'relative',
    width:                 `${PANEL_W_PX}px`,
    height:                `${PANEL_H_PX}px`,
    background:            'rgba(8, 6, 4, 0.72)',
    backdropFilter:        'blur(18px)',
    WebkitBackdropFilter:  'blur(18px)',
    border:                '1px solid rgba(200, 169, 110, 0.18)',
    borderRadius:          '4px',
    boxShadow:             '0 8px 48px rgba(0, 0, 0, 0.65)',
    fontFamily:            '"Inter Tight", "Inter", sans-serif',
    color:                 '#e8e0d0',
    padding:               '28px 32px',
    boxSizing:             'border-box',
    display:               'none',       // hidden until a flower is clicked
    pointerEvents:         'auto',       // this element is interactive
    userSelect:            'none',
    // Entry animation — opacity + scale driven by class toggle
    opacity:               '0',
    transform:             'scale(0.93)',
    transition:            'opacity 280ms cubic-bezier(0.22, 1, 0.36, 1), ' +
                           'transform 280ms cubic-bezier(0.22, 1, 0.36, 1)',
  });

  // × close button — top-right corner
  const closeBtn = document.createElement('button');
  Object.assign(closeBtn.style, {
    position:   'absolute',
    top:        '10px',
    right:      '14px',
    background: 'none',
    border:     'none',
    color:      'rgba(200, 169, 110, 0.55)',
    fontSize:   '22px',
    cursor:     'pointer',
    lineHeight: '1',
    padding:    '4px',
    fontFamily: 'inherit',
  });
  closeBtn.textContent  = '×';
  closeBtn.title        = 'Close (E)';
  closeBtn.setAttribute('aria-label', 'Close check-in panel');
  closeBtn.addEventListener('click', e => {
    e.stopPropagation();
    _closePanel();
  });
  _panelEl.appendChild(closeBtn);

  // Content area — habit-checkin.js renders into this element
  const content = document.createElement('div');
  content.id    = 'garden-checkin-content';
  content.style.height   = 'calc(100% - 20px)';
  content.style.overflow = 'hidden';
  _panelEl.appendChild(content);

  // Wrap in CSS3DObject only if CSS3DRenderer was available
  if (typeof THREE.CSS3DObject === 'function') {
    _panelObject = new THREE.CSS3DObject(_panelEl);
    _panelObject.scale.setScalar(CSS3D_SCALE);
    _panelObject.visible = false;
    _css3dScene.add(_panelObject);
  }
}

/**
 * Open the check-in panel at a flower's head position.
 * Closes any previously open panel before opening the new one.
 * Populates the panel with the habit's check-in form via habit-checkin.js.
 *
 * @param {Flower} flower
 */
function _openPanel(flower) {
  if (!_panelEl) return;
  if (!THREE.CSS3DObject) return;

  _closePanel();

  _panelFlower = flower;

  // Make visible before animating so transition fires correctly
  _panelEl.style.display = 'block';
  if (_panelObject) _panelObject.visible = true;

  // Position immediately — prevents frame of incorrect placement
  _positionPanel(flower);

  // Animate in on next frame (display:block must be painted first)
  requestAnimationFrame(() => {
    if (_panelEl) {
      _panelEl.style.opacity   = '1';
      _panelEl.style.transform = 'scale(1.0)';
    }
  });

  // Populate check-in form
  openCheckin(
    flower._habit,
    document.getElementById('garden-checkin-content'),
    {
      onSubmit: (logData) => _handleCheckinSubmit(flower, logData),
      onClose:  ()        => _closePanel(),
    }
  );

  resetInactivityTimer();
}

/**
 * Close and hide the check-in panel with a brief exit animation.
 */
function _closePanel() {
  if (!_panelEl || _panelEl.style.display === 'none') return;

  // Animate out
  _panelEl.style.opacity   = '0';
  _panelEl.style.transform = 'scale(0.93)';

  // Hide after animation completes (200 ms exit, matching spec)
  setTimeout(() => {
    if (_panelEl) _panelEl.style.display = 'none';
    if (_panelObject) _panelObject.visible = false;
  }, 200);

  closeCheckin();

  _panelFlower = null;

  // Restore default cursor
  document.body.style.cursor = '';
}

/**
 * Position the CSS3DObject panel in world space at the active flower's head.
 *
 * The panel:
 *   • Appears at stem-tip height + 0.25 u (just above the disk)
 *   • Is offset PANEL_CAM_OFFSET units toward the camera (XZ only)
 *   • Always faces the camera (Y-axis rotation only — panel stays upright)
 *
 * Called every frame when a panel is open so it tracks the animated flower
 * head (wind sway, phototropism, dormancy droop all move the head).
 *
 * @param {Flower} flower
 */
function _positionPanel(flower) {
  if (!_panelObject || !flower.root) return;

  const cam = getCamera();

  // World-space flower head position
  // flower._stemH is in local scale; apply root.scale.y for true world height
  const stemH  = flower._stemH * flower.root.scale.y;
  const headWY = flower.root.position.y + stemH + 0.25;

  const headPos = new THREE.Vector3(
    flower.root.position.x,
    headWY,
    flower.root.position.z
  );

  // Direction from flower to camera (XZ plane — no vertical offset)
  const toCam = new THREE.Vector3(
    cam.position.x - headPos.x,
    0,
    cam.position.z - headPos.z
  );
  const camDist = toCam.length();

  if (camDist > 0.01) toCam.divideScalar(camDist);

  // Offset toward camera
  _panelObject.position.set(
    headPos.x + toCam.x * PANEL_CAM_OFFSET,
    headPos.y,
    headPos.z + toCam.z * PANEL_CAM_OFFSET
  );

  // Face camera — Y rotation only
  _panelObject.rotation.y = Math.atan2(toCam.x, toCam.z);
}

/**
 * Handle a submitted check-in form from habit-checkin.js.
 *
 * Flow:
 *   1. Persist to Supabase via onCheckinSubmit() from habit-checkin.js
 *   2. Optimistically update state.habitLogs so the flower sees the new entry
 *      immediately without waiting for the next full data hydration
 *   3. Call flower.checkin() → clears dormancy, spawns pollen burst, re-bloom
 *   4. Close panel after a brief visual hold (820 ms feels like the flower
 *      has had time to respond before the panel disappears)
 *
 * Errors are surfaced within habit-checkin.js's own error state;
 * garden.js does not show its own error UI.
 *
 * @param {Flower}  flower
 * @param {Object}  logData  { date?, mood?, note? }
 */
async function _handleCheckinSubmit(flower, logData) {
  try {
    await onCheckinSubmit(flower._habit.id, logData);

    // Optimistic state update
    if (!Array.isArray(state.habitLogs)) state.habitLogs = [];
    state.habitLogs.push({
      habit_id: flower._habit.id,
      date:     logData.date || new Date().toISOString().split('T')[0],
      mood:     logData.mood || null,
      note:     logData.note || null,
    });

    // Notify organism — triggers visual response
    flower.checkin();

    // Hold panel open briefly so the user sees the flower respond
    setTimeout(() => _closePanel(), 820);

  } catch (err) {
    console.error('[garden] Check-in submission failed:', err);
    // habit-checkin.js will already be showing its error state in the panel
  }
}

// ─── Raycasting ───────────────────────────────────────────────────────────────

/**
 * Perform a throttled raycast against all flower pick targets.
 * Updates _hoveredFlower and calls setHovered() accordingly.
 * Cursor style reflects hover state.
 *
 * @param {number} nowMs  Current timestamp from performance.now()
 */
function _doRaycast(nowMs) {
  if (nowMs - _lastRaycastMs < RAYCAST_INTERVAL_MS) return;
  _lastRaycastMs = nowMs;

  // Skip raycasting when the panel is open — the user is interacting with the DOM
  if (_panelFlower) return;

  const cam = getCamera();
  _raycaster.setFromCamera(_mouse, cam);

  // Collect all pick meshes from all flowers; tag each with its Flower instance
  const targets = [];
  for (const flower of _flowers) {
    for (const mesh of flower.getPickTargets()) {
      mesh.userData._gardenFlowerRef = flower;
      targets.push(mesh);
    }
  }

  if (targets.length === 0) return;

  const hits = _raycaster.intersectObjects(targets, false);

  if (hits.length > 0) {
    const hit    = hits[0];
    const flower = hit.object.userData._gardenFlowerRef;

    if (flower && flower !== _hoveredFlower) {
      if (_hoveredFlower) _hoveredFlower.setHovered(false);
      _hoveredFlower = flower;
      _hoveredFlower.setHovered(true);
      document.body.style.cursor = 'pointer';
    }
  } else {
    if (_hoveredFlower) {
      _hoveredFlower.setHovered(false);
      _hoveredFlower = null;
      document.body.style.cursor = '';
    }
  }
}

// ─── Per-frame update ─────────────────────────────────────────────────────────

/**
 * Main per-frame update registered with scene.js.
 * Called every frame with (deltaSeconds, totalElapsedSeconds).
 *
 * @param {number} delta    Seconds since last frame
 * @param {number} elapsed  Total elapsed seconds since scene start
 */
function _update(delta, elapsed) {
  const now = performance.now();

  // Grass — 80,000 blades, LOD switching, uniform sync
  updateGrass(delta, elapsed);

  // All flowers — wind, growth, heliotropism, phototropism, dormancy, pollen
  for (const flower of _flowers) {
    flower.update(delta, elapsed);
  }

  // Hover detection (throttled)
  _doRaycast(now);

  // Panel position tracking — keeps panel glued to animated flower head
  if (_panelFlower && _panelObject && _panelObject.visible) {
    _positionPanel(_panelFlower);
  }

  // CSS3D render pass — must fire every frame while renderer is alive
  // (CSS3DRenderer does its own dirty detection; cost is low when nothing moves)
  if (_css3dRenderer && _css3dScene) {
    _css3dRenderer.render(_css3dScene, getCamera());
  }

  // Sync fog density from live state
  _syncFog();
}

/**
 * Keep the THREE.Scene's FogExp2 density in sync with state.fogDensity.
 * lighting.js updates state.fogDensity every frame; we propagate it here.
 * (scene.js initialises the fog object; garden.js maintains it while active.)
 */
function _syncFog() {
  const scene = getScene();
  if (scene && scene.fog) {
    scene.fog.density = state.fogDensity;
  }
}

// ─── Input events ─────────────────────────────────────────────────────────────

function _onPointerMove(e) {
  // Update normalised device coordinates for the raycaster
  _mouse.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  _mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  resetInactivityTimer();
}

function _onClick(e) {
  resetInactivityTimer();
  if (_hoveredFlower) {
    _openPanel(_hoveredFlower);
  }
}

function _onKeyDown(e) {
  resetInactivityTimer();
  if (e.key === 'e' || e.key === 'E' || e.key === 'Escape') {
    _closePanel();
  }
}

function _onCSS3DResize() {
  if (_css3dRenderer) {
    _css3dRenderer.setSize(window.innerWidth, window.innerHeight);
  }
}

function _bindEvents() {
  _boundPointerMove = _onPointerMove;
  _boundClick       = _onClick;
  _boundKeyDown     = _onKeyDown;
  _boundCSS3DResize = _onCSS3DResize;

  window.addEventListener('pointermove', _boundPointerMove, { passive: true });
  window.addEventListener('click',       _boundClick);
  window.addEventListener('keydown',     _boundKeyDown,     { passive: true });
  window.addEventListener('resize',      _boundCSS3DResize, { passive: true });
}

function _unbindEvents() {
  if (_boundPointerMove) window.removeEventListener('pointermove', _boundPointerMove);
  if (_boundClick)       window.removeEventListener('click',       _boundClick);
  if (_boundKeyDown)     window.removeEventListener('keydown',     _boundKeyDown);
  if (_boundCSS3DResize) window.removeEventListener('resize',      _boundCSS3DResize);

  _boundPointerMove = null;
  _boundClick       = null;
  _boundKeyDown     = null;
  _boundCSS3DResize = null;
}
