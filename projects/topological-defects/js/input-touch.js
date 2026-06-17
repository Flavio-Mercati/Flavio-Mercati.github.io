// Touch controls for the full simulation on a phone/tablet.
//
// Two additions, exactly mirroring the desktop "dual controls":
//   1. One-finger drag on the canvas LOOKS around. Non-inverted, aim-style:
//      swipe up -> look up, swipe right -> look right (the opposite of the
//      "drag the world" convention). It writes straight into player.yaw /
//      player.pitch, which the controller recomposes into the camera each
//      frame, so it shares the exact same orientation path as mouse-look.
//   2. Three thumb-sized buttons: bottom-left = cruise slow, bottom-right =
//      cruise fast (constant-speed glide along the view direction), top-right
//      = toggle defect outlines. The slow/fast buttons are a 3-way toggle
//      (off / slow / fast); tapping the lit one turns cruise off.
//
// State lives with the caller (player.cruise, defect edge visibility); this
// module only reads/writes it through the supplied callbacks and keeps the
// buttons' lit state in sync.

const LOOK_SENS = 0.005; // rad per pixel — comfortable phone look speed
const PITCH_LIMIT = 1.55;

export function setupMobileControls({ dom, player, setCruise, getCruise, toggleOutlines, getOutlines }) {
  document.body.classList.add('mobile');

  // ---- one-finger look (pointer events, single active finger) --------------
  let lookId = null, lastX = 0, lastY = 0;

  dom.addEventListener('pointerdown', (e) => {
    if (lookId !== null) return;           // already tracking a finger
    lookId = e.pointerId;
    lastX = e.clientX; lastY = e.clientY;
    dom.setPointerCapture?.(e.pointerId);
    hideHint();
    e.preventDefault();
  });

  dom.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookId) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    // aim-style, NOT inverted: swipe right -> look right, swipe up -> look up
    player.yaw -= dx * LOOK_SENS;
    player.pitch -= dy * LOOK_SENS;
    player.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, player.pitch));
  });

  const dropLook = (e) => { if (e.pointerId === lookId) lookId = null; };
  dom.addEventListener('pointerup', dropLook);
  dom.addEventListener('pointercancel', dropLook);
  dom.addEventListener('lostpointercapture', dropLook);

  // ---- the drag hint, fades on first touch ---------------------------------
  const hint = document.getElementById('hint');
  let hintShown = !!hint;
  function hideHint() {
    if (!hintShown) return;
    hintShown = false;
    hint.classList.add('gone');
  }

  // ---- the three buttons ---------------------------------------------------
  const slowBtn = document.getElementById('moveSlow');
  const fastBtn = document.getElementById('moveFast');
  const edgesBtn = document.getElementById('edgesBtn');

  function syncCruiseButtons() {
    const c = getCruise();
    slowBtn.classList.toggle('active', c === 1);
    fastBtn.classList.toggle('active', c === 2);
    slowBtn.setAttribute('aria-pressed', String(c === 1));
    fastBtn.setAttribute('aria-pressed', String(c === 2));
  }
  function syncEdgesButton() {
    const on = getOutlines();
    edgesBtn.classList.toggle('active', on);
    edgesBtn.setAttribute('aria-pressed', String(on));
  }

  // Buttons sit above the canvas; tapping one must not also start a look-drag.
  const tap = (el, fn) => el.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  tap(slowBtn, () => { setCruise(1); syncCruiseButtons(); });
  tap(fastBtn, () => { setCruise(2); syncCruiseButtons(); });
  tap(edgesBtn, () => { toggleOutlines(); syncEdgesButton(); });

  syncCruiseButtons();
  syncEdgesButton();
}
