import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// Computer use on the Mac that runs Covo: see the screen, move/click/drag,
// scroll, type and press keys. Uses only built-in macOS tools (screencapture,
// sips, osascript + CoreGraphics), so nothing to install.
//
// macOS asks once for two permissions for the program running Covo (node):
//   Screen Recording (to see the screen) and Accessibility (to click and type).
//
// Coordinates: the model sees a screenshot scaled to at most 1280 px wide and
// gives coordinates in that image; we map them back to screen points.
// ─────────────────────────────────────────────────────────────────────────────

// (No node:util here: this file is also bundled into the browser edition, where it's never called.)
const run = (cmd, args, opts) => new Promise((resolve, reject) => {
  execFile(cmd, args, opts, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stdout, stderr })) : resolve({ stdout, stderr })));
});
const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mac', 'input.jxa.js');
const MAX_W = 1280;
const TMP = path.join(os.tmpdir(), 'covo-computer');

export const computerSupported = () => process.platform === 'darwin';

async function helper(args) {
  const { stdout } = await run('osascript', ['-l', 'JavaScript', HELPER, JSON.stringify(args)], { timeout: 20_000 });
  return JSON.parse(stdout.trim() || '{}');
}

let screen = null; // { width, height } in points, cached briefly
async function screenInfo(force) {
  if (!screen || force || Date.now() - screen.at > 60_000) {
    const i = await helper({ action: 'info' });
    screen = { width: i.width, height: i.height, trusted: i.trusted, at: Date.now() };
  }
  return screen;
}
const scaleOf = (s) => Math.min(1, MAX_W / s.width);
async function toScreen(x, y) {
  const s = await screenInfo();
  const k = scaleOf(s);
  const X = Math.round(Number(x) / k), Y = Math.round(Number(y) / k);
  if (!Number.isFinite(X) || !Number.isFinite(Y)) throw new Error('x and y are required');
  return { x: Math.max(0, Math.min(s.width - 1, X)), y: Math.max(0, Math.min(s.height - 1, Y)) };
}

export async function screenshot() {
  const s = await screenInfo();
  fs.mkdirSync(TMP, { recursive: true });
  const raw = path.join(TMP, `shot-${Date.now()}.png`);
  const out = raw.replace(/\.png$/, '.jpg');
  try {
    await run('screencapture', ['-x', '-C', '-m', '-t', 'png', raw], { timeout: 20_000 });
  } catch (e) {
    throw new Error('Could not take a screenshot. Give the program running Covo "Screen Recording" permission in System Settings → Privacy & Security. ' + e.message);
  }
  const w = Math.round(s.width * scaleOf(s)), h = Math.round(s.height * scaleOf(s));
  await run('sips', ['-z', String(h), String(w), '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', raw, '--out', out], { timeout: 20_000 });
  const data = fs.readFileSync(out).toString('base64');
  fs.rmSync(raw, { force: true }); fs.rmSync(out, { force: true });
  return { image: { media_type: 'image/jpeg', data }, width: w, height: h, note: `Screenshot is ${w}x${h}. Give coordinates in this image.` };
}

async function typeText(text) {
  // Paste through the clipboard (handles any language and emoji), then put the old clipboard back.
  let old = '';
  try { old = (await run('pbpaste', [], { timeout: 5000 })).stdout; } catch {}
  const setClip = (v) => new Promise((resolve, reject) => {
    const p = execFile('pbcopy', (e) => (e ? reject(e) : resolve()));
    p.stdin.end(v);
  });
  await setClip(text);
  await helper({ action: 'key', keys: ['cmd+v'] });
  await new Promise((r) => setTimeout(r, 250));
  await setClip(old).catch(() => {});
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// One computer-use step. Every action except "wait"/"cursor" returns a fresh screenshot.
export async function computerAction(i) {
  const s = await screenInfo(i.action === 'screenshot');
  if (i.action !== 'screenshot' && i.action !== 'cursor' && i.action !== 'wait' && s.trusted === false) {
    return { error: 'Covo needs Accessibility permission to click and type. Open System Settings → Privacy & Security → Accessibility and turn on "node" (the program running Covo), then try again.' };
  }
  switch (i.action) {
    case 'screenshot': return screenshot();
    case 'click': case 'double_click': case 'right_click': {
      const p = await toScreen(i.x, i.y);
      await helper({ action: 'click', ...p, button: i.action === 'right_click' ? 'right' : i.button || 'left', count: i.action === 'double_click' ? 2 : i.count || 1 });
      break;
    }
    case 'move': await helper({ action: 'move', ...(await toScreen(i.x, i.y)) }); break;
    case 'drag': {
      const a = await toScreen(i.x, i.y), b = await toScreen(i.x2, i.y2);
      await helper({ action: 'drag', x: a.x, y: a.y, x2: b.x, y2: b.y });
      break;
    }
    case 'scroll': {
      const p = i.x !== undefined ? await toScreen(i.x, i.y) : {};
      await helper({ action: 'scroll', ...p, direction: i.direction || 'down', amount: i.amount || 5 });
      break;
    }
    case 'type': if (!i.text) return { error: 'text is required' }; await typeText(String(i.text)); break;
    case 'key': if (!i.keys) return { error: 'keys is required, e.g. "cmd+l" or "return"' }; await helper({ action: 'key', keys: String(i.keys).split(/\s+(?=\S)/) }); break;
    case 'wait': await wait(Math.min(10, Math.max(0.2, Number(i.seconds) || 1)) * 1000); break;
    case 'cursor': {
      const c = await helper({ action: 'cursor' });
      const k = scaleOf(s);
      return { x: Math.round(c.cursor.x * k), y: Math.round(c.cursor.y * k) };
    }
    default: return { error: `Unknown action "${i.action}"` };
  }
  await wait(i.action === 'type' ? 300 : 500);
  return screenshot();
}

// One approval covers a whole computer-use session instead of every click.
let grantUntil = 0;
export const computerGranted = () => Date.now() < grantUntil;
export function grantComputer(minutes = 30) { grantUntil = Date.now() + minutes * 60_000; }
export function revokeComputer() { grantUntil = 0; }
