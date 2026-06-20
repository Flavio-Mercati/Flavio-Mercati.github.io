// The containing polyhedral CELL and the flat manifold it represents, seen from
// the INSIDE. Where the parent project floated tiny portal-glued defects in an
// open landscape, here the whole world is one fundamental domain whose faces are
// identified: the observer lives inside a single cube (or hex prism, or rhombic
// dodecahedron) and the repeated images of the central planet seen through the
// walls are the literal periodic copies of the fundamental domain under the deck
// (covering) group. For a flat manifold this tiling is EXACT — no portal render
// pass, just the geometry drawn at every lattice transform.
//
// v1 implemented only the 3-torus T^3 = R^3 / Lambda. This file now carries ALL
// nine closed flat prime 3-manifolds available to the inside view: the six
// orientable platycosms (torus, quarter-, sixth-, half-, third-turn, and
// Hantzsche-Wendt) and three non-orientable amphi/amphidi cosms. Each face of a
// cell carries a gluing
//
//     g(x) = glueRefl (.) (glueQuat * x) + t          [ (.) = componentwise ]
//
// split into a PROPER rotation (glueQuat, det +1) and a per-axis sign vector
// (glueRefl, det = product of signs). The controller applies glueQuat to the
// camera (a real reorientation) and uses glueRefl only to flip handedness
// (parity), which the renderer realises as a whole-scene mirror — the reflection
// is never baked into the camera quaternion. The deck group (the copies + the
// gravity image sum) is enumerated per topology, so swapping the topology swaps
// the copies, the gravity field and the wall identifications together.

import * as THREE from 'three';

// Half-edge of the cube: the wall sits at |x| = |y| = |z| = CELL_HALF, so the
// "radius of the cell" (centre to face) is CELL_HALF and the edge is 2·CELL_HALF.
export const CELL_HALF = 250;
export const PERIOD = 2 * CELL_HALF; // lattice spacing for T^3 (and the cube cells)

// hexagonal-prism cells (sixth-/third-turn): a regular hexagonal prism with the
// given inradius (centre to a side face) and full height along z.
const HEX_RADIUS = CELL_HALF;   // inradius of the hexagon (centre to side wall)
const HEX_HEIGHT = PERIOD;      // full height of the prism (cap to cap)

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const ONE = () => new THREE.Vector3(1, 1, 1);
const qIdent = () => new THREE.Quaternion();

// ---------------------------------------------------------------------------
// gluing helpers
// ---------------------------------------------------------------------------
// A face gluing maps a point that has just left the +face back to its partner.
//   axis     : outward unit normal of the + face
//   glueQuat : proper rotation part (det +1)
//   glueRefl : per-axis sign vector (det = product of its three signs)
//   parity   : +1 / -1 = det of the full linear part (= product of glueRefl signs)
//   t        : translation part (world offset applied on crossing the + face)
function gluing(axis, { quat = qIdent(), refl = ONE(), t } = {}) {
  const parity = Math.round(refl.x * refl.y * refl.z);
  return { axis: axis.clone(), glueQuat: quat.clone(), glueRefl: refl.clone(), parity, t: t.clone() };
}

// Apply a gluing (or its inverse) to a position, accumulating the carried linear
// map (Matrix4, velocity transform), the proper-rotation quaternion (camera) and
// the parity. g(x) = D R x + t with D = diag(glueRefl), R = glueQuat. The inverse
// is g^{-1}(y) = R^T D (y - t): linear part R^T D, rotation R^{-1}, same det.
const _m3 = new THREE.Matrix3();
const _reflM = new THREE.Matrix4();
const _quatM = new THREE.Matrix4();
const _stepLin = new THREE.Matrix4();
function applyGluing(pos, g, inverse, acc) {
  const D = g.glueRefl;
  if (!inverse) {
    // forward: pos -> D (R pos) + t
    pos.applyQuaternion(g.glueQuat);
    pos.set(pos.x * D.x, pos.y * D.y, pos.z * D.z);
    pos.add(g.t);
    _quatM.makeRotationFromQuaternion(g.glueQuat);
    acc.rotationQuat.premultiply(g.glueQuat);
  } else {
    // inverse: pos -> R^T (D (pos - t))
    pos.sub(g.t);
    pos.set(pos.x * D.x, pos.y * D.y, pos.z * D.z);
    _quatM.makeRotationFromQuaternion(g.glueQuat).transpose();
    pos.applyMatrix4(_quatM);
    acc.rotationQuat.premultiply(_quatInv(g.glueQuat));
  }
  // carried linear part for velocity = (this step's linear) * (accumulated so far)
  _reflM.makeScale(D.x, D.y, D.z);
  if (!inverse) {
    // L_step = D * R
    _stepLin.multiplyMatrices(_reflM, _quatM /* = R */);
  } else {
    // L_step = R^T * D   (_quatM currently holds R^T)
    _stepLin.multiplyMatrices(_quatM /* = R^T */, _reflM);
  }
  acc.linear.premultiply(_stepLin);
  acc.parity *= g.parity;
  acc.changed = true;
}
const _qi = new THREE.Quaternion();
function _quatInv(q) { return _qi.copy(q).invert(); }

