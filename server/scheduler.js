import { db, wakeSnoozedTopics } from './db.js';
import { notify } from './notify.js';
import { getSettings } from './config.js';
import { log } from './util.js';
import { runRoutine, expireApprovals, runCheckin } from './agent/core.js';

// Fires routines at their HH:MM in the user's timezone and expires stale approvals.
function localParts(tz) {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { hm: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`, dow, day: `${parts.year}-${parts.month}-${parts.day}` };
}

const toMin = (hm) => { const [h, m] = String(hm || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
function inHours(hm, from, to) {
  const n = toMin(hm), a = toMin(from), b = toMin(to);
  return a <= b ? n >= a && n < b : n >= a || n < b; // windows can wrap past midnight
}
function maybeCheckin(hm) {
  const c = getSettings().agent.checkins;
  if (!c?.enabled) return;
  if (!inHours(hm, c.from || '08:00', c.to || '22:00')) return;
  const last = db.data.meta?.lastCheckin || 0;
  if (Date.now() - last < Math.max(15, Number(c.everyMin) || 120) * 60_000) return;
  const r = runCheckin();
  if (r.ok) log.info(`check-in started (${r.watchers} watchers)`);
}

function tick() {
  try {
    const tz = getSettings().profile.timezone;
    const { hm, dow, day } = localParts(tz);
    for (const r of db.data.routines) {
      if (!r.enabled || r.time !== hm) continue;
      if (r.days && r.days.length && !r.days.includes(dow)) continue;
      const key = `${day} ${hm}`;
      if (r.lastKey === key) continue;
      r.lastKey = key;
      log.info(`routine fired: ${r.title}`);
      runRoutine(r);
    }
    expireApprovals();
    maybeCheckin(hm);
    for (const t of wakeSnoozedTopics()) notify({ title: t.title, body: 'Snooze is over. This topic is back in your list.', kind: 'task', url: '/?tab=chat' });
  } catch (e) {
    log.error('scheduler', e);
  }
}

export function startScheduler() {
  setInterval(tick, 15_000);
  tick();
}
