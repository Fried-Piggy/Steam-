const EFFECT_PROPERTIES = Object.freeze([
  '--rotate-x', '--rotate-y', '--light-x', '--light-y', '--foil-x', '--foil-y', '--foil-angle',
  '--drag-x', '--drag-y', '--drag-rotate',
  'transform',
]);

const DRAG_THRESHOLD = 5;
const TOUCH_HOLD_MS = 160;
const TOUCH_SLOP = 8;
const INTERACTIVE_SELECTOR = 'button, a, input, select, textarea, label, [role="button"]';

/** Delegated hover, drag and spring-return controller. No animation loop runs while cards are idle. */
export function bindCardEffects(root) {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const hover = window.matchMedia('(hover: hover) and (pointer: fine)');
  let active = null;
  let pointer = null;
  let drag = null;
  let touchPending = null;
  let touchTimer = 0;
  let paintFrame = 0;
  let springFrame = 0;
  let spring = null;
  let suppressClickUntil = 0;

  function cardFor(slot = active) {
    return slot?.querySelector('.game-card') ?? null;
  }

  function releaseCapture(card, pointerId) {
    try {
      if (!card?.hasPointerCapture || card.hasPointerCapture(pointerId)) card?.releasePointerCapture?.(pointerId);
    } catch { /* the browser may already have released this pointer */ }
  }

  function clearCard(slot = active) {
    const card = cardFor(slot);
    if (!slot || !card) return;
    slot.classList.remove('is-inspecting', 'is-dragging', 'is-returning', 'is-touch-motion');
    root.classList?.remove('is-card-touch-active');
    for (const property of EFFECT_PROPERTIES) card.style.removeProperty(property);
  }

  function cancelFrames() {
    cancelAnimationFrame(paintFrame);
    cancelAnimationFrame(springFrame);
    paintFrame = 0;
    springFrame = 0;
    spring = null;
  }

  function reset() {
    clearTimeout(touchTimer);
    touchPending = null;
    cancelFrames();
    const held = drag;
    drag = null;
    if (held && !held.touch) releaseCapture(cardFor(held.slot), held.pointerId);
    pointer = null;
    clearCard();
    active = null;
  }

  function activate(slot) {
    if (slot === active) return;
    cancelFrames();
    clearCard();
    active = slot;
    active.classList.add('is-inspecting');
  }

  function setDragTransform(card, x, y, velocityX = 0, touch = false, lift = 1) {
    const rotation = Math.max(-7, Math.min(7, x * 0.025 + velocityX * 0.018));
    if (touch) {
      const tiltX = Math.max(-5, Math.min(5, -y * .025));
      const tiltY = Math.max(-8, Math.min(8, x * .04));
      // Direct transform avoids invalidating inherited custom properties across the card subtree.
      card.style.setProperty('transform', `translate3d(${x.toFixed(2)}px, ${(y - 12 * lift).toFixed(2)}px, 0) rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg) rotateZ(${rotation.toFixed(2)}deg) scale(${(1 + .04 * lift).toFixed(4)})`);
      return;
    }
    card.style.setProperty('--drag-x', `${x.toFixed(2)}px`);
    card.style.setProperty('--drag-y', `${y.toFixed(2)}px`);
    card.style.setProperty('--drag-rotate', `${rotation.toFixed(2)}deg`);
  }

  function paint() {
    paintFrame = 0;
    if (!active?.isConnected || !pointer) { reset(); return; }
    if (drag?.touch) {
      setDragTransform(cardFor(), drag.x, drag.y, drag.vx, true);
      return;
    }
    const rect = active.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (pointer.x - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (pointer.y - rect.top) / rect.height));
    const card = cardFor();
    card.style.setProperty('--rotate-x', `${((0.5 - y) * 13).toFixed(2)}deg`);
    card.style.setProperty('--rotate-y', `${((x - 0.5) * 24).toFixed(2)}deg`);
    card.style.setProperty('--light-x', `${(x * 100).toFixed(2)}%`);
    card.style.setProperty('--light-y', `${(y * 100).toFixed(2)}%`);
    card.style.setProperty('--foil-x', `${(25 + x * 50).toFixed(2)}%`);
    card.style.setProperty('--foil-y', `${(25 + y * 50).toFixed(2)}%`);
    card.style.setProperty('--foil-angle', `${(115 + x * 35 - y * 20).toFixed(2)}deg`);
    if (drag?.moved) setDragTransform(card, drag.x, drag.y, drag.vx);
  }

  function schedulePaint() {
    if (!paintFrame) paintFrame = requestAnimationFrame(paint);
  }

  function beginSpring(release) {
    cancelAnimationFrame(paintFrame);
    paintFrame = 0;
    const slot = release.slot;
    const card = cardFor(slot);
    if (!card) { reset(); return; }
    drag = null;
    pointer = null;
    slot.classList.remove('is-dragging');
    slot.classList.add('is-returning');
    spring = { slot, card, touch: release.touch, x: release.x, y: release.y, vx: release.vx, vy: release.vy,
      originX: release.x, originY: release.y, originVx: release.vx, originVy: release.vy, startTime: performance.now() };

    function tick(time) {
      if (!spring || !spring.slot.isConnected) { reset(); return; }
      // Analytic damped spring follows elapsed time even if a mobile frame is skipped.
      const elapsed = (time - spring.startTime) / 1000;
      const decay = Math.exp(-9.5 * elapsed);
      const frequency = Math.sqrt(210 - 9.5 ** 2);
      const cosine = Math.cos(frequency * elapsed);
      const sine = Math.sin(frequency * elapsed);
      const position = (x, v) => decay * (x * cosine + (v + 9.5 * x) / frequency * sine);
      const velocity = (x, v) => decay * (v * cosine - (9.5 * v + 210 * x) / frequency * sine);
      spring.x = position(spring.originX, spring.originVx);
      spring.y = position(spring.originY, spring.originVy);
      spring.vx = velocity(spring.originX, spring.originVx);
      spring.vy = velocity(spring.originY, spring.originVy);
      setDragTransform(spring.card, spring.x, spring.y, spring.vx, spring.touch, decay);
      const settled = Math.hypot(spring.x, spring.y) < 0.35 && Math.hypot(spring.vx, spring.vy) < 5;
      const timedOut = time - spring.startTime > 1500;
      if (settled || timedOut) {
        const finishedSlot = spring.slot;
        cancelFrames();
        clearCard(finishedSlot);
        if (active === finishedSlot) active = null;
        return;
      }
      springFrame = requestAnimationFrame(tick);
    }
    springFrame = requestAnimationFrame(tick);
  }

  function releaseDrag(event, cancelled = false) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.touch && !cancelled && paintFrame) {
      cancelAnimationFrame(paintFrame);
      paint();
    }
    const released = drag;
    drag = null;
    if (!released.touch) releaseCapture(cardFor(released.slot), released.pointerId);
    if (!released.moved || cancelled || motion.matches) {
      const moved = released.moved;
      reset();
      if (moved) suppressClickUntil = performance.now() + 350;
      return;
    }
    released.vx = Math.max(-1600, Math.min(1600, released.vx));
    released.vy = Math.max(-1600, Math.min(1600, released.vy));
    suppressClickUntil = performance.now() + 350;
    beginSpring(released);
  }

  function beginDrag(slot, event, touch = false) {
    let carryX = 0;
    let carryY = 0;
    if (spring) {
      const returningSlot = spring.slot;
      if (returningSlot === slot) {
        carryX = spring.x;
        carryY = spring.y;
        cancelFrames();
        returningSlot.classList.remove('is-returning');
      } else {
        cancelFrames();
        clearCard(returningSlot);
        if (active === returningSlot) active = null;
      }
    }
    activate(slot);
    if (touch) {
      slot.classList.add('is-touch-motion');
      root.classList?.add('is-card-touch-active');
    }
    const card = cardFor(slot);
    if (!touch) {
      card.style.removeProperty('transform');
      slot.classList.remove('is-touch-motion');
      root.classList?.remove('is-card-touch-active');
    }
    drag = {
      slot,
      touch,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastTime: event.timeStamp || performance.now(),
      baseX: carryX,
      baseY: carryY,
      x: carryX, y: carryY, vx: 0, vy: 0, moved: false,
    };
    pointer = { x: event.clientX, y: event.clientY };
    if (!touch) {
      try { card.setPointerCapture?.(event.pointerId); } catch { /* window listeners provide a release fallback */ }
    }
  }

  function moveDrag(event) {
    const samples = event.getCoalescedEvents?.();
    const sample = samples?.length ? samples[samples.length - 1] : event;
    const dx = sample.clientX - drag.startX;
    const dy = sample.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
      drag.moved = true;
      drag.slot.classList.add('is-dragging');
    }
    if (drag.moved) {
      event.preventDefault?.();
      const now = sample.timeStamp || event.timeStamp || performance.now();
      const dt = Math.max(8, now - drag.lastTime);
      const instantVx = (sample.clientX - drag.lastX) / dt * 1000;
      const instantVy = (sample.clientY - drag.lastY) / dt * 1000;
      drag.vx = drag.vx * 0.65 + instantVx * 0.35;
      drag.vy = drag.vy * 0.65 + instantVy * 0.35;
      drag.x = drag.baseX + dx;
      drag.y = drag.baseY + dy;
      drag.lastX = sample.clientX;
      drag.lastY = sample.clientY;
      drag.lastTime = now;
      if (!drag.touch) setDragTransform(cardFor(drag.slot), drag.x, drag.y, drag.vx);
    }
    pointer = { x: sample.clientX, y: sample.clientY };
    schedulePaint();
  }

  root.addEventListener('pointerdown', (event) => {
    if (motion.matches || !hover.matches || event.pointerType === 'touch' || event.button !== 0 || drag) return;
    if (event.target.closest(INTERACTIVE_SELECTOR)) return;
    const slot = event.target.closest('.card-slot');
    if (!slot || !root.contains(slot)) return;
    event.preventDefault?.();
    beginDrag(slot, event);
  });

  root.addEventListener('pointermove', (event) => {
    if (drag && !drag.touch && event.pointerId === drag.pointerId) {
      moveDrag(event);
      return;
    }
    if (spring) return;
    if (motion.matches || !hover.matches || event.pointerType === 'touch') return;
    const slot = event.target.closest('.card-slot');
    if (!slot || !root.contains(slot)) { reset(); return; }
    activate(slot);
    pointer = { x: event.clientX, y: event.clientY };
    schedulePaint();
  }, { passive: false });

  // Touch Events let the first move choose scrolling; changing touch-action after a hold is too late.
  root.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) { reset(); return; }
    if (motion.matches || drag || event.target.closest(INTERACTIVE_SELECTOR)) return;
    const slot = event.target.closest('.card-slot');
    if (!slot || !root.contains(slot)) return;
    clearTimeout(touchTimer);
    const finger = event.touches[0];
    touchPending = { slot, identifier: finger.identifier, clientX: finger.clientX, clientY: finger.clientY };
    touchTimer = setTimeout(() => {
      const pending = touchPending;
      touchPending = null;
      if (!pending?.slot.isConnected) return;
      beginDrag(pending.slot, { ...pending, pointerId: `touch:${pending.identifier}`, timeStamp: performance.now() }, true);
      drag.moved = true;
      drag.slot.classList.add('is-dragging');
      schedulePaint();
    }, TOUCH_HOLD_MS);
  }, { passive: true });

  root.addEventListener('touchmove', (event) => {
    if (event.touches.length !== 1) { reset(); return; }
    const finger = event.touches[0];
    if (touchPending) {
      if (Math.hypot(finger.clientX - touchPending.clientX, finger.clientY - touchPending.clientY) > TOUCH_SLOP) {
        clearTimeout(touchTimer);
        touchPending = null;
      }
      return;
    }
    if (!drag?.touch || drag.pointerId !== `touch:${finger.identifier}`) return;
    // A noncancelable move means the browser has already committed to scrolling.
    if (event.cancelable === false) { reset(); return; }
    event.preventDefault();
    moveDrag({ clientX: finger.clientX, clientY: finger.clientY, timeStamp: event.timeStamp });
  }, { passive: false });

  function endTouch(event, cancelled = false) {
    clearTimeout(touchTimer);
    touchPending = null;
    if (!drag?.touch) return;
    const released = [...event.changedTouches].find((finger) => drag.pointerId === `touch:${finger.identifier}`);
    if (released) releaseDrag({ pointerId: drag.pointerId }, cancelled);
  }
  root.addEventListener('touchend', (event) => endTouch(event));
  root.addEventListener('touchcancel', (event) => endTouch(event, true));
  root.addEventListener('contextmenu', (event) => {
    if (touchPending || drag?.touch) event.preventDefault();
  });

  root.addEventListener('pointerup', (event) => releaseDrag(event));
  root.addEventListener('pointercancel', (event) => releaseDrag(event, true));
  window.addEventListener('pointerup', (event) => releaseDrag(event));
  window.addEventListener('pointercancel', (event) => releaseDrag(event, true));
  root.addEventListener('dragstart', (event) => {
    if (event.target.closest('.game-card')) event.preventDefault();
  });
  root.addEventListener('lostpointercapture', (event) => {
    if (drag && event.pointerId === drag.pointerId) releaseDrag(event);
  });
  root.addEventListener('pointerout', (event) => {
    if (!drag && !spring && active && !active.contains(event.relatedTarget)) reset();
  });
  root.addEventListener('click', (event) => {
    if (performance.now() <= suppressClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      suppressClickUntil = 0;
      return;
    }
    suppressClickUntil = 0;
    if (!spring) reset();
  }, true);
  window.addEventListener('blur', reset);
  window.addEventListener('scroll', () => { if (!drag && !spring) reset(); }, { passive: true, capture: true });
  window.addEventListener('resize', reset, { passive: true });
  document.addEventListener('visibilitychange', reset);
  motion.addEventListener('change', reset);
  hover.addEventListener('change', reset);
  return { reset };
}
