import * as THREE from 'three';
import { createWorld } from './world.js';
import { PlayerController } from './player.js';
import {
  createTorusDefect, createQuarterTurnDefect, createHalfTurnDefect,
  createHexScrewDefect, createHantzscheWendtDefect, createFirstAmphicosmDefect,
  createSecondAmphicosmDefect, createFirstAmphidicosmDefect,
} from './defect.js';
import { createSignpost } from './sign.js';
import { DEFECT_SITES } from './sites.js';
import { setupMobileControls } from './input-touch.js';

// ---- device detection -------------------------------------------------------
// Touch device in "mobile" mode -> on-screen controls; anything in DESKTOP
// mode -> desktop controls, even on a phone. The signal that actually flips
// when a phone requests the desktop site is the UA (and, on Chromium, the
// UA-CH `mobile` boolean), so we key off those rather than raw touch capability
// (a touchscreen laptop should stay on desktop controls). A #mobile / #desktop
// URL hash forces either path for testing.
function detectMobile() {
  const h = location.hash;
  if (h.includes('mobile')) return true;
  if (h.includes('desktop')) return false;
  const ua = navigator.userAgent || '';
  const touch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
  const uaData = navigator.userAgentData;
  if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile && touch;
  const uaMobile = /Android|iPhone|iPod|Mobile|IEMobile|BlackBerry|Opera Mini/i.test(ua);
  const iPadOS = /Macintosh/i.test(ua) && touch; // modern iPads report a Mac UA
  return touch && (uaMobile || iPadOS);
}
const IS_MOBILE = detectMobile();

