// Defect site coordinates, shared between main.js (defect placement) and
// world.js (vegetation clearance + flower patches beneath each defect).
export const DEFECT_SITES = [
  { x: 0, z: 0 },      // 0 torus cell
  { x: 30, z: 12 },    // 1 quarter-turn cube
  { x: -28, z: 22 },   // 2 sixth-turn hexagonal prism
  { x: 44, z: -20 },   // 3 half-turn cube
  { x: 12, z: 36 },    // 4 third-turn hexagonal prism
  { x: -30, z: -6 },   // 5 Hantzsche–Wendt didicosm (moved into the open west meadow)
  { x: -14, z: -32 },  // 6 first amphicosm (Klein bottle × S¹), open south meadow
  { x: 6, z: -46 },    // 7 second amphicosm (swap-glide torus bundle), open south meadow
  { x: 24, z: -38 },   // 8 first amphidicosm (mm2), open south-east meadow
];
