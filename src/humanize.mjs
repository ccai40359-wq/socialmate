// Human-like browser behaviour. DESIGN.md §9.2.
// The point is to remove the two loudest automation tells: instant text
// insertion and instantaneous clicking with no lead-up.
import { appendLog } from './log.mjs';

function rand(a, b) { return Math.random() * (b - a) + a; }
function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// DESIGN.md §9.2 / T7-d: per-character typing 30-100ms, 3-5 warmup scrolls
// before acting, and a 2-5 second think pause between actions.
const DEFAULTS = {
  charDelayMin: 30,
  charDelayMax: 100,
  pauseMin: 2000,
  pauseMax: 5000,
  warmupScrollsMin: 3,
  warmupScrollsMax: 5,
  scrollStepMin: 200,
  scrollStepMax: 900,
};

export function pickTimingProfile(cfg = {}) {
  return { ...DEFAULTS, ...(cfg.humanize || {}) };
}

// Per-character typing with randomised delay. CJK gets a little more dwell
// time, which also reads as more human than a uniform rate.
export async function typeHuman(page, locator, text, opts = {}) {
  const p = pickTimingProfile(opts.cfg || {});
  const min = opts.charDelayMin ?? p.charDelayMin;
  const max = opts.charDelayMax ?? p.charDelayMax;

  await locator.click({ timeout: opts.clickTimeout ?? 10000 });
  await sleep(rand(120, 400));

  const started = Date.now();
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 0 });
    const isCJK = ch.codePointAt(0) >= 0x1100;
    let d = rand(min, max);
    if (isCJK) d *= 1.3;
    // Occasional longer pause, as if thinking mid-sentence.
    if (Math.random() < 0.06) d += rand(300, 1200);
    await sleep(d);
  }
  const elapsed = Date.now() - started;
  appendLog(`humanize: typed ${[...text].length} chars in ${elapsed}ms`);
  return elapsed;
}

export async function thinkPause(page, opts = {}) {
  const p = pickTimingProfile(opts.cfg || {});
  const ms = opts.ms ?? rand(p.pauseMin, p.pauseMax);
  await sleep(ms);
  return ms;
}

export async function scrollWarmup(page, opts = {}) {
  const p = pickTimingProfile(opts.cfg || {});
  const rolls = opts.rolls ?? randInt(p.warmupScrollsMin, p.warmupScrollsMax);
  for (let i = 0; i < rolls; i++) {
    const dy = rand(p.scrollStepMin, p.scrollStepMax) * (Math.random() < 0.25 ? -1 : 1);
    await page.mouse.wheel(0, dy).catch(() => {});
    await sleep(rand(150, 600));
  }
  return rolls;
}

// Move the pointer along a path instead of teleporting to the target.
export async function moveHuman(page, point, opts = {}) {
  const steps = opts.steps ?? randInt(8, 20);
  const from = opts.from || (await page.evaluate(() => ({ x: window.__smX ?? 0, y: window.__smY ?? 0 })).catch(() => ({ x: 0, y: 0 })));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t); // smoothstep
    const x = from.x + (point.x - from.x) * ease + rand(-3, 3);
    const y = from.y + (point.y - from.y) * ease + rand(-3, 3);
    await page.mouse.move(x, y).catch(() => {});
    await sleep(rand(8, 35));
  }
  await page.evaluate((p) => { window.__smX = p.x; window.__smY = p.y; }, point).catch(() => {});
}

// Move to an element then click it, so the click has a visible approach.
export async function clickHuman(page, locator, opts = {}) {
  const box = await locator.boundingBox().catch(() => null);
  if (box) {
    await moveHuman(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, opts);
    await sleep(rand(80, 260));
  }
  await locator.click({ timeout: opts.clickTimeout ?? 10000 });
}