const renderer = new THREE.WebGLRenderer({ antialias: true });
// Pixel ratio is the single biggest lever: the main pass AND every portal pass
// are drawn at this resolution. Phones like the S24 report devicePixelRatio ~3;
// capping at 1 on mobile renders ~9× fewer pixels per pass than the raw DPR
// (and 4× fewer than the desktop cap of 2). Raise MOBILE_PIXEL_RATIO toward 1.5
// for a sharper image if the frame budget allows.
const MOBILE_PIXEL_RATIO = 1;
renderer.setPixelRatio(Math.min(devicePixelRatio, IS_MOBILE ? MOBILE_PIXEL_RATIO : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
// Variance shadow maps: prefiltered (blurred) depth moments give smooth,
// realistic penumbrae instead of PCF's dithered edges.
renderer.shadowMap.type = THREE.VSMShadowMap;
// Shadow maps are built once per frame (the cascades are static within a frame)
// and shared by all portal passes + the main pass.
renderer.shadowMap.autoUpdate = false;

// ---- cascaded-shadow shader patch -------------------------------------------
// Core three.js has no CSM, so we patch its directional-light lighting chunk to
// blend two equal directional lights (the cascades, set up below) by view-space
// depth. csmWeight() returns each cascade's share: cascade 0 owns the near band,
// cascade 1 the far band, cross-faded across a small seam so the two full-bright
// lights sum to exactly one (no double-lighting) while each band samples its own
// shadow map. Patched on the shared THREE.ShaderChunk — this page only ever runs
// the two-cascade world scene, and the gallery viewer is a separate page/module
// with its own THREE import, so it is untouched.
{
  const DIR_SHADOW_LINE = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
  if (!THREE.ShaderChunk.lights_fragment_begin.includes(DIR_SHADOW_LINE))
    throw new Error('CSM patch: directional-shadow anchor not found in lights_fragment_begin');
  THREE.ShaderChunk.lights_pars_begin +=
    '\nfloat csmWeight( int cascade, float depth ) {\n' +
    '  const float SPLIT = 34.0;   // cascade boundary, view-space metres\n' +
    '  const float BAND  = 6.0;    // half-width of the cross-fade seam\n' +
    '  float t = clamp( ( depth - ( SPLIT - BAND ) ) / ( 2.0 * BAND ), 0.0, 1.0 );\n' +
    '  return ( cascade == 0 ) ? ( 1.0 - t ) : t;\n' +
    '}\n';
  THREE.ShaderChunk.lights_fragment_begin = THREE.ShaderChunk.lights_fragment_begin.replace(
    DIR_SHADOW_LINE,
    DIR_SHADOW_LINE + '\n\t\tdirectLight.color *= csmWeight( UNROLLED_LOOP_INDEX, vViewPosition.z );'
  );
}
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 2000);

const world = createWorld(scene, { lowDetail: IS_MOBILE });

// ---- lighting ---------------------------------------------------------------
// Cascaded shadows — two directional lights sharing the sun direction, each at
// FULL sun intensity. The patched lighting chunk (above) hands every fragment
// exactly ONE cascade by view depth (split 34 m, cross-faded), so the two lights
// never double-light: lit surfaces stay at full sun and the shadow comes from
// whichever cascade owns that depth band.
const SUN_COLOR = 0xfff3d6, SUN_INTENSITY = 3.0;

// cascade 0 — NEAR: crisp, short, follows the player.
const sunNear = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
sunNear.castShadow = true;
const NEAR_HALF = 52;                       // > SPLIT / cos(½fov): screen-edge fragments stay inside the near box
const NEAR_MAP = IS_MOBILE ? 1024 : 2048;   // ~0.05 m/texel on desktop
sunNear.shadow.mapSize.set(NEAR_MAP, NEAR_MAP);
sunNear.shadow.camera.left = -NEAR_HALF;
sunNear.shadow.camera.right = NEAR_HALF;
sunNear.shadow.camera.top = NEAR_HALF;
sunNear.shadow.camera.bottom = -NEAR_HALF;
sunNear.shadow.camera.near = 1;
sunNear.shadow.camera.far = 400;
sunNear.shadow.bias = -0.0002;
sunNear.shadow.normalBias = 0.02;
sunNear.shadow.radius = IS_MOBILE ? 2 : 3;
sunNear.shadow.blurSamples = IS_MOBILE ? 4 : 8;
scene.add(sunNear);
scene.add(sunNear.target);

// cascade 1 — FAR: coarse, heavily blurred, STATIC box covering the whole world.
const sunFar = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
sunFar.castShadow = true;
const FAR_HALF = 230;                       // span 460 m > world diameter (~400 m): edge never clips visible terrain
const FAR_MAP = IS_MOBILE ? 1024 : 2048;    // ~0.22 m/texel; coarseness hidden by heavy blur + the aerial haze
sunFar.shadow.mapSize.set(FAR_MAP, FAR_MAP);
sunFar.shadow.camera.left = -FAR_HALF;
sunFar.shadow.camera.right = FAR_HALF;
sunFar.shadow.camera.top = FAR_HALF;
sunFar.shadow.camera.bottom = -FAR_HALF;
sunFar.shadow.camera.near = 1;
sunFar.shadow.camera.far = 900;
sunFar.shadow.bias = -0.0007;               // coarse texels need a looser slope bias to avoid acne
sunFar.shadow.normalBias = 0.08;
sunFar.shadow.radius = IS_MOBILE ? 4 : 10;  // heavy blur → soft, very coarse distant shadows
sunFar.shadow.blurSamples = IS_MOBILE ? 6 : 12;
scene.add(sunFar);
scene.add(sunFar.target);
// Fixed on the world centre; the whole terrain + mountain ring is always inside
// it from any player position, so its cutoff edge never sweeps across geometry.
sunFar.position.copy(world.sunDir).multiplyScalar(320);
sunFar.target.position.set(0, 0, 0);
scene.add(new THREE.HemisphereLight(0xbfdcff, 0x6a8a4f, 1.1));

// ---- player + defects ---------------------------------------------------------
const player = new PlayerController(camera, renderer.domElement, world, { mobile: IS_MOBILE });

// Spawn on a low rise in the open south-east meadow, looking north-west across
// the field: the torus cell (origin) sits dead-centre with the sixth-turn and
// third-turn cells flanking it, the river and stone bridge off to the left, and
// the mountain ring behind — an unobstructed establishing view, well clear of
// every cottage. (The old spawn was right against a house by the road.)
const SPAWN = { x: 10, z: -22 };
camera.position.set(SPAWN.x, world.getHeight(SPAWN.x, SPAWN.z) + 1.7, SPAWN.z);
player.yaw = Math.atan2(-(0 - SPAWN.x), -(0 - SPAWN.z)); // face the origin/torus
player.pitch = -0.08;                                    // tip the gaze gently down over the meadow

const atSite = (i, height = 2) => {
  const s = DEFECT_SITES[i];
  return new THREE.Vector3(s.x, world.getHeight(s.x, s.z) + height, s.z);
};

// Sign colour encodes ORIENTABILITY: the six closed orientable flat 3-manifolds
// (the platycosms) are YELLOW, and — being prime and none of S³, S²×S¹ or a lens
// space — each is spinorial, written on its sign as (spin ½) (Hendriks; Friedman–
// Witt). The first amphicosm (Klein bottle × S¹) is non-orientable, so it is GREEN
// and carries no spin tag (a non-orientable manifold has pin± structure, not spin).
//
// Each label is a museum-style { title, aka, body }; the signpost auto-fits the
// text. Copy is the authoritative wording from defect_labels.md.
const entries = [
  { d: createTorusDefect(atSite(0), 1.0), orientable: true, spinorial: true, label: {
    title: 'Torus defect',
    aka: `the 3-torus, T³ = S¹×S¹×S¹ · Conway's torocosm · the trivial flat space form`,
    body: `Opposite faces glued straight across by pure translation. The flat 3-manifold with trivial holonomy — leave through one wall and return through the wall behind you, unrotated. Seam-free, the only cell without edge singularities.`,
  } },
  { d: createQuarterTurnDefect(atSite(1), 1.0), orientable: true, spinorial: true, label: {
    title: 'Quarter-turn defect',
    aka: `the tetracosm · the quarter-turn flat space form (holonomy ℤ/4)`,
    body: `A cube whose opposite faces are glued with a 90° twist. A flat 3-manifold in which a wall meets its partner rotated a quarter turn; circulate the right loop and the world comes back spun by 90°. Shown as a flattened stand-in: all three face-pairs twist, so the edges carry conical seams the smooth manifold has not.`,
  } },
  { d: createHexScrewDefect(atSite(2), Math.PI / 3, 'Sixth-turn defect', 0.64, 1.0), orientable: true, spinorial: true, label: {
    title: 'Sixth-turn defect',
    aka: `the hexacosm · the sixth-turn flat space form (holonomy ℤ/6)`,
    body: `A hexagonal cell: the six sides glue straight, the two caps glue with a 60° screw. One of the six closed flat 3-manifolds, the one with the tightest rotational holonomy.`,
  } },
  { d: createHalfTurnDefect(atSite(3), 1.0), orientable: true, spinorial: true, label: {
    title: 'Half-turn defect',
    aka: `the dicosm · the half-turn flat space form (holonomy ℤ/2)`,
    body: `A cube whose opposite faces are glued with a 180° twist. A flat 3-manifold; the partner wall arrives rotated a half turn, so “up” through it points down. Shown as a flattened stand-in: all three face-pairs twist, so the edges carry conical seams the smooth manifold has not.`,
  } },
  { d: createHexScrewDefect(atSite(4), 2 * Math.PI / 3, 'Third-turn defect', 0.64, 1.0), orientable: true, spinorial: true, label: {
    title: 'Third-turn defect',
    aka: `the tricosm · the third-turn flat space form (holonomy ℤ/3)`,
    body: `A hexagonal cell: sides glued straight, caps glued with a 120° screw. Another of the six closed flat 3-manifolds, sibling to the sixth-turn cell.`,
  } },
  { d: createHantzscheWendtDefect(atSite(5), 0.9), orientable: true, spinorial: true, label: {
    title: 'Hantzsche–Wendt space',
    aka: `the Hantzsche–Wendt manifold · the didicosm (holonomy ℤ/2×ℤ/2)`,
    body: `The sixth and last closed orientable flat 3-manifold, completing the platycosms — and the only flat space form that is a rational homology sphere, with finite first homology. A rhombic-dodecahedral cell (the Dirichlet domain of an offset basepoint); its twelve faces glue in six pairs by three mutually perpendicular, non-intersecting half-turn screws. The screws share no fixed point, so unlike the cube cells this is the genuine smooth manifold — no central singularity, seam-free, with holonomy ℤ/2×ℤ/2.`,
  } },
  { d: createFirstAmphicosmDefect(atSite(6), 1.0), orientable: false, label: {
    title: 'First amphicosm',
    aka: `Klein bottle × S¹ · the first amphicosm · a non-orientable flat space form (holonomy ℤ/2)`,
    body: `A cube whose ±x and ±y faces glue by pure translation while the ±z pair glues with a glide reflection — exit the top and re-enter the bottom mirror-reversed. The x–z section is a flat Klein bottle and the y direction a circle, so the cell is Klein bottle × S¹: the first non-orientable flat 3-manifold. Cross a glide wall and the world returns left–right reversed; cross it twice and the reversal cancels. A genuine smooth manifold, seam-free like the torus.`,
  } },
  { d: createSecondAmphicosmDefect(atSite(7), 1.0), orientable: false, label: {
    title: 'Second amphicosm',
    aka: `the swap-glide torus bundle · the second amphicosm · a non-orientable flat space form (holonomy ℤ/2)`,
    body: `A cube whose ±x and ±y faces glue by pure translation while the ±z pair glues with a swap glide reflection — exit the top and re-enter the bottom across the diagonal mirror x = y, with x and y exchanged. It is the mapping torus of the square torus under the order-2 swap, the second of the two non-orientable flat 3-manifolds with ℤ/2 holonomy: distinct from Klein bottle × S¹, whose mirror is axis-aligned rather than diagonal (first homology ℤ² here versus ℤ² ⊕ ℤ/2 there). Cross the swap wall and the world returns mirror-reversed with x and y traded; cross it twice and both undo. A genuine smooth manifold, seam-free like the torus.`,
  } },
  { d: createFirstAmphidicosmDefect(atSite(8), 1.0), orientable: false, label: {
    title: 'First amphidicosm',
    aka: `the first amphidicosm · a non-orientable flat space form (holonomy ℤ/2×ℤ/2)`,
    body: `The non-orientable sibling of the Hantzsche–Wendt didicosm — the same Klein-four holonomy ℤ/2×ℤ/2, but realised with mirrors instead of half-turns, so handedness is not preserved. A cube whose ±x and ±z faces each glue by a glide reflection (reflecting y and x respectively) while the ±y pair glues by pure translation; the two mirrors compose to a half-turn about the vertical axis, giving the point group mm2 — two reflections and one rotation. Every gluing slides within its mirror with no fixed point, so it is a genuine smooth manifold, seam-free like the torus. Cross either mirror wall and the world returns reversed; the two reversals compose into the half-turn.`,
  } },
];
const defects = entries.map((e) => e.d);

if (IS_MOBILE) {
  // Drop per-target MSAA on mobile (tile GPUs pay a resolve per pass; the
  // portal texture is sampled on a small face, so the aliasing is minor). The
  // 45 m cutoff and maxVisibleFaces are left at their desktop values: the big
  // structural win comes from frustum-culling off-screen cells (see the render
  // loop), which adds no pop-in, whereas shortening the cutoff would.
  for (const d of defects) d.rtSamples = 0;
}

entries.forEach(({ d, orientable, spinorial, label }) => {
  scene.add(d.group);
  // signpost a couple of meters in front of the defect, on the side facing
  // the spawn area, turned toward the approaching observer
  let dx = -d.position.x, dz = -d.position.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-3) { dx = 0; dz = 1; } else { dx /= len; dz /= len; }
  const sx = d.position.x + dx * 2.5;
  const sz = d.position.z + dz * 2.5;
  const sign = createSignpost(label, { orientable, spinorial });
  sign.position.set(sx, world.getHeight(sx, sz), sz);
  sign.rotation.y = Math.atan2(dx, dz);
  scene.add(sign);
});

