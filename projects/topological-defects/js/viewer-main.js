// Single-defect orbit viewer (mobile + desktop).
//
// The world is the SAME world as the full simulation — this file imports
// world.js / defect.js / sites.js unchanged, so the terrain, river, bridge,
// cottages, vegetation and flower patches are byte-for-byte identical. The
// only differences from main.js are: exactly one defect is created, there are
// no signposts, and the free-fly PlayerController is replaced by an orbit
// camera you steer by dragging (one finger on touch, hold-drag on desktop).
//
// Which defect this page shows is chosen by the URL hash, so a single
// viewer.html serves every defect:
//   viewer.html            -> torus (the first defect; the default)
//   viewer.html#quarter  #hex6  #dodeca  #half  #hex3  #octa
//   viewer.html#seifert  #lens71  #lens72  #hw
// (Keys, sites and sizes all come from js/viewer-defects.js.)
//
// Two run modes, selected by the query string (used by gallery.html):
//   ?poster   render ONE frame, post it back to the parent as a JPEG, stop.
//             (the still preview shown in the gallery before you tap a window)
//   (default) run the live orbit loop; after the first frame, post 'ready'.
// An optional &id=... is echoed back so the gallery can match the message to
// the right window.

import * as THREE from 'three';
import { createWorld } from './world.js';
import { DEFECT_SITES } from './sites.js';
import { VIEWER_DEFECTS } from './viewer-defects.js';

// ---- mode + defect selection ------------------------------------------------
const params = new URLSearchParams(location.search);
const POSTER = params.has('poster');
const FRAME_ID = params.get('id');
const SEL_KEY = location.hash.replace('#', '');

const BY_KEY = Object.fromEntries(VIEWER_DEFECTS.map((d) => [d.key, d]));
const CHOICE = BY_KEY[SEL_KEY] || VIEWER_DEFECTS[0];

// ---- renderer / scene / camera (identical setup to main.js) -----------------
// preserveDrawingBuffer is needed only in poster mode so toDataURL is reliable.
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: POSTER });
renderer.setPixelRatio(POSTER ? 1 : Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
renderer.shadowMap.autoUpdate = false; // built once per frame, shared by all passes
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const BASE_FOV = 70;               // framing reference for the 2/3-width fit
const FOV_MIN = 25, FOV_MAX = 95;  // zoom limits (fov only — the observer never moves)
const camera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.05, 2000);

const world = createWorld(scene);

// ---- lighting (identical to main.js) ----------------------------------------
const sun = new THREE.DirectionalLight(0xfff3d6, 3.0);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -55;
sun.shadow.camera.right = 55;
sun.shadow.camera.top = 55;
sun.shadow.camera.bottom = -55;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 400;
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 4;
sun.shadow.blurSamples = 8;
scene.add(sun);
scene.add(sun.target);
scene.add(new THREE.HemisphereLight(0xbfdcff, 0x6a8a4f, 1.1));

// ---- the one defect, at its real site, ~2 m above the terrain ---------------
const s = DEFECT_SITES[CHOICE.site];
const center = new THREE.Vector3(s.x, world.getHeight(s.x, s.z) + 2, s.z);
const defect = CHOICE.make(center);
scene.add(defect.group);
const defects = [defect];

// ---- orbit framing ----------------------------------------------------------
// Distance set so the defect's across-width fills SCREEN_FRACTION of the
// viewport WIDTH. across-width = largest extent of the defect's own outline
// (0.5 m for the cube); using the local outline (not the live silhouette)
// keeps the framing steady as you orbit instead of breathing.
//   fraction = W / (2·d·tan(hfov/2)),  tan(hfov/2) = aspect·tan(vfov/2)
const SCREEN_FRACTION = 2 / 3;

const og = defect.edges.geometry;
og.computeBoundingBox();
og.computeBoundingSphere();
const _ext = new THREE.Vector3();
og.boundingBox.getSize(_ext);
const ACROSS = Math.max(_ext.x, _ext.y, _ext.z);
const MIN_DIST = og.boundingSphere.radius * 2.0; // never enter the cell on wide screens

let radius = MIN_DIST;
let az = 0.6;   // initial 3/4 view so the displacement through the defect reads
let el = 0.34;
const EL_MIN = -1.2;
const EL_MAX = 1.45;

function computeRadius() {
  const tanV = Math.tan(THREE.MathUtils.degToRad(BASE_FOV) / 2);
  const tanH = camera.aspect * tanV;
  const d = (ACROSS * 0.5) / (SCREEN_FRACTION * tanH);
  radius = Math.max(d, MIN_DIST);
}

function updateCamera() {
  el = Math.min(EL_MAX, Math.max(EL_MIN, el));
  const ce = Math.cos(el), se = Math.sin(el);
  camera.position.set(
    center.x + radius * ce * Math.sin(az),
    center.y + radius * se,
    center.z + radius * ce * Math.cos(az)
  );
  const floor = world.getHeight(camera.position.x, camera.position.z, camera.position.y) + 0.3;
  if (camera.position.y < floor) camera.position.y = floor;
  camera.lookAt(center);
}

