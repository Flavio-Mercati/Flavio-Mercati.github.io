// The world INSIDE one fundamental cell: a tiny spherical planet (King-Kai /
// Kaiō-sama style) at the centre, the periodic copies of it seen receding
// through the identified walls, drifting clouds in the gulfs between, and birds
// circling the surface. Built from the parent project's asset library (the same
// four faceted tree variants, lumpy bushes, stem+bloom flowers, tapered wind-
// swayed grass, boulders, gable cottage) re-pointed from a flat heightfield onto
// a sphere.
//
// Lighting model (no sun, no single source). The sky glows isotropically, so
// the base is a flat ambient floor — but objects are NOT shaded flat: a custom
// material adds a soft "from above" term, where "above" is the LOCAL radial
// direction away from the planet centre (per-instance centre for the distant
// copies). Treetops read bright, undersides dark, uniformly all around the
// globe. Contact is faked with a fuzzy dark blob under each sizeable object
// (trees, bushes, boulders, the house) — an occlusion stand-in, no shadow maps.
//
// Faceting is done in-shader from screen-space derivatives, so any geometry
// (indexed or not, instanced or not) renders low-poly/cel with no precomputed
// face normals. Haze is exponential-squared, matched to the scene's FogExp2 so
// the custom and stock (cloud / edge) materials fade together.

import * as THREE from 'three';
import { createNoise, mulberry32 } from './noise.js';
import { CELL_HALF, PERIOD, latticeMatrices, latticeImageCenters, cubeEdgeSegments, getTopology } from './cell.js';

const lerp = (a, b, t) => a + (b - a) * t;
function smoothstep(e0, e1, x) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}
const linRGB = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

// ===== custom shading ========================================================

// One shared uniform block so a single uTime / uCamPos / fog update reaches
// every planet material at once.
function makeSharedUniforms(fogColorHex, fogDensity) {
  const c = new THREE.Color(fogColorHex); // linear working-space RGB
  return {
    uTime: { value: 0 },
    uCamPos: { value: new THREE.Vector3() },
    uFogColor: { value: new THREE.Vector3(c.r, c.g, c.b) },
    uFogDensity: { value: fogDensity },
    uAmbient: { value: 0.26 },                 // isotropic sky floor (a notch darker: deeper nights)
    uSunOffset: { value: new THREE.Vector3() }, // sun position relative to a planet centre
    uSunStrength: { value: 0.78 },              // how much the sun adds on the lit hemisphere
    uSunColor: { value: new THREE.Vector3(1.0, 0.93, 0.74) }, // warm sunlight
    // directional sun-cast shadows (desktop): one depth map of the central planet
    // shadows the whole lattice (each copy subtracts its own centre to sample it).
    uShadowMap: { value: null },
    uShadowMatrix: { value: new THREE.Matrix4() }, // world (central frame) -> light clip
    uShadowStrength: { value: 0.62 },              // how much a shadow darkens the sun term
    uShadowTexel: { value: 1 / 2048 },             // PCF step
    uShadowCenter: { value: new THREE.Vector3() }, // centre the depth map was rendered around
  };
}

const PLANET_VERT = /* glsl */ `
precision highp float;
precision highp int;
in vec3 position;
in vec3 color;
#ifdef USE_VERTEX_NORMALS
in vec3 normal;
out vec3 vNormal;
#endif
#ifdef USE_SMOOTH_LIGHT
in vec3 aSmoothN;
out vec3 vSmoothN;
#endif
#ifdef USE_INSTANCING
in mat4 instanceMatrix;
#endif
uniform mat4 modelMatrix, viewMatrix, projectionMatrix;
uniform float uTime;
uniform vec3 uCenter;
out vec3 vWorldPos;
out vec3 vColor;
out float vFogDepth;
#ifdef USE_INSTANCE_CENTER
out vec3 vCenter;
#endif
void main() {
  vec3 p = position;
#ifdef SWAY
  // wind sway: blades are modelled along local +y; quadratic taper from the base.
  // Per-instance phase comes from the instance translation so neighbours differ.
  float phx = instanceMatrix[3].x, phz = instanceMatrix[3].z;
  float ph = phx * 0.35 + phz * 0.45;
  float sw = p.y * p.y * 6.25;
  p.x += (sin(uTime * 1.7 + ph) * 0.06 + sin(uTime * 3.3 + ph * 1.7) * 0.022) * sw;
  p.z += cos(uTime * 1.4 + ph * 1.3) * 0.045 * sw;
#endif
#ifdef USE_INSTANCING
  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  #ifdef USE_INSTANCE_CENTER
  vCenter = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  #endif
#else
  vec4 wp = modelMatrix * vec4(p, 1.0);
#endif
  vWorldPos = wp.xyz;
  vColor = color;
#ifdef USE_VERTEX_NORMALS
  #ifdef USE_INSTANCING
  vNormal = mat3(modelMatrix) * mat3(instanceMatrix) * normal;
  #else
  vNormal = mat3(modelMatrix) * normal;
  #endif
#endif
#ifdef USE_SMOOTH_LIGHT
  vSmoothN = mat3(modelMatrix) * aSmoothN;
#endif
  vec4 mv = viewMatrix * wp;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const PLANET_FRAG = /* glsl */ `
precision highp float;
precision highp int;
in vec3 vWorldPos;
in vec3 vColor;
in float vFogDepth;
#ifdef USE_VERTEX_NORMALS
in vec3 vNormal;
#endif
#ifdef USE_SMOOTH_LIGHT
in vec3 vSmoothN;
#endif
#ifdef USE_INSTANCE_CENTER
in vec3 vCenter;
#endif
uniform vec3 uCenter;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uAmbient;
uniform vec3 uSunOffset;
uniform float uSunStrength;
uniform vec3 uSunColor;
#ifdef USE_CAST_SHADOW
uniform highp sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowStrength;
uniform float uShadowTexel;
uniform vec3 uShadowCenter;
#endif
out vec4 fragColor;

vec3 lin2srgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
#ifdef USE_VERTEX_NORMALS
  // hard-surface props: real per-face outward normal (built CPU-side), so flat
  // faces shade correctly instead of being bent toward the camera
  vec3 N = normalize(vNormal);
#else
  // faceted (flat) world normal straight from screen-space derivatives
  vec3 N = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  vec3 viewDir = normalize(uCamPos - vWorldPos);
  if (dot(N, viewDir) < 0.0) N = -N;     // outward normal of the visible face
#endif
#ifdef USE_INSTANCE_CENTER
  vec3 ctr = vCenter;
#else
  vec3 ctr = uCenter;
#endif
  vec3 up = normalize(vWorldPos - ctr);
  float upDot = clamp(dot(N, up) * 0.5 + 0.5, 0.0, 1.0); // 0 underside .. 1 top
  // ambient sky: a soft, DIM floor with undersides a touch darker (the night look)
  float form = mix(0.72, 1.0, upDot);
  // the orbiting sun is the real directional light: it gives day-side form AND
  // the day/night terminator. Each copy's sun sits at its own centre + the shared
  // orbit offset, so one uniform lights the whole lattice.
  vec3 sunDir = normalize(ctr + uSunOffset - vWorldPos);
#ifdef USE_SMOOTH_LIGHT
  vec3 Nlit = normalize(vSmoothN);             // smooth analytic normal -> the day/night
#else                                          // terminator crosses faces smoothly (no steps)
  vec3 Nlit = N;
#endif
  float ndl = dot(Nlit, sunDir);
  float sunCel = smoothstep(-0.12, 0.5, ndl);  // smooth day/night terminator (no hard cel bands)
  float shadow = 0.0;
#ifdef USE_CAST_SHADOW
  {
    // bring the fragment into the central planet's frame (subtract this copy's
    // centre), then project into the sun's light-clip space and PCF-compare:
    // one depth map of the central planet thus shadows the whole lattice.
    // normal-offset (push the receiver a touch off its surface along the lighting
    // normal) + a slope-scaled depth bias: together these stop the self-shadow
    // "acne" from shimmering as the sun creeps across a curved, spinning surface.
    vec3 sp = vWorldPos - ctr + uShadowCenter + Nlit * 0.6;
    vec4 lc = uShadowMatrix * vec4(sp, 1.0);
    vec3 proj = lc.xyz / lc.w;
    vec2 uv = proj.xy * 0.5 + 0.5;
    float curDepth = proj.z * 0.5 + 0.5;
    if (uv.x > 0.001 && uv.x < 0.999 && uv.y > 0.001 && uv.y < 0.999 && curDepth < 1.0) {
      float bias = max(0.0040 * (1.0 - ndl), 0.0015);
      float sum = 0.0;
      for (int dy = -1; dy <= 1; dy++)
        for (int dx = -1; dx <= 1; dx++) {
          float d = texture(uShadowMap, uv + vec2(float(dx), float(dy)) * uShadowTexel).r;
          sum += (curDepth - bias > d) ? 1.0 : 0.0;
        }
      shadow = (sum / 9.0) * uShadowStrength;
    }
  }
