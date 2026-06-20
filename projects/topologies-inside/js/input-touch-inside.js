// Touch controls for the interior view on a phone / tablet (no on-screen
// legend). One-finger drag looks around (aim-style: swipe right -> look right),
// feeding the same 6-DOF look path as the desktop mouse. The four corners:
//   * bottom-left   #rollCCW  - HOLD to roll anticlockwise (= Q)
//   * bottom-right  #rollCW   - HOLD to roll clockwise     (= E)
//   * bottom-centre #hoverBtn - TAP toggles hover (= H): hold altitude, glide tangentially
//   * top-right     #speedBtn - TAP cycles cruise: still -> slow -> fast -> still
//   * top-left      #edgesBtn - TAP toggles the cell outlines
// In hover, cruise drives you tangentially over the surface (no rise/fall here).

const LOOK_SENS_PX = 1.0; // applyLook already takes pixels; 1:1 with the mouse path

export function setupMobileControls({ dom, player, setCruise, getCruise, toggleOutlines, getOutlines }) {
  document.body.classList.add('mobile');

  // ---- one-finger look -----------------------------------------------------
  let lookId = null, lastX = 0, lastY = 0;
  dom.addEventListener('pointerdown', (e) => {
    if (lookId !== null) return;
    lookId = e.pointerId; lastX = e.clientX; lastY = e.clientY;
    dom.setPointerCapture?.(e.pointerId);
    hideHint();
    e.preventDefault();
  });
  dom.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookId) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    player.applyLook(dx * LOOK_SENS_PX, dy * LOOK_SENS_PX);
  });
  const dropLook = (e) => { if (e.pointerId === lookId) lookId = null; };
  dom.addEventListener('pointerup', dropLook);
  dom.addEventListener('pointercancel', dropLook);
  dom.addEventListener('lostpointercapture', dropLook);

  // ---- the drag hint -------------------------------------------------------
  const hint = document.getElementById('hint');
  let hintShown = !!hint;
  function hideHint() { if (!hintShown) return; hintShown = false; hint.classList.add('gone'); }

  // ---- buttons -------------------------------------------------------------
  const rollCCW = document.getElementById('rollCCW');
  const rollCW = document.getElementById('rollCW');
  const speedBtn = document.getElementById('speedBtn');
  const edgesBtn = document.getElementById('edgesBtn');
  const hoverBtn = document.getElementById('hoverBtn');

  function holdButton(el, onDown, onUp) {
    let held = false;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (held) return; held = true;
      el.setPointerCapture?.(e.pointerId);
      el.classList.add('active'); onDown();
    });
    const release = () => { if (!held) return; held = false; el.classList.remove('active'); onUp(); };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
  }
  // roll while held; release returns roll input to 0
  holdButton(rollCCW, () => player.setRoll(-1), () => player.setRoll(0));
  holdButton(rollCW, () => player.setRoll(1), () => player.setRoll(0));

  const tap = (el, fn) => el.addEventListener('click', (e) => { e.stopPropagation(); fn(); });

  const NEXT_CRUISE = { 0: 1, 1: 2, 2: 0 };
  const SPEED_LABEL = { 0: '\u25A0 Still', 1: '\u25B6 Slow', 2: '\u25B6\u25B6 Fast' };
  function syncSpeedButton() {
    const c = getCruise();
    speedBtn.textContent = SPEED_LABEL[c];
    speedBtn.classList.toggle('active', c !== 0);
    speedBtn.setAttribute('aria-pressed', String(c !== 0));
  }
  tap(speedBtn, () => { setCruise(NEXT_CRUISE[getCruise()]); syncSpeedButton(); });

  function syncEdgesButton() {
    const on = getOutlines();
    edgesBtn.classList.toggle('active', on);
    edgesBtn.setAttribute('aria-pressed', String(on));
  }
  tap(edgesBtn, () => { toggleOutlines(); syncEdgesButton(); });

  // hover toggle: hold a fixed altitude and glide tangentially (= the H key).
  // With cruise on you survey the surface; tap again to drop back to free flight.
  function syncHoverButton() {
    if (!hoverBtn) return;
    const on = !!player.hover;
    hoverBtn.classList.toggle('active', on);
    hoverBtn.setAttribute('aria-pressed', String(on));
  }
  if (hoverBtn) tap(hoverBtn, () => { player.toggleHover(); syncHoverButton(); });

  syncSpeedButton();
  syncEdgesButton();
  syncHoverButton();
}
