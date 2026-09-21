// Small DOM and colour helpers. No framework: an element is created, filled and appended.

/** The app chrome's palette, matching the game's UI. Lane colours are user data, not this. */
export const CHROME = {
  ground: '#070b0a',
  panel: '#0c1211',
  mint: '#3ee8b0',
  slate: '#4c5f5a',
  amber: '#e0a64a',
  red: '#e05c4a',
} as const;

/** Defaults offered when a new lane or person is created. The user may set anything. */
export const LANE_PALETTE = [
  '#3ee8b0', '#e0a64a', '#5aa9e0', '#c98ae0',
  '#e05c4a', '#8ad06a', '#e0d24a', '#6ad0c9',
];

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ---------------------------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------------------------

/** `#rrggbb` → `[r, g, b]`. Anything unparseable comes back as the mint accent. */
export function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [62, 232, 176];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `t = 0` is all `a`, `t = 1` is all `b`. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `rgb(${c(ar, br)} ${c(ag, bg)} ${c(ab, bb)})`;
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r} ${g} ${b} / ${alpha})`;
}

/** Black or white, whichever stays readable on `hex`. */
export function readableOn(hex: string): string {
  const [r, g, b] = parseHex(hex);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#08110f' : '#f2fbf8';
}

/** The initials the server would derive, so the app can preview them before it writes. */
export function deriveInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

// ---------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------

/**
 * Refusals are shown verbatim. Every one of them is a sentence written for a human to read, so
 * nothing here parses, trims or prettifies the text.
 *
 * A toast is one of the few elements in this app that is genuinely created once and never rebuilt
 * from under itself, so — unlike the chart — it can safely carry an exit animation: `.leaving` is
 * added, `animationend` removes the node, and a fallback timeout covers a browser that never
 * fires the event (a backgrounded tab, `prefers-reduced-motion` skipping the keyframes).
 */
export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 6000): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = el('div', { class: `toast ${kind}` }, [
    el('span', { class: 'toast-text', text: message }),
  ]);
  const close = el('button', { class: 'toast-close', type: 'button', text: '×' });

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    node.classList.add('leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    window.setTimeout(() => node.remove(), 400);
  };

  close.addEventListener('click', dismiss);
  node.append(close);
  host.append(node);
  window.setTimeout(dismiss, ms);
}

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