// ---------------------------------------------------------------------------
// deck-group enumeration (BFS over the face-pairing isometries)
// ---------------------------------------------------------------------------
// Each generator is a 4x4 isometry. We BFS from identity, multiplying by every
// generator, keeping any element whose translational part lies within the cell's
// bounding extent times `depth`. The identity is excluded from the returned set
// (the central cell holds the full-detail planet). Robust for the twisted and
// non-orientable cube cells, whose generators do NOT commute as translations.
function deckBFS(generators, depth, opts = {}) {
  const period = opts.period ?? PERIOD;
  const radial = !!opts.radial; // bound by radius (hex) vs Chebyshev (cube)
  // `free`: the action is fixed-point-free (a genuine flat manifold — hex screws,
  // HW screws), so EVERY distinct group element is its own copy and we must keep
  // them all, screw-rotated layers included. Dedup by the full matrix only. The
  // default (position dedup) is for the flattened twisted CUBE stand-ins, whose
  // face-pairings are not a free action, so many group words pile copies onto the
  // same cell position and we keep just one to bound the count.
  const free = !!opts.free;
  const maxR = (depth + 0.5) * period;
  // Full group key (rotation block + translation), so the BFS reaches every
  // element exactly once and never loops — needed because the twisted cells'
  // generators do not commute and compose into many distinct isometries.
  const keyFull = (m) => {
    const e = m.elements, r = (x) => Math.round(x * 1e3) / 1e3;
    return [r(e[0]), r(e[1]), r(e[2]), r(e[4]), r(e[5]), r(e[6]), r(e[8]), r(e[9]), r(e[10]),
            Math.round(e[12]), Math.round(e[13]), Math.round(e[14])].join(',');
  };
  // Spatial key (cell centre only): the renderer + gravity want ONE copy per
  // visible cell position. Several group elements can land a copy at the same
  // place (different orientation) for the flattened stand-in twisted cells; we
  // keep the first reached per position so the copy count stays sane.
  const keyPos = (m) => {
    const e = m.elements;
    return Math.round(e[12]) + ',' + Math.round(e[13]) + ',' + Math.round(e[14]);
  };
  const inRange = (m) => {
    const e = m.elements, x = e[12], y = e[13], z = e[14];
    if (radial) return Math.hypot(x, y) <= maxR && Math.abs(z) <= maxR;
    return Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) <= maxR;
  };
  const out = [];
  const visited = new Set();      // full-group dedup (traversal)
  const placed = new Set();       // per-position dedup (output, non-free cells only)
  const id = new THREE.Matrix4();
  visited.add(keyFull(id));
  placed.add(keyPos(id));         // never emit the origin (central full-detail planet)
  let frontier = [id];
  let guard = 0;
  while (frontier.length && guard++ < 100000) {
    const next = [];
    for (const m of frontier) {
      for (const gen of generators) {
        const cand = new THREE.Matrix4().multiplyMatrices(gen, m);
        if (!inRange(cand)) continue;
        const kf = keyFull(cand);
        if (visited.has(kf)) continue;
        visited.add(kf);
        next.push(cand);                 // keep walking the full group
        if (free) { out.push(cand); continue; }  // free action: every element is a copy
        const kp = keyPos(cand);
        if (placed.has(kp)) continue;     // else emit only one copy per cell position
        placed.add(kp);
        out.push(cand);
      }
    }
    frontier = next;
  }
  return out;
}

