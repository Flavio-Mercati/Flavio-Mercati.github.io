// A signpost carrying a museum-style label, readable from both sides.
//
// Each label is { title, aka, body }: a name, an italic "also known as" line,
// and a short description. It is drawn onto a canvas texture and AUTO-FITTED —
// the title size is stepped down until the whole wrapped block (title + aka +
// rule + body) fits the board's content box, so labels of very different
// lengths each render as large as they can while staying inside the frame.
//
// Red signs mark spinorial defects (those that can carry spin-½);
// yellow marks the non-spinorial ones.

import * as THREE from 'three';

const THEMES = {
  yellow: { bg: '#ffd23f', border: '#5e431f', text: '#3a2c18', sub: '#5b4322', rule: '#b98e2c', edge: '#e6b833' },
  red:    { bg: '#cf3b32', border: '#571410', text: '#fff6ea', sub: '#f4cdc1', rule: '#e58c7c', edge: '#b03028' },
};

const FONT = "Georgia, 'Times New Roman', serif";

// Greedy word-wrap at the current ctx.font; returns an array of lines.
function wrapLines(ctx, text, maxWidth) {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function createSignpost(label, red = false) {
  const theme = red ? THEMES.red : THEMES.yellow;
  const title = label.title || '';
  const aka = label.aka || '';
  const body = label.body || '';

  const g = new THREE.Group();

  const wood = new THREE.MeshToonMaterial({ color: '#6b4a2c' });
  // radius must stay below the board's half-thickness (0.03) so the pole
  // never pokes through the board faces
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 1.15, 6), wood);
  post.position.y = 0.575;
  post.castShadow = true;
  g.add(post);

  // ---- label texture (auto-fitted) -----------------------------------------
  const W = 1024, H = 488;            // ≈ the 1.24 : 0.59 board face aspect
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // frame
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 26;
  ctx.strokeRect(13, 13, W - 26, H - 26);

  const PAD = 52;
  const boxW = W - 2 * PAD;
  const boxH = H - 2 * PAD;
  const boxY = PAD;

  // Lay the label out for a trial title size `s` (px). Returns the resolved
  // fonts, wrapped lines and total block height, or null if it overflows.
  function layoutFor(s) {
    const titleFont = `bold ${s}px ${FONT}`;
    const akaFont = `italic ${Math.round(s * 0.50)}px ${FONT}`;
    const bodyFont = `${Math.round(s * 0.58)}px ${FONT}`;
    const titleLH = s * 1.12;
    const akaLH = s * 0.50 * 1.24;
    const bodyLH = s * 0.58 * 1.32;

    ctx.font = titleFont;
    const titleLines = wrapLines(ctx, title, boxW);
    ctx.font = akaFont;
    const akaLines = wrapLines(ctx, aka, boxW);
    ctx.font = bodyFont;
    const bodyLines = wrapLines(ctx, body, boxW);

    const gapTitleAka = akaLines.length ? s * 0.22 : 0;
    const gapAkaRule = bodyLines.length ? s * 0.34 : 0;
    const gapRuleBody = bodyLines.length ? s * 0.40 : 0;

    const total =
      titleLines.length * titleLH +
      gapTitleAka + akaLines.length * akaLH +
      gapAkaRule + gapRuleBody +
      bodyLines.length * bodyLH;

    if (total > boxH) return null;
    return {
      s, titleFont, akaFont, bodyFont, titleLH, akaLH, bodyLH,
      titleLines, akaLines, bodyLines, gapTitleAka, gapAkaRule, gapRuleBody, total,
    };
  }

  // Largest title size that fits (step down 1px at a time; ~50 cheap passes,
  // done once at construction).
  let L = null;
  for (let s = 66; s >= 13; s--) {
    L = layoutFor(s);
    if (L) break;
  }
  if (!L) L = layoutFor(13);

  // draw, vertically centred in the content box
  let y = boxY + (boxH - L.total) / 2;
  const cx = W / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  ctx.fillStyle = theme.text;
  ctx.font = L.titleFont;
  for (const ln of L.titleLines) { ctx.fillText(ln, cx, y); y += L.titleLH; }

  if (L.akaLines.length) {
    y += L.gapTitleAka;
    ctx.fillStyle = theme.sub;
    ctx.font = L.akaFont;
    for (const ln of L.akaLines) { ctx.fillText(ln, cx, y); y += L.akaLH; }
  }

  if (L.bodyLines.length) {
    y += L.gapAkaRule;
    ctx.strokeStyle = theme.rule;
    ctx.lineWidth = Math.max(2, L.s * 0.05);
    ctx.beginPath();
    ctx.moveTo(cx - boxW * 0.28, Math.round(y) + 0.5);
    ctx.lineTo(cx + boxW * 0.28, Math.round(y) + 0.5);
    ctx.stroke();
    y += L.gapRuleBody;
    ctx.fillStyle = theme.text;
    ctx.font = L.bodyFont;
    for (const ln of L.bodyLines) { ctx.fillText(ln, cx, y); y += L.bodyLH; }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  // board (colored edges) + a textured face on each side, both readable
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(1.3, 0.65, 0.06),
    new THREE.MeshToonMaterial({ color: theme.edge })
  );
  board.position.y = 1.25;
  board.castShadow = true;
  g.add(board);

  const faceMat = new THREE.MeshToonMaterial({ map: tex });
  const faceGeo = new THREE.PlaneGeometry(1.24, 0.59);
  const front = new THREE.Mesh(faceGeo, faceMat);
  front.position.set(0, 1.25, 0.033);
  g.add(front);
  const back = new THREE.Mesh(faceGeo, faceMat);
  back.position.set(0, 1.25, -0.033);
  back.rotation.y = Math.PI;
  g.add(back);

  return g;
}