// ---- resize -------------------------------------------------------------------
const drawSize = new THREE.Vector2();
const PORTAL_RT_SCALE = IS_MOBILE ? 0.5 : 0.75; // portal textures: half buffer res on mobile, 75% desktop

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  renderer.getDrawingBufferSize(drawSize);
  for (const d of defects) {
    d.setRenderTargetSize(
      Math.max(1, Math.floor(drawSize.x * PORTAL_RT_SCALE)),
      Math.max(1, Math.floor(drawSize.y * PORTAL_RT_SCALE))
    );
  }
}
addEventListener('resize', onResize);
addEventListener('orientationchange', onResize);
onResize();

let defectsRotating = false;
let defectAngle = 0;
const DEFECT_SPIN = (2 * Math.PI * 6) / 60; // 6 rpm in rad/s

// ---- shared toggles (used by keyboard, desktop mouse, and mobile buttons) ----
function toggleOutlines() { for (const d of defects) d.toggleEdges(); }
const outlinesOn = () => defects.length > 0 && defects[0].edges.visible;

// cruise: 0 off / 1 slow / 2 fast. Tapping the active mode turns it off.
function setCruise(mode) { player.cruise = player.cruise === mode ? 0 : mode; }

addEventListener('keydown', (e) => {
  if (e.code === 'KeyT') toggleOutlines();
  if (e.code === 'KeyR') defectsRotating = !defectsRotating;
});

