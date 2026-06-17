// Mobile viewer + gallery — defect catalog (single source of truth).
//
// One entry per gluing-cell defect, in the same order, at the same site and the
// same size as the full scene (main.js). The mobile viewer, the gallery and the
// standalone bundler all build their lists from here, so adding a defect to the
// scene means adding one line here.
//
//   key    URL hash / window id (viewer.html#<key>)
//   site   index into DEFECT_SITES (places it exactly where the full sim does)
//   red    true = spinorial (red sign) · false = non-spinorial (yellow sign)
//   sub    short tag shown in the window's title bar
//   label  the full signpost copy {title, aka, body}, verbatim from main.js /
//          defect_labels.md — shown on the window's plaque
//   make   builds the defect at position p, identically to main.js

import {
  createTorusDefect, createQuarterTurnDefect, createHalfTurnDefect,
  createHexScrewDefect, createDodecahedralDefect, createOctahedralDefect,
  createSeifertWeberDefect, createLensSpaceDefect, createHantzscheWendtDefect,
} from './defect.js';

export const VIEWER_DEFECTS = [
  {
    key: 'torus', site: 0, red: true, sub: 'T³ cell · pure translation',
    label: {
      title: `Torus defect`,
      aka:   `the 3-torus, T³ = S¹×S¹×S¹ · Conway's torocosm · the trivial flat space form`,
      body:  `Opposite faces glued straight across by pure translation. The flat 3-manifold with trivial holonomy — leave through one wall and return through the wall behind you, unrotated. Seam-free, the only cell without edge singularities.`,
    },
    make: (p) => createTorusDefect(p, 1.0),
  },
  {
    key: 'quarter', site: 1, red: true, sub: 'tetracosm · 90° twist',
    label: {
      title: `Quarter-turn defect`,
      aka:   `the tetracosm · the quarter-turn flat space form (holonomy ℤ/4)`,
      body:  `A cube whose opposite faces are glued with a 90° twist. A flat 3-manifold in which a wall meets its partner rotated a quarter turn; circulate the right loop and the world comes back spun by 90°. Shown as a flattened stand-in: all three face-pairs twist, so the edges carry conical seams the smooth manifold has not.`,
    },
    make: (p) => createQuarterTurnDefect(p, 1.0),
  },
  {
    key: 'hex6', site: 2, red: true, sub: 'hexacosm · 60° cap screw',
    label: {
      title: `Sixth-turn defect`,
      aka:   `the hexacosm · the sixth-turn flat space form (holonomy ℤ/6)`,
      body:  `A hexagonal cell: the six sides glue straight, the two caps glue with a 60° screw. One of the six closed flat 3-manifolds, the one with the tightest rotational holonomy.`,
    },
    make: (p) => createHexScrewDefect(p, Math.PI / 3, 'Sixth-turn defect', 0.64, 1.0),
  },
  {
    key: 'dodeca', site: 3, red: true, sub: 'Poincaré sphere · 36° twist',
    label: {
      title: `Dodecahedral defect`,
      aka:   `the Poincaré homology sphere · Poincaré dodecahedral space · S³/2I (binary icosahedral) · Σ(2,3,5)`,
      body:  `A dodecahedron with opposite pentagons glued by a 36° twist. A spherical space form with the same homology as a sphere but a non-trivial fundamental group of order 120 — the counterexample that forced Poincaré to refine his conjecture.`,
    },
    make: (p) => createDodecahedralDefect(p, 1.1),
  },
  {
    key: 'half', site: 4, red: true, sub: 'dicosm · 180° twist',
    label: {
      title: `Half-turn defect`,
      aka:   `the dicosm · the half-turn flat space form (holonomy ℤ/2)`,
      body:  `A cube whose opposite faces are glued with a 180° twist. A flat 3-manifold; the partner wall arrives rotated a half turn, so “up” through it points down. Shown as a flattened stand-in: all three face-pairs twist, so the edges carry conical seams the smooth manifold has not.`,
    },
    make: (p) => createHalfTurnDefect(p, 1.0),
  },
  {
    key: 'hex3', site: 5, red: true, sub: 'tricosm · 120° cap screw',
    label: {
      title: `Third-turn defect`,
      aka:   `the tricosm · the third-turn flat space form (holonomy ℤ/3)`,
      body:  `A hexagonal cell: sides glued straight, caps glued with a 120° screw. Another of the six closed flat 3-manifolds, sibling to the sixth-turn cell.`,
    },
    make: (p) => createHexScrewDefect(p, 2 * Math.PI / 3, 'Third-turn defect', 0.64, 1.0),
  },
  {
    key: 'octa', site: 6, red: true, sub: 'spherical space form · 60° twist',
    label: {
      title: `Octahedral defect`,
      aka:   `a spherical space form · the octahedral opposite-face cell`,
      body:  `An octahedron with its four pairs of opposite triangles glued by a 60° twist — a quotient of the 3-sphere, spinorial like the other closed space forms.`,
    },
    make: (p) => createOctahedralDefect(p, 0.9),
  },
  {
    key: 'seifert', site: 7, red: true, sub: 'closed hyperbolic · 108° twist',
    label: {
      title: `Seifert–Weber space`,
      aka:   `the Seifert–Weber dodecahedral space · the hyperbolic dodecahedral space`,
      body:  `The same dodecahedron as the Poincaré cell, but the opposite faces are glued with a 108° twist instead of 36°. That single change tips it out of spherical geometry into hyperbolic — a closed hyperbolic 3-manifold. Same shape, different universe.`,
    },
    make: (p) => createSeifertWeberDefect(p, 1.1),
  },
  {
    key: 'lens71', site: 8, red: false, sub: 'S³/(ℤ/7) · 2π/7 screw',
    label: {
      title: `Lens space L(7,1)`,
      aka:   `a lens space · the cyclic spherical space form S³/(ℤ/7) · gluing screw 2π/7`,
      body:  `A lens-shaped cell whose top cap glues to its bottom by a 2π/7 screw. A cyclic quotient of the 3-sphere — one of the non-spinorial spherical space forms. Paired here with L(7,2): same shape, same group, a different screw.`,
    },
    make: (p) => createLensSpaceDefect(p, 7, 1, 'Lens space L(7,1)'),
  },
  {
    key: 'lens72', site: 9, red: false, sub: 'S³/(ℤ/7) · 4π/7 screw',
    label: {
      title: `Lens space L(7,2)`,
      aka:   `a lens space · S³/(ℤ/7) · gluing screw 4π/7`,
      body:  `The same heptagonal lens as L(7,1), glued with a 4π/7 screw instead of 2π/7. L(7,1) and L(7,2) are homotopy-equivalent yet not homeomorphic — the classic case where homotopy type fails to pin down a 3-manifold, and Reidemeister torsion is needed to tell them apart.`,
    },
    make: (p) => createLensSpaceDefect(p, 7, 2, 'Lens space L(7,2)'),
  },
  {
    key: 'hw', site: 10, red: true, sub: 'didicosm · holonomy ℤ/2×ℤ/2',
    label: {
      title: `Hantzsche–Wendt space`,
      aka:   `the Hantzsche–Wendt manifold · the didicosm (holonomy ℤ/2×ℤ/2)`,
      body:  `The sixth and last closed orientable flat 3-manifold, completing the platycosms. Its walls glue by half-turns about axes that don't face you squarely — the only flat space form that is a rational homology sphere, with finite first homology. Shown as a flattened stand-in: the centred half-turns leave conical edge seams the smooth manifold has not.`,
    },
    make: (p) => createHantzscheWendtDefect(p, 1.0),
  },
];
