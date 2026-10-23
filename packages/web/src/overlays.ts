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
let swallowClick = false;
let swallowTimer: ReturnType<typeof setTimeout> | undefined;

function dismiss(): void {
  const o = open;
  open = null;
  o?.close();
}

function onPointerDown(e: PointerEvent): void {
  if (!open) return;
  const target = e.target as Node | null;
  if (target && open.contains(target)) return;
  dismiss();
  swallowClick = true;
  // A tap is pointerdown + click; if no click follows (it was a drag), drop the flag.
  clearTimeout(swallowTimer);
  swallowTimer = setTimeout(() => (swallowClick = false), 600);
}

function onClick(e: MouseEvent): void {
  if (!swallowClick) return;
  swallowClick = false;
  e.preventDefault();
  e.stopPropagation();
}

function onKey(e: KeyboardEvent): void {
  // The draw palette keeps its own Escape order (cancel tool, then fold), so skip it here.
  if (e.key === 'Escape' && open && !open.id.startsWith('pal-')) dismiss();
}

let installed = false;
function install(): void {
  if (installed || typeof document === 'undefined' || !document.addEventListener) return;
  installed = true;
  // Capture phase: the chart library stops some events from bubbling.
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
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
  dismiss();
}