// Build the 4x4 isometry of a face gluing's INVERSE (the deck transform that
// places the image you see THROUGH that + wall). For T^3 this is just +period
// along the axis; for twisted cells it carries the rotation/reflection too.
// generator(g) and generator(g^{-1}) together generate the whole deck group.
function faceGenerators(faceGluings) {
  const gens = [];
  for (const g of faceGluings) {
    const D = g.glueRefl;
    const R = new THREE.Matrix4().makeRotationFromQuaternion(g.glueQuat);
    const Dm = new THREE.Matrix4().makeScale(D.x, D.y, D.z);
    // forward g(x) = D R x + t
    const fwd = new THREE.Matrix4().multiplyMatrices(Dm, R);
    fwd.setPosition(g.t.x, g.t.y, g.t.z);
    // inverse g^{-1}(x) = R^T D x - R^T D t
    const inv = new THREE.Matrix4().copy(fwd).invert();
    gens.push(fwd, inv);
  }
  return gens;
}

// ---------------------------------------------------------------------------
// generalized cube reducer (per-axis while-loop applying each crossed gluing)
// ---------------------------------------------------------------------------
function makeCubeReduce(faceGluings) {
  // index the gluings by their dominant axis so a wall crossing picks the right one
  const byAxis = [null, null, null];
  for (const g of faceGluings) {
    const a = Math.abs(g.axis.x) > 0.5 ? 0 : Math.abs(g.axis.y) > 0.5 ? 1 : 2;
    byAxis[a] = g;
  }
  return function reduce(pos) {
    const acc = { changed: false, linear: new THREE.Matrix4(), rotationQuat: new THREE.Quaternion(), parity: 1 };
    const comp = ['x', 'y', 'z'];
    let guard = 64;
    while (guard-- > 0) {
      let crossed = false;
      for (let a = 0; a < 3; a++) {
        const k = comp[a], g = byAxis[a];
        if (pos[k] > CELL_HALF) { applyGluing(pos, g, false, acc); crossed = true; }
        else if (pos[k] < -CELL_HALF) { applyGluing(pos, g, true, acc); crossed = true; }
      }
      if (!crossed) break;
    }
    return acc;
  };
}

// ---------------------------------------------------------------------------
// T^3 — 3-torus (orientable, holonomy trivial)
// ---------------------------------------------------------------------------
// faceGluings: crossing the +axis wall translates by -period; every rotation is
// identity and parity +1 — a wall meets its partner straight across. The reducer
// here is the ORIGINAL independent per-axis wrap, kept verbatim so T^3 stays
// byte-for-byte identical (no quaternion/reflection bookkeeping at all).
function makeTorusTopology() {
  const faceGluings = [X, Y, Z].map((axis) => gluing(axis, { t: axis.clone().multiplyScalar(-PERIOD) }));
  const reduceFn = (pos) => {
    const acc = { changed: false, linear: new THREE.Matrix4(), rotationQuat: new THREE.Quaternion(), parity: 1 };
    for (let axis = 0; axis < 3; axis++) {
      const key = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
      let guard = 64;
      while (pos[key] > CELL_HALF && guard-- > 0) { pos[key] -= PERIOD; acc.changed = true; }
      guard = 64;
      while (pos[key] < -CELL_HALF && guard-- > 0) { pos[key] += PERIOD; acc.changed = true; }
    }
    return acc;
  };
  return {
    key: 'torus', name: 'T³ (torus)', orientable: true, faceGluings,
    latticeMatricesFn: latticeMatrices,           // the exact T^3 triple loop
    reduceFn,
  };
}

// ---------------------------------------------------------------------------
// twisted cube cells: quarter-/half-turn (orientable, axis-aligned rotations)
// ---------------------------------------------------------------------------
function makeTwistTopology(key, name, angle) {
  // crossing ±x rotates `angle` about x, ±y about y, ±z about z; pure translation
  // offset by -period along the crossed axis. glueRefl = (1,1,1), parity +1.
  const faceGluings = [
    gluing(X, { quat: new THREE.Quaternion().setFromAxisAngle(X, angle), t: X.clone().multiplyScalar(-PERIOD) }),
    gluing(Y, { quat: new THREE.Quaternion().setFromAxisAngle(Y, angle), t: Y.clone().multiplyScalar(-PERIOD) }),
    gluing(Z, { quat: new THREE.Quaternion().setFromAxisAngle(Z, angle), t: Z.clone().multiplyScalar(-PERIOD) }),
  ];
  const gens = faceGenerators(faceGluings);
  return {
    key, name, orientable: true, faceGluings,
    latticeMatricesFn: (depth = 3) => deckBFS(gens, depth),
    reduceFn: makeCubeReduce(faceGluings),
  };
}

