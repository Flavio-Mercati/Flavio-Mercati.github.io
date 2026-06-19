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
//   θ = π/3    : hexagonal prism caps (sides θ=0) — "1/6-turn screw" (hexacosm)
//   θ = 2π/3   : hexagonal prism caps (sides θ=0) — "1/3-turn screw" (tricosm)
//
// Faces may instead carry an EXPLICIT (R_F, t_F) — a general rigid motion, not
// tied to the face normal. That is what the Hantzsche–Wendt didicosm needs: its
// rhombic-dodecahedral cell is glued in six pairs by half-turn SCREWS (180°
// about a coordinate axis + an off-axis glide), a non-antipodal pairing in which
// R·n̂ carries each face normal to its partner's, which the "about own normal"
// form cannot express. The renderer and teleport are fully (R, t)-based, so both
// families share one code path; the clip plane is placed at the gluing-image
// of the entry face, whose outward normal is R·n̂ (it can point either way).
//
// Rendering: the image on face F is the scene from a VIRTUAL camera — the real
// camera pushed through F's world-space gluing — rendered with the SAME
// projection matrix and sampled at normalized screen coordinates. The defect
// may rotate (setRotation); all world quantities are derived from the current
// orientation q each frame, and the world gluing rotation is q·R·q⁻¹.
//
// A face may instead be glued by an ORIENTATION-REVERSING isometry: R_F with
// det −1 (a reflection or glide-reflection). This is what the non-orientable
// flat platycosms — the amphicosms and amphidicosms (the Klein-bottle × S¹
// family) — require; e.g. a ±z glide-reflection g(x,y,z) = (−x, y, z − D), whose
// linear part is diag(−1, 1, 1). Such an R is stored as the proper rotation
// glueQuat composed with a per-axis sign vector glueRefl (so R = Qrot·diag(s)),
// which leaves the proper path untouched. A single det −1 face makes the whole
// cell non-orientable; the renderer must then flip face-winding and the
// observer's handedness for passes/crossings through that face.
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
const _sphere = new THREE.Sphere();
// Reflecting-pass scratch: A = M_G⁻¹ (the world-root transform, optionally
// pre-composed with the observer mirror) and the factors that build M_G.
const _mScene = new THREE.Matrix4();
const _mR = new THREE.Matrix4();
const _mTmp = new THREE.Matrix4();
const _glm = new THREE.Matrix4();   // scratch for the teleport linear map
const _glm2 = new THREE.Matrix4();
const _wq = new THREE.Quaternion();
const _wqi = new THREE.Quaternion();

// Apply a face's local linear part R = Qrot · diag(refl) to v, in place, and
// return v. For a proper face refl = (1,1,1), so this is exactly
// v.applyQuaternion(glueQuat) — multiplying each component by 1 is exact — and
// the orientable cells stay numerically identical. For a non-orientable face
// refl carries the det −1 reflection, making R improper.
function glueLinear(v, f) {
  return v.multiply(f.glueRefl).applyQuaternion(f.glueQuat);
}

