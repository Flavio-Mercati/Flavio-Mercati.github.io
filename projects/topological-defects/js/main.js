import * as THREE from 'three';
import { createWorld } from './world.js';
import { PlayerController } from './player.js';
import {
  createTorusDefect, createQuarterTurnDefect, createHalfTurnDefect,
  createHexScrewDefect, createDodecahedralDefect, createOctahedralDefect,
  createSeifertWeberDefect, createLensSpaceDefect, createHantzscheWendtDefect,
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
// Shadow maps are built once per frame (the sun is static within a frame)
// and shared by all portal passes + the main pass.
renderer.shadowMap.autoUpdate = false;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 2000);

const world = createWorld(scene, { lowDetail: IS_MOBILE });

// ---- lighting ---------------------------------------------------------------
const sun = new THREE.DirectionalLight(0xfff3d6, 3.0);
sun.castShadow = true;
sun.shadow.mapSize.set(IS_MOBILE ? 1024 : 2048, IS_MOBILE ? 1024 : 2048);
sun.shadow.camera.left = -55;
sun.shadow.camera.right = 55;
sun.shadow.camera.top = 55;
sun.shadow.camera.bottom = -55;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 400;
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = IS_MOBILE ? 2 : 4;       // VSM penumbra blur radius
sun.shadow.blurSamples = IS_MOBILE ? 4 : 8;
scene.add(sun);
scene.add(sun.target);
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