if (IS_MOBILE) {
  // Touch look + on-screen speed/outline buttons; no pointer lock, no prompt.
  document.getElementById('prompt')?.remove();
  setupMobileControls({
    dom: renderer.domElement, player,
    setCruise, getCruise: () => player.cruise,
    toggleOutlines, getOutlines: outlinesOn,
  });
} else {
  // Desktop dual controls, active only once you've taken the seat (pointer
  // locked): left click -> cruise slow, double-click -> cruise fast, right
  // click -> toggle outlines. While unlocked, a click just grabs pointer lock
  // (handled in player.js), so these stay out of the way until you're driving.
  const dom = renderer.domElement;
  const locked = () => document.pointerLockElement === dom;
  let clickTimer = null;
  document.addEventListener('click', (e) => {
    if (e.button !== 0 || !locked()) return;
    if (clickTimer) {                  // second click within the window -> double
      clearTimeout(clickTimer); clickTimer = null;
      setCruise(2);
    } else {
      clickTimer = setTimeout(() => { clickTimer = null; setCruise(1); }, 250);
    }
  });
  // Right click -> outlines. Handle it on mousedown (reliable even under pointer
  // lock, where the contextmenu event is sometimes suppressed) and use the
  // contextmenu event only to stop the browser menu appearing.
  document.addEventListener('mousedown', (e) => {
    if (e.button === 2 && locked()) { e.preventDefault(); toggleOutlines(); }
  });
  document.addEventListener('contextmenu', (e) => { if (locked()) e.preventDefault(); });
}