// ---------------------------------------------------------------------------
// hexagonal-prism cells: sixth-/third-turn (orientable, cap screw)
// ---------------------------------------------------------------------------
// six side faces glue straight across (pure translation by the centre-to-opposite
// -side vector); the two caps glue with a screw: rotate `angle` about z and
// translate -HEX_HEIGHT along z. The reducer handles hexagonal side containment.
function makeHexTopology(key, name, angle) {
  // outward normals of the six side walls (flat-top hexagon: walls at 0,60,...°)
  const sideNormals = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    sideNormals.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
  }
  // opposite-side translation: moving out through a side wall puts you back in
  // through the opposite wall, shifted by -2*inradius along that normal.
  const SIDE_SHIFT = 2 * HEX_RADIUS;
  const capQuat = new THREE.Quaternion().setFromAxisAngle(Z, angle);
  // face gluings: 3 "side pairs" (only +normals listed) + the z cap pair, in the
  // {axis, glueQuat, glueRefl, t} shape used by the catalog/controller hooks.
  const faceGluings = [];
  for (let i = 0; i < 3; i++) {
    const n = sideNormals[i];
    faceGluings.push(gluing(n, { t: n.clone().multiplyScalar(-SIDE_SHIFT) }));
  }
  faceGluings.push(gluing(Z, { quat: capQuat, t: Z.clone().multiplyScalar(-HEX_HEIGHT) }));

  // deck lattice: the sixth/third-turn space is the mapping torus of the hexagonal
  // 2-torus under a `angle` rotation, so pi_1 = Z^2 (the in-plane hex lattice)
  // semidirect Z (the cap screw). Every deck element is uniquely s^k · (a·t1+b·t2):
  // screw up k layers, then an in-plane translation that the screw has rotated by
  // k·angle. We enumerate that directly (not by free BFS, which would mix rotated
  // and un-rotated representatives into one layer). The copy beyond the +z cap is
  // the inverse of the reduce gluing, so layer k carries rotation R(−k·angle) at
  // z = +k·HEX_HEIGHT — exactly what the reduce produces after k cap crossings,
  // making the crossing seamless.
  const b1 = sideNormals[0].clone().multiplyScalar(SIDE_SHIFT); // 0°  basis
  const b2 = sideNormals[1].clone().multiplyScalar(SIDE_SHIFT); // 60° basis
  const latticeFn = (depth = 3) => {
    const out = [];
    const maxR = (depth + 0.5) * HEX_HEIGHT;
    const tmp = new THREE.Vector3();
    for (let k = -depth; k <= depth; k++) {
      const Qk = new THREE.Quaternion().setFromAxisAngle(Z, -k * angle); // layer screw rotation
      const Rk = new THREE.Matrix4().makeRotationFromQuaternion(Qk);
      for (let a = -depth - 1; a <= depth + 1; a++) {
        for (let b = -depth - 1; b <= depth + 1; b++) {
          if (k === 0 && a === 0 && b === 0) continue;            // skip the central cell
          tmp.set(a * b1.x + b * b2.x, a * b1.y + b * b2.y, 0).applyQuaternion(Qk);
          tmp.z = k * HEX_HEIGHT;
          if (Math.hypot(tmp.x, tmp.y) > maxR || Math.abs(tmp.z) > maxR) continue;
          out.push(new THREE.Matrix4().copy(Rk).setPosition(tmp.x, tmp.y, tmp.z));
        }
      }
    }
    return out;
  };

  const reduceFn = (pos) => {
    const acc = { changed: false, linear: new THREE.Matrix4(), rotationQuat: new THREE.Quaternion(), parity: 1 };
    let guard = 64;
    while (guard-- > 0) {
      let crossed = false;
      // hexagonal side containment: the signed distance to a side wall is n·p - inradius
      for (let i = 0; i < 6; i++) {
        const n = sideNormals[i];
        const d = pos.x * n.x + pos.y * n.y - HEX_RADIUS;
        if (d > 1e-9) { pos.addScaledVector(n, -SIDE_SHIFT); acc.changed = true; crossed = true; }
      }
      // z caps: screw — accumulate the SAME rotation into both the camera
      // quaternion (rotationQuat) and the velocity transform (linear); leaving
      // linear at identity would rotate the view but not the velocity, tearing the
      // motion across the cap.
      if (pos.z > HEX_HEIGHT / 2) {
        pos.applyQuaternion(capQuat); pos.z -= HEX_HEIGHT;
        acc.rotationQuat.premultiply(capQuat);
        acc.linear.premultiply(new THREE.Matrix4().makeRotationFromQuaternion(capQuat));
        acc.changed = true; crossed = true;
      } else if (pos.z < -HEX_HEIGHT / 2) {
        const inv = _quatInv(capQuat).clone();
        pos.applyQuaternion(inv); pos.z += HEX_HEIGHT;
        acc.rotationQuat.premultiply(inv);
        acc.linear.premultiply(new THREE.Matrix4().makeRotationFromQuaternion(inv));
        acc.changed = true; crossed = true;
      }
      if (!crossed) break;
    }
    return acc;
  };

  return {
    key, name, orientable: true, faceGluings,
    latticeMatricesFn: latticeFn,
    reduceFn,
  };
}