#endif
  vec3 light = vec3(uAmbient * form) + uSunStrength * sunCel * (1.0 - shadow) * uSunColor;
  vec3 col = vColor * light;
  float f = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
  col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
  fragColor = vec4(lin2srgb(col), 1.0);
}`;

function makePlanetMaterial(shared, { center, instanced = false, instanceCenter = false, sway = false, vertexNormals = false, side = THREE.FrontSide, castShadow = false, smoothLight = false }) {
  const defines = {};
  if (instanced) defines.USE_INSTANCING = '';
  if (instanceCenter) defines.USE_INSTANCE_CENTER = '';
  if (sway) defines.SWAY = '';
  if (vertexNormals) defines.USE_VERTEX_NORMALS = '';
  if (castShadow) defines.USE_CAST_SHADOW = '';
  if (smoothLight) defines.USE_SMOOTH_LIGHT = '';
  const uniforms = {
    uTime: shared.uTime,
    uCamPos: shared.uCamPos,
    uFogColor: shared.uFogColor,
    uFogDensity: shared.uFogDensity,
    uAmbient: shared.uAmbient,
    uSunOffset: shared.uSunOffset,
    uSunStrength: shared.uSunStrength,
    uSunColor: shared.uSunColor,
    uCenter: { value: center ? center.clone() : new THREE.Vector3() },
  };
  if (castShadow) {
    uniforms.uShadowMap = shared.uShadowMap;
    uniforms.uShadowMatrix = shared.uShadowMatrix;
    uniforms.uShadowStrength = shared.uShadowStrength;
    uniforms.uShadowTexel = shared.uShadowTexel;
    uniforms.uShadowCenter = shared.uShadowCenter;
  }
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: PLANET_VERT,
    fragmentShader: PLANET_FRAG,
    defines,
    side,
    uniforms,
  });
}


// ===== geometry library (ported from the parent project) =====================

const _ni = (g) => (g.index ? g.toNonIndexed() : g);

function bakeColor(geo, rgb) {
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[3 * i] = rgb[0]; col[3 * i + 1] = rgb[1]; col[3 * i + 2] = rgb[2]; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

function mergeColored(parts) {
  parts = parts.map((q) => ({ geo: _ni(q.geo), color: q.color }));
  let n = 0; for (const q of parts) n += q.geo.attributes.position.count;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3); let o = 0;
  for (const q of parts) {
    const a = q.geo.attributes.position.array, m = q.geo.attributes.position.count;
    pos.set(a, o * 3);
    for (let i = 0; i < m; i++) {
      col[(o + i) * 3] = q.color[0]; col[(o + i) * 3 + 1] = q.color[1]; col[(o + i) * 3 + 2] = q.color[2];
    }
    o += m;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

// merge geometries that ALREADY carry a baked 'color' attribute
function mergeWithColors(geos) {
  geos = geos.map(_ni);
  let n = 0; for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3); let o = 0;
  for (const g of geos) {
    const m = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += m;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

function makeNoiseLumper(noise) {
  // lumpy icosahedron: displaced by a smooth function of DIRECTION so duplicated
  // corners move together (no tears) -> a unique faceted blob.
  return function lumpIcosa(radius, amp, off) {
    const g = new THREE.IcosahedronGeometry(radius, 0);
    const pa = g.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
      const r = Math.hypot(x, y, z) || 1, nx = x / r, ny = y / r, nz = z / r;
      const f = 1 + amp * noise.fbm(nx * 1.8 + ny * 0.9 + off, nz * 1.8 - ny * 0.7 + off, 2);
      pa.setXYZ(i, x * f, y * f, z * f);
    }
    return _ni(g);
  };
}

const _vA = new THREE.Vector3(), _vUp = new THREE.Vector3(0, 1, 0);
const _mR = new THREE.Matrix4(), _qR = new THREE.Quaternion();
function strut(ax, ay, az, bx, by, bz, r0, r1) {
  const dx = bx - ax, dy = by - ay, dz = bz - az, h = Math.hypot(dx, dy, dz) || 1e-3;
  const g = new THREE.CylinderGeometry(r1, r0, h, 5); g.translate(0, h / 2, 0);
  _vA.set(dx / h, dy / h, dz / h); _qR.setFromUnitVectors(_vUp, _vA);
  g.applyMatrix4(_mR.makeRotationFromQuaternion(_qR)); g.translate(ax, ay, az);
  return _ni(g);
}

function makeBladeGeometry(tint) {
  const levels = [
    { y: 0.00, w: 0.046, b: 0.000, shade: 0.55 },
    { y: 0.15, w: 0.034, b: 0.025, shade: 0.78 },
    { y: 0.28, w: 0.020, b: 0.070, shade: 0.96 },
    { y: 0.40, w: 0.000, b: 0.130, shade: 1.12 },
  ];
  const p = [], col = [];
  const push = (a, side) => {
    p.push(side * a.w / 2, a.y, a.b);
    col.push(tint[0] * a.shade, tint[1] * a.shade, tint[2] * a.shade);
  };
  for (let i = 0; i < levels.length - 1; i++) {
    const lo = levels[i], hi = levels[i + 1];
    push(lo, -1); push(lo, 1); push(hi, 1);
    push(lo, -1); push(hi, 1); push(hi, -1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  return g;
}

function makeTreeVariant(seed, lumpIcosa) {
  const r = mulberry32(seed), parts = [];
  const greens = ['#3f8a3c', '#4e9b45', '#5da84b', '#62b04f', '#56a049', '#6ab057'];
  const brown = linRGB('#7a5232'), brown2 = linRGB('#6b4a2c');
  const trunk = new THREE.CylinderGeometry(0.13, 0.22, 2.1, 6); trunk.translate(0, 1.05, 0);
  parts.push({ geo: trunk, color: brown });
  const nB = 4 + Math.floor(r() * 2), blobs = [];
  for (let i = 0; i < nB; i++) {
    const ang = r() * Math.PI * 2, rad = 0.28 + r() * 0.6;
    const bx = Math.cos(ang) * rad, by = 2.4 + r() * 1.15, bz = Math.sin(ang) * rad;
    const g = lumpIcosa(0.9 + r() * 0.55, 0.2, r() * 60); g.scale(1, 0.92, 1); g.translate(bx, by, bz);
    parts.push({ geo: g, color: linRGB(greens[Math.floor(r() * greens.length)]) });
    blobs.push([bx, by, bz]);
  }
  for (let i = 0, nS = 2 + Math.floor(r() * 2); i < nS; i++) {
    const b = blobs[Math.floor(r() * blobs.length)];
    parts.push({ geo: strut(0, 1.7, 0, b[0] * 0.7, b[1] - 0.3, b[2] * 0.7, 0.05, 0.09), color: brown2 });
  }
  return mergeColored(parts);
}

function makeBushVariant(seed, lumpIcosa, greenHex) {
  const r = mulberry32(seed), parts = [];
  const green = linRGB(greenHex);
  for (let i = 0; i < 3; i++) {
    const ang = r() * Math.PI * 2, rad = i === 0 ? 0 : 0.16 + r() * 0.2;
    const g = lumpIcosa(0.3 + r() * 0.18, 0.24, r() * 60); g.scale(1, 0.74, 1);
    g.translate(Math.cos(ang) * rad, 0.2 + r() * 0.14, Math.sin(ang) * rad);
    parts.push({ geo: g, color: green });
  }
  return mergeColored(parts);
}

function makeFlowerVariant(bloomHex) {
  const r = mulberry32(5151), parts = [];
  const stem = new THREE.CylinderGeometry(0.008, 0.015, 0.2, 4); stem.translate(0, 0.1, 0);
  parts.push({ geo: stem, color: linRGB('#4a7d39') });
  const blades = ['#5aa04a', '#69b257', '#4f9a44'];
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + r() * 0.6, h = 0.08 + r() * 0.06, w = 0.018;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const pp = new Float32Array([-w * dz, 0, w * dx, w * dz, 0, -w * dx, dx * 0.05, h, dz * 0.05]);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pp, 3));
    parts.push({ geo: g, color: linRGB(blades[i % 3]) });
  }
  const bloom = new THREE.IcosahedronGeometry(0.06, 0); bloom.translate(0, 0.22, 0);
  parts.push({ geo: bloom, color: linRGB(bloomHex) });
  return mergeColored(parts);
}

function gableRoofGeometry(w, d, h) {
  const A = [-w / 2, 0, -d / 2], B = [w / 2, 0, -d / 2];
  const C = [w / 2, 0, d / 2], D = [-w / 2, 0, d / 2];
  const P = [0, h, -d / 2], Q = [0, h, d / 2];
  const tris = [
    A, P, Q, A, Q, D, B, C, Q, B, Q, P,
    A, B, P, C, D, Q, A, B, C, A, C, D,
  ].flat();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris), 3));
  return g;
}

// Give a non-indexed geometry a flat per-face normal, each flipped to point AWAY
// from a local reference centre. Robust to inconsistent triangle winding (the
// hand-built roof had some), so convex-ish props shade and don't drop faces.
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _fn = new THREE.Vector3();
const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vc = new THREE.Vector3(), _ctr = new THREE.Vector3();
function outwardNormals(geo, cx = 0, cy = 0, cz = 0) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 3) {
    _va.fromBufferAttribute(pos, i); _vb.fromBufferAttribute(pos, i + 1); _vc.fromBufferAttribute(pos, i + 2);
    _e1.subVectors(_vb, _va); _e2.subVectors(_vc, _va);
    _fn.crossVectors(_e1, _e2).normalize();
    _ctr.set((_va.x + _vb.x + _vc.x) / 3 - cx, (_va.y + _vb.y + _vc.y) / 3 - cy, (_va.z + _vb.z + _vc.z) / 3 - cz);
    if (_fn.dot(_ctr) < 0) _fn.multiplyScalar(-1);
    for (let k = 0; k < 3; k++) { out[3 * (i + k)] = _fn.x; out[3 * (i + k) + 1] = _fn.y; out[3 * (i + k) + 2] = _fn.z; }
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return geo;
}

// ===== the world =============================================================

export function createWorld(scene, opts = {}) {
  const LOW = !!opts.lowDetail;
  const CAST = !LOW;                 // directional sun-cast shadows: desktop only
  const renderer = opts.renderer || null; // needed for the shadow depth pre-pass
  // The active flat-manifold topology. Defaults to T^3 so existing callers (and
  // the headless harness) are unchanged; main.js passes the URL-selected one. Its
  // latticeMatricesFn enumerates the deck group (copies + gravity image sum), so
  // swapping the topology swaps the tiling and the gravity field together.
  const topology = opts.topology || getTopology('torus');
  const latticeFn = topology.latticeMatricesFn;
  const noise = createNoise(20260619);
  const rand = mulberry32(4242);
  const lumpIcosa = makeNoiseLumper(noise);

  const FOG_COLOR = 0xbcdcf2; // sky blue (the background / horizon tone)
  // Density is tied to the cell size so the look survives any cube resize: the
  // copies always read at ~79% / 40% / 13% through successive walls and the 4th
  // (~2.5%) is gone. The constant is set so the 3rd copy (distance 3·PERIOD)
  // sits at ~13%; halving the cube doubles the density automatically.
  const FOG_DENSITY = 0.476 / PERIOD;
  const shared = makeSharedUniforms(FOG_COLOR, FOG_DENSITY);
  const ORIGIN = new THREE.Vector3(0, 0, 0);

  // A solid sky-blue surround (no privileged "up", so no vertical gradient) plus
  // matching exponential haze: the stock materials (clouds, water, edge cage)
  // fade through scene.fog while the custom planet material reproduces the same
  // FogExp2 falloff in its own shader, so everything dissolves into the same blue.
  scene.background = new THREE.Color(FOG_COLOR);
  scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

  // Everything fixed to the planet's surface lives under one group, so the planet
  // turns as a rigid body. The impostor copies are NOT in it (each turns about
  // its own centre, applied per-instance); birds fly in world space; the sky and
  // edge cage do not turn. Gravity is unaffected (it is a sum of point masses).
  const planetGroup = new THREE.Group();
  planetGroup.frustumCulled = false;
  scene.add(planetGroup);
  const SPIN_AXIS = new THREE.Vector3(0.15, 1, 0.1).normalize();
  const SPIN_RATE = 0.02; // rad/s — slow (~5 min per revolution)
  let planetSpin = 0;
  const planetQuat = new THREE.Quaternion();
  const planetQuatInv = new THREE.Quaternion();

  // ---- planet shape: radius field on the sphere ----------------------------
  const R0 = 50;          // base radius (100 m diameter)
  const HILL = 10;        // max hill height
  const ROAD_HALF = 0.10; // road half-width, radians (~5 m arc on a 50 m planet)
  const POND = { dir: new THREE.Vector3(0.35, 0.62, -0.70).normalize(), ang: 0.34 };
  const HOUSE = { dir: new THREE.Vector3(-0.15, 0.36, 0.92).normalize() };
  POND.cosAng = Math.cos(POND.ang);
  const WATER_DROP = 3.2;       // how far the pond floor dips below the rim level
  const WATER_LEVEL = R0 - 0.2; // water surface radius (raised 1 m from v1)

  // ---- chiral pond: a "P"-shaped lake --------------------------------------
  // The pond is shaped like a letter P so its handedness is visible: in any
  // mirror-reversed copy of the planet (the non-orientable cells, or a copy whose
  // deck matrix has det < 0) the P reads back-to-front, an immediate cue that you
  // have flipped orientation. A tangent frame at POND.dir turns a surface
  // direction into pond-local 2D coords (s = right, t = up), and a signed-distance
  // glyph marks the water (sdf < 0 inside). Everything downstream — the terrain
  // bowl, the sand rim, the vegetation mask, the water surface — is driven by this
  // one function, so they always agree.
  POND.up = new THREE.Vector3(0, 1, 0).projectOnPlane(POND.dir);
  if (POND.up.lengthSq() < 1e-4) POND.up.set(1, 0, 0).projectOnPlane(POND.dir);
  POND.up.normalize();
  POND.right = new THREE.Vector3().crossVectors(POND.up, POND.dir).normalize();
  POND.span = POND.ang * 0.92;   // glyph half-extent in radians (inside POND.ang)
  // 2D signed distance to a filled "P" drawn in a [-1,1]^2 box (s right, t up).
  // Units are box-normalized; multiply by POND.span for an angular distance.
  function sdfP(s, t) {
    // rounded-rectangle SDF helper
    const segBox = (px, py, hx, hy, r) => {
      const dx = Math.abs(px) - hx + r, dy = Math.abs(py) - hy + r;
      const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
      return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
    };
    // vertical stem on the left
    const stem = segBox(s + 0.42, t, 0.20, 0.78, 0.12);
    // the bowl of the P: an annulus (ring) on the upper right, closed to the stem
    const cx = 0.10, cy = 0.40, R = 0.50, thick = 0.20;
    const ring = Math.abs(Math.hypot(s - cx, t - cy) - R) - thick;
    // keep only the right ~3/4 of the ring (open toward the stem side it joins)
    const ringHalf = Math.max(ring, -(s - (cx - R - thick)) - 0.0); // trim far-left lobe
    // a short bar joining the bowl's lower end back to the stem (closes the P)
    const join = segBox(s + 0.06, t + 0.02, 0.34, 0.18, 0.10);
    return Math.min(stem, Math.min(ringHalf, join));
  }
  // signed angular distance from a planet-local direction to the pond glyph edge
  // (negative inside the water). Returns a large value outside the glyph's box.
  function pondSDF(n) {
    const d = _pondTmp.copy(n).sub(_pv.copy(POND.dir).multiplyScalar(n.dot(POND.dir)));
    const s = d.dot(POND.right) / POND.span;
    const t = d.dot(POND.up) / POND.span;
    // fall back to a plain radius outside the glyph box so distant tests are cheap
    if (Math.abs(s) > 1.6 || Math.abs(t) > 1.6) return POND.ang * 2.0;
    return sdfP(s, t) * POND.span;
  }
  const _pondTmp = new THREE.Vector3();
  const _pv = new THREE.Vector3();

  // a volcano region (stand-in, stylised): a cone raised in surfaceRadius with a
  // small crater bowl carved into the summit, an ash/rock biome tinted in
  // colorAt, vegetation cleared from it, and a periodic rising plume (built far
  // below). Direction validated headless to be clear of the pond, road and house.
  const VOLCANO = {
    dir: new THREE.Vector3(0.6222, -0.3011, 0.7226).normalize(),
    ang: 0.28,           // angular radius of the cone base (~14 m arc on R0=50): a tight cone
    height: 12,          // rim height above R0 (visible peak ~ R0 + 12): a small cinder cone (was 8)
    craterFrac: 0.34,    // crater-rim radius as a fraction of ang
    craterDepth: 4,      // shallow crater bowl carved below the rim
  };
  VOLCANO.craterAng = VOLCANO.ang * VOLCANO.craterFrac;
  VOLCANO.summitRadius = R0 + VOLCANO.height + 1; // conservative upper bound (tests)
  // bare ash/rock biome a bit wider than the cone; vegetation cleared (clearOf),
  // road swerves around it (roadLat).
  const ASH_ANG = VOLCANO.ang * 1.5;
  const VOLC_LON = Math.atan2(VOLCANO.dir.z, VOLCANO.dir.x);
  const VOLC_LAT = Math.asin(Math.max(-1, Math.min(1, VOLCANO.dir.y)));

  // ===========================================================================
  // GRAVITY IN A 3-TORUS, AND WHY WE TRUNCATE  (the Ewald / Jeans-swindle story)
  // ---------------------------------------------------------------------------
  // We want the Newtonian field of the planet AS FELT INSIDE the closed manifold.
  // In the universal cover that means the source is not one mass but its whole
  // deck-group orbit: a copy of the planet at every lattice point g(0), g in Gamma.
  // The honest field is therefore the lattice sum
  //
  //     g(r) = -grad phi(r),   phi(r) = -G M  Sum_n  1 / |r - r_n| ,
  //
  // over all images r_n. The subtlety a physicist will expect: this sum does NOT
  // converge. The potential sum diverges and the force sum is only conditionally
  // convergent — its value depends on the order/shape in which you add the shells.
  // The reason is the monopole: a 3-torus has a single sign of mass and no way to
  // satisfy Poisson's equation periodically, because integrating div g over the
  // (boundaryless) torus forces the enclosed mass to be zero. A net mass in a
  // periodic box has no consistent periodic field.
  //
  // The standard fix is the cosmologist's "Jeans swindle", made rigorous as EWALD
  // SUMMATION: add a uniform neutralising background of density -M/V_cell (a
  // "jellium"), so the cell is charge/mass neutral and Poisson is solvable. One
  // then splits each 1/r into a short-range piece summed in real space and a
  // smooth piece summed over reciprocal-lattice vectors (a theta-function split),
  // both exponentially convergent. THAT is the physically exact, exactly periodic
  // field of a mass-in-a-box, and if we ever want the "true" T^3 potential (or a
  // case where the background matters), that is the object to compute — once,
  // since for a fixed lattice it is a static vector field and a lookup table would
  // earn its keep.
  //
  // For THIS sim we deliberately do something cruder and better-suited: a finite
  // real-time IMAGE SUM over only the nearby copies (latticeImageCenters, the same
  // centres the renderer draws). This is a feature, not a shortcut:
  //   * The truncation regularises the divergence — a finite, smooth field.
  //   * It is exact in the near field: close to any planet the nearest term
  //     dominates and you get the right 1/r^2 well to fall into / orbit.
  //   * It is topology-robust for free: swap the lattice/holonomy and both the
  //     copies and the gravity update together, with no re-derivation or LUT.
  //   * It is cheap: a few hundred inverse-square terms per frame is nothing.
  // The price is that it is periodic only to truncation order: at the cell wall,
  // midway between two equal planets, the normal pull should cancel exactly but a
  // far unpaired shell leaves a small residual (~2% of surface g — see
  // tools/verify_geometry.py). That is precisely the conditional-convergence
  // ambiguity above, and it is dynamically negligible for a faint, for-feel field.
  // If realism ever demands it, replace gravityAt with a precomputed Ewald field.
  // ===========================================================================
  const G_SURFACE = 5.0;                 // m/s^2 at the surface (faint; tunable)
  const GM = G_SURFACE * R0 * R0;
  const GRAV_DEPTH = 3;                  // images summed (matches the rendered copies)
  const GRAV_CENTERS = latticeImageCenters(GRAV_DEPTH, latticeFn);
  const GRAV_MINR2 = (R0 * 0.5) * (R0 * 0.5); // soften inside the planet
  const _gd = new THREE.Vector3();
  function gravityAt(out, p) {
    out.set(0, 0, 0);
    for (let i = 0; i < GRAV_CENTERS.length; i++) {
      _gd.subVectors(GRAV_CENTERS[i], p);
      let r2 = _gd.lengthSq();
      if (r2 < GRAV_MINR2) r2 = GRAV_MINR2;
      out.addScaledVector(_gd, GM / (r2 * Math.sqrt(r2)));
    }
    return out;
  }

  // road centreline: a wavy circle about the planet's spin (y) axis. For a unit
  // direction n, longitude = atan2(z, x); the road sits at this signed latitude.
  const roadLatBase = (lon) => 0.22 * Math.sin(lon) + 0.12 * Math.sin(2 * lon + 1.3) + 0.06 * Math.sin(3 * lon + 0.4);
  // bend the road away from the volcano's ash field: a Gaussian swerve in latitude
  // centred on the volcano's longitude, so the track never runs over the rock.
  const ROAD_SWERVE_AMP = 0.36, ROAD_SWERVE_SIG = 0.5;
  const ROAD_SWERVE_DIR = (roadLatBase(VOLC_LON) - VOLC_LAT) >= 0 ? 1 : -1;
  const roadLat = (lon) => {
    let d = lon - VOLC_LON; d = Math.atan2(Math.sin(d), Math.cos(d));
    const swerve = ROAD_SWERVE_DIR * ROAD_SWERVE_AMP * Math.exp(-(d * d) / (2 * ROAD_SWERVE_SIG * ROAD_SWERVE_SIG));
    return roadLatBase(lon) + swerve;
  };
  function roadDist(n) {
    const lon = Math.atan2(n.z, n.x);
    const lat = Math.asin(Math.max(-1, Math.min(1, n.y)));
    return Math.abs(lat - roadLat(lon)); // angular distance to the centreline
  }
  function pondDist(n) { return Math.acos(Math.max(-1, Math.min(1, n.dot(POND.dir)))); }
  function volcanoDist(n) { return Math.acos(Math.max(-1, Math.min(1, n.dot(VOLCANO.dir)))); }

  // smooth hill field over the sphere (a couple of fbm octaves of the direction)
  function hills(nx, ny, nz) {
    const f = noise.fbm(nx * 2.1 + ny * 0.7, nz * 2.1 - ny * 0.5, 4) * 0.62
            + noise.fbm(ny * 2.4 + nz * 0.6 + 13, nx * 2.4 - nz * 0.4 + 13, 3) * 0.38;
    return (f * 0.5 + 0.5) * HILL;
  }

  // full surface radius at a direction (hills, road groove, pond bowl)
  const _n = new THREE.Vector3();
  function surfaceRadius(nx, ny, nz) {
    _n.set(nx, ny, nz);
    let h = R0 + hills(nx, ny, nz);
    const rd = roadDist(_n);
    h -= 0.55 * (1 - smoothstep(ROAD_HALF * 0.6, ROAD_HALF * 1.8, rd)); // shallow groove
    const pd = pondSDF(_n);
    // shape the pond: a flat floor well BELOW the water inside the glyph, and a
    // narrow rim just OUTSIDE the edge pulled down to ~water level so the
    // surrounding hills never poke up through the surface and hide the water.
    if (pd < POND.span * 0.6) {
      const FLOOR = WATER_LEVEL - 4.0;                            // pond bottom (below water)
      const RIM = WATER_LEVEL + 0.4;                             // shoreline height
      if (pd < 0) {
        const k = smoothstep(0, -POND.span * 0.18, pd);          // reach full depth quickly
        h = lerp(RIM, FLOOR, k);
      } else {
        // just outside the edge: blend the (possibly hilly) terrain down to the rim
        const k = 1 - smoothstep(0, POND.span * 0.6, pd);
        h = lerp(h, RIM, k);
      }
    }
    // volcano: a clean cone (full near the summit, faded to terrain at the base)
    // with a shallow crater bowl carved into the top. Blended over the local
    // hills with a max() so the cone always rises above them.
    const vd = volcanoDist(_n);
    if (vd < VOLCANO.ang) {
      const x = vd / VOLCANO.ang;                                // 0 axis -> 1 base
      // straight outer slope (a true cone) + a shallow crater bowl at the top
      const outer = VOLCANO.height * Math.max(0, Math.min(1, (1 - x) / (1 - VOLCANO.craterFrac)));
      const inner = VOLCANO.craterDepth * Math.max(0, Math.min(1, 1 - x / VOLCANO.craterFrac));
      const coneR = R0 + outer - inner;
      const w = 1 - smoothstep(0.7, 1.0, x);                     // merge the cone base into the hills
      h = lerp(h, Math.max(h, coneR), w);
    }
    return h;
  }
  // public form taking a Vector3 (used by the controller's collision). The planet
  // turns, so a world direction is first brought into the planet's own frame.
  const _rdir = new THREE.Vector3();
  function radiusAtDir(v) {
    _rdir.copy(v).applyQuaternion(planetQuatInv);
    return surfaceRadius(_rdir.x, _rdir.y, _rdir.z);
  }

  // vertex colour at a direction
  const cGrassA = new THREE.Color('#74b84a'), cGrassB = new THREE.Color('#9fce5a');
  const cDirt = new THREE.Color('#bd9362'), cSand = new THREE.Color('#cdb583');
  const cRock = new THREE.Color('#8b8d94'), cRockTone = new THREE.Color('#7a8472');
  const cAsh = new THREE.Color('#4a4540'), cLava = new THREE.Color('#d2532a');
  const _c = new THREE.Color();
  function colorAt(nx, ny, nz, slope) {
    _n.set(nx, ny, nz);
    _c.copy(cGrassA).lerp(cGrassB, 0.5 + 0.5 * noise.fbm(nx * 4.0, nz * 4.0, 2));
    // rocky tone on the steepest hill flanks
    _c.lerp(cRock, 0.85 * smoothstep(0.85, 1.7, slope));
    _c.lerp(cRockTone, 0.4 * smoothstep(6, 9.5, hills(nx, ny, nz)));
    // dirt road
    const rd = roadDist(_n);
    _c.lerp(cDirt, 0.9 * (1 - smoothstep(ROAD_HALF * 0.7, ROAD_HALF * 1.6, rd)));
    // sandy pond rim: a band straddling the glyph edge (sdf ≈ 0)
    const pd = pondSDF(_n);
    _c.lerp(cSand, (1 - smoothstep(0, POND.span * 0.30, Math.abs(pd))) * (pd > -POND.span * 0.15 ? 1 : 0.6));
    // volcano: dark ash/rock over the cone, with a warm glow at the crater rim
    const vd = volcanoDist(_n);
    if (vd < ASH_ANG) {
      const ashW = 1 - smoothstep(VOLCANO.ang * 0.85, ASH_ANG, vd);
      _c.lerp(cAsh, 0.92 * ashW);
      const rim = smoothstep(VOLCANO.craterAng * 0.2, VOLCANO.craterAng, vd)
                * (1 - smoothstep(VOLCANO.craterAng, VOLCANO.craterAng * 2.4, vd));
      _c.lerp(cLava, 0.42 * rim);
    }
    return _c;
  }

  // slope estimate: gradient of surfaceRadius across two tangent directions
  const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _yAx = new THREE.Vector3(0, 1, 0), _xAx = new THREE.Vector3(1, 0, 0);
  const _na = new THREE.Vector3(), _nb = new THREE.Vector3();
  function slopeAt(nx, ny, nz) {
    _n.set(nx, ny, nz);
    const ref = Math.abs(ny) > 0.95 ? _xAx : _yAx;
    _t1.crossVectors(_n, ref).normalize();
    _t2.crossVectors(_n, _t1).normalize();
    const eps = 0.02, r0 = surfaceRadius(nx, ny, nz);
    _na.copy(_n).addScaledVector(_t1, eps).normalize();
    _nb.copy(_n).addScaledVector(_t2, eps).normalize();
    const d1 = surfaceRadius(_na.x, _na.y, _na.z) - r0;
    const d2 = surfaceRadius(_nb.x, _nb.y, _nb.z) - r0;
    return Math.hypot(d1, d2) / (eps * R0);
  }

  // true outward normal of the displaced surface (so objects can lie flush on a
  // slope instead of perpendicular to the radius, which is what makes flat-based
  // props look like they hover). Cross product of two tangent surface deltas.
  const _sp0 = new THREE.Vector3(), _spa = new THREE.Vector3(), _spb = new THREE.Vector3();
  const _sv1 = new THREE.Vector3(), _sv2 = new THREE.Vector3(), _snorm = new THREE.Vector3();
  function surfaceNormal(nx, ny, nz) {
    _n.set(nx, ny, nz);
    const ref = Math.abs(ny) > 0.95 ? _xAx : _yAx;
    _t1.crossVectors(_n, ref).normalize();
    _t2.crossVectors(_n, _t1).normalize();
    const eps = 0.02, r0 = surfaceRadius(nx, ny, nz);
    _sp0.copy(_n).multiplyScalar(r0);
    _na.copy(_n).addScaledVector(_t1, eps).normalize();
    _nb.copy(_n).addScaledVector(_t2, eps).normalize();
    _spa.copy(_na).multiplyScalar(surfaceRadius(_na.x, _na.y, _na.z));
    _spb.copy(_nb).multiplyScalar(surfaceRadius(_nb.x, _nb.y, _nb.z));
    _sv1.subVectors(_spa, _sp0); _sv2.subVectors(_spb, _sp0);
    _snorm.crossVectors(_sv1, _sv2).normalize();
    if (_snorm.dot(_n) < 0) _snorm.multiplyScalar(-1);
    return _snorm;
  }

  // ---- terrain mesh --------------------------------------------------------
  function buildTerrainGeometry(detail, withSmoothN = false) {
    const g = new THREE.IcosahedronGeometry(R0, detail);
    const pos = g.attributes.position;
    const n = pos.count;
    const col = new Float32Array(n * 3);
    const snr = withSmoothN ? new Float32Array(n * 3) : null;
    for (let i = 0; i < n; i++) {
      let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const inv = 1 / Math.hypot(x, y, z);
      const nx = x * inv, ny = y * inv, nz = z * inv;
      const r = surfaceRadius(nx, ny, nz);
      pos.setXYZ(i, nx * r, ny * r, nz * r);
      const sl = slopeAt(nx, ny, nz);
      const c = colorAt(nx, ny, nz, sl);
      col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b;
      if (snr) { const sn = surfaceNormal(nx, ny, nz); snr[3 * i] = sn.x; snr[3 * i + 1] = sn.y; snr[3 * i + 2] = sn.z; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (snr) g.setAttribute('aSmoothN', new THREE.BufferAttribute(snr, 3));
    g.deleteAttribute('normal');
    return g;
  }

  // THREE subdivides each icosa face into (detail+1)^2 triangles (NOT 4^detail),
  // so these stay modest. The central planet is the one you walk on, so it gets
  // enough resolution to round the silhouette and to carry the vertex-painted
  // contact shadows (a 2 m shadow needs vertices closer than ~2 m to land on);
  // the distant copies stay coarse since there are many of them in the haze.
  // Desktop is subdivided once more (detail 69 ~= 2*34+1, so ~4x the facets) for
  // a rounder limb and a finer per-vertex AO gradient; this also ~4x's the
  // one-time AO bake over the planet's vertices (a slower load) - dial it back
  // toward 34 if the load hitches. Mobile stays coarse at 18.
  const terrainGeo = buildTerrainGeometry(LOW ? 18 : 69, true);
  const terrainMat = makePlanetMaterial(shared, { center: ORIGIN, castShadow: CAST, smoothLight: true });
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.frustumCulled = false;
  planetGroup.add(terrain);

  // Sample the ACTUAL rendered surface (the displaced icosphere) along a
  // direction. Objects used to be placed on the analytic surfaceRadius, which
  // bulges above the faceted mesh between vertices and makes things float at
  // convex silhouettes; placing on the mesh kills that. A direction-binned
  // triangle grid makes each lookup hit only a handful of ray-triangle tests.
  function buildGroundSampler(geo) {
    const P = geo.attributes.position.array;
    const triCount = (geo.attributes.position.count / 3) | 0;
    const NLAT = 128, NLON = 256;
    const bins = new Array(NLAT * NLON);
    for (let i = 0; i < bins.length; i++) bins[i] = [];
    const binIdx = (x, y, z) => {
      const r = Math.hypot(x, y, z) || 1;
      const lat = Math.acos(Math.max(-1, Math.min(1, y / r)));
      let lon = Math.atan2(z, x); if (lon < 0) lon += Math.PI * 2;
      const li = Math.min(NLAT - 1, (lat / Math.PI * NLAT) | 0);
      const lj = Math.min(NLON - 1, (lon / (Math.PI * 2) * NLON) | 0);
      return li * 1000 + lj;
    };
    const add = (li, lj, t) => {
      for (let a = -1; a <= 1; a++) {
        const ii = li + a; if (ii < 0 || ii >= NLAT) continue;
        for (let b = -1; b <= 1; b++) {
          let jj = (lj + b) % NLON; if (jj < 0) jj += NLON;
          bins[ii * NLON + jj].push(t);
        }
      }
    };
    for (let t = 0; t < triCount; t++) {
      const o = 9 * t;
      for (let k = 0; k < 3; k++) {
        const e = binIdx(P[o + 3 * k], P[o + 3 * k + 1], P[o + 3 * k + 2]);
        add((e / 1000) | 0, e % 1000, t);
      }
    }
    // ray from the origin along unit (dx,dy,dz) vs triangle t -> distance, or -1
    function rayTri(dx, dy, dz, t) {
      const o = 9 * t;
      const ax = P[o], ay = P[o + 1], az = P[o + 2];
      const e1x = P[o + 3] - ax, e1y = P[o + 4] - ay, e1z = P[o + 5] - az;
      const e2x = P[o + 6] - ax, e2y = P[o + 7] - ay, e2z = P[o + 8] - az;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-9 && det < 1e-9) return -1;
      const inv = 1 / det;
      const tx = -ax, ty = -ay, tz = -az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < -1e-4 || u > 1.0001) return -1;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < -1e-4 || u + v > 1.0001) return -1;
      const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
      return s > 0 ? s : -1;
    }
    return function groundRadius(dx, dy, dz) {
      const inv = 1 / (Math.hypot(dx, dy, dz) || 1);
      dx *= inv; dy *= inv; dz *= inv;
      const e = binIdx(dx, dy, dz);
      const list = bins[(((e / 1000) | 0)) * NLON + (e % 1000)];
      let best = -1;
      for (let i = 0; i < list.length; i++) {
        const s = rayTri(dx, dy, dz, list[i]);
        if (s > 0 && (best < 0 || s < best)) best = s;
      }
      return best > 0 ? best : surfaceRadius(dx, dy, dz);
    };
  }
  const groundRadius = buildGroundSampler(terrainGeo);

  // soft contact shadows are baked into the terrain's own vertex colours (no
  // hovering decals) — collected here, painted in after everything is placed
  const shadowCasters = [];
  const _scp = new THREE.Vector3();
  function castShadows(spots, footprint, strength) {
    for (const n of spots) {
      const r = groundRadius(n.x, n.y, n.z);
      _scp.copy(n).multiplyScalar(r);
      shadowCasters.push({ x: _scp.x, y: _scp.y, z: _scp.z, rad: footprint, r2: footprint * footprint, str: strength });
    }
  }
  function paintGroundShadows() {
    if (!shadowCasters.length) return;
    const pos = terrainGeo.attributes.position, col = terrainGeo.attributes.color, N = pos.count;
    for (let i = 0; i < N; i++) {
      const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
      let darken = 1;
      for (let c = 0; c < shadowCasters.length; c++) {
        const s = shadowCasters[c];
        const dx = vx - s.x, dy = vy - s.y, dz = vz - s.z, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < s.r2) {
          const tt = Math.sqrt(d2) / s.rad;           // 0 centre .. 1 edge
          darken *= 1 - s.str * (1 - smoothstep(0, 1, tt));
        }
      }
      if (darken < 0.999) {
        col.setX(i, col.getX(i) * darken); col.setY(i, col.getY(i) * darken); col.setZ(i, col.getZ(i) * darken);
      }
    }
    col.needsUpdate = true;
  }

  // ---- pond water ----------------------------------------------------------
  let waterMesh = null;
  let waterGeo = null, waterMat = null;   // reused to instance the pond over every copy
  {
    // Tessellate the pond-local box and keep the cells inside the P glyph (sdf<0),
    // projecting each kept vertex onto the sphere at the water radius. This makes
    // the water surface exactly match the chiral bowl carved by pondSDF.
    const NG = LOW ? 36 : 72;                       // grid resolution across the box
    const ext = 1.5;                                // box half-extent in glyph units
    const pos = [], idx = [];
    const rowOf = new Map();
    const vid = (i, j) => i * (NG + 1) + j;
    const tmp = new THREE.Vector3();
    for (let i = 0; i <= NG; i++) {
      for (let j = 0; j <= NG; j++) {
        const s = (i / NG * 2 - 1) * ext, t = (j / NG * 2 - 1) * ext;
        // direction on the sphere = POND.dir rotated by (s,t) along the tangents
        tmp.copy(POND.dir)
          .addScaledVector(POND.right, s * POND.span)
          .addScaledVector(POND.up, t * POND.span)
          .normalize();
        const inside = sdfP(s, t) < 0;
        rowOf.set(vid(i, j), inside);
        pos.push(tmp.x * WATER_LEVEL, tmp.y * WATER_LEVEL, tmp.z * WATER_LEVEL);
      }
    }
    for (let i = 0; i < NG; i++) {
      for (let j = 0; j < NG; j++) {
        const a = vid(i, j), b = vid(i + 1, j), c = vid(i + 1, j + 1), d = vid(i, j + 1);
        // emit a quad only if its whole cell is inside the glyph (clean edge)
        if (rowOf.get(a) && rowOf.get(b) && rowOf.get(c) && rowOf.get(d)) {
          idx.push(a, b, c, a, c, d);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color: 0x3ea7c4, transparent: true, opacity: 0.84, fog: true, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = shared.uTime;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         transformed += normal * (sin(position.x * 1.1 + uTime * 1.3) * 0.05
                                + cos(position.y * 1.4 + uTime * 1.0) * 0.04);`
      );
    };
    const water = new THREE.Mesh(g, mat);
    water.renderOrder = 1;
    water.frustumCulled = false;
    planetGroup.add(water);
    waterMesh = water;
    waterGeo = g; waterMat = mat;
  }

  // ---- scattering on the sphere --------------------------------------------
  function scatterSphere(count, accept) {
    const spots = []; let guard = count * 80;
    while (spots.length < count && guard-- > 0) {
      const u = rand() * 2 - 1, phi = rand() * Math.PI * 2, s = Math.sqrt(Math.max(0, 1 - u * u));
      const n = new THREE.Vector3(s * Math.cos(phi), u, s * Math.sin(phi));
      if (accept(n)) spots.push(n);
    }
    return spots;
  }

  // ---- houses: the original King-Kai cottage plus a few more round the globe.
  // The directions are sampled with a dedicated PRNG (isolated from the main
  // scatter stream), validated headless to stay clear of the road, pond, volcano
  // and one another; cosmetic props (scale / roof / yaw) come from a second PRNG
  // so the chosen directions are independent of them. Vegetation clears all of
  // them (houseDist is the arc to the NEAREST house).
  const HOUSE_ROOFS = ['#8c4a36', '#7d5a3a', '#9a5240', '#6f6347', '#864c52'];
  const HOUSES = [{ dir: HOUSE.dir.clone(), scale: 1.0, roof: '#8c4a36', yaw: 0.7 }];
  {
    const hr = mulberry32(13371);          // directions only (matches headless validation)
    let guard = 28 * 600;
    while (HOUSES.length < 28 && guard-- > 0) {
      const u = hr() * 2 - 1, phi = hr() * Math.PI * 2, s = Math.sqrt(Math.max(0, 1 - u * u));
      const n = new THREE.Vector3(s * Math.cos(phi), u, s * Math.sin(phi));
      if (roadDist(n) <= ROAD_HALF * 1.6 + 0.04) continue;
      if (pondDist(n) <= POND.ang + 0.10) continue;
      if (volcanoDist(n) <= ASH_ANG + 0.06) continue;
      let near = false;
      for (const h of HOUSES) if (n.angleTo(h.dir) < 0.30) { near = true; break; }
      if (near) continue;
      HOUSES.push({ dir: n, scale: 1, roof: '#8c4a36', yaw: 0 }); // props filled below
    }
    const pr = mulberry32(20771);           // cosmetic props, decoupled from the dirs
    for (let i = 1; i < HOUSES.length; i++) {
      HOUSES[i].scale = 0.82 + pr() * 0.5;
      HOUSES[i].roof = HOUSE_ROOFS[Math.floor(pr() * HOUSE_ROOFS.length)];
      HOUSES[i].yaw = pr() * Math.PI * 2;
    }
  }
  const houseDist = (n) => {
    let best = Math.PI;
    for (const h of HOUSES) {
      const a = Math.acos(Math.max(-1, Math.min(1, n.dot(h.dir))));
      if (a < best) best = a;
    }
    return best;
  };
  const clearOf = (roadM, pondM, houseM) => (n) =>
    roadDist(n) > roadM && pondDist(n) > POND.ang + pondM &&
    volcanoDist(n) > ASH_ANG && houseDist(n) > houseM;

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _sc = new THREE.Vector3();
  const _qSpin = new THREE.Quaternion(), _qAlign = new THREE.Quaternion();
  const UP0 = new THREE.Vector3(0, 1, 0);
  // Sit an object on the surface along direction n, standing RADIALLY — local +y
  // points away from the planet centre, so trees/bushes stand vertically. Height
  // comes from the ACTUAL mesh (groundRadius), so nothing floats at silhouettes;
  // a small slope-aware sink tucks flat bases just under the ground.
  function placeMatrix(n, s, spin, footprint = 0) {
    const slope = slopeAt(n.x, n.y, n.z);
    const r = groundRadius(n.x, n.y, n.z);
    const sink = 0.05 + footprint * slope * 0.6;
    _p.copy(n).multiplyScalar(r - sink);
    _qSpin.setFromAxisAngle(UP0, spin);
    _qAlign.setFromUnitVectors(UP0, n);
    _q.copy(_qAlign).multiply(_qSpin);
    _sc.set(s, s, s);
    return _m.compose(_p, _q, _sc);
  }

  function instancedOnSphere(geometry, material, spots, sMin, sMax, footprint = 0) {
    const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
    spots.forEach((n, i) => {
      const s = sMin + rand() * (sMax - sMin);
      mesh.setMatrixAt(i, placeMatrix(n, s, rand() * Math.PI * 2, footprint * s));
    });
    mesh.frustumCulled = false;
    planetGroup.add(mesh);
    return mesh;
  }

  // grass (3 green-tinted blade variants, wind-swayed), only on the real planet
  {
    const acceptGrass = clearOf(ROAD_HALF * 1.3, 0.03, 0.10);
    const centers = scatterSphere(LOW ? 220 : 2480, acceptGrass);
    const tints = [linRGB('#6fb84a'), linRGB('#84c455'), linRGB('#5fa844')];
    const grassMat = tints.map(() => makePlanetMaterial(shared, { center: ORIGIN, instanced: true, sway: true, castShadow: CAST }));
    const geos = tints.map((t) => makeBladeGeometry(t));
    const buckets = [[], [], []];
    const cap = LOW ? 9000 : 104000;
    let total = 0;
    const _t = new THREE.Vector3(), _b = new THREE.Vector3(), _ref = new THREE.Vector3();
    for (const ctr of centers) {
      const k = 12 + Math.floor(rand() * 16);
      _ref.set(0, 1, 0); if (Math.abs(ctr.y) > 0.95) _ref.set(1, 0, 0);
      _t.crossVectors(ctr, _ref).normalize();
      _b.crossVectors(ctr, _t).normalize();
      for (let i = 0; i < k && total < cap; i++) {
        const ang = rand() * Math.PI * 2, rr = Math.sqrt(rand()) * 0.045; // ~2.2 m arc cluster
        const n = ctr.clone().addScaledVector(_t, Math.cos(ang) * rr).addScaledVector(_b, Math.sin(ang) * rr).normalize();
        if (!acceptGrass(n)) continue;
        buckets[Math.floor(rand() * 3)].push(n);
        total++;
      }
    }
    buckets.forEach((spots, i) => { if (spots.length) instancedOnSphere(geos[i], grassMat[i], spots, 0.7, 1.5, 0.05); });
  }

  // trees (4 faceted variants) + blob shadows
  {
    const treeSpots = scatterSphere(LOW ? 78 : 192, clearOf(ROAD_HALF * 1.6 + 0.02, 0.06, 0.14));
    const treeMat = makePlanetMaterial(shared, { center: ORIGIN, instanced: true, castShadow: CAST });
    const seeds = [9001, 9005, 9003, 9004];
    const geos = seeds.map((s) => makeTreeVariant(s, lumpIcosa));
    for (let vi = 0; vi < 4; vi++) {
      const grp = treeSpots.filter((_, i) => i % 4 === vi);
      if (grp.length) instancedOnSphere(geos[vi], treeMat, grp, 0.85, 1.5, 1.2);
    }
    castShadows(treeSpots, 2.6, 0.72);
  }

  // bushes (3 variants) + blobs
  {
    const bushSpots = scatterSphere(LOW ? 180 : 450, clearOf(ROAD_HALF * 1.2, 0.04, 0.10));
    const bushMat = makePlanetMaterial(shared, { center: ORIGIN, instanced: true, castShadow: CAST });
    const geos = ['#2f7a35', '#3c8a3e', '#48953f'].map((h, i) => makeBushVariant(8801 + i, lumpIcosa, h));
    for (let vi = 0; vi < 3; vi++) {
      const grp = bushSpots.filter((_, i) => i % 3 === vi);
      if (grp.length) instancedOnSphere(geos[vi], bushMat, grp, 0.7, 1.5, 0.5);
    }
    castShadows(bushSpots, 1.4, 0.55);
  }

  // flowers (5 bloom colours)
  {
    const flSpots = scatterSphere(LOW ? 120 : 600, clearOf(ROAD_HALF * 1.1, 0.03, 0.08));
    const flMat = makePlanetMaterial(shared, { center: ORIGIN, instanced: true, castShadow: CAST });
    const geos = ['#ffffff', '#ffd34d', '#ff7eb6', '#b48cff', '#ff9d5c'].map((h) => makeFlowerVariant(h));
    for (let vi = 0; vi < 5; vi++) {
      const grp = flSpots.filter((_, i) => i % 5 === vi);
      if (grp.length) instancedOnSphere(geos[vi], flMat, grp, 0.8, 1.4, 0.12);
    }
  }

  // boulders (4 gray-tinted icosa variants) + blobs
  {
    const blSpots = scatterSphere(LOW ? 16 : 38, clearOf(ROAD_HALF * 1.0, 0.02, 0.08));
    const blMat = makePlanetMaterial(shared, { center: ORIGIN, instanced: true, castShadow: CAST });
    const grays = ['#9a9ba1', '#85868d', '#a8a9ad', '#77787f'];
    const geos = grays.map((h) => bakeColor(_ni(new THREE.IcosahedronGeometry(0.7, 1)), linRGB(h)));
    for (let vi = 0; vi < 4; vi++) {
      const grp = blSpots.filter((_, i) => i % 4 === vi);
      if (!grp.length) continue;
      const mesh = new THREE.InstancedMesh(geos[vi], blMat, grp.length);
      grp.forEach((n, i) => {
        const s = 0.6 + rand() * 1.4;
        // align radially (outward), then a small random tilt + yaw so boulders
        // sit naturally; sink along the radius so they look part-buried, not perched
        const qa = new THREE.Quaternion().setFromUnitVectors(UP0, n);
        const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * 0.5, rand() * Math.PI * 2, (rand() - 0.5) * 0.5));
        const q = qa.multiply(tilt);
        const slope = slopeAt(n.x, n.y, n.z);
        const r = groundRadius(n.x, n.y, n.z);
        const p = n.clone().multiplyScalar(r - (0.18 * s + 0.05 + s * slope));
        mesh.setMatrixAt(i, new THREE.Matrix4().compose(p, q, new THREE.Vector3(s, s * 0.85, s)));
      });
      mesh.frustumCulled = false;
      planetGroup.add(mesh);
    }
    castShadows(blSpots, 1.5, 0.57);
  }

  // ---- the houses (King-Kai's cottage and the others) ----------------------
  // collision volumes (spheres snug around each cottage), in the planet's LOCAL
  // frame; clampToObstacles spins them into world each frame.
  const HOUSE_COLLIDERS = [];
  {
    // hard-surface shading: real per-face outward normals + double-sided, so the
    // roof slopes shade right and no face drops out to winding. Shared by all.
    const houseMat = makePlanetMaterial(shared, { center: ORIGIN, vertexNormals: true, side: THREE.DoubleSide, castShadow: CAST });
    // window panes glow a touch (windows read as lit, not flat dark or white)
    const glassMat = makePlanetMaterial(shared, { center: ORIGIN, vertexNormals: true, side: THREE.DoubleSide, castShadow: CAST });
    glassMat.uniforms.uAmbient = { value: 0.8 };
    function buildCottage(house) {
      const g = new THREE.Group();
      const n = house.dir;
      const r = groundRadius(n.x, n.y, n.z);
      // stand the cottage level (radial up), sunk a touch so the walls meet the grass
      g.position.copy(n).multiplyScalar(r - 0.12 * house.scale);
      g.quaternion.setFromUnitVectors(UP0, n);
      g.rotateY(house.yaw);
      g.scale.setScalar(house.scale);
      const part = (geo, color, x, y, z, cx = 0, cy = 0, cz = 0, mat = houseMat) => {
        const ng = _ni(geo);
        bakeColor(ng, linRGB(color));
        outwardNormals(ng, cx, cy, cz);
        const mesh = new THREE.Mesh(ng, mat);
        mesh.position.set(x, y, z);
        g.add(mesh);
        return mesh;
      };
      // walls, roof, chimney (centres are the part's own local centre for outward flip)
      part(new THREE.BoxGeometry(4.2, 2.6, 3.4), '#efe4cd', 0, 1.3, 0, 0, 1.3, 0);
      part(gableRoofGeometry(4.9, 4.0, 1.5), house.roof, 0, 2.6, 0, 0, 0.5, 0);
      part(new THREE.BoxGeometry(0.5, 1.5, 0.5), '#9a9ba1', 1.2, 3.2, 0.5, 1.2, 3.2, 0.5); // chimney
      part(new THREE.BoxGeometry(0.95, 1.7, 0.18), '#5e4128', 0.6, 0.85, 1.66, 0.6, 0.85, 1.66); // door
      // glass panes (front + side), set just proud of the walls
      part(new THREE.BoxGeometry(0.78, 0.78, 0.12), '#86c5e6', -1.2, 1.5, 1.68, -1.2, 1.5, 1.68, glassMat);
      part(new THREE.BoxGeometry(0.12, 0.7, 0.7), '#86c5e6', 2.06, 1.5, -0.4, 2.06, 1.5, -0.4, glassMat);
      planetGroup.add(g);
      castShadows([house.dir], 5.0 * house.scale, 0.80);
    }
    for (const h of HOUSES) buildCottage(h);
    for (const h of HOUSES) {
      const gr = groundRadius(h.dir.x, h.dir.y, h.dir.z);
      HOUSE_COLLIDERS.push({ c: h.dir.clone().multiplyScalar(gr + 1.7 * h.scale), r: 3.0 * h.scale });
    }
  }

  // bake every collected contact shadow into the terrain's vertex colours
  paintGroundShadows();

  // ---- distant copies: one low-detail planet, instanced across the lattice --
  function buildImpostorGeometry(tier = 'far') {
    const near = tier === 'near';
    // the near shell matches the central planet's own terrain LOD (desktop); the
    // far shells stay coarse since there are many of them and the haze hides them
    const det = near ? (LOW ? 18 : 34) : (LOW ? 3 : 4);
    const base = buildTerrainGeometry(det); // colours baked, displaced
    const geos = [_ni(base)];
    // baked low-poly trees at a representative subset of directions (denser near)
    const treeN = near ? (LOW ? 40 : 72) : (LOW ? 22 : 40);
    const r = mulberry32(771);
    const accept = clearOf(ROAD_HALF * 1.6 + 0.02, 0.06, 0.14);
    let placed = 0, guard = treeN * 60;
    const greenL = linRGB('#4e9b45'), brownL = linRGB('#71502f');
    while (placed < treeN && guard-- > 0) {
      const u = r() * 2 - 1, phi = r() * Math.PI * 2, s = Math.sqrt(Math.max(0, 1 - u * u));
      const n = new THREE.Vector3(s * Math.cos(phi), u, s * Math.sin(phi));
      if (!accept(n)) continue;
      placed++;
      const sc = 0.9 + r() * 0.6;
      const trunk = bakeColor(_ni(new THREE.CylinderGeometry(0.18, 0.26, 1.0, 5)), brownL); trunk.translate(0, 0.5, 0);
      const cone = bakeColor(_ni(new THREE.ConeGeometry(1.1, 2.6, 6)), greenL); cone.translate(0, 2.4, 0);
      const M = placeMatrix(n, sc, r() * Math.PI * 2);
      trunk.applyMatrix4(M); cone.applyMatrix4(M);
      geos.push(trunk, cone);
    }
    // blocky houses so the silhouette matches the real planet (the volcano cone
    // is already in surfaceRadius, so the impostor terrain carries it for free)
    for (const house of HOUSES) {
      const n = house.dir;
      const body = bakeColor(_ni(new THREE.BoxGeometry(4.2, 2.6, 3.4)), linRGB('#efe4cd')); body.translate(0, 1.3, 0);
      const roof = bakeColor(gableRoofGeometry(4.9, 4.0, 1.5), linRGB(house.roof)); roof.translate(0, 2.6, 0);
      const r2 = surfaceRadius(n.x, n.y, n.z);
      const q = new THREE.Quaternion().setFromUnitVectors(UP0, n).multiply(new THREE.Quaternion().setFromAxisAngle(UP0, house.yaw));
      const M = new THREE.Matrix4().compose(n.clone().multiplyScalar(r2), q, new THREE.Vector3(house.scale, house.scale, house.scale));
      body.applyMatrix4(M); roof.applyMatrix4(M);
      geos.push(body, roof);
    }
    return mergeWithColors(geos);
  }

  const DEPTH = 3; // copies drawn this many cells out; fog hides the cutoff
  // The distant copies render in two LOD tiers. On desktop the FIRST neighbour
  // shell — the 26 cells at Chebyshev distance 1, i.e. the face-adjacent images
  // AND the edge/corner diagonals — uses the SAME terrain detail as the planet
  // you stand on, because from a cell corner those images sit about as far as
  // your own planet and a coarse impostor there pops against it. Everything past
  // the first shell stays low-detail (the haze swallows the cutoff). Mobile keeps
  // one coarse tier. impostorState.centers stays the FULL copy list either way
  // (the sun, clouds and plume instance over it).
  const impostorState = { meshes: [], centers: [] };
  {
    // DoubleSide: for the non-orientable deck groups some copy matrices have
    // det −1 and their triangles render with INVERTED winding, so a FrontSide
    // impostor would cull to nothing. The fragment shader already rebuilds the
    // outward normal from screen-space derivatives (cross(dFdx,dFdy), then a
    // dot(N,viewDir)<0 → N=−N flip), so lighting stays correct on both faces.
    const impostorMat = makePlanetMaterial(shared, { instanced: true, instanceCenter: true, castShadow: CAST, side: THREE.DoubleSide });
    const allMats = latticeFn(DEPTH);
    const p = new THREE.Vector3();
    for (const M of allMats) impostorState.centers.push(p.clone().setFromMatrixPosition(M));
    const isNear = (M) => {
      const e = M.elements; // pure translations: cell index = translation / period
      const i = Math.round(e[12] / PERIOD), j = Math.round(e[13] / PERIOD), k = Math.round(e[14] / PERIOD);
      return Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) === 1;
    };
    const tiers = LOW
      ? [['far', allMats]]
      : [['near', allMats.filter(isNear)], ['far', allMats.filter((M) => !isNear(M))]];
    for (const [tier, mats] of tiers) {
      if (!mats.length) continue;
      const geo = buildImpostorGeometry(tier);
      const mesh = new THREE.InstancedMesh(geo, impostorMat, mats.length);
      const centers = [];
      mats.forEach((M, i) => { mesh.setMatrixAt(i, M); centers.push(new THREE.Vector3().setFromMatrixPosition(M)); });
      mesh.frustumCulled = false;
      scene.add(mesh);
      impostorState.meshes.push({ mesh, centers });
    }
    // pond water on the COPIES too: the impostor terrain carries the pond BOWL
    // (via radiusAtDir) but not the blue surface, so distant planets read as a
    // dark dimple with no water. Instance the same pond disc at every deck matrix
    // M — the disc rides M's rotation/reflection, so on screw and glide cells the
    // pond is correctly turned or mirror-flipped, which (once the pond is given a
    // chiral shape) is the cue for whether that copy is orientation-reversed.
    if (waterGeo && waterMat) {
      const copyWater = new THREE.InstancedMesh(waterGeo, waterMat, allMats.length);
      allMats.forEach((M, i) => copyWater.setMatrixAt(i, M));
      copyWater.instanceMatrix.needsUpdate = true;
      copyWater.frustumCulled = false;
      copyWater.renderOrder = 1;
      scene.add(copyWater);
    }
  }

  // ---- the sun: a little body on a circular orbit above the clouds ----------
  // Kinematic and MASSLESS — it is a light only, it does not tug on you or the
  // orbits. Its angular speed is the Keplerian circular value for the planet's
  // own gravity, omega = sqrt(GM / r^3) at r = 3 R0, which works out to a ~100 s
  // "day". Every copy of the planet carries its own sun at the same orbital
  // phase (periodicity), so a single shared orbit offset (uSunOffset) lights the
  // whole lattice; the sun meshes are instanced at every cell centre + offset.
  const SUN_R = 3 * R0;
  const SUN_OMEGA = Math.sqrt(GM / (SUN_R * SUN_R * SUN_R));
  const SUN_N = new THREE.Vector3(0.32, 1, 0.08).normalize();      // orbit-plane normal, tilted off the spin axis
  const SUN_E1 = new THREE.Vector3().crossVectors(SUN_N, new THREE.Vector3(0, 0, 1)).normalize();
  const SUN_E2 = new THREE.Vector3().crossVectors(SUN_N, SUN_E1).normalize();
  const SUN_PHASE0 = 0.6;
  const _sunOff = new THREE.Vector3();
  function sunOffsetAt(time) {
    // sun revolves the OPPOSITE way to the planet's spin (negative angular rate)
    const a = SUN_PHASE0 - SUN_OMEGA * time;
    return _sunOff.copy(SUN_E1).multiplyScalar(Math.cos(a) * SUN_R).addScaledVector(SUN_E2, Math.sin(a) * SUN_R);
  }
  const sunState = { mesh: null, glow: null, centers: [] };
  {
    const centers = [ORIGIN.clone(), ...impostorState.centers.map((c) => c.clone())];
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true });
    const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(5.0, 2), sunMat, centers.length);
    mesh.frustumCulled = false;
    scene.add(mesh);
    // soft sun glow: a camera-facing ADDITIVE billboard per copy with a smooth
    // radial falloff (replaces the faceted translucent halo sphere). Placed in
    // the shader at each cell centre + the shared sun offset, so no per-frame
    // matrix work and it stays lattice-periodic.
    const gg = new THREE.InstancedBufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1,-1,0, 1,-1,0, 1,1,0, -1,-1,0, 1,1,0, -1,1,0]), 3));
    const gc = new Float32Array(centers.length * 3);
    centers.forEach((c, i) => { gc[3*i] = c.x; gc[3*i+1] = c.y; gc[3*i+2] = c.z; });
    gg.setAttribute('aCellCenter', new THREE.InstancedBufferAttribute(gc, 3));
    gg.instanceCount = centers.length;
    const glowMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uSunOffset: shared.uSunOffset, uSize: { value: 26.0 }, uGlow: { value: new THREE.Color(0xffdc5c) } },
      vertexShader: `precision highp float;
in vec3 position; in vec3 aCellCenter;
uniform mat4 modelMatrix, viewMatrix, projectionMatrix; uniform vec3 uSunOffset; uniform float uSize;
out vec2 vC;
void main(){
  vec2 c = position.xy; vC = c;
  // glow CENTRE rides the scene matrix (parity-mirror); quad stays camera-facing
  vec3 base = (modelMatrix * vec4(aCellCenter + uSunOffset, 1.0)).xyz;
  vec3 camR = vec3(viewMatrix[0].x, viewMatrix[1].x, viewMatrix[2].x);
  vec3 camU = vec3(viewMatrix[0].y, viewMatrix[1].y, viewMatrix[2].y);
  vec3 world = base + (camR * c.x + camU * c.y) * uSize;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`,
      fragmentShader: `precision highp float;
in vec2 vC; uniform vec3 uGlow; out vec4 fragColor;
void main(){
  float d = length(vC);
  float g = pow(max(0.0, 1.0 - d), 2.6);   // soft, blurry radial falloff
  if (g < 0.004) discard;
  fragColor = vec4(uGlow * g, g);
}`,
    });
    const glow = new THREE.Mesh(gg, glowMat);
    glow.frustumCulled = false; glow.renderOrder = 1;
    scene.add(glow);
    sunState.mesh = mesh; sunState.glow = glow; sunState.centers = centers;
  }

  // cloud + plume systems are built further down; declare their state here so the
  // shadow pre-pass (which must hide them) and update() can both reach them.
  const cloudWander = { mesh: null };
  const cloudWeather = { mesh: null, axis: SPIN_AXIS.clone(), rate: 0.012 };
  const plume = { mesh: null };

  // ---- the directional shadow rig (desktop only) ---------------------------
  // One depth map of the CENTRAL planet, rendered from the sun, is sampled by
  // every planet material; a copy subtracts its own centre before projecting, so
  // the single map shadows the whole lattice (the same topology trick the sun and
  // gravity use). The depth pass runs in update() only when a renderer was passed
  // in (the headless harness supplies none, so it skips cleanly). We render the
  // pass with a MeshDepthMaterial override, which both avoids sampling the map we
  // are writing and gives correct depth for the instanced foliage for free.
  const shadowRig = { enabled: CAST, size: CAST ? 3072 : 0, rt: null, cam: null, depthMat: null, frame: 0, lightDir: new THREE.Vector3(0, 1, 0) };
  // weather clouds cast sun shadows on the planet by drawing into the SAME sun
  // depth map, as little spheres (their own depth material), held in this scene.
  const cloudShadowScene = new THREE.Scene();
  if (CAST) {
    const SZ = shadowRig.size;
    const depthTex = new THREE.DepthTexture(SZ, SZ);
    depthTex.type = THREE.UnsignedIntType;
    const rt = new THREE.WebGLRenderTarget(SZ, SZ, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthTexture: depthTex, depthBuffer: true, stencilBuffer: false,
    });
    const half = R0 + 56;   // ortho frame now also encloses the weather-cloud shell (r=88) so clouds cast
    const cam = new THREE.OrthographicCamera(-half, half, half, -half, 1, 4 * SUN_R);
    shadowRig.rt = rt; shadowRig.cam = cam;
    shadowRig.depthMat = new THREE.MeshDepthMaterial();
    shared.uShadowMap.value = depthTex;
    shared.uShadowTexel.value = 1 / SZ;
    shared.uShadowCenter.value.copy(ORIGIN);
  }
  const _shUpY = new THREE.Vector3(0, 1, 0), _shUpX = new THREE.Vector3(1, 0, 0);
  function renderShadowDepth() {
    if (!CAST || !renderer || !shadowRig.rt) return;
    const dist = 2 * SUN_R, margin = R0 + 62;   // near/far span clears the cloud shell (r=88) on the sun side
    const cam = shadowRig.cam;
    cam.position.copy(ORIGIN).addScaledVector(shadowRig.lightDir, dist);
    cam.near = dist - margin; cam.far = dist + margin;
    cam.up.copy(Math.abs(shadowRig.lightDir.y) > 0.95 ? _shUpX : _shUpY);
    cam.lookAt(ORIGIN);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    shared.uShadowMatrix.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    // hide everything that is NOT a central-planet caster
    const hidden = [sunState.mesh, sunState.glow, edges, birds,
                    waterMesh, cloudWander.mesh, cloudWeather.mesh, plume.mesh];
    for (const im of impostorState.meshes) hidden.push(im.mesh);
    const vis = hidden.map((o) => (o ? o.visible : false));
    for (const o of hidden) if (o) o.visible = false;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.setRenderTarget(shadowRig.rt);
    renderer.autoClear = false;
    renderer.clear(true, true, false);          // clear colour+depth once for this pass
    scene.overrideMaterial = shadowRig.depthMat;
    renderer.render(scene, cam);                 // central planet casters -> depth
    scene.overrideMaterial = null;
    renderer.render(cloudShadowScene, cam);      // weather band puffs -> same depth buffer
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
    hidden.forEach((o, i) => { if (o) o.visible = vis[i]; });
  }

  // ---- the cube edge cage (toggled by "outlines") --------------------------
  const edges = new THREE.Group();
  {
    const segs = cubeEdgeSegments(CELL_HALF);
    const radius = 0.9; // half-width hairline cage (was 1.8)
    const tubes = segs.map(([a, b]) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const h = Math.hypot(dx, dy, dz);
      const g = new THREE.CylinderGeometry(radius, radius, h, 6); g.translate(0, h / 2, 0);
      const q = new THREE.Quaternion().setFromUnitVectors(UP0, new THREE.Vector3(dx / h, dy / h, dz / h));
      g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
      g.translate(a[0], a[1], a[2]);
      return _ni(g);
    });
    // merge the 12 edges into one cage, instance it across the central cell +
    // the visible lattice so the whole tiling reads as a grid of cells
    let nv = 0; for (const g of tubes) nv += g.attributes.position.count;
    const pos = new Float32Array(nv * 3); let o = 0;
    for (const g of tubes) { pos.set(g.attributes.position.array, o); o += g.attributes.position.count * 3; }
    const cage = new THREE.BufferGeometry();
    cage.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0xcfeefb, fog: true });
    const mats = [new THREE.Matrix4().identity(), ...latticeFn(DEPTH)];
    const mesh = new THREE.InstancedMesh(cage, edgeMat, mats.length);
    mats.forEach((M, i) => mesh.setMatrixAt(i, M));
    mesh.frustumCulled = false;
    edges.add(mesh);
  }
  scene.add(edges);
  edges.visible = false; // outlines start hidden (toggle: T / right-click / mobile button)

  // ---- clouds: two PERIODIC systems + the volcano plume --------------------
  // The old single box of puffs was not cell-periodic, so it slid against the
  // wall identifications. Both systems here are instanced once PER CELL over the
  // same image centres the planets use, and animated entirely in-shader from
  // uTime + per-instance attributes, so the field is exactly lattice-periodic
  // (no pop on a wall crossing) and costs no per-frame CPU matrix work. Cheap
  // camera-facing billboard puffs keep the vertex count low at full copy depth.
  const CLOUD_CENTERS = [ORIGIN.clone(), ...impostorState.centers.map((c) => c.clone())];
  const PUFF_PRELUDE = `precision highp float;
precision highp int;
vec3 lin2srgb(vec3 c){ c = clamp(c, 0.0, 1.0); return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4))-0.055, step(0.0031308, c)); }
float h21(vec2 p){ p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 34.53); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = h21(i), b = h21(i + vec2(1.0, 0.0)), c = h21(i + vec2(0.0, 1.0)), d = h21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
float fbm2(vec2 p){ float v = 0.0, a = 0.55; for (int i = 0; i < 3; i++){ v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return v; }
// Fat-plateau puff coverage: ~1 across a wide core, then a NOISE-eroded soft rim
// to 0 by the edge. The wide opaque core (not a faint fringe) is what lets
// adjacent puffs overlap into one continuous body instead of beading into a
// line of pearls at distance.
float puffAlpha(vec2 c, float seed){
  float r = length(c);
  float n = fbm2(c * 1.7 + seed);
  float edge = 0.74 + 0.18 * n;                  // fluffy, per-angle outer radius
  return smoothstep(edge, edge - 0.16, r);       // FAT opaque core, THIN soft rim
}
// Spherical-billboard window depth: treat the camera-facing quad as the FRONT of
// a sphere (screen-radius 1, view radius = sizeView) so overlapping puffs
// intersect as spheres, not flat cards - no disc/tube seams. With alpha-to-
// coverage + depthWrite this is what makes a near cloud truly occlude a far one
// (real depth test, order-independent) instead of bleeding through it. vzc is the
// puff centre's view-space z (negative, camera looks down -z).
float puffDepth(vec2 c, float vzc, float sizeView, mat4 proj){
  float r2 = clamp(dot(c, c), 0.0, 1.0);
  float vz = vzc + sizeView * sqrt(1.0 - r2);     // sphere front, toward the camera
  float zc = proj[2].z * vz + proj[3].z;
  float wc = proj[2].w * vz + proj[3].w;          // = -vz for a perspective proj
  return clamp((zc / wc) * 0.5 + 0.5, 0.0, 1.0);
}
`;
  // a unit camera-facing quad shared by every puff system (corner in [-1,1]^2)
  function makePuffBase() {
    const g = new THREE.InstancedBufferGeometry();
    // NB: the renderer derives the vertex count from a real 'position' attribute;
    // an 'aCorner'-only geometry has count 0 and DRAWS NOTHING (this was the bug
    // that hid every cloud + the plume). Pass corners AS position (z=0); each puff
    // shader reads position.xy as the corner.
    const corners = new Float32Array([-1,-1,0, 1,-1,0, 1,1,0,  -1,-1,0, 1,1,0, -1,1,0]);
    g.setAttribute('position', new THREE.BufferAttribute(corners, 3));
    g.instanceCount = 0;
    return g;
  }
  const instAttr = (g, name, arr, size) => g.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size));

  // ===== wanderer clouds: globular puffs drifting in the gulfs ==============
  {
    const WK = 120; // keep-out radius: puffs never enter the planet's airspace
    // Each cloud is a TIGHT clump of many size-varied puffs (a couple of big
    // cores plus smaller satellites) packed inside a small radius so they overlap
    // into one continuous fluffy volume rather than a few separate spheres.
    const puffs = [];
    const nClusters = LOW ? 6 : 9;
    let guard = nClusters * 40, made = 0;
    while (made < nClusters && guard-- > 0) {
      const ext = 2 * CELL_HALF * 0.86;
      const cx = (rand() - 0.5) * ext, cy = (rand() - 0.5) * ext, cz = (rand() - 0.5) * ext;
      if (Math.hypot(cx, cy, cz) < WK + 24) continue; // cluster centre out in the gulf
      made++;
      const np = LOW ? (5 + Math.floor(rand() * 2)) : (6 + Math.floor(rand() * 3));
      const spread = 14 + rand() * 8;                // clump radius (puffs overlap within it)
      for (let p = 0; p < np; p++) {
        const core = p < 2;                          // big cores + smaller satellites
        const size = core ? (9 + rand() * 5) : (4 + rand() * 5);
        puffs.push({
          base: [cx + (rand() - 0.5) * spread, cy + (rand() - 0.5) * spread * 0.5, cz + (rand() - 0.5) * spread],
          size, seed: rand() * 100,
        });
      }
    }
    const N = puffs.length * CLOUD_CENTERS.length;
    const aCenter = new Float32Array(N * 3), aBase = new Float32Array(N * 3);
    const aSize = new Float32Array(N), aSeed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const ctr = CLOUD_CENTERS[(i / puffs.length) | 0], pf = puffs[i % puffs.length];
      aCenter[3*i] = ctr.x; aCenter[3*i+1] = ctr.y; aCenter[3*i+2] = ctr.z;
      aBase[3*i] = pf.base[0]; aBase[3*i+1] = pf.base[1]; aBase[3*i+2] = pf.base[2];
      aSize[i] = pf.size; aSeed[i] = pf.seed;
    }
    const g = makePuffBase();
    instAttr(g, 'aCellCenter', aCenter, 3); instAttr(g, 'aLocalBase', aBase, 3);
    instAttr(g, 'aSize', aSize, 1); instAttr(g, 'aSeed', aSeed, 1);
    g.instanceCount = N;
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, side: THREE.DoubleSide,
      transparent: false, depthWrite: true, depthTest: true, alphaToCoverage: true,
      uniforms: {
        uTime: shared.uTime, uFogColor: shared.uFogColor, uFogDensity: shared.uFogDensity,
        uDrift: { value: new THREE.Vector3(4.5, 0.7, 1.8) }, uHalf: { value: CELL_HALF },
        uPeriod: { value: PERIOD }, uKeep: { value: WK },
      },
      vertexShader: PUFF_PRELUDE + `
in vec3 position; in vec3 aCellCenter; in vec3 aLocalBase; in float aSize; in float aSeed;
uniform mat4 modelMatrix, viewMatrix, projectionMatrix; uniform float uTime, uHalf, uPeriod, uKeep; uniform vec3 uDrift;
out vec2 vCorner; out float vFog; out float vSeed; out float vVZc; out float vSize;
void main(){
  vec2 aCorner = position.xy;
  vec3 q = aLocalBase + uDrift * uTime;
  q -= uPeriod * floor((q + uHalf) / uPeriod);          // wrap into the cell
  float rad = length(q);
  float t = smoothstep(uKeep, uKeep * 1.3, rad);        // soft radial clamp (never clip the planet)
  float target = mix(uKeep, rad, t);
  q *= target / max(rad, 1e-4);
  // the puff CENTRE rides the scene matrix (so the non-orientable parity-mirror
  // reflects the clouds with the rest of the world); the quad still expands toward
  // the camera in world space, so it stays a camera-facing billboard.
  vec3 base = (modelMatrix * vec4(aCellCenter + q, 1.0)).xyz;
  vec3 camR = vec3(viewMatrix[0].x, viewMatrix[1].x, viewMatrix[2].x);
  vec3 camU = vec3(viewMatrix[0].y, viewMatrix[1].y, viewMatrix[2].y);
  vec3 world = base + (camR * aCorner.x + camU * aCorner.y) * aSize;
  vec4 mv = viewMatrix * vec4(world, 1.0); vFog = -mv.z; vCorner = aCorner; vSeed = aSeed;
  vVZc = mv.z; vSize = aSize;                            // centre view-z + radius (sphere depth)
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: PUFF_PRELUDE + `
in vec2 vCorner; in float vFog; in float vSeed; in float vVZc; in float vSize;
uniform mat4 projectionMatrix; uniform vec3 uFogColor; uniform float uFogDensity; out vec4 fragColor;
void main(){
  // OPAQUE puff with alpha-to-coverage: a fat noise-eroded core whose alpha drives
  // MSAA sample coverage (soft edges) while the puff WRITES DEPTH as a little
  // sphere - so a near clump truly hides a far one (depth test, order-independent),
  // no see-through, no transparency-mask, and no flat-card disc seams.
  float a = puffAlpha(vCorner, vSeed);
  if (a <= 0.001) discard;
  gl_FragDepth = puffDepth(vCorner, vVZc, vSize, projectionMatrix);
  float top = clamp(vCorner.y * 0.5 + 0.62, 0.0, 1.0);
  // a touch of sunset: warm-white tops fading to a soft-pink underside
  vec3 col = mix(vec3(0.96, 0.78, 0.81), vec3(1.0, 0.965, 0.92), top) * (0.85 + 0.15 * top);
  float f = 1.0 - exp(-uFogDensity * uFogDensity * vFog * vFog);
  col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
  fragColor = vec4(lin2srgb(col), a);
}`,
    });
    // Occlusion is the depth buffer's job now (spherical-billboard depth + alpha-
    // to-coverage), so there is no pre-pass and no transparency sorting: a nearer
    // cloud writes nearer depth and hides whatever is behind it, planets included.
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    cloudWander.mesh = mesh;
  }

  // ===== weather clouds: ribbons of soft puffs girdling each planet =========
  // Each cloud is a DENSE ribbon of overlapping, size-varied puffs strung along
  // a circle of LATITUDE about the planet's spin axis - fixed height and radius
  // in cylindrical coordinates (axis = SPIN_AXIS) - with a sparse second row for
  // thickness, so it wraps the planet as one continuous fluffy band, not a row
  // of separate pearls. Puff spacing is fixed BELOW the puff radius so adjacent
  // puffs always overlap, and each ribbon tapers toward its ends.
  {
    // in-plane basis perpendicular to the spin axis (the latitude-circle plane)
    const wAxis = SPIN_AXIS.clone();
    const wRef = Math.abs(wAxis.z) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const wE1 = new THREE.Vector3().crossVectors(wAxis, wRef).normalize();
    const wE2 = new THREE.Vector3().crossVectors(wAxis, wE1).normalize();
    const puffs = [];
    const nBands = LOW ? 6 : 8;          // number of cloud ribbons around the planet
    const shellR = 88;                   // shell radius (always above hills + volcano)
    const place = (zz, rr, phi, size) => {
      const cph = Math.cos(phi), sph = Math.sin(phi);
      puffs.push({ pos: [
        wAxis.x * zz + (wE1.x * cph + wE2.x * sph) * rr,
        wAxis.y * zz + (wE1.y * cph + wE2.y * sph) * rr,
        wAxis.z * zz + (wE1.z * cph + wE2.z * sph) * rr,
      ], size, seed: rand() * 100 });
    };
    for (let b = 0; b < nBands; b++) {
      const u = rand() * 1.7 - 0.85;                 // latitude param (cos colatitude), off the poles
      const z = u * shellR;                          // along-axis height (fixed for this ribbon)
      const rho = Math.sqrt(Math.max(0, 1 - u * u)) * shellR; // in-plane radius (fixed for this ribbon)
      const phi0 = rand() * Math.PI * 2;             // ribbon centre azimuth
      const span = 0.7 + rand() * 0.8;               // ribbon length (radians)
      const meanR = 8 + rand() * 4;                  // puff radius scale for this ribbon
      const dphi = (0.36 * meanR) / Math.max(rho, 1e-3);     // spacing well under the fat core => solid overlap
      const m = Math.max(4, Math.round(span / dphi));
      for (let i = 0; i < m; i++) {
        const f = m > 1 ? i / (m - 1) : 0.5;
        const phi = phi0 + (f - 0.5) * span;
        const taper = 0.74 + 0.26 * Math.sin(Math.PI * (0.1 + 0.8 * f)); // fat middle, only mildly thinner ends
        const size = meanR * taper * (0.85 + 0.3 * rand());
        place(z + (rand() - 0.5) * 5, rho + (rand() - 0.5) * 6, phi, size);   // main row
        if (i % 2 === 0)                                                      // sparse 2nd row -> thickness
          place(z + (rand() < 0.5 ? 1 : -1) * meanR * 0.55, rho + (rand() - 0.5) * 5, phi, size * 0.6);
      }
    }
    const N = puffs.length * CLOUD_CENTERS.length;
    const aCenter = new Float32Array(N * 3), aPos = new Float32Array(N * 3);
    const aSize = new Float32Array(N), aSeed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const ctr = CLOUD_CENTERS[(i / puffs.length) | 0], pf = puffs[i % puffs.length];
      aCenter[3*i] = ctr.x; aCenter[3*i+1] = ctr.y; aCenter[3*i+2] = ctr.z;
      aPos[3*i] = pf.pos[0]; aPos[3*i+1] = pf.pos[1]; aPos[3*i+2] = pf.pos[2];
      aSize[i] = pf.size; aSeed[i] = pf.seed;
    }
    const g = makePuffBase();
    instAttr(g, 'aCellCenter', aCenter, 3); instAttr(g, 'aPos', aPos, 3);
    instAttr(g, 'aSize', aSize, 1); instAttr(g, 'aSeed', aSeed, 1);
    g.instanceCount = N;
    const uWeatherRot = { value: new THREE.Matrix3() };   // ribbon spin, updated each frame
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, side: THREE.DoubleSide,
      transparent: false, depthWrite: true, depthTest: true, alphaToCoverage: true,
      uniforms: {
        uTime: shared.uTime, uFogColor: shared.uFogColor, uFogDensity: shared.uFogDensity,
        uSunOffset: shared.uSunOffset, uWeatherRot,
      },
      vertexShader: PUFF_PRELUDE + `