export class PortalDefect {
  // faceSpecs: [{ n: unit Vector3 (local outward normal), D: distance to the
  //   partner face, geometry: BufferGeometry already positioned in local
  //   coords, and EITHER theta (twist about n̂, with the implicit −D·n̂ slide)
  //   OR an explicit { glueQuat, glueT } rigid gluing }]
  // boundPlanes: optional extra local half-spaces { n, d } (n·x < d) that bound
  //   the cell for teleport containment but are NOT portals — for cells whose
  //   identified faces do not by themselves enclose a finite region. Currently
  //   unused (the lens cell that needed it was removed); kept as general
  //   containment infrastructure for cells of that kind.
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
    this.rtSamples = 2;      // portal-target MSAA; main.js drops this to 0 on mobile
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
      // Linear part R = glueQuat · diag(glueRefl). glueRefl is the OPTIONAL
      // orientation-reversing factor (a per-axis sign vector). Absent ⇒ (1,1,1):
      // R is the proper rotation glueQuat (det +1) and — since ×1 is exact —
      // every formula below reduces to the original quaternion-only path, so the
      // orientable cells are byte-for-byte unchanged. Present (e.g. (−1,1,1)) ⇒
      // R is improper (det −1); det R is the product of the three signs, kept as
      // `parity`.
      const glueRefl = spec.glueRefl ? spec.glueRefl.clone() : new THREE.Vector3(1, 1, 1);
      const parity = glueRefl.x * glueRefl.y * glueRefl.z; // det R ∈ {+1, −1}
      return {
        n: spec.n.clone(),
        halfD: spec.D / 2,    // entry-face plane offset: n·x = halfD
        glueQuat,
        glueT,
        glueRefl,
        parity,
        exit: this.position,  // opposite-face gluing exits at this defect's own center
        mesh,
        mat,
      };
    });

    // Orientation-preserving overall iff every face gluing is proper; a single
    // det −1 face makes the cell non-orientable (an amphicosm / amphidicosm).
    this.orientable = this.faces.every((f) => f.parity > 0);

    this.boundPlanes = boundPlanes.map((b) => ({ n: b.n.clone(), d: b.d }));

    this.edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(outlineGeometry, 5),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 })
    );
    this.group.add(this.edges);

    // World-space bounding radius (the cell sits at this.position; the outline
    // is centred on the local origin, so its sphere radius is the world radius).
    // Used for optional frustum culling of off-screen cells; the 1.2 margin
    // keeps a cell that is only partly on-screen from being culled.
    outlineGeometry.computeBoundingSphere();
    this.boundingRadius = (outlineGeometry.boundingSphere?.radius || 1) * 1.2;
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
        new THREE.WebGLRenderTarget(this._rtW, this._rtH, { samples: this.rtSamples })
      );
    }
    return this.renderTargets[i];
  }

  // World-space gluing affine for a face, inverted, as a Matrix4. The gluing
  //   M_G(X) = q·( R·(q⁻¹·(X − c)) + t ) + c,   c = this.position, q = group quat,
  //   R = glueQuat · diag(glueRefl);   det M_G = det R = parity (±1).
  // M_G⁻¹ is what a reflecting pass installs as the scene-root transform:
  // rendering the REAL camera through a world reflected by M_G⁻¹ is pixel-
  // equivalent to the virtual-camera image, and for a det −1 face its negative
  // determinant flips every object's winding so culling stays correct (a
  // mirrored camera cannot — Three keys culling off the object matrix).
  worldGlueInverse(f, target) {
    const c = this.position;
    _wq.copy(this.group.quaternion);
    _wqi.copy(_wq).invert();
    _mR.makeRotationFromQuaternion(f.glueQuat).scale(f.glueRefl); // R = Qrot·diag(refl)
    target.makeTranslation(c.x, c.y, c.z);                        // T(c)
    _mTmp.makeRotationFromQuaternion(_wq);   target.multiply(_mTmp);            // ·Rq
    _mTmp.makeTranslation(f.glueT.x, f.glueT.y, f.glueT.z); target.multiply(_mTmp); // ·T(t)
    target.multiply(_mR);                                         // ·R
    _mTmp.makeRotationFromQuaternion(_wqi);  target.multiply(_mTmp);            // ·Rq⁻¹
    _mTmp.makeTranslation(-c.x, -c.y, -c.z); target.multiply(_mTmp);            // ·T(−c)
    return target.invert();                                       // M_G⁻¹
  }

  // Render the portal textures. Caller must have hidden all defect groups.
  // `frustum` is optional: when supplied, a cell whose bounding sphere lies
  // fully outside the view is skipped (its portal passes would never be seen).
  // This is lossless — during portal passes every defect group is hidden, so a
  // cell can never appear inside another cell's portal, only as itself.
  // opts.observerParity < 0 ⇒ the traveller is mirrored (crossed an odd number
  // of reflecting faces); opts.mirror is the per-frame camera Householder H
  // (Matrix4) used to render that mirrored world. Both default to the
  // orientable case, so the six orientable cells call this exactly as before.
  render(renderer, scene, camera, fullResolution, frustum = null, opts = {}) {
    const observerParity = opts.observerParity ?? 1;
    const mirror = opts.mirror || null;
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
    if (frustum) {
      _sphere.center.copy(this.position);
      _sphere.radius = this.boundingRadius;
      if (!frustum.intersectsSphere(_sphere)) {     // off-screen: nothing to draw
        for (const f of this.faces) f.mesh.visible = false;
        return;                                      // keep RTs warm for the turn back
      }
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

      // Shared projection: the virtual camera (option A) inherits the real
      // camera's lens; harmless to set even when option B uses the real camera.
      this.portalCam.fov = camera.fov;
      this.portalCam.aspect = camera.aspect;
      this.portalCam.near = camera.near;
      this.portalCam.far = camera.far;
      this.portalCam.updateProjectionMatrix();

      // Exit-face clip plane (same geometry for both render paths): the gluing-
      // image of the entry face, centre g(halfD·n̂), outward normal R·n̂ (which
      // may flip relative to n̂ when R is improper or not a twist about n̂),
      // negated so the kept half-space is the one beyond the exit face.
      _gn.copy(f.n); glueLinear(_gn, f);                    // local exit normal R·n̂
      _c.copy(_gn).multiplyScalar(f.halfD).add(f.glueT);    // local exit-face center
      _c.applyQuaternion(_q).add(f.exit);                   // → world
      _gn.applyQuaternion(_q).negate();                     // → world, into kept side
      _plane.setFromNormalAndCoplanarPoint(_gn, _c);

      // A pass is "reflecting" when it carries an odd number of reflections: a
      // det −1 face gluing, OR an odd-parity (mirrored) observer, OR both. Even
      // face · even observer → option A; anything else → option B.
      const reflecting = f.parity < 0 || observerParity < 0;
      const rt = this._getRT(rtIndex++);
      renderer.setRenderTarget(rt);

      if (!reflecting) {
        // OPTION A — orientation-preserving pass. The world stays put and a
        // VIRTUAL camera (the real camera pushed through the world gluing) is
        // rendered. This is the original, perf-light path; the six orientable
        // cells always take it (parity +1, observer even).
        _l.copy(camera.position).sub(this.position).applyQuaternion(_qi);
        glueLinear(_l, f).add(f.glueT);
        this.portalCam.position.copy(_l).applyQuaternion(_q).add(f.exit);
        _qIso.copy(_q).multiply(f.glueQuat).multiply(_qi); // world gluing rotation
        this.portalCam.quaternion.copy(_qIso).multiply(camera.quaternion);
        renderer.clippingPlanes = [_plane];
        renderer.render(scene, this.portalCam);
      } else {
        // OPTION B — reflecting pass. A mirrored camera CANNOT be used: Three
        // keys face culling off each object's world-matrix determinant, not the
        // camera's, so a mirrored camera renders inside-out. Instead install
        // A = M_G⁻¹ (optionally pre-composed with the observer mirror H) as the
        // scene-root transform and render the REAL camera. That is pixel-
        // equivalent to the virtual-camera image, and det A < 0 (odd reflection
        // count) flips every object's winding so culling stays correct. The clip
        // is the SAME exit plane carried through A (Plane.applyMatrix4 keeps
        // exactly the half-space option A would), and it stays correct under cell
        // yaw, which a camera scale could not. (Seam continuity for an odd-parity
        // observer looking INTO a portal follows this determinant algebra but is
        // not pixel-verifiable headlessly — confirm on-device.)
        this.worldGlueInverse(f, _mScene);                 // A = M_G⁻¹
        if (mirror) _mScene.premultiply(mirror);           // A = H · M_G⁻¹ (odd observer)
        _plane.applyMatrix4(_mScene);                      // carry the clip through A
        renderer.clippingPlanes = [_plane];
        // Install A as the scene-root transform. matrixAutoUpdate is forced
        // off so the renderer's own updateMatrixWorld won't recompute
        // scene.matrix from its (identity) transform and wipe the reflection;
        // restored immediately after (so the viewer, which leaves it on, and
        // the main app both behave).
        const prevAuto = scene.matrixAutoUpdate;
        scene.matrixAutoUpdate = false;
        scene.matrix.copy(_mScene);                        // reflect the world root
        scene.matrixWorldNeedsUpdate = true;
        // The sun is a child of the scene root, so it reflects WITH the world
        // in this pass. The shadow map shared by the orientation-preserving
        // passes was built un-reflected; projecting it onto the reflected
        // geometry drops shadows on the wrong side (the dark smear seen when
        // looking into a glide cell from outside). Rebuild it in THIS reflected
        // frame — each reflecting face carries its own reflection, so the
        // rebuild can't be shared — then flag it again afterwards so the next
        // pass, which restores a different root transform, rebuilds to match.
        renderer.shadowMap.needsUpdate = true;
        renderer.render(scene, camera);                    // REAL camera
        scene.matrix.identity();                           // restore for the next pass
        scene.matrixWorldNeedsUpdate = true;
        scene.matrixAutoUpdate = prevAuto;
        renderer.shadowMap.needsUpdate = true;             // next consumer rebuilds to its own frame
      }

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

    glueLinear(_l.copy(_lc), best).add(best.glueT);
    const position = _l.applyQuaternion(_q).add(best.exit).clone();
    // Orientation-preserving part of the world gluing (proper rotation); kept
    // for compatibility.
    const rotation = new THREE.Quaternion().copy(_q).multiply(best.glueQuat).multiply(_qi);
    // FULL world-space linear part of the gluing: R = q·glueQuat·diag(glueRefl)·q⁻¹
    // — the SAME isometry applied to `position`, minus translation, INCLUDING the
    // det −1 reflection of a glide face. The traveller carries its look (and hence
    // its flight velocity, which follows the look) through this so the geodesic
    // stays straight across the seam; only the handedness is split off as `parity`.
    // For an orientable face glueRefl = (1,1,1), so `linear` equals `rotation`.
    const linear = new THREE.Matrix4().makeRotationFromQuaternion(_q)
      .multiply(_glm.makeRotationFromQuaternion(best.glueQuat))
      .scale(best.glueRefl)
      .multiply(_glm2.makeRotationFromQuaternion(_qi));
    return { position, rotation, linear, parity: best.parity };
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

// Hantzsche–Wendt didicosm — the FAITHFUL flat cell (not a cube stand-in). It is
// the rhombic-dodecahedral Dirichlet domain of the HW manifold: the Voronoi cell
// of the FCC orbit of a basepoint offset to (0, ½, 0). Its twelve rhombic faces
// glue in six pairs under the three mutually perpendicular, NON-intersecting
// half-turn screws that generate the group — each a 180° rotation about a
// coordinate axis composed with an off-axis glide. Because the screws share no
// fixed point the action is free, so this is the genuine smooth manifold with NO
// central orbifold singularity; and because it is a true Dirichlet domain of a
// free Euclidean action its rhombic-dodecahedron edge cycles each close at
// exactly 2π, so it is honestly flat and SEAM-FREE (like the torus), unlike the
// dicosm/tetracosm cube cells. The three rotation parts {diag(1,−1,−1),
// diag(−1,1,−1), diag(−1,−1,1)} generate the holonomy ℤ/2×ℤ/2 — the HW
// fingerprint, the unique orientable flat 3-manifold with that holonomy — and
// all have det +1 → orientable → red. The pairing is NOT antipodal: each rhombus
// glues to a non-opposite rhombus, which is exactly what closes the edges into
// smooth 2π cycles. Verified headlessly: facet-pairing isometries (every entry
// rhombus maps onto its partner), mutual inverses (round-trips home), free
// action, holonomy order 4, all edge cycles = 2π.
//
// Scale law (lattice-derived): obtuse (degree-4) vertices sit at ±circumRadius on
// the axes, acute (degree-3) vertices at ±circumRadius/2; the inradius is then
// circumRadius/√2 and each screw's glide is (integer half-units)·circumRadius.
// V (14 vertices) and F (12 faces: four vertex indices CCW-outward, the screw
// axis, and the glide in half-units) are emitted directly from that derivation.
export function createHantzscheWendtDefect(position, circumRadius = 0.5) {
  const V = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [0.5, -0.5, 0.5], [0.5, -0.5, -0.5],
    [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5],
  ];
  // [v0, v1, v2, v3 (CCW outward), screwAxis, glide x, y, z in half-units]
  const F = [
    [7, 2, 6, 0, 'x', -1, 1, 0], [0, 8, 3, 9, 'x', -1, -1, 0],
    [1, 10, 2, 11, 'x', 1, 1, 0], [13, 3, 12, 1, 'x', 1, -1, 0],
    [0, 6, 4, 8, 'z', 1, 0, -1], [9, 5, 7, 0, 'z', 1, 0, 1],
    [12, 4, 10, 1, 'z', -1, 0, -1], [1, 11, 5, 13, 'z', -1, 0, 1],
    [10, 4, 6, 2, 'y', 0, -1, 1], [2, 7, 5, 11, 'y', 0, -1, -1],
    [3, 8, 4, 12, 'y', 0, 1, 1], [13, 5, 9, 3, 'y', 0, 1, -1],
  ];
  const AX = {
    x: new THREE.Vector3(1, 0, 0),
    y: new THREE.Vector3(0, 1, 0),
    z: new THREE.Vector3(0, 0, 1),
  };
  const vert = (i) => new THREE.Vector3(V[i][0], V[i][1], V[i][2]).multiplyScalar(circumRadius);

  const faceSpecs = [];
  for (const [a, b, c, d, axis, tx, ty, tz] of F) {
    const p = [vert(a), vert(b), vert(c), vert(d)];
    const tris = [p[0], p[1], p[2], p[0], p[2], p[3]]; // two CCW-outward triangles
    const arr = new Float32Array(18);
    tris.forEach((v, k) => { arr[3 * k] = v.x; arr[3 * k + 1] = v.y; arr[3 * k + 2] = v.z; });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));

    const n = new THREE.Vector3().subVectors(p[1], p[0])
      .cross(new THREE.Vector3().subVectors(p[2], p[0])).normalize();
    const D = 2 * n.dot(p[0]);                        // 2 × inradius (= circumRadius·√2)
    const glueQuat = new THREE.Quaternion().setFromAxisAngle(AX[axis], Math.PI);
    const glueT = new THREE.Vector3(tx, ty, tz).multiplyScalar(circumRadius);
    faceSpecs.push({ n, D, geometry, glueQuat, glueT });
  }

  // Indexed outline: 14 shared vertices so EdgesGeometry resolves the 24 rhombus
  // edges cleanly (and drops the 12 in-face diagonals). A non-indexed soup would
  // mis-merge and under-count.
  const oPos = new Float32Array(V.length * 3);
  V.forEach((v, k) => { oPos[3 * k] = v[0] * circumRadius; oPos[3 * k + 1] = v[1] * circumRadius; oPos[3 * k + 2] = v[2] * circumRadius; });
  const oIdx = [];
  for (const [a, b, c, d] of F) oIdx.push(a, b, c, a, c, d);
  const outlineGeometry = new THREE.BufferGeometry();
  outlineGeometry.setAttribute('position', new THREE.BufferAttribute(oPos, 3));
  outlineGeometry.setIndex(oIdx);

  return new PortalDefect({
    position,
    label: 'Hantzsche–Wendt defect (didicosm)',
    faceSpecs,
    outlineGeometry,
  });
}

