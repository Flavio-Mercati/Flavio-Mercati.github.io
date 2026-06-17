// Polyhedral topological defects rendered as sets of "portal" faces.
//
// A defect is a convex polyhedral region removed from space whose boundary
// faces are identified in pairs by rigid isometries. In the defect's local
// frame (origin at the centre) each face F carries a gluing
//
//     g_F (x) = R_F · x  +  t_F                       (R_F a rotation, t_F a
//                                                      translation)
//
// The common, "twist about the face's own outward normal" family is the
// special case
//
//     R_F = R(n̂_F, θ_F),   t_F = −D_F · n̂_F
//
// i.e. "rotate by θ about n̂_F, then slide to the opposite face". A pleasant
// fact: with the SAME θ on both members of an opposite pair the two gluings
// are automatically mutual inverses, so one number per face suffices.
//
//   θ = 0      : torus (T³) cell                — pure translation
//   θ = π/2    : quarter-turn cube              — Friedman–Sorkin-flavored
//   θ = π/3    : hexagonal prism caps (sides θ=0) — "1/6-turn screw"
//   θ = π/5    : dodecahedron                   — the Poincaré-sphere gluing
//   θ = 3π/5   : dodecahedron                   — the Seifert–Weber gluing
//   θ = 2πq/p  : lens-space caps L(p,q)         — cap-only screw, no sides
//
// Faces may instead carry an EXPLICIT (R_F, t_F) — a general rigid motion, not
// tied to the face normal. That is what the Hantzsche–Wendt didicosm needs:
// its opposite faces are glued by 180° rotations about IN-PLANE axes (so R·n̂
// flips the normal rather than fixing it), which the "about own normal" form
// cannot express. The renderer and teleport are fully (R, t)-based, so both
// families share one code path; the clip plane is placed at the gluing-image
// of the entry face, whose outward normal is R·n̂ (it can point either way).
//
// Rendering: the image on face F is the scene from a VIRTUAL camera — the real
// camera pushed through F's world-space gluing — rendered with the SAME
// projection matrix and sampled at normalized screen coordinates. The defect
// may rotate (setRotation); all world quantities are derived from the current
// orientation q each frame, and the world gluing rotation is q·R·q⁻¹.
//
// Physics caveat, stated honestly: gluing faces pairwise leaves conical
// curvature singularities along the polyhedron's edges (deficit angles). That
// is a real feature of such defects and shows up as image seams at the face
// boundaries — exact, not a bug. Only the θ=0 torus cell is seam-free.
//
// v1 limitation: no recursion — defects are hidden during portal passes, so a
// defect seen through a defect is invisible.

import * as THREE from 'three';

const PORTAL_VERT = /* glsl */ `
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const PORTAL_FRAG = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec2 uRes;
  void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    gl_FragColor = vec4(texture2D(uTex, uv).rgb, 1.0);
    #include <colorspace_fragment>
  }`;

const _zAxis = new THREE.Vector3(0, 0, 1);
const _n = new THREE.Vector3();
const _gn = new THREE.Vector3();
const _c = new THREE.Vector3();
const _l = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _lc = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _qIso = new THREE.Quaternion();
const _plane = new THREE.Plane();