// ---------------------------------------------------------------------------
// Hantzsche–Wendt — didicosm (orientable, holonomy Z/2 x Z/2)
// ---------------------------------------------------------------------------
// Three mutually perpendicular half-turn SCREWS (180° rotation + a glide with no
// shared fixed point). The fundamental domain is a rhombic dodecahedron; we
// realise the wall identifications directly from the three screw generators and
// reduce by repeatedly translating the point back by whichever screw lowers its
// distance from the origin (a Dirichlet/nearest-image reduction). Seam-free.
function makeHWTopology() {
  const R = CELL_HALF; // circumradius scale of the glides
  const halfTurn = (axis) => new THREE.Quaternion().setFromAxisAngle(axis, Math.PI);
  // three screws (rotation, glide) — signs chosen so each is its own partner pair
  const screws = [
    { quat: halfTurn(X), glide: new THREE.Vector3(-R,  R,  0) }, // x-screw: diag(1,-1,-1)
    { quat: halfTurn(Y), glide: new THREE.Vector3( R,  0, -R) }, // y-screw: diag(-1,1,-1)
    { quat: halfTurn(Z), glide: new THREE.Vector3( 0, -R,  R) }, // z-screw: diag(-1,-1,1)
  ];
  // build the 4x4 of each screw and its inverse as the deck generators
  const gens = [];
  for (const s of screws) {
    const Rm = new THREE.Matrix4().makeRotationFromQuaternion(s.quat);
    const fwd = new THREE.Matrix4().copy(Rm).setPosition(s.glide.x, s.glide.y, s.glide.z);
    gens.push(fwd, new THREE.Matrix4().copy(fwd).invert());
  }
  // surface the screws as "faceGluings" too (used only for the catalog hooks);
  // their axes are the rotation axes, glueRefl encodes the diag sign of the turn.
  const faceGluings = [
    gluing(X, { quat: screws[0].quat, t: screws[0].glide }),
    gluing(Y, { quat: screws[1].quat, t: screws[1].glide }),
    gluing(Z, { quat: screws[2].quat, t: screws[2].glide }),
  ];

  // nearest-image reduction: repeatedly apply the generator (or inverse) that
  // brings the point closest to the origin, until none helps. Guard cap 32.
  const allGens = gens; // fwd + inv already both present
  const reduceFn = (pos) => {
    const acc = { changed: false, linear: new THREE.Matrix4(), rotationQuat: new THREE.Quaternion(), parity: 1 };
    let guard = 32;
    const cand = new THREE.Vector3();
    while (guard-- > 0) {
      let best = -1, bestD = pos.lengthSq();
      for (let i = 0; i < allGens.length; i++) {
        cand.copy(pos).applyMatrix4(allGens[i]);
        const d = cand.lengthSq();
        if (d < bestD - 1e-6) { bestD = d; best = i; }
      }
      if (best < 0) break;
      // apply the chosen generator; track rotation (proper, det +1 for screws)
      pos.applyMatrix4(allGens[best]);
      _m3.setFromMatrix4(allGens[best]);
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(allGens[best]));
      acc.rotationQuat.premultiply(q);
      const lin = new THREE.Matrix4().extractRotation(allGens[best]);
      acc.linear.premultiply(lin);
      acc.changed = true;
    }
    return acc;
  };

  return {
    key: 'hw', name: 'Hantzsche–Wendt', orientable: true, faceGluings,
    latticeMatricesFn: (depth = 3) => deckBFS(gens, depth, { free: true }),
    reduceFn,
  };
}

