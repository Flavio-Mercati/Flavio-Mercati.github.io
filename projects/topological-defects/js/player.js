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
const RUN_MULT = 2.8;
const SPRING_W = 7.0;    // rad/s — sets the ~1 s recovery time
const SPRING_ZETA = 0.28; // < 1: underdamped → visible bob
const TILT_EPS = 0.03;   // rad — below this residual roll, no oscillation

const _qNew = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();

export class PlayerController {
  constructor(camera, dom, world) {
    this.camera = camera;
    this.world = world;
    this.dom = dom;
    this.yaw = 0;
    this.pitch = 0;
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

    const prompt = document.getElementById('prompt');
    document.addEventListener('click', () => {
      if (document.pointerLockElement !== dom) dom.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      prompt.classList.toggle('hidden', document.pointerLockElement === dom);
    });
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== dom) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
    });
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
    if (k.has('KeyD')) { v.x += cy; v.z -= sy; }
    if (k.has('KeyA')) { v.x -= cy; v.z += sy; }
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

    // Pass through any defect we flew into: apply the FULL gluing isometry.
    for (const d of defects) {
      const tp = d.tryTeleport(this.prev, cam.position);
      if (!tp) continue;
      cam.position.copy(tp.position);

      // exact new orientation = gluing rotation ∘ current full orientation
      _qNew.copy(tp.rotation).multiply(cam.quaternion);

      // roll-free part: yaw/pitch from the rotated forward direction
      this._fwd.set(0, 0, -1).applyQuaternion(_qNew);
      this.yaw = Math.atan2(-this._fwd.x, -this._fwd.z);
      const fy = Math.max(-1, Math.min(1, this._fwd.y));
      this.pitch = Math.max(-1.55, Math.min(1.55, Math.asin(fy)));
      this._euler.set(this.pitch, this.yaw, 0);
      this._baseQ.setFromEuler(this._euler);

      // Offset such that full = offset ∘ base. Since base shares full's
      // forward direction, the offset is a pure ROLL about the view axis by
      // angle θ — the bank the crossing imparted to "up". Oscillate ONLY if
      // θ is non-negligible; a pure-yaw or pure-translation crossing gives
      // θ ≈ 0 and leaves the view steady (no wobble).
      _qInv.copy(this._baseQ).invert();
      _qNew.multiply(_qInv);
      if (_qNew.w < 0) { // canonical hemisphere → angle in [0, π]
        _qNew.set(-_qNew.x, -_qNew.y, -_qNew.z, -_qNew.w);
      }
      const s = Math.sqrt(Math.max(0, 1 - _qNew.w * _qNew.w));
      const theta = 2 * Math.acos(Math.min(1, _qNew.w));
      if (s > 1e-4 && theta > TILT_EPS) {
        // damped harmonic oscillator: equilibrium upright, x(0)=θ, x'(0)=0
        this._tiltAxis.set(_qNew.x / s, _qNew.y / s, _qNew.z / s);
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
