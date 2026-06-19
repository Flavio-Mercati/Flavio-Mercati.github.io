// Free-floating first-person camera with bee-like crossing dynamics.
//
// W/S fly forward/backward along the FULL view direction (including pitch);
// A/D strafe horizontally; Space/C float up/down along WORLD vertical (handy
// for absolute altitude); E/Q float up/down along the CAMERA-LOCAL vertical
// (so when pitched, "up" follows the top of your head).
// Run: hold Shift, or toggle with CapsLock (tracked via the actual lock
// state). Position is clamped to the terrain/bridge deck, the boundary
// radius, and a max altitude — the observer is trapped.
//
// Crossing a defect applies the FULL gluing isometry, orientation included:
// the camera's orientation is tilt ∘ base, where base is the roll-free
// yaw/pitch frame and tilt is a residual rotation. On crossing, the gluing
// rotation is applied exactly (seamless transition) and yaw/pitch are
// re-derived from the new forward direction. Because base then shares the
// new forward direction, the leftover offset is a PURE ROLL about the view
// axis by some angle θ — i.e. how far the crossing banked your sense of "up".
// Only if θ ≠ 0 does the view oscillate: the tilt becomes a damped harmonic
// oscillator with equilibrium upright and initial angle θ (zero initial
// velocity), so it swings level, overshoots, bobs, and settles in ~1 s, like
// a bee righting itself. A pure-yaw crossing (vertical-axis quarter-turn
// face) or a pure translation (torus, wormhole) leaves θ = 0 and so produces
// no wobble at all.

import * as THREE from 'three';

const WALK_SPEED = 3.5;  // m/s
const RUN_MULT = 4.2;       // run = 1.5× the former (3.5 m/s walk → 14.7 m/s run)
const SPRING_W = 7.0;    // rad/s — sets the ~1 s recovery time
const SPRING_ZETA = 0.28; // < 1: underdamped → visible bob
const TILT_EPS = 0.03;   // rad — below this residual roll, no oscillation

const _qNew = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _vUp = new THREE.Vector3();    // scratch: base "up" at a crossing
const _vCross = new THREE.Vector3(); // scratch: baseUp × carried-up

export class PlayerController {
  constructor(camera, dom, world, opts = {}) {
    this.camera = camera;
    this.world = world;
    this.dom = dom;
    this.mobile = !!opts.mobile;
    this.yaw = 0;
    this.pitch = 0;
    // Constant-speed "cruise" toggled by clicks (desktop) or the on-screen
    // speed buttons (mobile): 0 = off, 1 = slow (walk), 2 = fast (run). It
    // flies along the FULL view direction, exactly like holding W, so you
    // steer a cruise by aiming. Manual WASD still adds on top of it.
    this.cruise = 0;
    this.keys = new Set();
    this.capsRun = false;
    this.prev = new THREE.Vector3();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._move = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._localUp = new THREE.Vector3();
    this._baseQ = new THREE.Quaternion();
    this._tiltQ = new THREE.Quaternion();
    this._tiltAxis = new THREE.Vector3(1, 0, 0);
    this._tiltAngle = 0;
    this._tiltVel = 0;
    // Handedness/orientation parity of the traveller: +1 normal, −1 mirrored.
    // Flipped by crossing an orientation-reversing (det −1) face; odd parity
    // renders the whole world mirrored (see main.js).
    this.parity = 1;

    // Mouse-look needs pointer lock, which only exists on desktop; on a touch
    // device the on-screen drag (js/input-touch.js) writes yaw/pitch directly,
    // so we skip all of this there (and avoid hijacking taps into lock requests).
    if (!this.mobile) {
      const prompt = document.getElementById('prompt');
      document.addEventListener('click', () => {
        if (document.pointerLockElement !== dom) dom.requestPointerLock();
      });
      document.addEventListener('pointerlockchange', () => {
        prompt.classList.toggle('hidden', document.pointerLockElement === dom);
      });
      document.addEventListener('mousemove', (e) => {
        if (document.pointerLockElement !== dom) return;
        // Horizontal look flips with parity: in a mirrored world (odd parity)
        // the view is reflected left↔right, so dragging right must still pan
        // toward what sits on the right of the flipped screen. Pitch is
        // vertical, which the left-right mirror leaves alone.
        this.yaw -= e.movementX * 0.0022 * this.parity;
        this.pitch -= e.movementY * 0.0022;
        this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
      });
    }
    const trackCaps = (e) => {
      if (e.getModifierState) this.capsRun = e.getModifierState('CapsLock');
    };
    addEventListener('keydown', (e) => { this.keys.add(e.code); trackCaps(e); });
    addEventListener('keyup', (e) => { this.keys.delete(e.code); trackCaps(e); });
    addEventListener('blur', () => this.keys.clear());
  }

