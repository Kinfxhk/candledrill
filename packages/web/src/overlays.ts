// SPDX-License-Identifier: AGPL-3.0-or-later
// One open panel at a time on the practice screen. A panel closes when you tap outside it,
// press Escape, or open another one. The tap that closes a panel does nothing else, so
// dismissing a panel by tapping the chart never also places a drawing point or an order.

export interface Overlay {
  readonly id: string;
  /** True when `target` is inside the panel or its opening button (taps there keep it open). */
  contains(target: Node): boolean;
  close(): void;
}

let open: Overlay | null = null;
/** The gesture that closed a panel: its pointer events and click reach nothing else. */
let swallowPointer: number | null = null;
let swallowClick = false;
let swallowTimer: ReturnType<typeof setTimeout> | undefined;

function dismiss(): void {
  const o = open;
  open = null;
  o?.close();
}

function stop(e: Event): void {
  e.preventDefault();
  e.stopImmediatePropagation();
}

function onPointerDown(e: PointerEvent): void {
  if (!open) return;
  const target = e.target as Node | null;
  if (target && open.contains(target)) return;
  dismiss();
  // Stop the whole gesture here (capture phase, before the chart sees it): no pan, no
  // freehand stroke, no drawing point, no button press.
  stop(e);
  swallowPointer = e.pointerId;
  swallowClick = true;
  // If no click follows (it was a drag), drop the click flag.
  clearTimeout(swallowTimer);
  swallowTimer = setTimeout(() => (swallowClick = false), 600);
}

function onPointerMove(e: PointerEvent): void {
  if (swallowPointer !== null && e.pointerId === swallowPointer) stop(e);
}

function onPointerUp(e: PointerEvent): void {
  if (swallowPointer === null || e.pointerId !== swallowPointer) return;
  swallowPointer = null;
  stop(e);
}

function onClick(e: MouseEvent): void {
  if (!swallowClick) return;
  swallowClick = false;
  stop(e);
}

function onKey(e: KeyboardEvent): void {
  // The draw palette keeps its own Escape order (cancel tool, then fold), so skip it here.
  if (e.key === 'Escape' && open && !open.id.startsWith('pal-')) dismiss();
}

let installed = false;
function install(): void {
  if (installed || typeof window === 'undefined' || !window.addEventListener) return;
  installed = true;
  // Capture on window: it runs before any element's own capture listener (the chart and its
  // freehand recorder listen in capture on their container), so a closing gesture is stopped
  // before anything underneath sees it.
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerUp, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
}

/** Register `o` as the open panel; any other open panel closes first. */
export function opened(o: Overlay): void {
  install();
  if (open && open.id !== o.id) dismiss();
  open = o;
}

/** The panel closed through its own control: forget it without calling close() again. */
export function closed(id: string): void {
  if (open?.id === id) open = null;
}

export function isOpen(id: string): boolean {
  return open?.id === id;
}

/** Close whatever is open (view teardown). */
export function closeAll(): void {
  swallowClick = false;
  swallowPointer = null;
  dismiss();
}
