// Touch controls for the full simulation on a phone/tablet.
//
// Look: one-finger drag on the canvas looks around. Non-inverted, aim-style:
// swipe up -> look up, swipe right -> look right (the opposite of the "drag the
// world" convention). It writes straight into player.yaw / player.pitch, which
// the controller recomposes into the camera each frame, so it shares the exact
// same orientation path as desktop mouse-look.
//
// Four thumb buttons, one per corner, mirroring the desktop keyboard's vertical
// + cruise controls (the on-screen legend is dropped on touch UI):
//   * top-left     #moveUp   - HOLD to rise along the WORLD vertical   (= Space)
//   * bottom-left  #moveDown - HOLD to descend toward the ground       (= C)
//   * bottom-right #speedBtn - TAP cycles the forward cruise speed:
//                              still -> slow -> fast -> still
//   * top-right    #edgesBtn - TAP toggles defect outlines
//
// The up/down buttons simply inject the same key codes the controller already
// reads (player.keys), so vertical flight runs through player.js's identical
// movement + altitude-clamp path as Space/C -- no special-casing there. The
// speed button drives the caller's cruise via setCruise/getCruise; the edges
// button via toggleOutlines/getOutlines. This module only reads and writes that
// state through the supplied callbacks and keeps each button's lit state in sync.

const LOOK_SENS = 0.005; // rad per pixel -- comfortable phone look speed
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
    player.yaw -= dx * LOOK_SENS * player.parity; // horizontal flips in a mirrored world
    player.pitch -= dy * LOOK_SENS;               // vertical is unmirrored
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

  // ---- the four buttons ----------------------------------------------------
  const upBtn    = document.getElementById('moveUp');
  const downBtn  = document.getElementById('moveDown');
  const speedBtn = document.getElementById('speedBtn');
  const edgesBtn = document.getElementById('edgesBtn');

  // Press-and-hold: lit while a finger is down, firing onDown once on press and
  // onUp once on release (lift / cancel / lost capture). Capturing the pointer
  // keeps the action running even if the thumb drifts off the button before
  // lifting, and means a press that lands here never also starts a look-drag.
  function holdButton(el, onDown, onUp) {
    let held = false;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (held) return;
      held = true;
      el.setPointerCapture?.(e.pointerId);
      el.classList.add('active');
      onDown();
    });
    const release = () => {
      if (!held) return;
      held = false;
      el.classList.remove('active');
      onUp();
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
  }

  // Vertical flight: inject the very keys the controller reads, so up/down share
  // Space/C's exact movement + clamp path. (Space -> +world-y, KeyC -> -world-y.)
  holdButton(upBtn,   () => player.keys.add('Space'), () => player.keys.delete('Space'));
  holdButton(downBtn, () => player.keys.add('KeyC'),  () => player.keys.delete('KeyC'));

  // A plain tap (stopping the touch from also starting a look-drag on canvas).
  const tap = (el, fn) => el.addEventListener('click', (e) => { e.stopPropagation(); fn(); });

  // Speed: one button cycling the forward cruise still -> slow -> fast -> still.
  // The next mode always differs from the current, so setCruise just sets it
  // (its "tap the lit mode to stop" shortcut never fires from this cycle).
  const NEXT_CRUISE = { 0: 1, 1: 2, 2: 0 };
  const SPEED_LABEL = { 0: '■ Still', 1: '▶ Slow', 2: '▶▶ Fast' };
  function syncSpeedButton() {
    const c = getCruise();
    speedBtn.textContent = SPEED_LABEL[c];
    speedBtn.classList.toggle('active', c !== 0); // lit while cruising
    speedBtn.setAttribute('aria-pressed', String(c !== 0));
  }
  tap(speedBtn, () => { setCruise(NEXT_CRUISE[getCruise()]); syncSpeedButton(); });

  // Outlines: unchanged toggle.
  function syncEdgesButton() {
    const on = getOutlines();
    edgesBtn.classList.toggle('active', on);
    edgesBtn.setAttribute('aria-pressed', String(on));
  }
  tap(edgesBtn, () => { toggleOutlines(); syncEdgesButton(); });

  syncSpeedButton();
  syncEdgesButton();
}