// ---------------------------------------------------------------------------
// non-orientable cube cells: amphicosms + amphidicosm
// ---------------------------------------------------------------------------
// Built from explicit per-face {quat, refl, t}. The reducer is the generalized
// cube while-loop; glueRefl carries the reflection (parity), glueQuat any proper
// rotation. The deck group is BFS over the face generators (elements alternate
// det +1 / -1, so some copies render mirror-reversed — correct physics).
function makeCubeFromFaces(key, name, orientable, faceSpecs) {
  const faceGluings = faceSpecs.map((f) => gluing(f.axis, { quat: f.quat || qIdent(), refl: f.refl || ONE(), t: f.t }));
  const gens = faceGenerators(faceGluings);
  return {
    key, name, orientable, faceGluings,
    latticeMatricesFn: (depth = 3) => deckBFS(gens, depth),
    reduceFn: makeCubeReduce(faceGluings),
  };
}

// 7. First amphicosm — Klein bottle × S^1 (non-orientable, Z/2)
function makeAmphi1Topology() {
  return makeCubeFromFaces('amphi1', 'First amphicosm', false, [
    { axis: X, t: X.clone().multiplyScalar(-PERIOD) },                                  // pure translation
    { axis: Y, t: Y.clone().multiplyScalar(-PERIOD) },                                  // pure translation
    { axis: Z, refl: new THREE.Vector3(-1, 1, 1), t: Z.clone().multiplyScalar(-PERIOD) }, // glide: reflect x
  ]);
}

// 8. Second amphicosm — swap-glide torus bundle (non-orientable, Z/2)
function makeAmphi2Topology() {
  const swapQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 1, 0).normalize(), Math.PI);
  return makeCubeFromFaces('amphi2', 'Second amphicosm', false, [
    { axis: X, t: X.clone().multiplyScalar(-PERIOD) },
    { axis: Y, t: Y.clone().multiplyScalar(-PERIOD) },
    { axis: Z, quat: swapQuat, refl: new THREE.Vector3(1, 1, -1), t: Z.clone().multiplyScalar(-PERIOD) },
  ]);
}

// 9. First amphidicosm — mm2 (non-orientable, Z/2 x Z/2)
function makeAmphidi1Topology() {
  return makeCubeFromFaces('amphidi1', 'First amphidicosm', false, [
    { axis: X, refl: new THREE.Vector3(1, -1, 1), t: X.clone().multiplyScalar(-PERIOD) },  // glide: reflect y
    { axis: Y, t: Y.clone().multiplyScalar(-PERIOD) },                                      // pure translation
    { axis: Z, refl: new THREE.Vector3(-1, 1, 1), t: Z.clone().multiplyScalar(-PERIOD) },  // glide: reflect x
  ]);
}

// ---------------------------------------------------------------------------
// the visible copy lattice for T^3 (kept exported + unchanged for the harness)
// ---------------------------------------------------------------------------
// All deck transforms whose cell centre is within `depth` cells of the origin
// along every axis, EXCLUDING the identity. For T^3 these are the pure
// translations (i,j,k)·PERIOD. Drawn as a single InstancedMesh.
export function latticeMatrices(depth = 3) {
  const mats = [];
  const m = new THREE.Matrix4();
  for (let i = -depth; i <= depth; i++)
    for (let j = -depth; j <= depth; j++)
      for (let k = -depth; k <= depth; k++) {
        if (i === 0 && j === 0 && k === 0) continue;
        m.makeTranslation(i * PERIOD, j * PERIOD, k * PERIOD);
        mats.push(m.clone());
      }
  return mats;
}

// The centres of the planet and all its visible images. For T^3 this is the
// origin + the lattice; for a general topology pass its latticeMatricesFn.
export function latticeImageCenters(depth = 3, latticeFn = latticeMatrices) {
  const centers = [new THREE.Vector3(0, 0, 0)];
  const p = new THREE.Vector3();
  for (const m of latticeFn(depth)) centers.push(p.clone().setFromMatrixPosition(m));
  return centers;
}