export class PortalDefect {
  // faceSpecs: [{ n: unit Vector3 (local outward normal), D: distance to the
  //   partner face, geometry: BufferGeometry already positioned in local
  //   coords, and EITHER theta (twist about n̂, with the implicit −D·n̂ slide)
  //   OR an explicit { glueQuat, glueT } rigid gluing }]
  // boundPlanes: optional extra local half-spaces { n, d } (n·x < d) that bound
  //   the cell for teleport containment but are NOT portals — used by cells
  //   whose identified faces do not by themselves enclose a finite region (the
  //   lens cell, whose only portals are its two caps; the radial rim is the
  //   cone-collapsed equatorial edge, not a portal).
  constructor({ position, label, faceSpecs, outlineGeometry, boundPlanes = [] }) {
    this.position = position.clone();
    this.label = label;
    this.maxRenderDistance = 45;

    this.group = new THREE.Group();
    this.group.position.copy(position);

    this.portalCam = new THREE.PerspectiveCamera();
    this.renderTargets = []; // allocated lazily (only near defects hold any)
    this._rtW = 1;
    this._rtH = 1;
    this.maxVisibleFaces = Math.ceil(faceSpecs.length / 2);

    this.faces = faceSpecs.map((spec) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTex: { value: null }, uRes: { value: new THREE.Vector2(1, 1) } },
        vertexShader: PORTAL_VERT,
        fragmentShader: PORTAL_FRAG,
      });
      const mesh = new THREE.Mesh(spec.geometry, mat);
      this.group.add(mesh);
      // Local gluing g(x) = glueQuat·x + glueT. Either supplied explicitly, or
      // built from the "twist θ about n̂, slide −D·n̂ to the opposite face" form.
      const glueQuat = spec.glueQuat
        ? spec.glueQuat.clone()
        : new THREE.Quaternion().setFromAxisAngle(spec.n, spec.theta || 0);
      const glueT = spec.glueT
        ? spec.glueT.clone()
        : new THREE.Vector3().copy(spec.n).multiplyScalar(-spec.D);
      return {
        n: spec.n.clone(),
        halfD: spec.D / 2,    // entry-face plane offset: n·x = halfD
        glueQuat,
        glueT,
        exit: this.position,  // opposite-face gluing exits at this defect's own center
        mesh,
        mat,
      };
    });

    this.boundPlanes = boundPlanes.map((b) => ({ n: b.n.clone(), d: b.d }));

    this.edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(outlineGeometry, 5),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 })
    );
    this.group.add(this.edges);
  }

  setRotation(angleY) {
    this.group.rotation.y = angleY;
  }

  toggleEdges() {
    this.edges.visible = !this.edges.visible;
  }

  setRenderTargetSize(w, h) {
    for (const rt of this.renderTargets) rt.dispose();
    this.renderTargets = [];
    this._rtW = w;
    this._rtH = h;
  }

  _getRT(i) {
    while (this.renderTargets.length <= i) {
      this.renderTargets.push(
        new THREE.WebGLRenderTarget(this._rtW, this._rtH, { samples: 2 })
      );
    }
    return this.renderTargets[i];
  }

  // Render the portal textures. Caller must have hidden all defect groups.
  render(renderer, scene, camera, fullResolution) {
    const dist = camera.position.distanceTo(this.position);
    if (dist > this.maxRenderDistance) {
      for (const f of this.faces) f.mesh.visible = false;
      // free GPU memory once safely past the cutoff (hysteresis avoids thrash)
      if (dist > this.maxRenderDistance * 1.4 && this.renderTargets.length) {
        for (const rt of this.renderTargets) rt.dispose();
        this.renderTargets = [];
      }
      return;
    }

    _q.copy(this.group.quaternion);
    _qi.copy(_q).invert();

    let rtIndex = 0;
    for (const f of this.faces) {
      _n.copy(f.n).applyQuaternion(_q); // world-space outward normal
      _c.copy(_n).multiplyScalar(f.halfD).add(this.position); // entry-face center
      const facing =
        (camera.position.x - _c.x) * _n.x +
        (camera.position.y - _c.y) * _n.y +
        (camera.position.z - _c.z) * _n.z;
      if (facing <= 0 || rtIndex >= this.maxVisibleFaces) {
        f.mesh.visible = false;
        continue;
      }

      this.portalCam.fov = camera.fov;
      this.portalCam.aspect = camera.aspect;
      this.portalCam.near = camera.near;
      this.portalCam.far = camera.far;
      this.portalCam.updateProjectionMatrix();

      // Virtual camera position: local coords → local gluing g(x)=R·x+t → back
      // to world, anchored at the face's exit center (own center for
      // opposite-face gluing; the partner mouth for wormholes).
      _l.copy(camera.position).sub(this.position).applyQuaternion(_qi);
      _l.applyQuaternion(f.glueQuat).add(f.glueT);
      this.portalCam.position.copy(_l).applyQuaternion(_q).add(f.exit);
      // Virtual camera orientation: world gluing rotation = q·R·q⁻¹.
      _qIso.copy(_q).multiply(f.glueQuat).multiply(_qi);
      this.portalCam.quaternion.copy(_qIso).multiply(camera.quaternion);

      // Clip plane at the EXIT face = the gluing-image of the entry face. Its
      // outward normal is R·n̂ (which may flip relative to n̂ when R is not a
      // twist about n̂), and its centre is g(halfD·n̂). The plane normal is
      // negated so the kept half-space is the one the virtual camera looks into
      // (the oblique-near-plane role: drop geometry in front of the exit face).
      _gn.copy(f.n).applyQuaternion(f.glueQuat);            // local exit normal R·n̂
      _c.copy(_gn).multiplyScalar(f.halfD).add(f.glueT);    // local exit-face center
      _c.applyQuaternion(_q).add(f.exit);                   // → world
      _gn.applyQuaternion(_q).negate();                     // → world, into kept side
      _plane.setFromNormalAndCoplanarPoint(_gn, _c);
      renderer.clippingPlanes = [_plane];

      const rt = this._getRT(rtIndex++);
      renderer.setRenderTarget(rt);
      renderer.render(scene, this.portalCam);

      f.mat.uniforms.uTex.value = rt.texture;
      f.mat.uniforms.uRes.value.copy(fullResolution);
      f.mesh.visible = true;
    }
    renderer.setRenderTarget(null);
    renderer.clippingPlanes = [];
  }

  // If the segment prev→pos entered the cell, return the traveller's new
  // { position, rotation } (rotation = world gluing rotation to apply to the
  // view direction); otherwise null.
  tryTeleport(prev, pos) {
    _q.copy(this.group.quaternion);
    _qi.copy(_q).invert();

    _lc.copy(pos).sub(this.position).applyQuaternion(_qi);
    for (const f of this.faces) {
      if (_lc.dot(f.n) >= f.halfD) return null; // outside this face's half-space
    }
    for (const bp of this.boundPlanes) {
      if (_lc.dot(bp.n) >= bp.d) return null;   // outside a containment bound
    }

    _lp.copy(prev).sub(this.position).applyQuaternion(_qi);
    let best = null;
    let bestDepth = 0;
    for (const f of this.faces) {
      const depth = _lp.dot(f.n) - f.halfD;
      if (depth >= 0 && depth >= bestDepth) {
        bestDepth = depth;
        best = f;
      }
    }
    if (!best) return null; // started inside / entered via a bound rim — no portal

    _l.copy(_lc).applyQuaternion(best.glueQuat).add(best.glueT);
    const position = _l.applyQuaternion(_q).add(best.exit).clone();
    const rotation = new THREE.Quaternion().copy(_q).multiply(best.glueQuat).multiply(_qi);
    return { position, rotation };
  }
}