// First amphicosm (+a1) — Klein bottle × S¹, the simplest NON-orientable flat
// 3-manifold, and the seventh platycosm overall. A cube cell whose ±x and ±y
// faces glue straight across by pure translation (exactly as the torus), while
// the ±z faces glue by a GLIDE REFLECTION
//
//     g(x, y, z) = (−x, y, z − D),   linear part diag(−1, 1, 1)  (det −1).
//
// Exit the top and you re-enter the bottom with x mirrored, so the (x, z) cross-
// section is a flat Klein bottle and the y-direction an ordinary circle — hence
// Klein × S¹. The single orientation-reversing pair makes the holonomy ℤ/2
// generated by diag(−1, 1, 1), a REFLECTION (det −1 → non-orientable). That is
// what distinguishes it from the dicosm, whose ℤ/2 is the det +1 half-turn
// diag(1, −1, −1): same abstract holonomy group, orientation-reversing vs
// orientation-preserving generator.
//
// Because the glide is an involution up to translation (g² = translation by 2D
// in z), the cube of side D is the GENUINE Dirichlet domain, not a flattened
// stand-in: {cube, g·cube} tiles one z-period (2D), and the gluing carries x- to
// x-edges and y- to y-edges, so every edge cycle closes at four right angles
// (2π). It is therefore a faithful, SEAM-FREE flat manifold — like the torus and
// the Hantzsche–Wendt cell, unlike the twist-every-face cube stand-ins (whose
// rotated caps shear edge cycles off 2π). Verified headlessly: facet-pairing
// mutual inverses, holonomy ℤ/2, fixed-point-free (free) action, the Klein
// relation g·t_x·g⁻¹ = t_x⁻¹, and all edge cycles = 2π.
//
// The slide is −D·n̂ on every face (as in the torus); the ±z pair simply adds the
// glueRefl reflection diag(−1,1,1) on top of that translation.
export function createFirstAmphicosmDefect(position, size = 0.5) {
  const N = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
  ];
  const faceSpecs = N.map((n) => ({
    n,
    D: size,
    geometry: bakeFace(new THREE.PlaneGeometry(size, size), n, size / 2),
    glueQuat: new THREE.Quaternion(),                          // no rotation
    glueT: new THREE.Vector3().copy(n).multiplyScalar(-size),  // slide −D·n̂
    // the ±z pair is the glide-reflection (reflect x); ±x, ±y stay translations
    glueRefl: n.z !== 0 ? new THREE.Vector3(-1, 1, 1) : new THREE.Vector3(1, 1, 1),
  }));
  return new PortalDefect({
    position,
    label: 'First amphicosm (Klein bottle × S¹)',
    faceSpecs,
    outlineGeometry: new THREE.BoxGeometry(size, size, size),
  });
}

