// Free-floating observer for the interior view. Orientation is a 6-DOF body in
// its OWN frame (mouse yaws/pitches, E/Q roll about the line of sight), but
// translation is now NEWTONIAN, not direct: the observer is a little flying body
// ("a bee") with a persistent velocity, pulled by the planet's faint gravity and
// pushed by thrust along whatever directions are held — forward/back, strafe,
// and (new) up/down relative to where you are looking. Aerodynamic drag gives a
// terminal velocity: the "slow" setting and "fast/boost" setting simply raise
// both the thrust and that drag-limited top speed (the bee pushing its
// aerodynamics). Releasing the keys, you coast and gravity gently curves you in.
//
// Containment is the manifold itself: crossing a wall wraps the observer (and
// its velocity) to the partner wall via that face's gluing — pure translation
// for T^3. The one solid obstacle is the planet; the body skims its hilly
// surface and the inward velocity is absorbed there so resting is stable.
//
// H toggles HOVER: gravity is switched off and motion is restricted to the two
// tangential directions at a locked radius, so you orbit the planet at constant
// altitude (handy for surveying the surface). R / F raise / lower that altitude.

import * as THREE from 'three';
import { reduceToCell, getTopology } from './cell.js';

const V_SLOW = 14;     // m/s — drag-limited cruise (also the gravity terminal scale)
const V_FAST = 42;     // m/s — boosted top speed
const DRAG = 0.5;      // 1/s — linear drag; terminal = thrust / DRAG
const ROLL_SPEED = 1.6;   // rad/s for E / Q
const LOOK_SENS = 0.0022; // rad per pixel (desktop mouse)
const MAX_SPEED = V_FAST * 1.6; // hard safety clamp on |v|

export class PlayerController {
  constructor(camera, dom, world, opts = {}) {
    this.camera = camera;
    this.world = world;
    this.dom = dom;
    this.mobile = !!opts.mobile;
    // The active flat-manifold topology drives the wall identifications. Defaults
    // to T^3 so old callers are unchanged; main.js passes the URL-selected one.
    this.topology = opts.topology || getTopology('torus');
    this.keys = new Set();
    this.capsRun = false;
    this.cruise = 0;        // 0 off / 1 slow / 2 fast
    this.parity = 1;        // handedness; flips on non-orientable (glide-reflected) crossings
    this.roll = 0;          // current roll input from buttons: -1 / 0 / +1
    this.hover = false;     // hover mode: hold a fixed radius, move only tangentially
    this.hoverR = 0;        // the locked distance from the planet centre
    this._lookDX = 0;       // accumulated look delta (pixels) since last frame
    this._lookDY = 0;

    this.vel = new THREE.Vector3(); // persistent world-space velocity

    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._thrust = new THREE.Vector3();
    this._acc = new THREE.Vector3();
    this._grav = new THREE.Vector3();
    this._dq = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'XYZ');
    this._dir = new THREE.Vector3();
    this._rad = new THREE.Vector3();

