// Stylized BotW-ish world.
//
// Layered height function (single source of truth for geometry, colors,
// placement, and camera collision):
//   rawHeight  = rolling hills + ridged mountain ring + path grooves
//   +  river carve: the corridor blends to a fixed-level bed so the water
//      plane can be flat
//   +  cottage pads: terrain blends to a constant around each cottage
//
// Visual features: wind-swayed tapered grass blades (instanced, custom
// vertex sway injected with onBeforeCompile so toon shading, shadows and
// the portal clipping planes all keep working), two-tone faceted trees,
// bushes, flowers, boulders, gable-roofed cottages, an animated river,
// gradient sky with sun, drifting flat-bottomed clouds.

import * as THREE from 'three';
import { createNoise, mulberry32 } from './noise.js';
import { DEFECT_SITES } from './sites.js';

function smoothstep(e0, e1, x) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}
const lerp = (a, b, t) => a + (b - a) * t;

export function createWorld(scene, opts = {}) {
  // lowDetail (mobile): coarser visual meshes and less grass. The collision
  // floor is analytic (worldFloor -> height(x,z)), independent of the terrain
  // MESH resolution, so coarsening the mesh changes only how the ground looks,
  // never where the observer stands or how the river/bridge/pads anchor.
  const LOW = !!opts.lowDetail;
  const noise = createNoise(20260610);
  const rand = mulberry32(1337);

  const BOUNDS_RADIUS = 130;
  const MAX_ALTITUDE = 32;
  const TERRAIN_SIZE = 400;
  const TERRAIN_SEG = LOW ? 150 : 280;

  // ---- height function, layer by layer -------------------------------------
  function pathDist(x, z) {
    // single main road (x = 22*sin(z/30)) that the stone bridge sits on; the old
    // branch (z = 25*sin(x/35)) wandered into the river and up the mountains, so
    // it has been removed.
    return Math.abs(x - 22 * Math.sin(z / 30));
  }

  const RIVER_LEVEL = -0.05;  // water plane (raised 0.5 m from the old -0.55)

  // River centreline z(x): a gentle meander through the meadow that grows long
  // and tortuous once it reaches the mountains (|x| > ~55), so the gorge keeps
  // bending and never gives a straight line of sight out of the valley. Stays
  // single-valued in x and identical to the old meander in the meadow, so the
  // stone bridge still lands squarely on it.
  const riverZ = (x) => {
    const base = -14 + 10 * Math.sin(x / 30);
    const w = smoothstep(55, 120, Math.abs(x));          // 0 meadow -> 1 deep range
    const wind = 22 * Math.sin(x / 12 + 1.7) + 12 * Math.sin(x / 6 + 4.0);
    // Local swing so the channel meets the stone bridge square-on. At the deck
    // centre xb the value is unchanged (the river still lands on the bridge),
    // but A·(x-xb) sets the tangent there to be perpendicular to the deck axis
    // (deck dir = (cos ry, -sin ry); river dir must be (sin ry, cos ry)-ish so
    // dz/dx = -0.605). The Gaussian window keeps the bend local to the crossing
    // and decays to ~0 well before the deep range, leaving the meander intact.
    const xb = -12.44, sigma = 12, A = -0.9102;
    const t = (x - xb) / sigma;
    const bend = A * (x - xb) * Math.exp(-t * t);
    return base + w * wind + bend;
  };
  // Sampled polyline + exact point-to-segment distance (|z - riverZ(x)| is only
  // valid for a gently sloped channel; the tortuous gorge needs the true
  // perpendicular distance).
  const RIVER_X0 = -190, RIVER_DX = 2;
  const RIVER_PTS = [];
  for (let x = RIVER_X0; x <= 190; x += RIVER_DX) RIVER_PTS.push([x, riverZ(x)]);
  const RIVER_N = RIVER_PTS.length;
  function segDist(px, pz, ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + t * dx, cz = az + t * dz;
    return Math.hypot(px - cx, pz - cz);
  }
  function riverDist(x, z) {
    const i0 = Math.round((x - RIVER_X0) / RIVER_DX), W = 30;
    const lo = Math.max(0, i0 - W), hi = Math.min(RIVER_N - 2, i0 + W);
    let best = Infinity;
    for (let i = lo; i <= hi; i++) {
      const a = RIVER_PTS[i], b = RIVER_PTS[i + 1];
      const d = segDist(x, z, a[0], a[1], b[0], b[1]);
      if (d < best) best = d;
    }
    return best;
  }

  // Stone bridge where the x = 22·sin(z/30) path crosses the river.
  // Crossing point and yaw solved numerically (path tangent there).
  // ~2.2x longer, 2.3x wider than before so it spans the gorge. Deck profile is
  // defined later (after heightWithRiver) so it can anchor to the ground.
  const BRIDGE = { x: -12.44, z: -18.03, ry: -1.0268, halfL: 13, halfW: 3.0 };
  function bridgeLocal(x, z) {
    const dx = x - BRIDGE.x, dz = z - BRIDGE.z;
    const c = Math.cos(BRIDGE.ry), s = Math.sin(BRIDGE.ry);
    return { u: dx * c - dz * s, v: dx * s + dz * c };
  }
  const nearBridge = (x, z, margin = 2) => {
    const { u, v } = bridgeLocal(x, z);
    return Math.abs(u) < BRIDGE.halfL + margin && Math.abs(v) < BRIDGE.halfW + margin;
  };

  const MEADOW_FLOOR = 0.3;  // soft floor, kept ~0.35 m above the raised water plane
  function rawHeight(x, z) {
    const r = Math.hypot(x, z);
    const hills =
      6.0 * noise.fbm(x * 0.012, z * 0.012, 4) +
      2.5 * noise.fbm(x * 0.0045 + 7, z * 0.0045 + 7, 3) + 1.5;
    const m = smoothstep(112, 175, r);
    let ridge = 1 - Math.abs(noise.fbm(x * 0.016 + 50, z * 0.016 + 50, 4));
    ridge *= ridge;                                  // primary ridge lines
    let ridgeB = 1 - Math.abs(noise.fbm(x * 0.043 + 90, z * 0.043 + 90, 4));
    ridgeB *= ridgeB;                                // secondary spurs / gullies
    const rough = noise.fbm(x * 0.10 + 13, z * 0.10 + 13, 4); // fine roughness [-1,1]
    const mountains = m * (12 + 24 * ridge + 13 * ridgeB + 6 * rough);
    let h = hills * (1 - 0.55 * m) + mountains;
    h -= 0.3 * (1 - smoothstep(0.4, 2.6, pathDist(x, z)));
    // soft lower bound: keep the un-carved terrain just above the water plane so
    // low meadow valleys don't flood. The canyon (min with the wall) and the
    // pond carve are applied afterwards and still cut below it; high ground is
    // left untouched (softplus -> identity for h well above the floor).
    return MEADOW_FLOOR + 0.5 * Math.log1p(Math.exp((h - MEADOW_FLOOR) / 0.5));
  }

  // Canyon cross-section: a narrow flat floor, then ~45 degree walls (slope ~ 1)
  // that climb until they meet the natural terrain — a shallow banked stream in
  // the low meadow, a deep gorge where the same channel cuts the mountains.
  const CANYON_FLOOR = RIVER_LEVEL - 1.1;   // bed held at -1.15: river is now 1.1 m deep
  const CANYON_BED_HALF = 4.5;              // half-width of the flat floor
  function heightWithRiver(x, z) {
    const H = rawHeight(x, z);
    const d = riverDist(x, z);
    if (d > 64) return H;                    // far field: untouched terrain
    const wall = CANYON_FLOOR + Math.max(0, d - CANYON_BED_HALF); // 45 deg walls
    return Math.min(H, wall);
  }

  // Bridge deck anchored to the terrain at both abutments: the two ends sit at
  // the natural ground height (so the deck meets the ground flush) and the span
  // humps up over the river in between.
  const _bc = Math.cos(BRIDGE.ry), _bs = Math.sin(BRIDGE.ry);
  const _abut = (u) => ({ x: BRIDGE.x + u * _bc, z: BRIDGE.z - u * _bs });
  const A0 = _abut(-BRIDGE.halfL), A1 = _abut(BRIDGE.halfL);
  BRIDGE.y0 = heightWithRiver(A0.x, A0.z);   // world ground height at the -end
  BRIDGE.y1 = heightWithRiver(A1.x, A1.z);   // world ground height at the +end
  BRIDGE.hump = 1.7;                          // +0.3 lifts the deck; ends stay pinned to y0/y1 (glued)
  const bridgeTop = (u) => {                  // deck top, LOCAL y (rel. water)
    const s = (u + BRIDGE.halfL) / (2 * BRIDGE.halfL);
    const chord = (BRIDGE.y0 + (BRIDGE.y1 - BRIDGE.y0) * s) - RIVER_LEVEL;
    return chord + BRIDGE.hump * (1 - (u / BRIDGE.halfL) ** 2);
  };
  function bridgeDeckY(x, z) {
    const { u, v } = bridgeLocal(x, z);
    if (Math.abs(u) > BRIDGE.halfL || Math.abs(v) > BRIDGE.halfW) return -Infinity;
    return RIVER_LEVEL + bridgeTop(u);
  }
  // flat pads under each abutment so the ground is flush with the deck ends —
  // guarded by riverDist so they never spill into the gorge.
  const ABUT = [{ x: A0.x, z: A0.z, y: BRIDGE.y0 }, { x: A1.x, z: A1.z, y: BRIDGE.y1 }];

  // Cottage pads (positions chosen near the defect at the origin): terrain
  // blends to a constant around each.
  const COTTAGES = [
    { x: 14, z: 7, rot: 0.6 },
    { x: -16, z: -4, rot: 2.3 },
    { x: -8, z: 18, rot: -1.1 },
    // more houses strung along the road. The first three sit across the bridge
    // (south of the river); the last three are on the near side. Positions were
    // chosen on buildable ground beside the road (each gets a flattening pad).
    { x: -42, z: -48, rot: 0.95 },   // moved clear of the bridge (was -23.5,-30: impeded the deck and hovered)
    { x: -28.5, z: -41, rot: 1.29 },
    { x: -15.8, z: -51, rot: -1.25 },
    { x: 1.2, z: 10, rot: 1.25 },
    { x: 19.6, z: 20, rot: -1.25 },
    { x: 26.5, z: 30, rot: -1.33 },
  ];
  const PADS = COTTAGES.map((c) => ({ x: c.x, z: c.z, rIn: 4.5, rOut: 9 }));
  for (const p of PADS) p.baseH = heightWithRiver(p.x, p.z);
  for (const c of COTTAGES) c.baseH = heightWithRiver(c.x, c.z);

  // pond: a smooth bowl dipping below the water plane (so the water table fills
  // it), placed ~44 m clear of every defect and cottage.
  const POND = { x: -16, z: 70, r: 13, floor: RIVER_LEVEL - 1.7 };
  function height(x, z) {
    let h = heightWithRiver(x, z);
    for (const p of PADS) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.rOut) h = lerp(p.baseH, h, smoothstep(p.rIn, p.rOut, d));
    }
    for (const p of ABUT) {
      if (riverDist(x, z) > 6.5) {                       // never fill the gorge
        const d = Math.hypot(x - p.x, z - p.z);
        if (d < 7) h = lerp(p.y, h, smoothstep(3.0, 7, d));
      }
    }
    const pd = Math.hypot(x - POND.x, z - POND.z);
    if (pd < POND.r) {
      const k = 1 - smoothstep(POND.r * 0.45, POND.r, pd); // 1 centre -> 0 rim
      h = lerp(h, Math.min(h, POND.floor), k);
    }
    return h;
  }

  // ---- toon material factory ------------------------------------------------
  const gradientData = new Uint8Array([110, 170, 225, 255]);
  const gradientMap = new THREE.DataTexture(gradientData, gradientData.length, 1, THREE.RedFormat);
  gradientMap.minFilter = THREE.NearestFilter;
  gradientMap.magFilter = THREE.NearestFilter;
  gradientMap.needsUpdate = true;
  const toon = (params) => new THREE.MeshToonMaterial({ gradientMap, ...params });

  const uTime = { value: 0 }; // shared by grass sway + water ripple

  // ---- terrain ----------------------------------------------------------------
  const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEG, TERRAIN_SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cGrassA = new THREE.Color('#79b94e');
  const cGrassB = new THREE.Color('#a4cf5e');
  const cDirt = new THREE.Color('#c09a6a');
  const cSand = new THREE.Color('#cbb287');
  const cRock = new THREE.Color('#8b8d94');
  const cRock2 = new THREE.Color('#6f7178');
  const cSnow = new THREE.Color('#eef3f6');
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = height(x, z);
    pos.setY(i, h);
    // local slope (finite differences) for rock exposure
    const slope = Math.hypot(height(x + 1.2, z) - h, height(x, z + 1.2) - h) / 1.2;

    c.copy(cGrassA).lerp(cGrassB, 0.5 + 0.5 * noise.fbm(x * 0.05, z * 0.05, 2));
    // sandy banks near the river
    const rd = riverDist(x, z);
    c.lerp(cSand, (1 - smoothstep(3.0, 6.5, rd)) * (1 - smoothstep(0.2, 0.9, h)));
    // dirt paths
    c.lerp(cDirt, 0.85 * (1 - smoothstep(1.4, 3.2, pathDist(x, z))));
    // rock on steep slopes and high ground
    c.lerp(cRock, 0.9 * smoothstep(0.55, 1.05, slope));
    c.lerp(cRock2, 0.6 * smoothstep(12, 20, h) * (0.5 + 0.5 * noise.fbm(x * 0.08, z * 0.08, 2)));
    // snowline: a soft but LARGE-scale jagged boundary — the threshold altitude
    // wanders by a sizeable fraction of the peak height, dominated by a low
    // frequency (big sweeping fingers rather than fine speckle), while the
    // smoothstep keeps the edge itself anti-aliased.
    const snowJag = 6.5 * noise.fbm(x * 0.016 + 30, z * 0.016 + 30, 3)
                  + 2.2 * noise.fbm(x * 0.052 + 60, z * 0.052 + 60, 2);
    const snowLo = 22.0 + snowJag;
    c.lerp(cSnow, smoothstep(snowLo, snowLo + 2.2, h));
    colors[3 * i] = c.r; colors[3 * i + 1] = c.g; colors[3 * i + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const terrain = new THREE.Mesh(geo, toon({ vertexColors: true }));
  terrain.receiveShadow = true;
  scene.add(terrain);

  // ---- water table ------------------------------------------------------------
  {
    // a single flat plane (the water table) at y = RIVER_LEVEL, sized just
    // inside the terrain footprint so the rim mountains occlude its edge. Water
    // appears wherever the ground dips below it (the canyon + the pond) and is
    // hidden by terrain everywhere else — no ribbon seams, fills any depression.
    const wSeg = LOW ? 100 : 200;
    const g = new THREE.PlaneGeometry(TERRAIN_SIZE - 4, TERRAIN_SIZE - 4, wSeg, wSeg);
    g.rotateX(-Math.PI / 2);
    const mat = toon({ color: '#3ea7c4', transparent: true, opacity: 0.85 });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime;
      shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         transformed.y += sin(position.x * 1.3 + uTime * 1.4) * 0.03
                        + cos(position.z * 1.9 + uTime * 1.0) * 0.025;`
      );
    };
    const water = new THREE.Mesh(g, mat);
    water.position.y = RIVER_LEVEL;
    water.receiveShadow = true;
    scene.add(water);
  }


  // ---- medieval stone bridge ------------------------------------------------------
  {
    const g = new THREE.Group();
    g.position.set(BRIDGE.x, RIVER_LEVEL, BRIDGE.z);
    g.rotation.y = BRIDGE.ry;
    const stone = toon({ color: '#a39d92', flatShading: true, side: THREE.DoubleSide });

    // Side profile (u, y rel. water): terrain-anchored deck on top, base near the
    // canyon floor, two round arches spanning the river in the middle.
    const HL = BRIDGE.halfL, HW = BRIDGE.halfW, BASE = -1.5;  // footing ~world -1.55, still in the bed
    const R = 3.0, C1 = 3.3, C2 = -3.3;
    const shape = new THREE.Shape();
    shape.moveTo(-HL, bridgeTop(-HL));
    for (let u = -HL; u <= HL + 1e-3; u += 0.5) shape.lineTo(u, bridgeTop(u));
    shape.lineTo(HL, BASE);
    shape.lineTo(C1 + R, BASE);
    shape.absarc(C1, BASE, R, 0, Math.PI, false);   // right arch (upper semicircle)
    shape.lineTo(C2 + R, BASE);                      // central pier
    shape.absarc(C2, BASE, R, 0, Math.PI, false);    // left arch
    shape.lineTo(-HL, BASE);
    shape.closePath();
    const body = new THREE.Mesh(
      new THREE.ExtrudeGeometry(shape, { depth: HW * 2, bevelEnabled: false }), stone);
    body.geometry.translate(0, 0, -HW);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // crenellation stones along both parapets, following the deck top
    const stoneGeo = new THREE.BoxGeometry(0.95, 0.4, 0.4);
    const NC = 11;
    for (let k = -NC; k <= NC; k++) {
      const u = (k / NC) * (HL - 0.7);
      for (const sgn of [-1, 1]) {
        const m = new THREE.Mesh(stoneGeo, stone);
        m.position.set(u, bridgeTop(u) + 0.2, sgn * (HW - 0.18));
        m.castShadow = true;
        g.add(m);
      }
    }
    scene.add(g);
  }

  // ---- sky + sun -----------------------------------------------------------------
  const sunDir = new THREE.Vector3(0.45, 0.62, 0.3).normalize();
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(900, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color('#3d86d8') },
        uHorizon: { value: new THREE.Color('#d9eef8') },
        uSun: { value: sunDir },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform vec3 uTop, uHorizon, uSun;
        void main() {
          vec3 d = normalize(vDir);
          vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 0.5, d.y));
          float ca = dot(d, uSun);
          col += vec3(1.0, 0.90, 0.70) * pow(max(ca, 0.0), 8.0) * 0.10; // gentle halo
          col += vec3(1.0, 0.93, 0.66) * pow(max(ca, 0.0), 3.0) * 0.16; // broad pale-yellow glow
          // crisp-bordered sun disc (~2.4° radius, stylized)
          float disc = smoothstep(cos(0.045), cos(0.041), ca);
          col = mix(col, vec3(1.0, 0.97, 0.86), disc);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    })
  ));
  // Blue aerial-perspective haze (Leonardesque atmospheric depth): distance fades
  // toward a pale sky-blue (the sky's own horizon tone, so the ring dissolves
  // into the sky rather than meeting a wall). Desktop uses FogExp2 — physical
  // exponential extinction, no hard opaque plane and no near onset, so the
  // foreground and near-midground stay clear and the haze builds smoothly with
  // distance, only true distance saturating. Single dial: HAZE_DENSITY (lower =
  // clearer / longer view, the mountain ring crisper; higher = hazier / shorter).
  // At 0.0035 the air is near-clear out to ~90 m, ~50% hazed only near ~240 m,
  // and the ~130 m mountain ring still reads through as a pale silhouette; nudge
  // by ±0.0005 (≈0.003 clearer, ≈0.004 hazier). Mobile keeps the lighter linear
  // profile (the on-screen frame budget likes a hard far clip).
  const HAZE_DENSITY = 0.0035;
  scene.fog = LOW
    ? new THREE.Fog(0xd4eaf6, 95, 380)            // mobile: linear, longer/lighter
    : new THREE.FogExp2(0xd4eaf6, HAZE_DENSITY);  // desktop: physical exponential falloff

  // ---- clouds (flat-bottomed cartoon puffs) -----------------------------------------
  const clouds = new THREE.Group();
  const puffGeo = new THREE.SphereGeometry(1, 8, 6);
  const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 });
  for (let i = 0; i < 16; i++) {
    const g = new THREE.Group();
    const r = 50 + rand() * 210, a = rand() * Math.PI * 2;
    g.position.set(r * Math.cos(a), 44 + rand() * 24, r * Math.sin(a));
    const puffs = 4 + Math.floor(rand() * 5);
    for (let p = 0; p < puffs; p++) {
      const m = new THREE.Mesh(puffGeo, cloudMat);
      m.position.set((rand() - 0.5) * 12, rand() * 1.4, (rand() - 0.5) * 5);
      m.scale.set(2.6 + rand() * 3.2, 1.0 + rand() * 0.9, 1.8 + rand() * 1.6);
      g.add(m);
    }
    g.scale.y = 0.8;
    clouds.add(g);
  }
  scene.add(clouds);

  // ---- seagulls (black silhouettes circling overhead) -------------------------------
  const gulls = new THREE.Group();
  {
    const gullMat = new THREE.MeshBasicMaterial({ color: 0x16181d, side: THREE.DoubleSide });
    const wingGeo = new THREE.BufferGeometry();
    wingGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, 0, 0.10, 0, 0, -0.10, 0.55, 0.07, -0.02,
    ]), 3));
    wingGeo.computeVertexNormals();
    for (let i = 0; i < 9; i++) {
      const gull = new THREE.Group();
      const right = new THREE.Mesh(wingGeo, gullMat);
      const left = new THREE.Mesh(wingGeo, gullMat);
      left.scale.x = -1;
      gull.add(right, left);
      gull.userData = {
        cx: (rand() - 0.5) * 160, cz: (rand() - 0.5) * 160,
        r: 14 + rand() * 30, y: 20 + rand() * 11,
        w: (0.06 + rand() * 0.09) * (rand() < 0.5 ? -1 : 1),
        ph: rand() * Math.PI * 2, flap: 4.5 + rand() * 3,
        wings: [right, left],
      };
      gulls.add(gull);
    }
    scene.add(gulls);
  }

  // ---- scattering helpers --------------------------------------------------------------
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);

  const cottageDist = (x, z) =>
    Math.min(...COTTAGES.map((c) => Math.hypot(x - c.x, z - c.z)));
  const siteDist = (x, z) =>
    Math.min(...DEFECT_SITES.map((s) => Math.hypot(x - s.x, z - s.z)));

  const meadow = (pathMargin, riverMargin = 5.5, cottageMargin = 6.5, defectMargin = 0) =>
    (x, z, h) =>
      h > -0.1 && h < 9 && Math.hypot(x, z) < 118 &&
      siteDist(x, z) > defectMargin &&
      pathDist(x, z) > pathMargin &&
      riverDist(x, z) > riverMargin &&
      cottageDist(x, z) > cottageMargin &&
      !nearBridge(x, z);

  function scatter(count, accept) {
    const spots = [];
    let guard = count * 50;
    while (spots.length < count && guard-- > 0) {
      const x = (rand() - 0.5) * 250;
      const z = (rand() - 0.5) * 250;
      const h = height(x, z);
      if (accept(x, z, h)) spots.push({ x, z, h });
    }
    return spots;
  }

  function instanced(geometry, material, spots, { sMin = 1, sMax = 1, colorsList = null, shadow = false }) {
    const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
    const col = new THREE.Color();
    spots.forEach((sp, i) => {
      // If the spot carries a scale (multi-part objects like trees must share
      // one scale across all their meshes), use it exactly; otherwise random.
      const s = sp.s !== undefined ? sp.s : sMin + rand() * (sMax - sMin);
      _q.setFromAxisAngle(_up, rand() * Math.PI * 2);
      _p.set(sp.x, sp.h, sp.z);
      _s.set(s, s, s);
      mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
      if (colorsList) mesh.setColorAt(i, col.set(colorsList[Math.floor(rand() * colorsList.length)]));
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = shadow;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  }

  // ---- grass: tapered, bent, wind-swayed blades in clusters -----------------------------
  function makeBladeGeometry() {
    const levels = [
      { y: 0.00, w: 0.046, b: 0.000, shade: 0.55 },
      { y: 0.15, w: 0.034, b: 0.025, shade: 0.75 },
      { y: 0.28, w: 0.020, b: 0.070, shade: 0.92 },
      { y: 0.40, w: 0.000, b: 0.130, shade: 1.10 },
    ];
    const p = [], col = [];
    const push = (a, side) => { p.push(side * a.w / 2, a.y, a.b); col.push(a.shade, a.shade, a.shade); };
    for (let i = 0; i < levels.length - 1; i++) {
      const lo = levels[i], hi = levels[i + 1];
      // quad (degenerates to a triangle at the tip)
      push(lo, -1); push(lo, 1); push(hi, 1);
      push(lo, -1); push(hi, 1); push(hi, -1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    g.computeVertexNormals();
    return g;
  }

  const grassMat = toon({ color: '#ffffff', vertexColors: true, side: THREE.DoubleSide });
  grassMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       #ifdef USE_INSTANCING
         vec2 ip = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
         float ph = ip.x * 0.35 + ip.y * 0.45;
         float sw = position.y * position.y * 6.25; // quadratic taper from the base
         transformed.x += (sin(uTime * 1.7 + ph) * 0.06 + sin(uTime * 3.3 + ph * 1.7) * 0.022) * sw;
         transformed.z += cos(uTime * 1.4 + ph * 1.3) * 0.045 * sw;
       #endif`
    );
  };

  {
    const acceptGrass = meadow(2.0, 5.0, 5.5);
    const centers = scatter(LOW ? 1400 : 3400, acceptGrass);
    const spots = [];
    const spotCap = LOW ? 32000 : 110000;
    for (const ctr of centers) {
      const n = 16 + Math.floor(rand() * 20);
      for (let i = 0; i < n && spots.length < spotCap; i++) {
        const ang = rand() * Math.PI * 2;
        const rr = Math.sqrt(rand()) * 2.4;
        const x = ctr.x + Math.cos(ang) * rr;
        const z = ctr.z + Math.sin(ang) * rr;
        if (!acceptGrass(x, z, height(x, z))) continue;
        spots.push({ x, z, h: height(x, z) - 0.02 });
      }
    }
    instanced(makeBladeGeometry(), grassMat, spots, {
      sMin: 0.75, sMax: 1.6,
      colorsList: ['#6fb84a', '#84c455', '#9bd161', '#5fa844'],
    });
  }

  // ---- vegetation helpers (desktop) -------------------------------------------
  // The vendored three is the core build (no BufferGeometryUtils), so primitives
  // are merged by hand: each part is made non-indexed (triangle soup) and its
  // positions are concatenated. Flat shading derives face normals in-shader; we
  // still computeVertexNormals so the attribute exists. Baked colours are LINEAR
  // (THREE.Color(hex).r/g/b) to match what `color: hex` would produce. None of
  // these helpers touch the shared `rand`, so scatter positions are unaffected.
  const linRGB = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
  const _ni = (g) => (g.index ? g.toNonIndexed() : g);
  function mergePos(geos) {
    geos = geos.map(_ni);
    let n = 0; for (const g of geos) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3); let o = 0;
    for (const g of geos) { pos.set(g.attributes.position.array, o); o += g.attributes.position.count * 3; }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.computeVertexNormals();
    return out;
  }
  function mergeColored(parts) {
    parts = parts.map((q) => ({ geo: _ni(q.geo), color: q.color }));
    let n = 0; for (const q of parts) n += q.geo.attributes.position.count;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3); let o = 0;
    for (const q of parts) {
      const a = q.geo.attributes.position.array, m = q.geo.attributes.position.count;
      pos.set(a, o * 3);
      for (let i = 0; i < m; i++) { col[(o + i) * 3] = q.color[0]; col[(o + i) * 3 + 1] = q.color[1]; col[(o + i) * 3 + 2] = q.color[2]; }
      o += m;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.computeVertexNormals();
    return out;
  }
  // lumpy icosahedron: vertices displaced by a smooth function of DIRECTION, so
  // duplicated corners move together (no tears) -> a unique faceted blob.
  function lumpIcosa(radius, amp, off) {
    const g = new THREE.IcosahedronGeometry(radius, 0);
    const pa = g.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
      const r = Math.hypot(x, y, z) || 1, nx = x / r, ny = y / r, nz = z / r;
      const f = 1 + amp * noise.fbm(nx * 1.8 + ny * 0.9 + off, nz * 1.8 - ny * 0.7 + off, 2);
      pa.setXYZ(i, x * f, y * f, z * f);
    }
    return _ni(g);
  }
  // tapered cylinder strut a -> b (tree branches), non-indexed.
  const _vA = new THREE.Vector3(), _vUp = new THREE.Vector3(0, 1, 0), _mR = new THREE.Matrix4(), _qR = new THREE.Quaternion();
  function strut(ax, ay, az, bx, by, bz, r0, r1) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, h = Math.hypot(dx, dy, dz) || 1e-3;
    const g = new THREE.CylinderGeometry(r1, r0, h, 5); g.translate(0, h / 2, 0);
    _vA.set(dx / h, dy / h, dz / h); _qR.setFromUnitVectors(_vUp, _vA);
    g.applyMatrix4(_mR.makeRotationFromQuaternion(_qR)); g.translate(ax, ay, az);
    return _ni(g);
  }

  // ---- trees ------------------------------------------------------------------
  // One scale per tree, shared across its instanced layer(s).
  const treeSpots = scatter(110, meadow(5, 6.5, 8, 6))
    .map((sp) => ({ ...sp, s: 0.8 + rand() * 0.8 }));
  // 8 extra trees filling the open west meadow around the relocated HW cell
  // (uses the same meadow predicate, so they stay clear of the cell, cottages,
  // road and river; both the mobile and desktop tree paths read treeSpots).
  {
    const acceptTree = meadow(4, 6.5, 8, 7);
    let need = 8, guard = 6000;
    while (need > 0 && guard-- > 0) {
      const x = -46 + rand() * 30;   // x in [-46, -16]
      const z = -12 + rand() * 24;   // z in [-12, 12]
      const h = height(x, z);
      if (acceptTree(x, z, h)) { treeSpots.push({ x, z, h, s: 0.9 + rand() * 0.7 }); need--; }
    }
  }
  if (LOW) {
    // mobile: cheap trunk + two faceted blobs (unchanged)
    const trunkGeo = new THREE.CylinderGeometry(0.14, 0.22, 2.0, 6); trunkGeo.translate(0, 1.0, 0);
    const canopyGeo = new THREE.IcosahedronGeometry(1.25, 0); canopyGeo.scale(1, 0.82, 1); canopyGeo.translate(0, 2.6, 0);
    const canopyTopGeo = new THREE.IcosahedronGeometry(0.8, 0); canopyTopGeo.translate(0.3, 3.5, 0.1);
    instanced(trunkGeo, toon({ color: '#7a5232' }), treeSpots, { sMin: 0.8, sMax: 1.6, shadow: true });
    instanced(canopyGeo, toon({ color: '#ffffff', flatShading: true }), treeSpots, { sMin: 0.8, sMax: 1.6, shadow: true, colorsList: ['#3f8a3c', '#4e9b45', '#5da84b'] });
    instanced(canopyTopGeo, toon({ color: '#ffffff', flatShading: true }), treeSpots, { sMin: 0.8, sMax: 1.6, shadow: true, colorsList: ['#62b04f', '#76b85a', '#8ac562'] });
  } else {
    // desktop: 4 merged variants (trunk + branches + 4-5 lumpy foliage blobs),
    // vertex-coloured, one flat-shaded draw call each. Per-tree variety = variant
    // x random yaw/scale; foliage is lush (big, overlapping blobs).
    const greens = ['#3f8a3c', '#4e9b45', '#5da84b', '#62b04f', '#56a049', '#6ab057'];
    const brown = linRGB('#7a5232'), brown2 = linRGB('#6b4a2c');
    const treeVariant = (seed) => {
      const r = mulberry32(seed), parts = [];
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
    };
    const treeMat = toon({ vertexColors: true }); // faceted via the merged geometry's face normals
    // Variant seeds: 9002 dropped (undesired form), replaced by 9005.
    const treeSeeds = [9001, 9005, 9003, 9004];
    for (let vi = 0; vi < 4; vi++) {
      const grp = treeSpots.filter((_, i) => i % 4 === vi);
      instanced(treeVariant(treeSeeds[vi]), treeMat, grp, { shadow: true });
    }
  }

  // ---- bushes -----------------------------------------------------------------
  if (LOW) {
    const bushGeo = new THREE.IcosahedronGeometry(0.45, 0); bushGeo.scale(1, 0.7, 1); bushGeo.translate(0, 0.26, 0);
    instanced(bushGeo, toon({ color: '#ffffff', flatShading: true }), scatter(280, meadow(3, 5, 6)), { sMin: 0.7, sMax: 1.6, shadow: true, colorsList: ['#2f7a35', '#3c8a3e', '#48953f'] });
  } else {
    // desktop: a clump of 3 lumpy icosas; per-instance green keeps the variety.
    const r = mulberry32(8881), bparts = [];
    for (let i = 0; i < 3; i++) {
      const ang = r() * Math.PI * 2, rad = i === 0 ? 0 : 0.16 + r() * 0.2;
      const g = lumpIcosa(0.3 + r() * 0.18, 0.24, r() * 60); g.scale(1, 0.74, 1);
      g.translate(Math.cos(ang) * rad, 0.2 + r() * 0.14, Math.sin(ang) * rad);
      bparts.push(g);
    }
    instanced(mergePos(bparts), toon({ color: '#ffffff' }), scatter(280, meadow(3, 5, 6)), { sMin: 0.7, sMax: 1.6, shadow: true, colorsList: ['#2f7a35', '#3c8a3e', '#48953f'] });
  }

  // ---- flowers ----------------------------------------------------------------
  const flowerColors = ['#ffffff', '#ffd34d', '#ff7eb6', '#b48cff', '#ff9d5c'];
  // shared bloom icosa (function scope): mobile flowers, desktop blooms, and the
  // dense per-defect patch below all instance it.
  const bloomGeo = new THREE.IcosahedronGeometry(0.055, 0); bloomGeo.translate(0, 0.2, 0);
  if (LOW) {
    instanced(bloomGeo, toon({ color: '#ffffff' }), scatter(420, meadow(2.5, 5, 5)), { sMin: 0.8, sMax: 1.4, colorsList: flowerColors });
  } else {
    // desktop: stem + a small grass tuft at the base (green, one draw call) plus
    // the coloured bloom on top. A shared per-spot scale keeps them aligned.
    const flowerSpots = scatter(420, meadow(2.5, 5, 5)).map((sp) => ({ ...sp, s: 0.8 + rand() * 0.6 }));
    const flowerBase = () => {
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
      return mergeColored(parts);
    };
    instanced(flowerBase(), toon({ vertexColors: true }), flowerSpots, {});
    instanced(bloomGeo, toon({ color: '#ffffff' }), flowerSpots, { colorsList: flowerColors });
  }

  // dense flower patch directly beneath each defect
  {
    const patch = [];
    for (const s of DEFECT_SITES) {
      for (let i = 0; i < 48; i++) {
        const ang = rand() * Math.PI * 2;
        const rr = Math.sqrt(rand()) * 1.7;
        const x = s.x + Math.cos(ang) * rr;
        const z = s.z + Math.sin(ang) * rr;
        patch.push({ x, z, h: height(x, z) });
      }
    }
    instanced(bloomGeo, toon({ color: '#ffffff' }), patch, {
      sMin: 0.9, sMax: 1.5,
      colorsList: flowerColors,
    });
  }

  // ---- boulders: a cluster around the defect + scattered ---------------------------------------
  {
    const boulderGeo = new THREE.IcosahedronGeometry(0.7, 1);
    const nearDefect = [
      { x: 3.5, z: -2.5, s: 1.5 }, { x: -4.2, z: 1.5, s: 1.1 }, { x: 1.5, z: 4.2, s: 0.8 },
      { x: 5.2, z: 2.2, s: 1.9 }, { x: -2.5, z: -4.5, s: 1.2 }, { x: -1.0, z: 3.0, s: 0.6 },
    ];
    const spots = nearDefect.map((b) => ({ x: b.x, z: b.z, h: height(b.x, b.z), s: b.s }));
    spots.push(...scatter(55, meadow(3, 2, 6)));
    const mesh = new THREE.InstancedMesh(
      boulderGeo, toon({ color: '#ffffff', flatShading: true }), spots.length);
    const col = new THREE.Color();
    const grays = ['#9a9ba1', '#85868d', '#a8a9ad', '#77787f'];
    spots.forEach((sp, i) => {
      const s = sp.s ?? (0.5 + rand() * 1.3);
      _q.setFromEuler(new THREE.Euler(rand() * 0.6, rand() * Math.PI * 2, rand() * 0.6));
      _p.set(sp.x, sp.h - 0.18 * s, sp.z);
      _s.set(s * (0.8 + rand() * 0.5), s * (0.6 + rand() * 0.5), s * (0.8 + rand() * 0.5));
      mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
      mesh.setColorAt(i, col.set(grays[Math.floor(rand() * grays.length)]));
    });
    mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  // ---- cottages ------------------------------------------------------------------------------------
  function gableRoofGeometry(w, d, h) {
    const A = [-w / 2, 0, -d / 2], B = [w / 2, 0, -d / 2];
    const C = [w / 2, 0, d / 2], D = [-w / 2, 0, d / 2];
    const P = [0, h, -d / 2], Q = [0, h, d / 2];
    const tris = [
      A, P, Q, A, Q, D,        // left slope
      B, C, Q, B, Q, P,        // right slope
      A, B, P, C, D, Q,        // gable ends
      A, B, C, A, C, D,        // base — closes the prism (can't see up inside)
    ].flat();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris), 3));
    g.computeVertexNormals();
    return g;
  }

  function buildCottage() {
    const g = new THREE.Group();
    const wall = toon({ color: '#efe4cd' });
    const roof = toon({ color: '#8c4a36', flatShading: true, side: THREE.DoubleSide });
    const wood = toon({ color: '#5e4128' });
    const glass = toon({ color: '#39506b' });
    const add = (mesh, x, y, z) => { mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh); return mesh; };

    add(new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.6, 3.4), wall), 0, 1.3, 0);
    add(new THREE.Mesh(gableRoofGeometry(4.9, 4.0, 1.5), roof), 0, 2.6, 0);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.5, 0.5), toon({ color: '#9a9ba1' })), 1.2, 3.2, 0.5);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.7, 0.1), wood), 0.6, 0.85, 1.72);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.75, 0.1), glass), -1.2, 1.5, 1.72);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.75, 0.75), glass), 2.12, 1.5, -0.4);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.75, 0.75), glass), -2.12, 1.5, 0.3);
    return g;
  }

  const cottageColliders = [];
  for (const cSpot of COTTAGES) {
    const cottage = buildCottage();
    cottage.position.set(cSpot.x, cSpot.baseH, cSpot.z);
    cottage.rotation.y = cSpot.rot;
    scene.add(cottage);
    // solid box: wall footprint 4.2 x 3.4, up to the roof peak (~4.1 m)
    cottageColliders.push({
      x: cSpot.x, z: cSpot.z,
      cos: Math.cos(cSpot.rot), sin: Math.sin(cSpot.rot),
      hw: 2.1, hd: 1.7, baseY: cSpot.baseH, top: cSpot.baseH + 4.1,
    });
  }

  // ---- per-frame updates --------------------------------------------------------------------------
  function update(dt) {
    uTime.value += dt;
    const t = uTime.value;
    for (const g of clouds.children) {
      g.position.x += 1.4 * dt;
      if (g.position.x > 320) g.position.x = -320;
    }
    for (const gull of gulls.children) {
      const u = gull.userData;
      const a = u.ph + u.w * t * 4;
      const px = u.cx + Math.cos(a) * u.r;
      const pz = u.cz + Math.sin(a) * u.r;
      const py = u.y + Math.sin(t * 0.7 + u.ph) * 1.2;
      gull.position.set(px, py, pz);
      const a2 = a + (u.w > 0 ? 0.08 : -0.08);
      gull.lookAt(u.cx + Math.cos(a2) * u.r, py, u.cz + Math.sin(a2) * u.r);
      const f = Math.sin(t * u.flap + u.ph) * 0.55 + 0.1;
      u.wings[0].rotation.z = f;
      u.wings[1].rotation.z = -f;
    }
  }

  // Floor height for the camera: terrain, or the bridge deck when on it.
  // The deck only counts when approaching from above (y), so the observer
  // can still fly UNDER the arches.
  function worldFloor(x, z, y = Infinity) {
    const h = height(x, z);
    const deck = bridgeDeckY(x, z);
    let f = h;
    if (deck > h && y > deck - 0.6) f = deck;
    return Math.max(f, RIVER_LEVEL); // water is solid: never sink below the surface
  }

  return {
    getHeight: worldFloor,
    update,
    cottages: cottageColliders,
    boundsRadius: BOUNDS_RADIUS,
    maxAltitude: MAX_ALTITUDE,
    sunDir,
  };
}