// Second amphicosm (+a2) — the OTHER non-orientable flat 3-manifold with cyclic
// holonomy ℤ/2, and the eighth platycosm. Like the first amphicosm it is a cube
// whose ±x and ±y faces glue by pure translation (the T² fibre), but the ±z pair
// glues by a SWAP glide-reflection
//
//     g(x, y, z) = (y, x, z − D),   linear part  swap = [[0,1,0],[1,0,0],[0,0,1]]
//
// — reflect across the diagonal plane x = y, then slide −D along z (det −1). It
// is the mapping torus of the square torus T² under the order-2 reflection
// [[0,1],[1,0]] ("swap"), whose GL(2,ℤ) class is distinct from the first
// amphicosm's diag(1,−1): the swap's ±1 eigenlattices (spanned by (1,1) and
// (1,−1)) generate only the index-2 even-sum sublattice, so the two amphicosms
// are not affinely equivalent. They are the two — and only two — non-orientable
// flat 3-manifolds with ℤ/2 holonomy; first homology separates them (H₁ = ℤ²
// here, vs ℤ² ⊕ ℤ/2 for Klein × S¹).
//
// The swap is an involution up to translation (g² = (x, y, z−2D), a pure
// translation); its glide vector (0,0,−D) lies in the mirror plane x = y; and it
// carries x-edges to y-edges, so the cube is the GENUINE Dirichlet domain of a
// free, fixed-point-free action whose every edge cycle closes at 2π — a
// faithful, SEAM-FREE flat manifold like the torus, not a flattened stand-in.
// The linear part is improper, so it factors as Qrot·diag(refl) with the proper
// rotation a 180° turn about (1,1,0)/√2 (= [[0,1,0],[1,0,0],[0,0,−1]]) and
// refl = diag(1,1,−1) restoring +z: their product is the swap. Verified
// headlessly: facet-pairing mutual inverses, holonomy ℤ/2 (one det −1 generator),
// free action, all edge cycles = 2π.
export function createSecondAmphicosmDefect(position, size = 0.5) {
  const N = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
  ];
  // Qrot·diag(refl) = swap_xy : Qrot = 180° about (1,1,0)/√2, refl = diag(1,1,−1).
  const swapQuat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 1, 0).normalize(), Math.PI);
  const faceSpecs = N.map((n) => {
    const onZ = n.z !== 0;                                      // ±z pair = swap glide
    return {
      n,
      D: size,
      geometry: bakeFace(new THREE.PlaneGeometry(size, size), n, size / 2),
      glueQuat: onZ ? swapQuat.clone() : new THREE.Quaternion(),
      glueT: new THREE.Vector3().copy(n).multiplyScalar(-size),  // slide −D·n̂
      glueRefl: onZ ? new THREE.Vector3(1, 1, -1) : new THREE.Vector3(1, 1, 1),
    };
  });
  return new PortalDefect({
    position,
    label: 'Second amphicosm (swap-glide torus bundle)',
    faceSpecs,
    outlineGeometry: new THREE.BoxGeometry(size, size, size),
  });
}