// ---- geometry helpers ----------------------------------------------------------

// Rotate a +z-facing geometry to face n̂ and slide it dist along n̂.
function bakeFace(geo, n, dist) {
  const q = new THREE.Quaternion().setFromUnitVectors(_zAxis, n);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3().copy(n).multiplyScalar(dist), q, new THREE.Vector3(1, 1, 1)
  );
  geo.applyMatrix4(m);
  return geo;
}

function cubeFaceSpecs(size, theta) {
  const N = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
  ];
  return N.map((n) => ({
    n, D: size, theta,
    geometry: bakeFace(new THREE.PlaneGeometry(size, size), n, size / 2),
  }));
}

// ---- concrete defects ------------------------------------------------------------

export function createTorusDefect(position, size = 0.5) {
  return new PortalDefect({
    position,
    label: 'Torus defect (T³ cell)',
    faceSpecs: cubeFaceSpecs(size, 0),
    outlineGeometry: new THREE.BoxGeometry(size, size, size),
  });
}

export function createQuarterTurnDefect(position, size = 0.5) {
  return new PortalDefect({
    position,
    label: 'Quarter-turn defect (90° twist)',
    faceSpecs: cubeFaceSpecs(size, Math.PI / 2),
    outlineGeometry: new THREE.BoxGeometry(size, size, size),
  });
}

export function createHalfTurnDefect(position, size = 0.5) {
  return new PortalDefect({
    position,
    label: 'Half-turn defect (180° twist)',
    faceSpecs: cubeFaceSpecs(size, Math.PI),
    outlineGeometry: new THREE.BoxGeometry(size, size, size),
  });
}