// ---- the cube edge cage -----------------------------------------------------
export function cubeEdgeSegments(half = CELL_HALF) {
  const v = [
    [-half, -half, -half], [half, -half, -half], [half, half, -half], [-half, half, -half],
    [-half, -half, half], [half, -half, half], [half, half, half], [-half, half, half],
  ];
  const E = [
    [0, 1], [1, 2], [2, 3], [3, 0], // bottom ring
    [4, 5], [5, 6], [6, 7], [7, 4], // top ring
    [0, 4], [1, 5], [2, 6], [3, 7], // verticals
  ];
  return E.map(([a, b]) => [v[a], v[b]]);
}

// ---------------------------------------------------------------------------
// the catalog: every topology + its gallery caption data
// ---------------------------------------------------------------------------
export const TOPOLOGY_CATALOG = [
  {
    key: 'torus', name: 'T³ (torus)', orientable: true, spinorial: true,
    sub: 'T³ · pure translation · holonomy trivial',
    label: {
      title: 'Torus defect',
      aka: "the 3-torus, T³ = S¹×S¹×S¹ · Conway's torocosm · the trivial flat space form",
      body: 'Opposite faces glued straight across by pure translation. The flat 3-manifold with trivial holonomy — leave through one wall and return through the wall behind you, unrotated. Seam-free, the only cell without edge singularities.',
    },
    topology: makeTorusTopology(),
  },
  {
    key: 'quarter', name: 'Quarter-turn space', orientable: true, spinorial: true,
    sub: 'tetracosm · 90° twist · holonomy ℤ/4',
    label: {
      title: 'Quarter-turn space',
      aka: 'the tetracosm · the quarter-turn flat space form (holonomy ℤ/4)',
      body: 'A cube whose opposite faces are glued with a 90° twist. A flat 3-manifold in which a wall meets its partner rotated a quarter turn; circulate the right loop and the world comes back spun by 90°. Shown as a flattened stand-in: all three face-pairs twist, so the edges carry conical seams the smooth manifold has not.',
    },
    topology: makeTwistTopology('quarter', 'Quarter-turn space', Math.PI / 2),
  },
  {
    key: 'hex6', name: 'Sixth-turn space', orientable: true, spinorial: true,
    sub: 'hexacosm · 60° cap screw · holonomy ℤ/6',
    label: {
      title: 'Sixth-turn space',
      aka: 'the hexacosm · the sixth-turn flat space form (holonomy ℤ/6)',
      body: 'A hexagonal cell: the six sides glue straight, the two caps glue with a 60° screw. One of the six closed flat 3-manifolds, the one with the tightest rotational holonomy.',
    },
    topology: makeHexTopology('hex6', 'Sixth-turn space', Math.PI / 3),
  },
  {
    key: 'half', name: 'Half-turn space', orientable: true, spinorial: true,
    sub: 'dicosm · 180° twist · holonomy ℤ/2',
    label: {
      title: 'Half-turn space',
      aka: 'the dicosm · the half-turn flat space form (holonomy ℤ/2)',
      body: 'A cube whose opposite faces are glued with a 180° twist. A flat 3-manifold; the partner wall arrives rotated a half turn, so "up" through it points down. Shown as a flattened stand-in: all three face-pairs twist, so the edges carry conical seams the smooth manifold has not.',
    },
    topology: makeTwistTopology('half', 'Half-turn space', Math.PI),
  },
  {
    key: 'hex3', name: 'Third-turn space', orientable: true, spinorial: true,
    sub: 'tricosm · 120° cap screw · holonomy ℤ/3',
    label: {
      title: 'Third-turn space',
      aka: 'the tricosm · the third-turn flat space form (holonomy ℤ/3)',
      body: 'A hexagonal cell: sides glued straight, caps glued with a 120° screw. Another of the six closed flat 3-manifolds, sibling to the sixth-turn cell.',
    },
    topology: makeHexTopology('hex3', 'Third-turn space', (2 * Math.PI) / 3),
  },
  {
    key: 'hw', name: 'Hantzsche–Wendt', orientable: true, spinorial: true,
    sub: 'didicosm · half-turn screws · holonomy ℤ/2×ℤ/2',
    label: {
      title: 'Hantzsche–Wendt space',
      aka: 'the Hantzsche–Wendt manifold · the didicosm (holonomy ℤ/2×ℤ/2)',
      body: 'The sixth and last closed orientable flat 3-manifold, completing the platycosms — and the only flat space form that is a rational homology sphere, with finite first homology. A rhombic-dodecahedral cell (the Dirichlet domain of an offset basepoint); its twelve faces glue in six pairs by three mutually perpendicular, non-intersecting half-turn screws. The screws share no fixed point, so unlike the cube cells this is the genuine smooth manifold — no central singularity, seam-free, with holonomy ℤ/2×ℤ/2.',
    },
    topology: makeHWTopology(),
  },
  {
    key: 'amphi1', name: 'First amphicosm', orientable: false,
    sub: 'Klein bottle × S¹ · glide reflection · holonomy ℤ/2',
    label: {
      title: 'First amphicosm',
      aka: 'Klein bottle × S¹ · the first amphicosm · a non-orientable flat space form (holonomy ℤ/2)',
      body: 'A cube whose ±x and ±y faces glue by pure translation while the ±z pair glues with a glide reflection — exit the top and re-enter the bottom mirror-reversed. The x–z section is a flat Klein bottle and the y direction a circle, so the cell is Klein bottle × S¹: the first non-orientable flat 3-manifold. Cross a glide wall and the world returns left–right reversed; cross it twice and the reversal cancels. A genuine smooth manifold, seam-free like the torus.',
    },
    topology: makeAmphi1Topology(),
  },
  {
    key: 'amphi2', name: 'Second amphicosm', orientable: false,
    sub: 'swap-glide torus bundle · holonomy ℤ/2',
    label: {
      title: 'Second amphicosm',
      aka: 'the swap-glide torus bundle · the second amphicosm · a non-orientable flat space form (holonomy ℤ/2)',
      body: 'A cube whose ±x and ±y faces glue by pure translation while the ±z pair glues with a swap glide reflection — exit the top and re-enter the bottom across the diagonal mirror x = y, with x and y exchanged. It is the mapping torus of the square torus under the order-2 swap, the second of the two non-orientable flat 3-manifolds with ℤ/2 holonomy: distinct from Klein bottle × S¹, whose mirror is axis-aligned rather than diagonal (first homology ℤ² here versus ℤ² ⊕ ℤ/2 there). Cross the swap wall and the world returns mirror-reversed with x and y traded; cross it twice and both undo. A genuine smooth manifold, seam-free like the torus.',
    },
    topology: makeAmphi2Topology(),
  },
  {
    key: 'amphidi1', name: 'First amphidicosm', orientable: false,
    sub: 'mm2 · two mirrors + half-turn · holonomy ℤ/2×ℤ/2',
    label: {
      title: 'First amphidicosm',
      aka: 'the first amphidicosm · a non-orientable flat space form (holonomy ℤ/2×ℤ/2)',
      body: 'The non-orientable sibling of the Hantzsche–Wendt didicosm — the same Klein-four holonomy ℤ/2×ℤ/2, but realised with mirrors instead of half-turns, so handedness is not preserved. A cube whose ±x and ±z faces each glue by a glide reflection (reflecting y and x respectively) while the ±y pair glues by pure translation; the two mirrors compose to a half-turn about the vertical axis, giving the point group mm2 — two reflections and one rotation. Every gluing slides within its mirror with no fixed point, so it is a genuine smooth manifold, seam-free like the torus. Cross either mirror wall and the world returns reversed; the two reversals compose into the half-turn.',
    },
    topology: makeAmphidi1Topology(),
  },
];

// ---------------------------------------------------------------------------
// dynamic topology selection
// ---------------------------------------------------------------------------
export function getTopology(key) {
  return (TOPOLOGY_CATALOG.find((t) => t.key === key) ?? TOPOLOGY_CATALOG[0]).topology;
}

// The default topology (T^3) and its exports, kept so existing importers and the
// headless harness (which call reduceToCell(pos) with no topology) still work.
export const TOPOLOGY = getTopology('torus');

// ---- fundamental-domain reduction (the face identifications) ----------------
// Bring a world position back inside the cell, applying each crossed wall's
// gluing. Topology-dispatching: pass the active topology to use its reducer; with
// no topology it falls back to T^3 (identical to the original wraparound, with
// linear = identity, rotationQuat = identity, parity +1, so orientation rides
// through untouched and no recovery wobble is ever triggered).
export function reduceToCell(pos, topology = TOPOLOGY) {
  const acc = topology.reduceFn(pos);
  // expose both the velocity transform (full linear, incl. reflection) and the
  // proper-rotation-only quaternion the controller applies to the camera.
  return {
    changed: acc.changed,
    linear: acc.linear,
    rotationQuat: acc.rotationQuat,
    parity: acc.parity,
  };
}
