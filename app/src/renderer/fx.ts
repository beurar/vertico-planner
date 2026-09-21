// Decorative polish shared by the rest of the renderer: a particle burst for a moment worth
// noticing, and a short "this row is brand new" memory so a freshly inserted bar, lane or person
// can play an entrance animation exactly once.
//
// Both are deliberately cheap and deliberately optional. The chart clears and rebuilds its whole
// DOM subtree on nearly every render — including one made because a teammate elsewhere changed an
// unrelated row over the shared subscription — so nothing here may assume it runs once per user
// action. A particle burst is triggered explicitly, by the call site, at the moment a reducer
// call actually commits; the freshness map self-expires instead of being cleared by whoever set
// it, because the render that would clear it might never come (a row can be marked fresh and then
// never selected again).

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------------------------

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  life: number;
  maxLife: number;
  size: number;
  colour: string;
  shrink: boolean;
}

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let particles: Particle[] = [];
let rafHandle: number | null = null;
let lastTick = 0;

/** Call once, after the DOM is ready. A no-op the second time. */
export function initParticles(): void {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  document.body.append(canvas);
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
}

function resize(): void {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function ensureLoop(): void {
  if (rafHandle !== null) return;
  lastTick = performance.now();
  rafHandle = requestAnimationFrame(tick);
}

function tick(now: number): void {
  const dt = Math.min(48, now - lastTick) / 1000;
  lastTick = now;

  if (ctx && canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) {
      p.life -= dt;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const t = clamp01(p.life / p.maxLife);
      ctx.globalAlpha = t;
      const size = p.shrink ? p.size * t : p.size;
      ctx.fillStyle = p.colour;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.4, size), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  particles = particles.filter(p => p.life > 0);

  if (particles.length > 0) {
    rafHandle = requestAnimationFrame(tick);
  } else {
    rafHandle = null;
  }
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

interface BurstOptions {
  count: number;
  speed: number;
  spread: number;
  gravity: number;
  life: number;
  size: number;
  /** Radians; 0 is straight up. The cone of `spread` is centred on this. */
  angle: number;
  shrink: boolean;
}

function burst(x: number, y: number, colours: string[], opts: BurstOptions): void {
  if (REDUCED_MOTION || !canvas) return;
  for (let i = 0; i < opts.count; i += 1) {
    const a = opts.angle + (Math.random() - 0.5) * opts.spread;
    const speed = opts.speed * (0.5 + Math.random() * 0.7);
    particles.push({
      x,
      y,
      vx: Math.sin(a) * speed,
      vy: -Math.cos(a) * speed,
      gravity: opts.gravity,
      life: opts.life * (0.7 + Math.random() * 0.6),
      maxLife: opts.life,
      size: opts.size * (0.6 + Math.random() * 0.8),
      colour: colours[Math.floor(Math.random() * colours.length)],
      shrink: opts.shrink,
    });
  }
  ensureLoop();
}

/** A task just hit 100%. A small upward, colourful pop at the bar's badge. */
export function celebrate(x: number, y: number, laneColour: string): void {
  burst(x, y, [laneColour, '#ffffff', '#3ee8b0'], {
    count: 22,
    speed: 190,
    spread: Math.PI * 0.9,
    gravity: 420,
    life: 0.7,
    size: 3,
    angle: 0,
    shrink: true,
  });
}

/** A drag committed, or an avatar was dropped onto a bar. Small, quick, low-key. */
export function puff(x: number, y: number, colour: string): void {
  burst(x, y, [colour], {
    count: 8,
    speed: 80,
    spread: Math.PI * 1.4,
    gravity: 260,
    life: 0.4,
    size: 2.4,
    angle: 0,
    shrink: true,
  });
}

// ---------------------------------------------------------------------------------------------
// "Just created" — entrance-animation memory
// ---------------------------------------------------------------------------------------------

const FRESH_MS = 900;
const freshUntil = new Map<string, number>();

export function markFresh(kind: string, id: bigint | number): void {
  freshUntil.set(`${kind}:${id}`, Date.now() + FRESH_MS);
}

/** True for one short window after `markFresh`. Self-expiring — nothing has to clear it. */
export function isFresh(kind: string, id: bigint | number): boolean {
  if (REDUCED_MOTION) return false;
  const key = `${kind}:${id}`;
  const until = freshUntil.get(key);
  if (until === undefined) return false;
  if (Date.now() > until) {
    freshUntil.delete(key);
    return false;
  }
  return true;
}
