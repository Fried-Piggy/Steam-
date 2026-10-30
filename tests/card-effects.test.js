import test from 'node:test';
import assert from 'node:assert/strict';
import { bindCardEffects } from '../src/card-effects.js';

// A tiny event/style adapter exercises the real pointer controller without a browser dependency.
test('card tilt coalesces frames, follows the pointer, resets, and respects reduced motion', (t) => {
  function target() {
    const listeners = new Map();
    return {
      addEventListener(name, callback) {
        const list = listeners.get(name) ?? [];
        list.push(callback);
        listeners.set(name, list);
      },
      emit(name, event = {}) { for (const callback of listeners.get(name) ?? []) callback(event); },
    };
  }
  const motion = { ...target(), matches: false };
  const hover = { ...target(), matches: true };
  const win = { ...target(), matchMedia: (query) => query.includes('reduced-motion') ? motion : hover };
  const doc = target();
  const root = { ...target(), contains: (node) => node === slot };
  const styles = new Map();
  const classes = new Set();
  const card = { style: { setProperty: (key, value) => styles.set(key, value), removeProperty: (key) => styles.delete(key) } };
  const slot = {
    isConnected: true,
    closest: () => slot,
    contains: (node) => node === card,
    querySelector: () => card,
    getBoundingClientRect: () => ({ left: 100, top: 200, width: 200, height: 400 }),
    classList: { add: (...values) => values.forEach((value) => classes.add(value)), remove: (...values) => values.forEach((value) => classes.delete(value)) },
  };
  let nextFrame = 0;
  const frames = new Map();
  const originals = new Map();
  for (const [key, value] of Object.entries({
    window: win,
    document: doc,
    requestAnimationFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id) => frames.delete(id),
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  function move(x, y, pointerType = 'mouse') { root.emit('pointermove', { target: slot, clientX: x, clientY: y, pointerType }); }
  function flush() { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } }

  const effects = bindCardEffects(root);
  move(150, 250);
  move(300, 200);
  assert.equal(frames.size, 1, 'pointer bursts schedule one frame');
  flush();
  assert.equal(styles.get('--rotate-y'), '12.00deg');
  assert.equal(styles.get('--rotate-x'), '6.50deg');
  assert.equal(styles.get('--light-x'), '100.00%');
  assert.equal(styles.get('--light-y'), '0.00%');
  assert.equal(frames.size, 0, 'no perpetual animation loop');

  move(100, 600);
  flush();
  assert.equal(styles.get('--rotate-y'), '-12.00deg');
  assert.equal(styles.get('--rotate-x'), '-6.50deg');
  assert.equal(styles.get('--light-x'), '0.00%');
  root.emit('pointerout', { relatedTarget: card });
  assert.equal(classes.has('is-inspecting'), true, 'moving between descendants does not reset');
  root.emit('pointerout', { relatedTarget: null });
  assert.equal(styles.size, 0);
  assert.equal(classes.size, 0);

  move(200, 400);
  effects.reset();
  assert.equal(frames.size, 0, 'rerender cancels pending work on old cards');
  motion.matches = true;
  motion.emit('change');
  move(300, 200);
  assert.equal(frames.size, 0);
  motion.matches = false;
  move(300, 200, 'touch');
  assert.equal(frames.size, 0);
  hover.matches = false;
  move(300, 200);
  assert.equal(frames.size, 0);
});

test('card drag follows the pointer, suppresses its click, and springs back to rest', (t) => {
  function target() {
    const listeners = new Map();
    return {
      addEventListener(name, callback, options) {
        const list = listeners.get(name) ?? [];
        list.push({ callback, capture: options === true || options?.capture });
        listeners.set(name, list);
      },
      emit(name, event = {}) {
        for (const { callback } of listeners.get(name) ?? []) callback(event);
      },
    };
  }
  const motion = { ...target(), matches: false };
  const hover = { ...target(), matches: true };
  const win = { ...target(), matchMedia: (query) => query.includes('reduced-motion') ? motion : hover };
  const doc = target();
  const root = { ...target(), contains: (node) => node === slot };
  const styles = new Map();
  const classes = new Set();
  let captured = null;
  let boundsReads = 0;
  let transformWrites = 0;
  const card = {
    style: { setProperty: (key, value) => {
      styles.set(key, value);
      if (key === 'transform') transformWrites += 1;
    }, removeProperty: (key) => styles.delete(key) },
    closest: (selector) => selector === '.card-slot' ? slot : selector === '.game-card' ? card : null,
    setPointerCapture: (id) => { captured = id; },
    releasePointerCapture: (id) => { if (captured === id) captured = null; },
  };
  const button = { closest: (selector) => selector.includes('button') ? button : selector === '.card-slot' ? slot : null };
  const slot = {
    isConnected: true,
    contains: (node) => node === card || node === button,
    querySelector: () => card,
    getBoundingClientRect: () => { boundsReads += 1; return { left: 100, top: 100, width: 240, height: 400 }; },
    classList: {
      add: (...values) => values.forEach((value) => classes.add(value)),
      remove: (...values) => values.forEach((value) => classes.delete(value)),
    },
  };
  let nextFrame = 0;
  let now = 100;
  const frames = new Map();
  const originals = new Map();
  for (const [key, value] of Object.entries({
    window: win,
    document: doc,
    performance: { now: () => now },
    requestAnimationFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id) => frames.delete(id),
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  function flushOne(time = now += 16) {
    const item = frames.entries().next().value;
    if (!item) return false;
    const [id, callback] = item;
    frames.delete(id);
    callback(time);
    return true;
  }

  bindCardEffects(root);
  root.emit('pointerdown', { target: button, pointerId: 1, pointerType: 'mouse', button: 0, clientX: 130, clientY: 140, timeStamp: 100 });
  assert.equal(captured, null, 'buttons never start a drag');
  root.emit('pointerdown', { target: card, pointerId: 2, pointerType: 'mouse', button: 0, clientX: 130, clientY: 140, timeStamp: 100 });
  assert.equal(captured, 2);
  let preventedMove = false;
  root.emit('pointermove', { target: card, pointerId: 2, pointerType: 'mouse', clientX: 230, clientY: 200, timeStamp: 116, preventDefault: () => { preventedMove = true; } });
  flushOne();
  assert.equal(preventedMove, true);
  assert.equal(classes.has('is-dragging'), true);
  assert.equal(styles.get('--drag-x'), '100.00px', 'card displacement follows the pointer one-to-one');
  assert.equal(styles.get('--drag-y'), '60.00px', 'card displacement follows the pointer one-to-one');

  root.emit('pointerup', { pointerId: 2 });
  assert.equal(captured, null);
  assert.equal(classes.has('is-returning'), true);
  let preventedClick = false;
  root.emit('click', { preventDefault: () => { preventedClick = true; }, stopImmediatePropagation() {} });
  assert.equal(preventedClick, true, 'the click created by the drag is consumed');

  for (let index = 0; index < 240 && frames.size; index += 1) flushOne(now += 16);
  assert.equal(frames.size, 0, 'spring stops when the card settles');
  assert.equal(classes.size, 0);
  assert.equal(styles.has('--drag-x'), false);
  assert.equal(styles.has('--drag-y'), false);

  hover.matches = false;
  const boundsBeforeTouch = boundsReads;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const finger = (x = 130, y = 140) => ({ identifier: 7, clientX: x, clientY: y });
  const touchStart = (target = card) => root.emit('touchstart', { target, touches: [finger()] });
  let blockedScroll = false;
  const touchMove = (x, y, cancelable = true) => root.emit('touchmove', {
    target: card, touches: [finger(x, y)], cancelable, timeStamp: now += 16,
    preventDefault() { blockedScroll = true; },
  });

  touchStart();
  touchMove(131, 165);
  t.mock.timers.tick(200);
  assert.equal(blockedScroll, false, 'immediate swipes never block page scrolling');
  assert.equal(classes.has('is-dragging'), false, 'a swipe cancels the long press');

  touchStart(button);
  t.mock.timers.tick(200);
  assert.equal(classes.has('is-dragging'), false, 'touching controls never starts a drag');

  touchStart();
  t.mock.timers.tick(159);
  assert.equal(classes.has('is-dragging'), false);
  t.mock.timers.tick(1);
  assert.equal(classes.has('is-dragging'), true, 'a stationary hold lifts the card on coarse devices');
  touchMove(160, 180);
  touchMove(180, 210);
  assert.equal(blockedScroll, true, 'only an active long-press drag owns scrolling');
  assert.equal(transformWrites, 0, 'touch events wait for one compositor update per frame');
  flushOne();
  assert.equal(transformWrites, 1, 'touch bursts paint only the latest position');
  assert.ok(styles.get('transform').startsWith('translate3d(50.00px, 58.00px, 0)'));
  assert.equal(styles.has('--foil-angle'), false, 'mobile dragging never repaints gradient angles');
  assert.equal(styles.has('--drag-x'), false, 'mobile dragging avoids inherited variable invalidation');
  assert.equal(boundsReads, boundsBeforeTouch, 'mobile dragging needs no layout reads');
  root.emit('touchend', { changedTouches: [finger(180, 210)] });
  assert.equal(classes.has('is-returning'), true, 'touch release uses the desktop spring');
  for (let index = 0; index < 240 && frames.size; index += 1) flushOne(now += 16);
  assert.equal(classes.size, 0);

  touchStart();
  t.mock.timers.tick(160);
  root.emit('touchstart', { target: card, touches: [finger(), { identifier: 8 }] });
  assert.equal(classes.size, 0, 'a second finger cancels without trapping zoom/scroll');
  assert.equal(styles.has('--drag-x'), false);

  touchStart();
  t.mock.timers.tick(160);
  touchMove(180, 210, false);
  assert.equal(classes.size, 0, 'a browser-owned scroll cancels the drag');

  touchStart();
  root.emit('touchcancel', { changedTouches: [finger()] });
  t.mock.timers.tick(200);
  assert.equal(classes.size, 0, 'cancellation before the hold leaves no delayed drag');

  let preventedSelection = false;
  let preventedMenu = false;
  root.emit('selectstart', { target: card, preventDefault: () => { preventedSelection = true; } });
  root.emit('contextmenu', { target: card, preventDefault: () => { preventedMenu = true; } });
  assert.equal(preventedSelection, true, 'coarse pointers cannot select card text');
  assert.equal(preventedMenu, true, 'coarse pointers cannot open the card long-press menu');
});
