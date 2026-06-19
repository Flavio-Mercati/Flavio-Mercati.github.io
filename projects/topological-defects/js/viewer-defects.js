// Mobile viewer + gallery — defect catalog (single source of truth).
//
// One entry per gluing-cell defect, in the same order, at the same site and the
// same size as the full scene (main.js). The mobile viewer, the gallery and the
// standalone bundler all build their lists from here, so adding a defect to the
// scene means adding one line here.
//
//   key    URL hash / window id (viewer.html#<key>)
//   site   index into DEFECT_SITES (places it exactly where the full sim does)
//   orientable  true = orientable (yellow sign) · false = non-orientable (green)
//   spinorial   orientable cells only: true → (spin ½) written, false → (spin 1)
//   sub    short tag shown in the window's title bar
//   label  the full signpost copy {title, aka, body}, verbatim from main.js /
//          defect_labels.md — shown on the window's plaque
//   make   builds the defect at position p, identically to main.js

import {
  createTorusDefect, createQuarterTurnDefect, createHalfTurnDefect,
  createHexScrewDefect, createHantzscheWendtDefect, createFirstAmphicosmDefect,
  createSecondAmphicosmDefect, createFirstAmphidicosmDefect,
} from './defect.js';

export const VIEWER_DEFECTS = [
  {
    key: 'torus', site: 0, orientable: true, spinorial: true, sub: 'T³ cell · pure translation',
    label: {
      title: `Torus defect`,
      aka:   `the 3-torus, T³ = S¹×S¹×S¹ · Conway's torocosm · the trivial flat space form`,
      body:  `Opposite faces glued straight across by pure translation. The flat 3-manifold with trivial holonomy — leave through one wall and return through the wall behind you, unrotated. Seam-free, the only cell without edge singularities.`,
    },
    make: (p) => createTorusDefect(p, 1.0),
  },
  {
    key: 'quarter', site: 1, orientable: true, spinorial: true, sub: 'tetracosm · 90° twist',
    label: {
      title: `Quarter-turn defect`,
      aka:   `the tetracosm · the quarter-turn flat space form (holonomy ℤ/4)`,
      body:  `A cube whose opposite faces are glued with a 90° twist. A flat 3-manifold in which a wall meets its partner rotated a quarter turn; circulate the right loop and the world comes back spun by 90°. Shown as a flattened stand-in: all three face-pairs twist, so the edges carry conical seams the smooth manifold has not.`,
    },
    make: (p) => createQuarterTurnDefect(p, 1.0),
  },
  {
    key: 'hex6', site: 2, orientable: true, spinorial: true, sub: 'hexacosm · 60° cap screw',
    label: {
      title: `Sixth-turn defect`,
      aka:   `the hexacosm · the sixth-turn flat space form (holonomy ℤ/6)`,
      body:  `A hexagonal cell: the six sides glue straight, the two caps glue with a 60° screw. One of the six closed flat 3-manifolds, the one with the tightest rotational holonomy.`,
    },
    make: (p) => createHexScrewDefect(p, Math.PI / 3, 'Sixth-turn defect', 0.64, 1.0),
  },
  {
    key: 'half', site: 3, orientable: true, spinorial: true, sub: 'dicosm · 180° twist',
    label: {
      title: `Half-turn defect`,
      aka:   `the dicosm · the half-turn flat space form (holonomy ℤ/2)`,
      body:  `A cube whose opposite faces are glued with a 180° twist. A flat 3-manifold; the partner wall arrives rotated a half turn, so “up” through it points down. Shown as a flattened stand-in: all three face-pairs twist, so the edges carry conical seams the smooth manifold has not.`,
    },
    make: (p) => createHalfTurnDefect(p, 1.0),
  },
  {
    key: 'hex3', site: 4, orientable: true, spinorial: true, sub: 'tricosm · 120° cap screw',
    label: {
      title: `Third-turn defect`,
      aka:   `the tricosm · the third-turn flat space form (holonomy ℤ/3)`,
      body:  `A hexagonal cell: sides glued straight, caps glued with a 120° screw. Another of the six closed flat 3-manifolds, sibling to the sixth-turn cell.`,
    },
    make: (p) => createHexScrewDefect(p, 2 * Math.PI / 3, 'Third-turn defect', 0.64, 1.0),
  },
  {
    key: 'hw', site: 5, orientable: true, spinorial: true, sub: 'didicosm · holonomy ℤ/2×ℤ/2',
    label: {
      title: `Hantzsche–Wendt space`,
      aka:   `the Hantzsche–Wendt manifold · the didicosm (holonomy ℤ/2×ℤ/2)`,
      body:  `The sixth and last closed orientable flat 3-manifold, completing the platycosms — and the only flat space form that is a rational homology sphere, with finite first homology. A rhombic-dodecahedral cell (the Dirichlet domain of an offset basepoint); its twelve faces glue in six pairs by three mutually perpendicular, non-intersecting half-turn screws. The screws share no fixed point, so unlike the cube cells this is the genuine smooth manifold — no central singularity, seam-free, with holonomy ℤ/2×ℤ/2.`,
    },
    make: (p) => createHantzscheWendtDefect(p, 0.9),
  },
  {
    key: 'amphi1', site: 6, orientable: false, sub: 'amphicosm · glide reflection',
    label: {
      title: `First amphicosm`,
      aka:   `Klein bottle × S¹ · the first amphicosm · a non-orientable flat space form (holonomy ℤ/2)`,
      body:  `A cube whose ±x and ±y faces glue by pure translation while the ±z pair glues with a glide reflection — exit the top and re-enter the bottom mirror-reversed. The x–z section is a flat Klein bottle and the y direction a circle, so the cell is Klein bottle × S¹: the first non-orientable flat 3-manifold. Cross a glide wall and the world returns left–right reversed; cross it twice and the reversal cancels. A genuine smooth manifold, seam-free like the torus.`,
    },
    make: (p) => createFirstAmphicosmDefect(p, 1.0),
  },
  {
    key: 'amphi2', site: 7, orientable: false, sub: 'swap glide · torus bundle',
    label: {
      title: `Second amphicosm`,
      aka:   `the swap-glide torus bundle · the second amphicosm · a non-orientable flat space form (holonomy ℤ/2)`,
      body:  `A cube whose ±x and ±y faces glue by pure translation while the ±z pair glues with a swap glide reflection — exit the top and re-enter the bottom across the diagonal mirror x = y, with x and y exchanged. It is the mapping torus of the square torus under the order-2 swap, the second of the two non-orientable flat 3-manifolds with ℤ/2 holonomy: distinct from Klein bottle × S¹, whose mirror is axis-aligned rather than diagonal (first homology ℤ² here versus ℤ² ⊕ ℤ/2 there). Cross the swap wall and the world returns mirror-reversed with x and y traded; cross it twice and both undo. A genuine smooth manifold, seam-free like the torus.`,
    },
    make: (p) => createSecondAmphicosmDefect(p, 1.0),
  },
  {
    key: 'amphidi1', site: 8, orientable: false, sub: 'mm2 · two mirrors + half-turn',
    label: {
      title: `First amphidicosm`,
      aka:   `the first amphidicosm · a non-orientable flat space form (holonomy ℤ/2×ℤ/2)`,
      body:  `The non-orientable sibling of the Hantzsche–Wendt didicosm — the same Klein-four holonomy ℤ/2×ℤ/2, but realised with mirrors instead of half-turns, so handedness is not preserved. A cube whose ±x and ±z faces each glue by a glide reflection (reflecting y and x respectively) while the ±y pair glues by pure translation; the two mirrors compose to a half-turn about the vertical axis, giving the point group mm2 — two reflections and one rotation. Every gluing slides within its mirror with no fixed point, so it is a genuine smooth manifold, seam-free like the torus. Cross either mirror wall and the world returns reversed; the two reversals compose into the half-turn.`,
    },
    make: (p) => createFirstAmphidicosmDefect(p, 1.0),
  },
];