// Hexagonal prism: side faces glued straight across (θ=0), caps glued with a
// screw twist. θ=π/3 is the flat "sixth-turn space" gluing; θ=2π/3 the
// "third-turn space". Both are genuine flat 3-manifold structures.
export function createHexScrewDefect(position, capTheta, label, hexRadius = 0.32, height = 0.5) {
  const apothem = hexRadius * Math.sqrt(3) / 2;
  const specs = [];
  const up = new THREE.Vector3(0, 1, 0);
  const down = new THREE.Vector3(0, -1, 0);
  specs.push({
    n: up, D: height, theta: capTheta,
    geometry: bakeFace(new THREE.CircleGeometry(hexRadius, 6), up, height / 2),
  });
  specs.push({
    n: down, D: height, theta: capTheta,
    geometry: bakeFace(new THREE.CircleGeometry(hexRadius, 6), down, height / 2),
  });
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + (k * Math.PI) / 3; // edge-midpoint directions
    const n = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    specs.push({
      n, D: 2 * apothem, theta: 0,
      geometry: bakeFace(new THREE.PlaneGeometry(hexRadius, height), n, apothem),
    });
  }
  return new PortalDefect({
    position,
    label,
    faceSpecs: specs,
    // thetaStart π/2 aligns the outline's hexagon with the cap vertices
    outlineGeometry: new THREE.CylinderGeometry(hexRadius, hexRadius, height, 6, 1, false, Math.PI / 2),
  });
}

// Lens space L(p, q): a coin-shaped cell whose two p-gon caps are the only
// identified pair — the top cap glued to the bottom by a 2πq/p screw about the
// axis (= the cap normal), so it fits the "twist about own normal" form
// directly; there are NO side faces. The thin cylindrical rim is the
// cone-collapsed equatorial edge (it carries the deficit, like every other
// flattened cell's edges) and is added only as a radial CONTAINMENT bound so a
// crossing teleports just when the observer passes through a cap within the
// polygon. Lens spaces are the cyclic spherical space forms S³/(ℤ/p): exactly
// the non-spinorial S³ quotients → yellow sign.
export function createLensSpaceDefect(position, p, q, label, radius = 0.5, height = 0.36) {
  const up = new THREE.Vector3(0, 1, 0);
  const down = new THREE.Vector3(0, -1, 0);
  const theta = (2 * Math.PI * q) / p;
  const faceSpecs = [
    { n: up,   D: height, theta, geometry: bakeFace(new THREE.CircleGeometry(radius, p), up,   height / 2) },
    { n: down, D: height, theta, geometry: bakeFace(new THREE.CircleGeometry(radius, p), down, height / 2) },
  ];
  const apothem = radius * Math.cos(Math.PI / p);
  const boundPlanes = [];
  for (let k = 0; k < p; k++) {
    const a = (Math.PI * (2 * k + 1)) / p; // p-gon edge-midpoint directions
    boundPlanes.push({ n: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), d: apothem });
  }
  return new PortalDefect({
    position,
    label,
    faceSpecs,
    boundPlanes,
    outlineGeometry: new THREE.CylinderGeometry(radius, radius, height, p, 1, false, 0),
  });
}

// Hantzsche–Wendt didicosm: a cube whose three opposite face-pairs are glued by
// 180° rotations about three mutually perpendicular IN-PLANE axes — the +x
// pair about ẑ, the +y pair about x̂, the +z pair about ŷ. Those three
// half-turns generate the holonomy ℤ/2×ℤ/2 (the defining feature of the
// manifold), and each is order 2, so the two gluings of a pair are mutual
// inverses (round-trips return home). Every rotation has det +1 → orientation-
// preserving → orientable → red. This is the centred (orbifold) flattened
// stand-in, like the dicosm/tetracosm cube cells: the half-turn axes pass
// through the centre, so the edges carry conical seams the smooth manifold has
// not. It completes the six orientable closed flat 3-manifolds (platycosms).
export function createHantzscheWendtDefect(position, size = 0.5) {
  const Rx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  const Ry = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  const Rz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  const pairs = [
    [new THREE.Vector3(1, 0, 0), Rz], [new THREE.Vector3(-1, 0, 0), Rz],   // +x↔−x by ẑ half-turn
    [new THREE.Vector3(0, 1, 0), Rx], [new THREE.Vector3(0, -1, 0), Rx],   // +y↔−y by x̂ half-turn
    [new THREE.Vector3(0, 0, 1), Ry], [new THREE.Vector3(0, 0, -1), Ry],   // +z↔−z by ŷ half-turn
  ];
  const faceSpecs = pairs.map(([n, R]) => ({
    n, D: size, glueQuat: R, glueT: new THREE.Vector3(),
    geometry: bakeFace(new THREE.PlaneGeometry(size, size), n, size / 2),
  }));
  return new PortalDefect({
    position,
    label: 'Hantzsche–Wendt defect (didicosm)',
    faceSpecs,
    outlineGeometry: new THREE.BoxGeometry(size, size, size),
  });
}