  _composeOrientation() {
    this._euler.set(this.pitch, this.yaw, 0);
    this._baseQ.setFromEuler(this._euler);
    if (this._tiltAngle !== 0 || this._tiltVel !== 0) {
      this._tiltQ.setFromAxisAngle(this._tiltAxis, this._tiltAngle);
      this.camera.quaternion.copy(this._tiltQ).multiply(this._baseQ);
    } else {
      this.camera.quaternion.copy(this._baseQ);
    }
  }

  update(dt, defects) {
    const cam = this.camera;

    // evolve the recovery tilt (underdamped spring toward upright)
    if (this._tiltAngle !== 0 || this._tiltVel !== 0) {
      this._tiltVel += (-SPRING_W * SPRING_W * this._tiltAngle
                        - 2 * SPRING_ZETA * SPRING_W * this._tiltVel) * dt;
      this._tiltAngle += this._tiltVel * dt;
      if (Math.abs(this._tiltAngle) < 1e-4 && Math.abs(this._tiltVel) < 1e-3) {
        this._tiltAngle = 0;
        this._tiltVel = 0;
      }
    }
    this._composeOrientation();

    this.prev.copy(cam.position);

    const k = this.keys;
    const running = k.has('ShiftLeft') || k.has('ShiftRight') || this.capsRun;
    const speed = WALK_SPEED * (running ? RUN_MULT : 1);

    // W/S: full 3D view direction (tilt included — bees fly where they look).
    // A/D: horizontal strafe. Space/C: world vertical. E/Q: camera-local
    // vertical (the top-of-head axis, so it tilts with the view).
    const fwd = this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const v = this._move.set(0, 0, 0);
    if (k.has('KeyW')) v.add(fwd);
    if (k.has('KeyS')) v.sub(fwd);
    // Strafe runs along the camera-right axis. In a mirrored world the view
    // is flipped left↔right, so screen-right is world-left: fold parity in so
    // D always moves toward the right of the (possibly mirrored) screen.
    const px = this.parity;
    if (k.has('KeyD')) { v.x += cy * px; v.z -= sy * px; }
    if (k.has('KeyA')) { v.x -= cy * px; v.z += sy * px; }
    if (k.has('Space')) v.y += 1;
    if (k.has('KeyC')) v.y -= 1;
    if (k.has('KeyE') || k.has('KeyQ')) {
      const up = this._localUp.set(0, 1, 0).applyQuaternion(cam.quaternion);
      if (k.has('KeyE')) v.add(up);
      if (k.has('KeyQ')) v.sub(up);
    }
    if (v.lengthSq() > 0) {
      v.normalize().multiplyScalar(speed * dt);
      cam.position.add(v);
    }

    // Constant-speed cruise (click / speed buttons): glide forward along the
    // full view direction at a fixed speed, independent of the keys. Slow =
    // walk, fast = run. Added separately so its speed stays exact (the key
    // vector above is normalised, which would otherwise rescale it).
    if (this.cruise) {
      const cs = WALK_SPEED * (this.cruise === 2 ? RUN_MULT : 1);
      cam.position.addScaledVector(fwd, cs * dt);
    }

    // Pass through any defect we flew into: apply the FULL gluing isometry.
    for (const d of defects) {
      const tp = d.tryTeleport(this.prev, cam.position);
      if (!tp) continue;
      cam.position.copy(tp.position);
      this.parity *= tp.parity; // det −1 faces flip the traveller's handedness

      // Carry the look direction through the FULL gluing isometry — proper
      // rotation AND any det −1 glide reflection — exactly as `position` was
      // (tp.linear is that isometry's linear part, translation aside). The
      // flight velocity follows the look, so the geodesic stays straight across
      // the seam: no jerk, and the velocity component parallel to the face is
      // NOT spuriously flipped. Handedness rides in `parity` (main.js mirrors
      // the view for odd parity).
      const fwd = this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion).applyMatrix4(tp.linear).normalize();
      const up = this._localUp.set(0, 1, 0).applyQuaternion(cam.quaternion).applyMatrix4(tp.linear).normalize();

      // roll-free base: yaw/pitch from the carried forward direction
      this.yaw = Math.atan2(-fwd.x, -fwd.z);
      const fy = Math.max(-1, Math.min(1, fwd.y));
      this.pitch = Math.max(-1.55, Math.min(1.55, Math.asin(fy)));
      this._euler.set(this.pitch, this.yaw, 0);
      this._baseQ.setFromEuler(this._euler);

      // Residual bank = signed roll about the view axis carrying the base's
      // "up" onto the carried "up" (both ⊥ fwd): θ = atan2((baseUp×up)·fwd,
      // baseUp·up). θ = 0 for level flight through a pure glide, and for any
      // pure-yaw or pure-translation crossing — no wobble there. Otherwise the
      // tilt becomes a damped spring that bobs upright like a bee.
      const baseUp = _vUp.set(0, 1, 0).applyQuaternion(this._baseQ);
      const sinT = _vCross.crossVectors(baseUp, up).dot(fwd);
      const cosT = Math.max(-1, Math.min(1, baseUp.dot(up)));
      const theta = Math.atan2(sinT, cosT);
      if (Math.abs(theta) > TILT_EPS) {
        // damped harmonic oscillator: equilibrium upright, x(0)=θ, x'(0)=0
        this._tiltAxis.copy(fwd);
        this._tiltAngle = theta;
        this._tiltVel = 0;
      }
      this._composeOrientation();
      this.prev.copy(tp.position);
    }