    if (!this.mobile) {
      const prompt = document.getElementById('prompt');
      document.addEventListener('click', () => {
        if (document.pointerLockElement !== dom) dom.requestPointerLock();
      });
      document.addEventListener('pointerlockchange', () => {
        if (prompt) prompt.classList.toggle('hidden', document.pointerLockElement === dom);
      });
      document.addEventListener('mousemove', (e) => {
        if (document.pointerLockElement !== dom) return;
        this._lookDX += e.movementX;
        this._lookDY += e.movementY;
      });
    }
    const trackCaps = (e) => { if (e.getModifierState) this.capsRun = e.getModifierState('CapsLock'); };
    addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      trackCaps(e);
      if (e.code === 'KeyH' && !e.repeat) this.toggleHover();
    });
    addEventListener('keyup', (e) => { this.keys.delete(e.code); trackCaps(e); });
    addEventListener('blur', () => { this.keys.clear(); this.roll = 0; });
  }

  // Hover: hold the current distance from the planet centre and restrict motion
  // to the two tangential directions (gravity and any radial thrust are removed).
  toggleHover() {
    this.hover = !this.hover;
    if (this.hover) this.hoverR = this.camera.position.distanceTo(this.world.planetCenter);
  }

  // touch / external look input (pixels). Aim-style: right -> look right.
  applyLook(dx, dy) { this._lookDX += dx; this._lookDY += dy; }
  setRoll(dir) { this.roll = dir; } // -1 anticlockwise, +1 clockwise, 0 none

  update(dt) {
    const cam = this.camera;

    // ---- orientation: compose a small local-frame rotation this frame -------
    let rollInput = this.roll;
    if (this.keys.has('KeyE')) rollInput += 1;  // clockwise
    if (this.keys.has('KeyQ')) rollInput -= 1;  // anticlockwise
    const yaw = -this._lookDX * LOOK_SENS * this.parity; // horizontal flips when mirrored
    const pitch = -this._lookDY * LOOK_SENS;
    const roll = rollInput * ROLL_SPEED * dt;
    this._lookDX = 0; this._lookDY = 0;
    if (yaw || pitch || roll) {
      this._e.set(pitch, yaw, roll, 'YXZ');
      this._dq.setFromEuler(this._e);
      cam.quaternion.multiply(this._dq);
      cam.quaternion.normalize();
    }

    // ---- thrust: a direction in the camera frame from the held keys ---------
    const fwd = this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const right = this._right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const thrust = this._thrust.set(0, 0, 0);
    const k = this.keys;
    if (k.has('KeyW')) thrust.add(fwd);
    if (k.has('KeyS')) thrust.sub(fwd);
    if (k.has('KeyD')) thrust.addScaledVector(right, this.parity);
    if (k.has('KeyA')) thrust.addScaledVector(right, -this.parity);
    if (!this.mobile && !this.hover) {        // up/down relative to where you look
      if (k.has('KeyR') || k.has('Space')) thrust.add(up);
      if (k.has('KeyF')) thrust.sub(up);
    }
    if (this.cruise) thrust.add(fwd);          // hands-free forward cruise

    const boosting = this.cruise === 2 || k.has('ShiftLeft') || k.has('ShiftRight') || this.capsRun;
    const topSpeed = boosting ? V_FAST : V_SLOW;
    const thrustAccel = DRAG * topSpeed;       // so sustained thrust -> topSpeed

    const v = this.vel;
    const c = this.world.planetCenter;
    const acc = this._acc.set(0, 0, 0);

    if (this.hover) {
      // ---- hover: glide in the tangent plane; R/F raise/lower the altitude ----
      if (!this.mobile) {                                  // change the locked radius
        if (k.has('KeyR') || k.has('Space')) this.hoverR += topSpeed * dt;
        if (k.has('KeyF')) this.hoverR -= topSpeed * dt;
      }
      const radial = this._rad.copy(cam.position).sub(c);
      const d0 = radial.length();
      if (d0 > 1e-4) radial.multiplyScalar(1 / d0); else radial.set(0, 1, 0);
      if (thrust.lengthSq() > 1e-9) acc.addScaledVector(thrust.normalize(), thrustAccel);
      acc.addScaledVector(radial, -acc.dot(radial));     // drop the radial part of thrust
      v.addScaledVector(acc, dt);
      v.multiplyScalar(Math.exp(-DRAG * dt));
      v.addScaledVector(radial, -v.dot(radial));         // keep velocity tangential
      if (v.lengthSq() > MAX_SPEED * MAX_SPEED) v.setLength(MAX_SPEED);
      cam.position.addScaledVector(v, dt);
      // re-lock the radius (never inside the terrain), stay tangential
      const dir = this._dir.copy(cam.position).sub(c);
      const d = dir.length();
      if (d > 1e-4) {
        dir.multiplyScalar(1 / d);
        const floor = this.world.radiusAtDir(dir) + 1.5;
        if (this.hoverR < floor) this.hoverR = floor;    // don't sink the lock below ground
        cam.position.copy(c).addScaledVector(dir, this.hoverR);
        v.addScaledVector(dir, -v.dot(dir));
      }
    } else {
      // ---- free flight: gravity + thrust, drag, then planet collision ---------
      this.world.gravityAt(this._grav, cam.position);
      acc.add(this._grav);
      if (thrust.lengthSq() > 1e-9) acc.addScaledVector(thrust.normalize(), thrustAccel);
      v.addScaledVector(acc, dt);
      v.multiplyScalar(Math.exp(-DRAG * dt));    // aerodynamic drag -> terminal velocity
      if (v.lengthSq() > MAX_SPEED * MAX_SPEED) v.setLength(MAX_SPEED);
      cam.position.addScaledVector(v, dt);

      this._dir.copy(cam.position).sub(c);
      const dist = this._dir.length();
      if (dist > 1e-4) {
        this._dir.multiplyScalar(1 / dist);                 // outward radial unit
        const minR = this.world.radiusAtDir(this._dir) + 1.5; // skim just above surface
        if (dist < minR) {
          cam.position.copy(c).addScaledVector(this._dir, minR);
          const vn = v.dot(this._dir);                      // remove only the INWARD part,
          if (vn < 0) v.addScaledVector(this._dir, -vn);    // so resting is stable, lift-off still works
        }
      }
    }
    // solid props the terrain skim does not cover: the cottages and the pond
    // water surface (you skim the water, you do not dive through it).
    if (this.world.clampToObstacles) this.world.clampToObstacles(cam.position, v);
    // face identifications: wrap back into the cell, carrying velocity through the
    // gluing's linear part. For T^3 this is pure translation (a no-op linear map,
    // identity rotation, parity +1). For twisted cells the proper rotation reorients
    // the camera; for non-orientable cells the reflection flips handedness (parity),
    // which the renderer realises as a whole-scene mirror — never baked into the
    // camera quaternion. The crossing is INSTANTANEOUS: no spring, no recovery wobble.
    const red = reduceToCell(cam.position, this.topology);
    if (red.changed) {
      v.applyMatrix4(red.linear);                    // velocity through the full linear part
      this.parity *= red.parity;                     // flip handedness on reflecting crossings
      // Only touch the camera when the gluing carries a real proper rotation. For
      // T^3 (and any pure-translation / pure-glide crossing) rotationQuat is the
      // identity, so we leave the quaternion byte-for-byte untouched — the
      // controller's orientation rides through exactly as before.
      const rq = red.rotationQuat;
      if (rq.x !== 0 || rq.y !== 0 || rq.z !== 0 || rq.w !== 1) {
        cam.quaternion.premultiply(rq);              // apply the proper rotation only
        cam.quaternion.normalize();
      }
    }
  }
}