// ---- input: drag to orbit, pinch / wheel to zoom the field of view ----------
// Zoom changes ONLY the camera fov — the observer never moves. One finger (or a
// held mouse) orbits; two fingers pinch; the mouse wheel and trackpad pinch
// (which the browser delivers as a ctrl+wheel event) zoom on desktop.
const ROT = 0.005; // rad per pixel
const canvas = renderer.domElement;

function setFov(f) {
  camera.fov = Math.min(FOV_MAX, Math.max(FOV_MIN, f));
  camera.updateProjectionMatrix();
}

const pointers = new Map();  // pointerId -> { x, y }
let mode = null;             // 'orbit' | 'pinch'
let orbitId = null, lastX = 0, lastY = 0;
let pinchDist0 = 0, pinchFov0 = 0;

const twoFingerDist = () => {
  const p = [...pointers.values()];
  return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
};

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture?.(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  hideHint();
  if (pointers.size === 1) {
    mode = 'orbit'; orbitId = e.pointerId; lastX = e.clientX; lastY = e.clientY;
  } else if (pointers.size === 2) {
    mode = 'pinch'; pinchDist0 = twoFingerDist(); pinchFov0 = camera.fov;
  }
  e.preventDefault();
});

canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX; p.y = e.clientY;
  if (mode === 'pinch' && pointers.size >= 2) {
    const d = twoFingerDist();
    if (d > 0 && pinchDist0 > 0) setFov(pinchFov0 * (pinchDist0 / d)); // fingers apart -> zoom in
  } else if (mode === 'orbit' && e.pointerId === orbitId) {
    az -= (e.clientX - lastX) * ROT;
    el += (e.clientY - lastY) * ROT;   // drag down -> look down (vertical reversed)
    lastX = e.clientX; lastY = e.clientY;
  }
});

const dropPointer = (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 1) {           // lift one of two fingers -> resume orbiting with the other
    mode = 'orbit';
    const [id, p] = [...pointers.entries()][0];
    orbitId = id; lastX = p.x; lastY = p.y;
  } else if (pointers.size === 0) {
    mode = null; orbitId = null;
  }
};
canvas.addEventListener('pointerup', dropPointer);
canvas.addEventListener('pointercancel', dropPointer);
canvas.addEventListener('lostpointercapture', dropPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// mouse wheel + trackpad pinch (ctrl+wheel) -> fov zoom
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  setFov(camera.fov * Math.exp(e.deltaY * 0.0015)); // scroll up / pinch out -> zoom in
}, { passive: false });

// ---- UI: name label, drag hint, edge toggle --------------------------------
document.getElementById('label').textContent = CHOICE.label.title;

const hint = document.getElementById('hint');
let hintShown = true;
function hideHint() {
  if (!hintShown) return;
  hintShown = false;
  hint.classList.add('gone');
}

const btn = document.getElementById('edges');
function syncBtn() {
  const on = defect.edges.visible;
  btn.textContent = on ? 'Edges: on' : 'Edges: off';
  btn.setAttribute('aria-pressed', String(on));
}
btn.addEventListener('click', () => { defect.toggleEdges(); syncBtn(); });
syncBtn();

// ---- resize -----------------------------------------------------------------
const drawSize = new THREE.Vector2();
const PORTAL_RT_SCALE = 0.6; // portal textures at 60% of buffer res (mobile-friendly)

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
  computeRadius();
}
addEventListener('resize', onResize);
addEventListener('orientationchange', onResize);
onResize();

// ---- one frame, used by both modes ------------------------------------------
function placeSun() {
  const texel = 110 / 2048;
  const ax = Math.round(camera.position.x / texel) * texel;
  const ay = Math.round(camera.position.y / texel) * texel;
  const azp = Math.round(camera.position.z / texel) * texel;
  sun.position.set(ax, ay, azp).addScaledVector(world.sunDir, 140);
  sun.target.position.set(ax, ay, azp);
}

function renderFrame() {
  updateCamera();
  placeSun();
  renderer.shadowMap.needsUpdate = true;
  defect.group.visible = false;          // no recursion: hide during its own portal pass
  defect.render(renderer, scene, camera, drawSize);
  defect.group.visible = true;
  renderer.render(scene, camera);
}

const post = (msg) => { try { parent.postMessage(msg, '*'); } catch (_) {} };

if (POSTER) {
  // Render exactly the first live frame, hand a still back, then stop.
  world.update(0);
  renderFrame();
  let url = '';
  try { url = renderer.domElement.toDataURL('image/jpeg', 0.82); } catch (_) {}
  post({ type: 'poster', id: FRAME_ID, url });
} else {
  const clock = new THREE.Clock();
  let announced = false;
  (function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    world.update(dt);
    renderFrame();
    if (!announced) { announced = true; post({ type: 'ready', id: FRAME_ID }); }
  })();
}