// ---- render loop ----------------------------------------------------------------
// Single-pass portals: hide every defect, render each one's visible faces from
// its gluing-transformed virtual camera into its own render targets, then show
// them all for the main pass. (No recursion any more — the wormhole nesting that
// needed it was removed; see WORMHOLE_NOTES.md.)
//
// On mobile we also pass the view frustum so cells fully off-screen skip their
// portal passes entirely. This is lossless: during portal passes every defect
// group is hidden, so a cell never appears inside another cell's portal — only
// as itself — and a cell you can't see contributes nothing. (Safe on desktop
// too; gated to mobile only because that is where the budget is tight.)
const _frustum = new THREE.Frustum();
const _viewProj = new THREE.Matrix4();
function computeFrustum() {
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  _viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_viewProj);
  return _frustum;
}
// Householder reflection across the vertical plane through the camera (normal =
// camera-right). Mirrors the view left↔right — the parity flip from crossing a
// reflecting face, which makes on-screen text read backwards. Rebuilt each frame
// from the live camera; returns the same Matrix4 it was handed.
const _camRight = new THREE.Vector3();
const _sceneMirror = new THREE.Matrix4();
function buildCameraMirror(cam, out) {
  _camRight.set(1, 0, 0).applyQuaternion(cam.quaternion).normalize();
  const r = _camRight, p = cam.position;
  const rx = r.x, ry = r.y, rz = r.z;
  const d = 2 * (p.x * rx + p.y * ry + p.z * rz);
  // L = I − 2 r rᵀ (det −1);  translation b = 2 (p·r) r.
  out.set(
    1 - 2 * rx * rx, -2 * rx * ry,     -2 * rx * rz,     d * rx,
    -2 * ry * rx,     1 - 2 * ry * ry, -2 * ry * rz,     d * ry,
    -2 * rz * rx,    -2 * rz * ry,      1 - 2 * rz * rz, d * rz,
    0, 0, 0, 1
  );
  return out;
}

