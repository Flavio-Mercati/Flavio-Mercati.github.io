// Deterministic, seedable 2D value noise + fbm, and a small PRNG.
// Copied verbatim from the parent "topo-defects" project so the two share one
// reproducible noise basis. Kept dependency-free.

export function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createNoise(seed = 1) {
  function hash(xi, yi) {
    let h = Math.imul(xi, 374761393) + Math.imul(yi, 668265263) + Math.imul(seed, 69069);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296; // [0, 1)
  }

  // Smooth value noise in [-1, 1]
  function value(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = hash(xi, yi), b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 2 - 1;
  }

  // Fractal Brownian motion in [-1, 1]
  function fbm(x, y, octaves = 4) {
    let amp = 1, sum = 0, norm = 0, fx = x, fy = y;
    for (let i = 0; i < octaves; i++) {
      sum += amp * value(fx, fy);
      norm += amp;
      amp *= 0.5;
      fx = fx * 2.03 + 11.7;
      fy = fy * 2.03 + 5.3;
    }
    return sum / norm;
  }

  return { value, fbm };
}
