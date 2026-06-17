// Defect site coordinates, shared between main.js (defect placement) and
// world.js (vegetation clearance + flower patches beneath each defect).
export const DEFECT_SITES = [
  { x: 0, z: 0 },      // 0 torus cell
  { x: 30, z: 12 },    // 1 quarter-turn cube
  { x: -28, z: 22 },   // 2 sixth-turn hexagonal prism
  { x: -12, z: -34 },  // 3 dodecahedral (Poincaré, 36° twist)
  { x: 44, z: -20 },   // 4 half-turn cube
  { x: 12, z: 36 },    // 5 third-turn hexagonal prism
  { x: -45, z: -8 },   // 6 octahedral (60° twist)
  { x: -2, z: -38 },   // 7 Seifert–Weber dodecahedral (108° twist) — beside the Poincaré cell
  { x: 56, z: 18 },    // 8 lens space L(7,1) — NE meadow, paired with L(7,2)
  { x: 64, z: 18 },    // 9 lens space L(7,2) — same shape, different screw
  { x: 38, z: 4 },     // 10 Hantzsche–Wendt didicosm — near the other flat cube cells
];
