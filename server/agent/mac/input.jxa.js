// macOS mouse / keyboard / screen info for Covo's computer-use tool.
// Run: osascript -l JavaScript input.jxa.js '<json>'   (JXA + CoreGraphics, no extra installs)
// Needs Accessibility permission for the process that runs Covo (System Settings → Privacy & Security).
ObjC.import('CoreGraphics');
ObjC.import('Cocoa');

const KEYS = {
  return: 36, enter: 76, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
  forwarddelete: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29,
  ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43,
  '/': 44, n: 45, m: 46, '.': 47, '`': 50,
};
const MODS = { cmd: 0x100000, command: 0x100000, shift: 0x20000, alt: 0x80000, option: 0x80000, opt: 0x80000, ctrl: 0x40000, control: 0x40000, fn: 0x800000 };

const post = (e) => $.CGEventPost(0, e); // kCGHIDEventTap
const pt = (x, y) => $.CGPointMake(x, y);
const sleep = (s) => delay(s);
function mouse(type, x, y, button, clicks) {
  const e = $.CGEventCreateMouseEvent(null, type, pt(x, y), button || 0);
  if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks); // kCGMouseEventClickState
  post(e);
}
function where() { const p = $.CGEventGetLocation($.CGEventCreate(null)); return { x: Math.round(p.x), y: Math.round(p.y) }; }
function click(x, y, button, count) {
  const [down, up] = button === 'right' ? [3, 4] : button === 'middle' ? [25, 26] : [1, 2];
  const b = button === 'right' ? 1 : button === 'middle' ? 2 : 0;
  mouse(5, x, y, 0); sleep(0.05);
  for (let i = 1; i <= (count || 1); i++) { mouse(down, x, y, b, i); mouse(up, x, y, b, i); if (i < count) sleep(0.06); }
}
function combo(spec) {
  const parts = String(spec).toLowerCase().replace(/\s+/g, '').split('+').filter(Boolean);
  let flags = 0; let key = null;
  for (const p of parts) { if (MODS[p] !== undefined) flags |= MODS[p]; else key = p; }
  if (key === null || KEYS[key] === undefined) throw new Error(`Unknown key "${spec}"`);
  const down = $.CGEventCreateKeyboardEvent(null, KEYS[key], true);
  const up = $.CGEventCreateKeyboardEvent(null, KEYS[key], false);
  $.CGEventSetFlags(down, flags); $.CGEventSetFlags(up, flags);
  post(down); post(up);
}

function run(argv) {
  const a = JSON.parse(argv[0] || '{}');
  const out = { ok: true };
  switch (a.action) {
    case 'info': {
      const b = $.CGDisplayBounds($.CGMainDisplayID());
      out.width = b.size.width; out.height = b.size.height;
      out.trusted = !!$.AXIsProcessTrusted();
      out.cursor = where();
      break;
    }
    case 'move': mouse(5, a.x, a.y, 0); break;
    case 'click': click(a.x, a.y, a.button, a.count || 1); break;
    case 'drag': {
      mouse(5, a.x, a.y, 0); sleep(0.05);
      mouse(1, a.x, a.y, 0, 1);
      const steps = 12;
      for (let i = 1; i <= steps; i++) { mouse(6, a.x + ((a.x2 - a.x) * i) / steps, a.y + ((a.y2 - a.y) * i) / steps, 0); sleep(0.02); }
      mouse(2, a.x2, a.y2, 0, 1);
      break;
    }
    case 'scroll': {
      if (a.x !== undefined) { mouse(5, a.x, a.y, 0); sleep(0.05); }
      const n = Math.max(1, Math.min(30, Math.abs(a.amount || 5)));
      const dir = a.direction === 'up' || a.direction === 'left' ? 1 : -1;
      const horizontal = a.direction === 'left' || a.direction === 'right';
      for (let i = 0; i < n; i++) { post(horizontal ? $.CGEventCreateScrollWheelEvent(null, 1, 2, 0, dir * 3) : $.CGEventCreateScrollWheelEvent(null, 1, 1, dir * 3)); sleep(0.01); }
      break;
    }
    case 'key': for (const k of [].concat(a.keys || a.key)) { combo(k); sleep(0.05); } break;
    case 'cursor': out.cursor = where(); break;
    default: throw new Error(`Unknown action ${a.action}`);
  }
  return JSON.stringify(out);
}
