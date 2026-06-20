import * as THREE from 'three';
import { createWorld } from './world-inside.js';
import { PlayerController } from './player-inside.js';
import { setupMobileControls } from './input-touch-inside.js';
import { CELL_HALF, getTopology, TOPOLOGY_CATALOG } from './cell.js';

// ---- topology + poster selection from the query string ---------------------
// ?topo=<key> picks one of the nine flat 3-manifolds (default T^3). ?poster
// renders a single still and posts it to the embedding gallery, then stops.
const PARAMS = new URLSearchParams(location.search);
const topoKey = PARAMS.get('topo') ?? 'torus';
const TOPOLOGY = getTopology(topoKey);
const POSTER = PARAMS.has('poster');
const TOPO_META = TOPOLOGY_CATALOG.find((t) => t.key === TOPOLOGY.key) || TOPOLOGY_CATALOG[0];

// ---- device detection (same heuristic as the parent project) ---------------
function detectMobile() {
  const h = location.hash;
  if (h.includes('mobile')) return true;
  if (h.includes('desktop')) return false;
  const ua = navigator.userAgent || '';
  const touch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
  const uaData = navigator.userAgentData;
  if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile && touch;
  const uaMobile = /Android|iPhone|iPod|Mobile|IEMobile|BlackBerry|Opera Mini/i.test(ua);
  const iPadOS = /Macintosh/i.test(ua) && touch;
  return touch && (uaMobile || iPadOS);
}
const IS_MOBILE = detectMobile();

// Poster mode needs the framebuffer preserved so toDataURL can read it back, and
// a pixel ratio of 1 so the capture size is exactly width×height.
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: POSTER });
const MOBILE_PIXEL_RATIO = 1;
renderer.setPixelRatio(POSTER ? 1 : Math.min(devicePixelRatio, IS_MOBILE ? MOBILE_PIXEL_RATIO : 2));
renderer.setSize(innerWidth, innerHeight);
// Lighting: isotropic ambient floor + an orbiting sun (the directional light).
// On desktop the sun also casts real shadows via a depth pre-pass the world runs
// each frame (so it needs the renderer); baked vertex-colour contact AO underlies
// both. Mobile skips the cast-shadow pass. See world-inside.js.
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// far must clear the visible lattice corner; near kept modest so the heavy
// overlapping planet geometry has plenty of depth precision (no log-depth, since
// the custom RawShaderMaterial would not honour it and would mis-sort vs stock).
const FAR = (3 + 2) * 2 * CELL_HALF * 1.8;
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.6, FAR);

const world = createWorld(scene, { lowDetail: IS_MOBILE, renderer, topology: TOPOLOGY });

const player = new PlayerController(camera, renderer.domElement, world, { mobile: IS_MOBILE, topology: TOPOLOGY });

// HUD title reflects the active topology (the <b> line of the help panel).
{
  const hudTitle = document.querySelector('#hud b');
  if (hudTitle) hudTitle.textContent = 'Inside the ' + (TOPO_META.label?.title || TOPOLOGY.name);
  const titleEl = document.querySelector('title');
  if (titleEl) titleEl.textContent = TOPOLOGY.name + ' — from the inside';
}

// DIAG (temporary): with #diag in the URL, expose internals and allow a frozen,
// hand-posed camera for close-up inspection renders. Removed before release.
if (location.hash.includes('diag')) {
  window.__diag = {
    scene, camera, renderer, world, player, THREE,
    renderOnce: () => renderScene(),   // same path as the loop (applies the parity mirror)
  };
}

// Spawn out in the gulf, a little above the planet, looking down at it. With
// the cell halved the copies sit closer, so we start a bit nearer the surface.
camera.position.set(28, 40, 135);
camera.lookAt(world.planetCenter);

// ---- shared toggles ---------------------------------------------------------
function toggleOutlines() { world.edges.visible = !world.edges.visible; }
const outlinesOn = () => world.edges.visible;
function setCruise(mode) { player.cruise = player.cruise === mode ? 0 : mode; }

addEventListener('keydown', (e) => { if (e.code === 'KeyT') toggleOutlines(); });

if (IS_MOBILE) {
  document.getElementById('prompt')?.remove();
  setupMobileControls({
    dom: renderer.domElement, player,
    setCruise, getCruise: () => player.cruise,
    toggleOutlines, getOutlines: outlinesOn,
  });
} else {
  const dom = renderer.domElement;
  const locked = () => document.pointerLockElement === dom;
  let clickTimer = null;
  document.addEventListener('click', (e) => {
    if (e.button !== 0 || !locked()) return;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; setCruise(2); }
    else { clickTimer = setTimeout(() => { clickTimer = null; setCruise(1); }, 250); }
  });
  document.addEventListener('mousedown', (e) => {
    if (e.button === 2 && locked()) { e.preventDefault(); toggleOutlines(); }
  });
  document.addEventListener('contextmenu', (e) => { if (locked()) e.preventDefault(); });
}

// ---- resize -----------------------------------------------------------------
function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', onResize);
addEventListener('orientationchange', onResize);
onResize();

// ---- whole-scene mirror for odd parity (non-orientable cells) ---------------
// Householder reflection H across the vertical plane through the camera (normal =
// camera-right). Applied as scene.matrix when the observer's parity < 0, so the
// entire rendered world appears mirror-reversed left↔right. det H = −1, which
// Three.js propagates through every object's effective world matrix, flipping
// face winding and keeping backface culling correct. For all six orientable
// topologies parity stays +1 and this is never built — the render is a bare
// renderer.render(scene, camera) with no overhead.
const _camRight = new THREE.Vector3();
const _sceneMirror = new THREE.Matrix4();
function buildCameraMirror(cam, out) {
  _camRight.set(1, 0, 0).applyQuaternion(cam.quaternion).normalize();
  const r = _camRight, p = cam.position;
  const rx = r.x, ry = r.y, rz = r.z;
  const d = 2 * (p.x * rx + p.y * ry + p.z * rz);
  out.set(
    1 - 2 * rx * rx, -2 * rx * ry, -2 * rx * rz, d * rx,
    -2 * ry * rx, 1 - 2 * ry * ry, -2 * ry * rz, d * ry,
    -2 * rz * rx, -2 * rz * ry, 1 - 2 * rz * rz, d * rz,
    0, 0, 0, 1,
  );
  return out;
}
function renderScene() {
  const mirror = player.parity < 0 ? buildCameraMirror(camera, _sceneMirror) : null;
  if (mirror) {
    const prevAuto = scene.matrixAutoUpdate;
    scene.matrixAutoUpdate = false;
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

// ---- poster mode: one frame, post it, stop (no animation loop) --------------
if (POSTER) {
  world.update(0, camera);          // set the initial scene state (sun, clouds, shadows)
  renderScene();                    // render one frame, including the shadow map and planet
  const url = renderer.domElement.toDataURL('image/jpeg', 0.82);
  try { parent.postMessage({ type: 'poster', id: PARAMS.get('id'), url }, '*'); } catch (_) {}
} else {
  // ---- render loop (single pass) --------------------------------------------
  const clock = new THREE.Clock();
  (function animate() {
    if (window.__stop) return;        // diagnostics: freeze the loop for static capture
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!window.__frozen) player.update(dt);
    world.update(dt, camera);
    renderScene();
  })();
}