    // Solid cottages: push the camera out of any cottage box it has entered.
    const RAD = 0.45;
    for (const c of this.world.cottages) {
      const dx = cam.position.x - c.x, dz = cam.position.z - c.z;
      const lx = dx * c.cos - dz * c.sin;       // world -> cottage-local
      const lz = dx * c.sin + dz * c.cos;
      const hw = c.hw + RAD, hd = c.hd + RAD;
      const cyc = (c.baseY + c.top) / 2, hh = (c.top - c.baseY) / 2 + RAD;
      const px = hw - Math.abs(lx), pz = hd - Math.abs(lz), py = hh - Math.abs(cam.position.y - cyc);
      if (px > 0 && pz > 0 && py > 0) {           // inside: eject along least-penetration axis
        if (px <= pz && px <= py) {
          const nlx = lx >= 0 ? hw : -hw;
          cam.position.x = c.x + nlx * c.cos + lz * c.sin;
          cam.position.z = c.z - nlx * c.sin + lz * c.cos;
        } else if (pz <= px && pz <= py) {
          const nlz = lz >= 0 ? hd : -hd;
          cam.position.x = c.x + lx * c.cos + nlz * c.sin;
          cam.position.z = c.z - lx * c.sin + nlz * c.cos;
        } else {
          cam.position.y = cam.position.y >= cyc ? cyc + hh : cyc - hh;
        }
      }
    }

    // The observer is trapped: floor (terrain or bridge deck), ceiling, boundary
    const minY = this.world.getHeight(cam.position.x, cam.position.z, cam.position.y) + 0.45;
    if (cam.position.y < minY) cam.position.y = minY;
    if (cam.position.y > this.world.maxAltitude) cam.position.y = this.world.maxAltitude;
    const r = Math.hypot(cam.position.x, cam.position.z);
    if (r > this.world.boundsRadius) {
      const f = this.world.boundsRadius / r;
      cam.position.x *= f;
      cam.position.z *= f;
    }
  }
}