function renderDefectPortals(observerParity, mirror) {
  const frustum = IS_MOBILE ? computeFrustum() : null;
  for (const d of defects) d.group.visible = false;
  for (const d of defects) d.render(renderer, scene, camera, drawSize, frustum, { observerParity, mirror });
  for (const d of defects) d.group.visible = true;
}

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  player.update(dt, defects);
  world.update(dt);

  if (defectsRotating) {
    defectAngle += DEFECT_SPIN * dt;
    for (const d of defects) d.setRotation(defectAngle);
  }

  // The NEAR cascade follows the player so its crisp frustum stays tight; the
  // anchor is snapped to its texel grid to stop edge shimmer. The FAR cascade is
  // static (world-centred) and never re-aimed.
  const texel = (2 * NEAR_HALF) / NEAR_MAP; // world metres per near-cascade texel
  const ax = Math.round(camera.position.x / texel) * texel;
  const ay = Math.round(camera.position.y / texel) * texel;
  const az = Math.round(camera.position.z / texel) * texel;
  sunNear.position.set(ax, ay, az).addScaledVector(world.sunDir, 140);
  sunNear.target.position.set(ax, ay, az);

  renderer.shadowMap.needsUpdate = true; // rebuilt by the first render below

  // Observer parity: after crossing an odd number of reflecting faces the
  // traveller is mirrored, so the whole world (text included) renders
  // reflected. The same camera mirror H is shared by the portal passes and the
  // main pass. Even parity (the only case until a non-orientable cell exists)
  // leaves scene.matrix identity and the main render untouched.
  const parity = player.parity;
  const mirror = parity < 0 ? buildCameraMirror(camera, _sceneMirror) : null;
  renderDefectPortals(parity, mirror);
  if (mirror) {
    const prevAuto = scene.matrixAutoUpdate;
    scene.matrixAutoUpdate = false;          // keep the reflection from being recomputed away
    scene.matrix.copy(mirror);
    scene.matrixWorldNeedsUpdate = true;
    renderer.render(scene, camera);
    scene.matrix.identity();
    scene.matrixWorldNeedsUpdate = true;
    scene.matrixAutoUpdate = prevAuto;
  } else {
    renderer.render(scene, camera);
  }
}
animate();
