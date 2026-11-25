// Drag and drop that works the same with a mouse, a pen and a finger (pointer events, not HTML5 drag, which phones
// don't do). A mouse drag starts after a few pixels of movement; on touch you press and hold first, so ordinary
// scrolling still works. Every drag has a plain click or button alternative elsewhere on the page.
//
//   draggable(node, { type, data, ghost? })        ghost: a node to carry around (default: a copy of `node`)
//   dropzone(node, { accepts, onDrop(data, type) })
//   dock({ accepts, label, icon, onDrop })         a target pinned to the bottom of the screen while a matching drag
//                                                  is going (e.g. "Drop to remove"); returns a function that removes it

const MOVE_PX = 6;
const HOLD_MS = 280;
const zones = new Set();
const docks = new Set();
let drag = null; // { type, data, ghost, over, dx, dy }

export function draggable(node, opts) {
  node.classList.add('draggable');
  node.addEventListener('pointerdown', (e) => start(e, node, opts));
  node.addEventListener('contextmenu', (e) => { if (e.pointerType !== 'mouse' && drag) e.preventDefault(); });
  return node;
}

export function dropzone(node, { accepts, onDrop }) {
  node.classList.add('dropzone');
  node._drop = { accepts: [].concat(accepts), onDrop };
  zones.add(node);
  return node;
}

export function dock({ accepts, label, iconNode, onDrop, kind = '' }) {
  const d = { accepts: [].concat(accepts), label, iconNode, onDrop, kind };
  docks.add(d);
  return () => docks.delete(d);
}

function start(e, node, opts) {
  if (e.button !== 0 || drag) return;
  const touch = e.pointerType !== 'mouse';
  const x0 = e.clientX, y0 = e.clientY;
  let begun = false, timer = null, moved = false;

  const begin = (ev) => {
    begun = true;
    clearTimeout(timer);
    const rect = node.getBoundingClientRect();
    const ghost = (opts.ghost?.() ?? node.cloneNode(true));
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${Math.min(rect.width, 220)}px`;
    document.body.append(ghost);
    drag = { type: opts.type, data: opts.data, ghost, over: null, dx: Math.min(ev.clientX - rect.left, 110), dy: Math.min(ev.clientY - rect.top, 60), docks: [] };
    document.body.classList.add('is-dragging');
    document.body.dataset.drag = opts.type;
    node.classList.add('drag-source');
    for (const z of zones) if (z.isConnected && z._drop.accepts.includes(opts.type)) z.classList.add('drop-ok');
    showDocks(opts.type);
    navigator.vibrate?.(8);
    follow(ev);
  };

  const onMove = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    const far = Math.hypot(ev.clientX - x0, ev.clientY - y0) > MOVE_PX;
    if (!begun) {
      if (touch) { if (far) { moved = true; cleanup(); } return; } // moved before the hold: it's a scroll
      if (far) begin(ev); else return;
    }
    ev.preventDefault();
    follow(ev);
  };
  const onUp = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    if (begun) finish(true); else cleanup();
  };
  const onKey = (ev) => { if (ev.key === 'Escape' && begun) finish(false); };
  const blockTouch = (ev) => { if (begun) ev.preventDefault(); };

  function finish(dropIt) {
    const target = drag?.over;
    const { type, data } = drag ?? {};
    endDrag(node);
    cleanup();
    // the click that follows a drag must not also open the thing that was dragged
    const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
    node.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => node.removeEventListener('click', swallow, { capture: true }), 50);
    if (dropIt && target) target.onDrop(data, type);
  }
  function cleanup() {
    clearTimeout(timer);
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('pointercancel', onUp);
    removeEventListener('keydown', onKey);
    removeEventListener('touchmove', blockTouch);
  }

  addEventListener('pointermove', onMove, { passive: false });
  addEventListener('pointerup', onUp);
  addEventListener('pointercancel', onUp);
  addEventListener('keydown', onKey);
  addEventListener('touchmove', blockTouch, { passive: false });
  if (touch) timer = setTimeout(() => { if (!moved) begin({ clientX: x0, clientY: y0 }); }, HOLD_MS);
}

// Near the top or bottom edge the page scrolls by itself, since a finger that is dragging can't also scroll.
const EDGE = 70;
function autoscroll() {
  if (!drag) return;
  const { x, y } = drag.last;
  const v = y < EDGE ? -(EDGE - y) / 3 : y > innerHeight - EDGE ? (y - (innerHeight - EDGE)) / 3 : 0;
  if (v) {
    scrollBy({ top: Math.round(v), behavior: 'instant' });
    hitTest(x, y);
  }
  drag.raf = requestAnimationFrame(autoscroll);
}

function follow(ev) {
  const { ghost } = drag;
  ghost.style.transform = `translate(${ev.clientX - drag.dx}px, ${ev.clientY - drag.dy}px) rotate(-2deg) scale(1.04)`;
  drag.last = { x: ev.clientX, y: ev.clientY };
  drag.raf ??= requestAnimationFrame(autoscroll);
  hitTest(ev.clientX, ev.clientY);
}

function hitTest(x, y) {
  const hit = document.elementFromPoint(x, y);
  let over = null;
  for (let n = hit; n; n = n.parentElement) {
    if (n._drop?.accepts.includes(drag.type)) { over = n._drop; over.node = n; break; }
  }
  if (drag.over?.node !== over?.node) {
    drag.over?.node.classList.remove('drop-over');
    over?.node.classList.add('drop-over');
    drag.over = over;
  }
}

function showDocks(type) {
  const list = [...docks].filter((d) => d.accepts.includes(type));
  if (!list.length) return;
  const bar = document.createElement('div');
  bar.className = 'dockbar';
  for (const d of list) {
    const n = document.createElement('div');
    n.className = `dock ${d.kind}`;
    if (d.iconNode) n.append(d.iconNode());
    n.append(d.label);
    n._drop = { accepts: d.accepts, onDrop: d.onDrop };
    bar.append(n);
  }
  document.body.append(bar);
  drag.docks.push(bar);
}

function endDrag(node) {
  if (!drag) return;
  cancelAnimationFrame(drag.raf);
  drag.ghost.remove();
  for (const b of drag.docks) b.remove();
  drag.over?.node.classList.remove('drop-over');
  for (const z of zones) { z.classList.remove('drop-ok'); if (!z.isConnected) zones.delete(z); }
  document.body.classList.remove('is-dragging');
  delete document.body.dataset.drag;
  node.classList.remove('drag-source');
  drag = null;
}

/** Forget drop zones that are no longer on the page (call when a page is replaced). */
export function resetZones() {
  for (const z of zones) if (!z.isConnected) zones.delete(z);
  docks.clear();
}