// Red signs: spinorial defects (their prime is not S³, S²×S¹, or a lens space
// — Hendriks; Friedman–Witt — so they can carry spin-1/2). Yellow signs: the
// non-spinorial space forms. Yellow returns here with the lens spaces L(7,1)
// and L(7,2), the cyclic spherical forms; the old wormhole pairs that once
// carried yellow were removed (see WORMHOLE_NOTES.md).
//
// Each label is a museum-style { title, aka, body }; the signpost auto-fits the
// text. Copy is the authoritative wording from defect_labels.md.
const entries = [
  { d: createTorusDefect(atSite(0), 1.0), red: true, label: {
    title: 'Torus defect',
    aka: `the 3-torus, T³ = S¹×S¹×S¹ · Conway's torocosm · the trivial flat space form`,
    body: `Opposite faces glued straight across by pure translation. The flat 3-manifold with trivial holonomy — leave through one wall and return through the wall behind you, unrotated. Seam-free, the only cell without edge singularities.`,
  } },
  { d: createQuarterTurnDefect(atSite(1), 1.0), red: true, label: {
    title: 'Quarter-turn defect',
    aka: `the tetracosm · the quarter-turn flat space form (holonomy ℤ/4)`,
    body: `A cube whose opposite faces are glued with a 90° twist. A flat 3-manifold in which a wall meets its partner rotated a quarter turn; circulate the right loop and the world comes back spun by 90°. Shown as a flattened stand-in: all three face-pairs twist, so the edges carry conical seams the smooth manifold has not.`,
  } },
  { d: createHexScrewDefect(atSite(2), Math.PI / 3, 'Sixth-turn defect', 0.64, 1.0), red: true, label: {
    title: 'Sixth-turn defect',
    aka: `the hexacosm · the sixth-turn flat space form (holonomy ℤ/6)`,
    body: `A hexagonal cell: the six sides glue straight, the two caps glue with a 60° screw. One of the six closed flat 3-manifolds, the one with the tightest rotational holonomy.`,
  } },
  { d: createDodecahedralDefect(atSite(3), 1.1), red: true, label: {
    title: 'Dodecahedral defect',
    aka: `the Poincaré homology sphere · Poincaré dodecahedral space · S³/2I (binary icosahedral) · Σ(2,3,5)`,
    body: `A dodecahedron with opposite pentagons glued by a 36° twist. A spherical space form with the same homology as a sphere but a non-trivial fundamental group of order 120 — the counterexample that forced Poincaré to refine his conjecture.`,
  } },
  { d: createHalfTurnDefect(atSite(4), 1.0), red: true, label: {
    title: 'Half-turn defect',
    aka: `the dicosm · the half-turn flat space form (holonomy ℤ/2)`,
    body: `A cube whose opposite faces are glued with a 180° twist. A flat 3-manifold; the partner wall arrives rotated a half turn, so “up” through it points down. Shown as a flattened stand-in: all three face-pairs twist, so the edges carry conical seams the smooth manifold has not.`,
  } },
  { d: createHexScrewDefect(atSite(5), 2 * Math.PI / 3, 'Third-turn defect', 0.64, 1.0), red: true, label: {
    title: 'Third-turn defect',
    aka: `the tricosm · the third-turn flat space form (holonomy ℤ/3)`,
    body: `A hexagonal cell: sides glued straight, caps glued with a 120° screw. Another of the six closed flat 3-manifolds, sibling to the sixth-turn cell.`,
  } },
  { d: createOctahedralDefect(atSite(6), 0.9), red: true, label: {
    title: 'Octahedral defect',
    aka: `a spherical space form · the octahedral opposite-face cell`,
    body: `An octahedron with its four pairs of opposite triangles glued by a 60° twist — a quotient of the 3-sphere, spinorial like the other closed space forms.`,
  } },
  { d: createSeifertWeberDefect(atSite(7), 1.1), red: true, label: {
    title: 'Seifert–Weber space',
    aka: `the Seifert–Weber dodecahedral space · the hyperbolic dodecahedral space`,
    body: `The same dodecahedron as the Poincaré cell, but the opposite faces are glued with a 108° twist instead of 36°. That single change tips it out of spherical geometry into hyperbolic — a closed hyperbolic 3-manifold. Same shape, different universe.`,
  } },
  { d: createLensSpaceDefect(atSite(8), 7, 1, 'Lens space L(7,1)'), red: false, label: {
    title: 'Lens space L(7,1)',
    aka: `a lens space · the cyclic spherical space form S³/(ℤ/7) · gluing screw 2π/7`,
    body: `A lens-shaped cell whose top cap glues to its bottom by a 2π/7 screw. A cyclic quotient of the 3-sphere — one of the non-spinorial spherical space forms. Paired here with L(7,2): same shape, same group, a different screw.`,
  } },
  { d: createLensSpaceDefect(atSite(9), 7, 2, 'Lens space L(7,2)'), red: false, label: {
    title: 'Lens space L(7,2)',
    aka: `a lens space · S³/(ℤ/7) · gluing screw 4π/7`,
    body: `The same heptagonal lens as L(7,1), glued with a 4π/7 screw instead of 2π/7. L(7,1) and L(7,2) are homotopy-equivalent yet not homeomorphic — the classic case where homotopy type fails to pin down a 3-manifold, and Reidemeister torsion is needed to tell them apart.`,
  } },
  { d: createHantzscheWendtDefect(atSite(10), 1.0), red: true, label: {
    title: 'Hantzsche–Wendt space',
    aka: `the Hantzsche–Wendt manifold · the didicosm (holonomy ℤ/2×ℤ/2)`,
    body: `The sixth and last closed orientable flat 3-manifold, completing the platycosms. Its walls glue by half-turns about axes that don't face you squarely — the only flat space form that is a rational homology sphere, with finite first homology. Shown as a flattened stand-in: the centred half-turns leave conical edge seams the smooth manifold has not.`,
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

entries.forEach(({ d, red, label }) => {
  scene.add(d.group);
  // signpost a couple of meters in front of the defect, on the side facing
  // the spawn area, turned toward the approaching observer
  let dx = -d.position.x, dz = -d.position.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-3) { dx = 0; dz = 1; } else { dx /= len; dz /= len; }
  const sx = d.position.x + dx * 2.5;
  const sz = d.position.z + dz * 2.5;
  const sign = createSignpost(label, red);
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
function renderDefectPortals() {
  const frustum = IS_MOBILE ? computeFrustum() : null;
  for (const d of defects) d.group.visible = false;
  for (const d of defects) d.render(renderer, scene, camera, drawSize, frustum);
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

  // Sun follows the player so the shadow frustum stays tight and crisp;
  // the anchor is snapped to shadow-map texels to stop edge shimmer.
  const texel = 110 / 2048;
  const ax = Math.round(camera.position.x / texel) * texel;
  const ay = Math.round(camera.position.y / texel) * texel;
  const az = Math.round(camera.position.z / texel) * texel;
  sun.position.set(ax, ay, az).addScaledVector(world.sunDir, 140);
  sun.target.position.set(ax, ay, az);

  renderer.shadowMap.needsUpdate = true; // rebuilt by the first render below
  renderDefectPortals();
  renderer.render(scene, camera);
}
animate();