// Cluster a triangulated convex polyhedron (non-indexed) into its flat faces
// and produce opposite-pair gluing specs with twist `theta`.
function polyhedronFaceSpecs(solid, theta) {
  const posAttr = solid.attributes.position;
  const triCount = posAttr.count / 3;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();

  const groups = [];
  for (let t = 0; t < triCount; t++) {
    a.fromBufferAttribute(posAttr, 3 * t);
    b.fromBufferAttribute(posAttr, 3 * t + 1);
    c.fromBufferAttribute(posAttr, 3 * t + 2);
    nrm.copy(e1.copy(b).sub(a)).cross(e2.copy(c).sub(a)).normalize();
    let g = groups.find((G) => G.n.dot(nrm) > 0.99);
    if (!g) {
      g = { n: nrm.clone(), tris: [] };
      groups.push(g);
    }
    g.tris.push(t);
  }

  return groups.map((g) => {
    const verts = new Float32Array(g.tris.length * 9);
    let o = 0;
    for (const t of g.tris) {
      for (let v = 0; v < 3; v++) {
        verts[o++] = posAttr.getX(3 * t + v);
        verts[o++] = posAttr.getY(3 * t + v);
        verts[o++] = posAttr.getZ(3 * t + v);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    a.set(verts[0], verts[1], verts[2]);
    const planeDist = g.n.dot(a); // inradius
    return { n: g.n, D: 2 * planeDist, theta, geometry };
  });
}

// Dodecahedron, opposite faces glued with a π/5 (36°) twist — the gluing
// pattern of the Poincaré homology sphere (flattened here; edges carry the
// resulting deficit angles).
export function createDodecahedralDefect(position, circumRadius = 0.55) {
  const solid = new THREE.DodecahedronGeometry(circumRadius, 0);
  return new PortalDefect({
    position,
    label: 'Dodecahedral defect (36° twist)',
    faceSpecs: polyhedronFaceSpecs(solid, Math.PI / 5),
    outlineGeometry: solid,
  });
}

// Seifert–Weber dodecahedral space: the SAME dodecahedron as the Poincaré
// cell, opposite faces glued with a 3π/5 (108°) twist instead of 36°. The
// larger twist tips the closed manifold out of spherical (S³) geometry into
// hyperbolic (H³) — a closed hyperbolic 3-manifold. Flattened cone-manifold
// stand-in exactly like the Poincaré cell: edges carry deficit-angle seams,
// and it rides the identical portal/teleport code path — only the twist angle
// differs, and the opposite-pair gluings stay mutual inverses for any θ (so
// round-trips are seam-consistent). Closed hyperbolic, not S³ / S²×S¹ / a lens
// space, so spinorial → red sign.
export function createSeifertWeberDefect(position, circumRadius = 0.55) {
  const solid = new THREE.DodecahedronGeometry(circumRadius, 0);
  return new PortalDefect({
    position,
    label: 'Seifert–Weber space (108° twist)',
    faceSpecs: polyhedronFaceSpecs(solid, 3 * Math.PI / 5),
    outlineGeometry: solid,
  });
}

// Octahedron, opposite (antiparallel) triangles glued with a π/3 (60°) twist
// — the vertex-exact gluing for opposite octahedron faces.
export function createOctahedralDefect(position, circumRadius = 0.45) {
  const solid = new THREE.OctahedronGeometry(circumRadius, 0);
  return new PortalDefect({
    position,
    label: 'Octahedral defect (60° twist)',
    faceSpecs: polyhedronFaceSpecs(solid, Math.PI / 3),
    outlineGeometry: solid,
  });
}