in vec3 position; in vec3 aCellCenter; in vec3 aPos; in float aSize; in float aSeed;
uniform mat4 modelMatrix, viewMatrix, projectionMatrix; uniform mat3 uWeatherRot;
out vec2 vCorner; out float vFog; out vec3 vDir; out float vSeed; out float vVZc; out float vSize;
void main(){
  vec2 aCorner = position.xy;
  vec3 p = uWeatherRot * aPos;                          // rotate the ribbons about the spin axis
  vDir = normalize(p);
  // puff CENTRE rides the scene matrix (parity-mirror), quad stays camera-facing
  vec3 base = (modelMatrix * vec4(aCellCenter + p, 1.0)).xyz;
  vec3 camR = vec3(viewMatrix[0].x, viewMatrix[1].x, viewMatrix[2].x);
  vec3 camU = vec3(viewMatrix[0].y, viewMatrix[1].y, viewMatrix[2].y);
  vec3 world = base + (camR * aCorner.x + camU * aCorner.y) * aSize; // round puff
  vec4 mv = viewMatrix * vec4(world, 1.0); vFog = -mv.z; vCorner = aCorner; vSeed = aSeed;
  vVZc = mv.z; vSize = aSize;                           // centre view-z + radius (sphere depth)
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: PUFF_PRELUDE + `
in vec2 vCorner; in float vFog; in vec3 vDir; in float vSeed; in float vVZc; in float vSize;
uniform mat4 projectionMatrix; uniform vec3 uFogColor; uniform float uFogDensity; uniform vec3 uSunOffset; out vec4 fragColor;
void main(){
  // OPAQUE puff with alpha-to-coverage and spherical-billboard depth (see the
  // wanderers): the band WRITES DEPTH so a near ribbon truly hides the far side
  // of the band behind the planet, and adjacent puffs - now fat-cored - overlap
  // into one continuous fluffy girdle instead of a beaded line of pearls. On top:
  // a day/night terminator and a warm sun-facing glow on the lit side.
  float a = puffAlpha(vCorner, vSeed);
  if (a <= 0.001) discard;
  gl_FragDepth = puffDepth(vCorner, vVZc, vSize, projectionMatrix);
  float dayDot = dot(vDir, normalize(uSunOffset));
  float lit = mix(0.62, 1.0, smoothstep(-0.25, 0.4, dayDot));     // terminator on the layer
  float top = clamp(vCorner.y * 0.5 + 0.62, 0.0, 1.0);
  // a touch of sunset: warm-white tops fading to a soft-pink underside
  vec3 col = mix(vec3(0.96, 0.78, 0.81), vec3(1.0, 0.965, 0.92), top) * lit * (0.86 + 0.14 * top);
  // warm sun-facing glow: a golden tint plus a little bloom on the side that
  // faces the sun, ramped by how directly the ribbon points at it.
  float glow = smoothstep(0.05, 0.92, dayDot);
  vec3 sunWarm = vec3(1.0, 0.82, 0.52);                  // golden sunlight
  col = mix(col, col * (0.85 + 0.55 * sunWarm), glow);   // golden tint on the lit side
  col += sunWarm * (0.30 * glow * glow);                 // warm bloom at the sun-facing edge
  float f = 1.0 - exp(-uFogDensity * uFogDensity * vFog * vFog);
  col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
  fragColor = vec4(lin2srgb(col), a);
}`,
    });
    // Depth-buffer occlusion (spherical depth + alpha-to-coverage): no pre-pass,
    // no sorting. The near arc of the band writes nearer depth and the planet's
    // own depth hides the far arc, so the ribbon reads as a solid girdle.
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    cloudWeather.mesh = mesh; cloudWeather.mat = mat;
    // sun shadow caster: the SAME band puffs, drawn depth-only as little spheres
    // (facing the shadow camera) into the sun depth map, so the band throws soft
    // moving shadow stripes onto the planet below. Desktop only (CAST), where the
    // sun-cast shadow rig exists.
    if (CAST) {
      const shadowMat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, colorWrite: false, depthWrite: true, depthTest: true,
        uniforms: { uWeatherRot },
        vertexShader: PUFF_PRELUDE + `
in vec3 position; in vec3 aCellCenter; in vec3 aPos; in float aSize; in float aSeed;
uniform mat4 viewMatrix, projectionMatrix; uniform mat3 uWeatherRot;
out vec2 vCorner; out float vVZc; out float vSize; out float vSeed;
void main(){
  vec2 aCorner = position.xy;
  vec3 base = aCellCenter + uWeatherRot * aPos;
  vec3 camR = vec3(viewMatrix[0].x, viewMatrix[1].x, viewMatrix[2].x);
  vec3 camU = vec3(viewMatrix[0].y, viewMatrix[1].y, viewMatrix[2].y);
  vec3 world = base + (camR * aCorner.x + camU * aCorner.y) * aSize * 1.5; // slightly enlarged so the band casts a clearly visible soft shadow
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vCorner = aCorner; vVZc = mv.z; vSize = aSize * 1.5; vSeed = aSeed;
  gl_Position = projectionMatrix * mv;
}`,
        fragmentShader: PUFF_PRELUDE + `
in vec2 vCorner; in float vVZc; in float vSize; in float vSeed;
uniform mat4 projectionMatrix;
void main(){
  // hard cutout of the same fat puff core (shadow maps are binary), written as a
  // sphere depth so overlapping puffs cast one continuous band shadow.
  if (puffAlpha(vCorner, vSeed) < 0.45) discard;
  gl_FragDepth = puffDepth(vCorner, vVZc, vSize, projectionMatrix);
}`,
      });
      const shadowMesh = new THREE.Mesh(g, shadowMat);
      shadowMesh.frustumCulled = false;
      cloudShadowScene.add(shadowMesh);
      cloudWeather.shadowMesh = shadowMesh;
    }
  }

  // ===== the volcano plume: rising embers -> ash, periodic over every copy ===
  {
    const puffs = [];
    const nP = LOW ? 12 : 18;   // a few more puffs so the slimmer column stays continuous
    for (let i = 0; i < nP; i++) puffs.push({ phase: i / nP + rand() * 0.02, seed: rand(), size: 4 + rand() * 4 });
    const N = puffs.length * CLOUD_CENTERS.length;
    const aCenter = new Float32Array(N * 3), aPhase = new Float32Array(N), aSeed = new Float32Array(N), aSize = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const ctr = CLOUD_CENTERS[(i / puffs.length) | 0], pf = puffs[i % puffs.length];
      aCenter[3*i] = ctr.x; aCenter[3*i+1] = ctr.y; aCenter[3*i+2] = ctr.z;
      aPhase[i] = pf.phase; aSeed[i] = pf.seed; aSize[i] = pf.size;
    }
    const g = makePuffBase();
    instAttr(g, 'aCellCenter', aCenter, 3); instAttr(g, 'aPhase', aPhase, 1);
    instAttr(g, 'aSeed', aSeed, 1); instAttr(g, 'aSize', aSize, 1);
    g.instanceCount = N;
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        uTime: shared.uTime, uFogColor: shared.uFogColor, uFogDensity: shared.uFogDensity,
        uSummit: { value: new THREE.Vector3() }, uPlumeUp: { value: new THREE.Vector3(0, 1, 0) },
        uT1: { value: new THREE.Vector3(1, 0, 0) }, uT2: { value: new THREE.Vector3(0, 0, 1) },
        uRise: { value: 18 }, uRate: { value: 0.10 },
      },
      vertexShader: PUFF_PRELUDE + `
in vec3 position; in vec3 aCellCenter; in float aPhase; in float aSeed; in float aSize;
uniform mat4 modelMatrix, viewMatrix, projectionMatrix; uniform float uTime, uRise, uRate;
uniform vec3 uSummit, uPlumeUp, uT1, uT2;
out vec2 vCorner; out float vFog; out float vLife;
void main(){
  vec2 aCorner = position.xy;
  float life = fract(uTime * uRate + aPhase);
  float h = life * uRise;
  float ang = aSeed * 6.2831853 + life * 1.6;
  float spread = mix(0.8, 3.4, life) * (0.3 + aSeed * 0.7); // ~half the lateral throw -> a narrower column
  vec3 lateral = (uT1 * cos(ang) + uT2 * sin(ang)) * spread;
  // base column position rides the scene matrix (parity-mirror); the quad still
  // expands toward the camera, so it stays a camera-facing billboard.
  vec3 base = (modelMatrix * vec4(aCellCenter + uSummit + uPlumeUp * (h + 2.0) + lateral, 1.0)).xyz;
  float grow = mix(0.55, 1.9, life) * aSize;               // slimmer puffs (the column was set by puff size)
  vec3 camR = vec3(viewMatrix[0].x, viewMatrix[1].x, viewMatrix[2].x);
  vec3 camU = vec3(viewMatrix[0].y, viewMatrix[1].y, viewMatrix[2].y);
  vec3 world = base + (camR * aCorner.x + camU * aCorner.y) * grow;
  vec4 mv = viewMatrix * vec4(world, 1.0); vFog = -mv.z; vCorner = aCorner; vLife = life;
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: PUFF_PRELUDE + `
in vec2 vCorner; in float vFog; in float vLife;
uniform vec3 uFogColor; uniform float uFogDensity; out vec4 fragColor;
void main(){
  float soft = smoothstep(1.0, 0.15, length(vCorner));
  float fade = smoothstep(0.0, 0.12, vLife) * (1.0 - smoothstep(0.55, 1.0, vLife));
  float a = soft * fade * 0.92;
  if (a < 0.01) discard;
  vec3 ember = vec3(0.95, 0.42, 0.14), ash = vec3(0.24, 0.23, 0.23);
  vec3 col = mix(ember, ash, smoothstep(0.0, 0.5, vLife));
  float f = 1.0 - exp(-uFogDensity * uFogDensity * vFog * vFog);
  col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
  fragColor = vec4(lin2srgb(col), a);
}`,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false; mesh.renderOrder = 3;
    scene.add(mesh);
    plume.mesh = mesh; plume.mat = mat;
    plume.summitR = R0 + VOLCANO.height - VOLCANO.craterDepth * 0.5; // mid-crater (where smoke issues)
  }

  // ---- birds circling the planet -------------------------------------------
  const birds = new THREE.Group();
  {
    const birdMat = new THREE.MeshBasicMaterial({ color: 0x16181d, side: THREE.DoubleSide, fog: true });
    const wingGeo = new THREE.BufferGeometry();
    wingGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, 0, 0.10, 0, 0, -0.10, 0.55, 0.07, -0.02,
    ]), 3));
    const N = LOW ? 36 : 54;
    for (let i = 0; i < N; i++) {
      const bird = new THREE.Group();
      const right = new THREE.Mesh(wingGeo, birdMat);
      const left = new THREE.Mesh(wingGeo, birdMat); left.scale.x = -1;
      bird.add(right, left);
      // a random great-circle-ish orbit plane around the planet
      const axis = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
      const planeQ = new THREE.Quaternion().setFromUnitVectors(UP0, axis);
      bird.userData = {
        planeQ, r: R0 + 14 + rand() * 24, w: (0.15 + rand() * 0.12) * (rand() < 0.5 ? -1 : 1),
        ph: rand() * Math.PI * 2, flap: 5 + rand() * 3, wings: [right, left],
        bob: 4 + rand() * 5,
      };
      birds.add(bird);
    }
    scene.add(birds);
  }

  // ---- per-frame update ----------------------------------------------------
  const _bp = new THREE.Vector3(), _bp2 = new THREE.Vector3(), _bm = new THREE.Matrix4(), _bq = new THREE.Quaternion(), _bsc = new THREE.Vector3();
  const _bUp = new THREE.Vector3(), _bFwd = new THREE.Vector3(), _bX = new THREE.Vector3(), _bMat = new THREE.Matrix4(), _iScale = new THREE.Vector3(1, 1, 1);
  function update(dt, camera) {
    shared.uTime.value += dt;
    if (camera) shared.uCamPos.value.copy(camera.position);
    const t = shared.uTime.value;

    // spin the planet as a rigid body about its fixed tilted axis; the copies are
    // the same planet, so each turns by the same amount about its own centre
    planetSpin += SPIN_RATE * dt;
    planetQuat.setFromAxisAngle(SPIN_AXIS, planetSpin);
    planetGroup.quaternion.copy(planetQuat);
    planetQuatInv.copy(planetQuat).invert();
    for (const im of impostorState.meshes) {
      const mesh = im.mesh, centers = im.centers;
      for (let i = 0; i < centers.length; i++) mesh.setMatrixAt(i, _bm.compose(centers[i], planetQuat, _iScale));
      mesh.instanceMatrix.needsUpdate = true;
    }

    // advance the sun on its circular orbit; one offset lights every cell
    const sunOff = sunOffsetAt(t);
    shared.uSunOffset.value.copy(sunOff);
    if (sunState.mesh) {
      const cs = sunState.centers;
      for (let i = 0; i < cs.length; i++) {
        _bp.copy(cs[i]).add(sunOff);
        _bm.compose(_bp, _bq.identity(), _iScale);
        sunState.mesh.setMatrixAt(i, _bm);
      }
      sunState.mesh.instanceMatrix.needsUpdate = true;
      // the glow billboard positions itself in-shader from uSunOffset (no matrices)
    }

    // clouds + plume are periodic and animate in-shader from uTime; only their
    // few orientation/position uniforms need a per-frame refresh (no matrices).
    if (cloudWeather.mat) {
      _bq.setFromAxisAngle(cloudWeather.axis, cloudWeather.rate * t);
      _bm.makeRotationFromQuaternion(_bq);
      cloudWeather.mat.uniforms.uWeatherRot.value.setFromMatrix4(_bm);
    }
    if (plume.mesh) {
      const u = plume.mat.uniforms;
      u.uSummit.value.copy(VOLCANO.dir).multiplyScalar(plume.summitR).applyQuaternion(planetQuat);
      u.uPlumeUp.value.copy(VOLCANO.dir).applyQuaternion(planetQuat);
      const up = u.uPlumeUp.value;
      _bX.set(0, 1, 0); if (Math.abs(up.y) > 0.95) _bX.set(1, 0, 0);
      u.uT1.value.crossVectors(up, _bX).normalize();
      u.uT2.value.crossVectors(up, u.uT1.value).normalize();
    }

    // directional shadow map. The light direction is a world quantity, so it
    // updates every frame even headless; the GL depth re-render needs a renderer.
    // It runs EVERY frame: the planet spins and the sun creeps each frame, so a
    // stale map (the old every-4th-frame refresh) made the cast shadows strobe.
    if (CAST) {
      shadowRig.lightDir.copy(sunOff).normalize();
      if (renderer) renderShadowDepth();
      shadowRig.frame++;
    }

    // birds: travel their orbit plane, flap, and hold their up RADIALLY outward
    // (local +y = away from the planet centre, local -z = direction of travel)
    for (const bird of birds.children) {
      const u = bird.userData;
      const a = u.ph + u.w * t;
      _bp.set(Math.cos(a) * u.r, Math.sin(t * 0.6 + u.ph) * u.bob, Math.sin(a) * u.r).applyQuaternion(u.planeQ);
      bird.position.copy(_bp);
      const a2 = a + (u.w > 0 ? 0.08 : -0.08);
      _bp2.set(Math.cos(a2) * u.r, _bp.y, Math.sin(a2) * u.r).applyQuaternion(u.planeQ);
      _bUp.copy(_bp).sub(ORIGIN).normalize();                 // radial outward
      _bFwd.copy(_bp2).sub(_bp).normalize();                  // travel tangent
      _bFwd.addScaledVector(_bUp, -_bFwd.dot(_bUp));           // -> perpendicular to up
      if (_bFwd.lengthSq() < 1e-6) _bFwd.set(1, 0, 0); else _bFwd.normalize();
      _bFwd.multiplyScalar(-1);                               // local -z faces travel
      _bX.crossVectors(_bUp, _bFwd).normalize();
      _bMat.makeBasis(_bX, _bUp, _bFwd);
      bird.quaternion.setFromRotationMatrix(_bMat);
      const f = Math.sin(t * u.flap + u.ph) * 0.55 + 0.1;
      u.wings[0].rotation.z = f; u.wings[1].rotation.z = -f;
    }
  }

  // resolve collisions the radial terrain skim does not cover: the cottages
  // (snug sphere volumes) and the pond water surface (you skim it, never dive
  // through it). World space; house centres are spun into world by planetQuat,
  // the pond test is done in the planet's local frame.
  const _oc = new THREE.Vector3(), _od = new THREE.Vector3(), _ol = new THREE.Vector3(), _owr = new THREE.Vector3();
  function clampToObstacles(pos, vel) {
    for (let i = 0; i < HOUSE_COLLIDERS.length; i++) {
      _oc.copy(HOUSE_COLLIDERS[i].c).applyQuaternion(planetQuat);
      _od.subVectors(pos, _oc);
      const d = _od.length(), R = HOUSE_COLLIDERS[i].r;
      if (d < R) {
        if (d > 1e-4) _od.multiplyScalar(1 / d); else _od.set(0, 1, 0);
        pos.copy(_oc).addScaledVector(_od, R);
        const vn = vel.dot(_od); if (vn < 0) vel.addScaledVector(_od, -vn);
      }
    }
    _ol.copy(pos).applyQuaternion(planetQuatInv);
    const dl = _ol.length();
    if (dl > 1e-4) {
      _ol.multiplyScalar(1 / dl);
      if (pondSDF(_ol) < 0) {
        const wmin = WATER_LEVEL + 1.2;
        if (dl < wmin) {
          _owr.copy(pos).multiplyScalar(1 / dl);
          pos.copy(_owr).multiplyScalar(wmin);
          const vn = vel.dot(_owr); if (vn < 0) vel.addScaledVector(_owr, -vn);
        }
      }
    }
  }

  return {
    update,
    planetCenter: ORIGIN,
    cellHalf: CELL_HALF,
    radiusAtDir,            // analytic surface radius along a unit direction (collision)
    groundRadius,           // exact rendered-mesh radius along a direction (placement)
    clampToObstacles,       // resolve cottage + pond-water collision (player controller)
    pondDir: POND.dir.clone(), waterLevel: WATER_LEVEL,  // pond centre + water surface radius
    surfaceGravity: G_SURFACE,
    gravityAt,              // gravityAt(outVec3, posVec3) -> faint Newtonian field
    baseRadius: R0,
    edges,                  // group toggled by the outline control
    fogDensity: FOG_DENSITY,
    sun: { radius: SUN_R, omega: SUN_OMEGA, period: (2 * Math.PI) / SUN_OMEGA },
    volcano: { dir: VOLCANO.dir.clone(), ang: VOLCANO.ang, height: VOLCANO.height, craterFrac: VOLCANO.craterFrac, craterDepth: VOLCANO.craterDepth, summitRadius: VOLCANO.summitRadius },
    houses: HOUSES.map((h) => h.dir.clone()),  // direction of every cottage (>= 1)
    // directional sun-cast shadows (desktop). lightDir() tracks the orbiting sun.
    shadow: { enabled: CAST, mapSize: shadowRig.size, lightDir: () => shadowRig.lightDir.clone() },
    // the image centres clouds + plume are instanced over (periodicity invariant)
    cloudCenters: CLOUD_CENTERS.map((c) => c.clone()),
  };
}