// First amphidicosm (+a2² / mm2) — a NON-orientable flat 3-manifold with
// holonomy ℤ/2 × ℤ/2, the ninth platycosm. It is the non-orientable sibling of
// the Hantzsche–Wendt didicosm: same Klein-four holonomy group, but realised by
// REFLECTIONS rather than half-turns, so it is non-orientable (pin±, not spin)
// where HW is orientable. A cube whose three face-pairs glue as
//
//     ±x :  g(x,y,z) = (x − D, −y,  z)     linear σ_y = diag( 1,−1, 1)  (det −1)
//     ±y :  g(x,y,z) = (x,  y − D,  z)     linear  I  = diag( 1, 1, 1)  (translation)
//     ±z :  g(x,y,z) = (−x,  y,  z − D)    linear σ_x = diag(−1, 1, 1)  (det −1)
//
// — a glide reflection on ±x (reflect y, glide along x), a plain translation on
// ±y, and a glide reflection on ±z (reflect x, glide along z). The two reflection
// generators give holonomy ⟨σ_y, σ_x⟩ = {I, σ_x, σ_y, σ_xσ_y = C₂(z)} = mm2
// (point group C₂ᵥ): two mirrors (det −1) and one half-turn C₂(z) (det +1), so
// the cell is non-orientable. Each non-identity element is realised fixed-point-
// freely — the two glides slide within their mirror planes, and the diagonal
// C₂(z) inherits a z-glide from the ±z reflection, so it is a SCREW with no fixed
// line — making the action free and the cube a genuine Dirichlet domain: a
// faithful, SEAM-FREE flat manifold (edge cycles 2π), not a flattened stand-in.
// H₁ = ℤ ⊕ ℤ/2 ⊕ ℤ/2 (the free ℤ along the ±y translation circle). Verified
// headlessly: facet-pairing mutual inverses, holonomy group ℤ/2×ℤ/2 with a det −1
// generator, free action, all edge cycles = 2π.
//
// (Only one of the two amphidicosms admits an opposite-face cube domain: every
// other free mm2 assignment is either this same group with the origin shifted or
// has a fixed-line half-turn. The second amphidicosm needs a non-cube Dirichlet
// domain — the rhombic-dodecahedral treatment HW received — and is left for that
// dedicated build.)
export function createFirstAmphidicosmDefect(position, size = 0.5) {
  const N = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
  ];
  // refl per pair (Qrot = I, slide −D·n̂):  ±x → σ_y, ±z → σ_x, ±y → identity.
  const reflFor = (n) => {
    if (n.x !== 0) return new THREE.Vector3(1, -1, 1); // ±x : reflect y (σ_y)
    if (n.z !== 0) return new THREE.Vector3(-1, 1, 1); // ±z : reflect x (σ_x)
    return new THREE.Vector3(1, 1, 1);                 // ±y : pure translation
  };
  const faceSpecs = N.map((n) => ({
    n,
    D: size,
    geometry: bakeFace(new THREE.PlaneGeometry(size, size), n, size / 2),
    glueQuat: new THREE.Quaternion(),                           // no rotation
    glueT: new THREE.Vector3().copy(n).multiplyScalar(-size),   // slide −D·n̂
    glueRefl: reflFor(n),
  }));
  return new PortalDefect({
    position,
    label: 'First amphidicosm (mm2)',
    faceSpecs,
    outlineGeometry: new THREE.BoxGeometry(size, size, size),
  });
}
