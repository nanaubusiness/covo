import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR, id, now, readJson, writeJsonAtomic, log } from './util.js';
import { broadcast } from './bus.js';

// Tiny JSON document store. Everything lives in memory and is flushed to
// data/db.json (debounced). Good for a personal agent; swap for SQLite if you outgrow it.
const FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = () => ({
  version: 1,
  feed: [],          // UI items shown in the single conversation thread
  transcript: [],    // raw API messages for the main conversation (append-only)
  topics: [],        // { id, title, emoji, color, status, updatedAt, working, settledAt, settlePending, snoozedUntil, unread }
  tasks: [],         // background jobs
  artifacts: [],     // Make tab items (content stored on disk)
  approvals: [],     // pending / decided approvals
  memory: [],        // long-term facts
  routines: [],      // scheduled prompts (morning brief…)
  pushSubs: [],      // web push subscriptions
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 },
  meta: { seeded: false },
});

export const db = { data: Object.assign(EMPTY(), readJson(FILE, {})) };
// Nothing is running yet at startup: drop stale "working" flags and finish pending settles.
for (const t of db.data.topics || []) {
  if (t.working) t.working = false;
  if (t.settlePending) { t.settledAt = Date.now(); t.settlePending = false; }
}

let timer = null;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 250);
}
export function flush() {
  clearTimeout(timer);
  try { writeJsonAtomic(FILE, db.data); } catch (e) { log.error('db flush failed', e); }
}
export function resetDb(keepRoutines = false) {
  const routines = keepRoutines ? db.data.routines : [];
  db.data = EMPTY();
  db.data.routines = routines;
  flush();
}
export function replaceDb(data) {
  db.data = Object.assign(EMPTY(), data);
  flush();
}
process.on('exit', flush);

/* ---------------- feed ---------------- */
export function addFeed(item) {
  const it = { id: id('f_'), ts: now(), ...item };
  db.data.feed.push(it);
  if (db.data.feed.length > 5000) db.data.feed.splice(0, db.data.feed.length - 5000);
  if (it.topicId) topicActivity(it.topicId, { fromUser: it.kind === 'user' });
  save();
  broadcast('feed.add', it);
  return it;
}
export function updateFeed(fid, patch) {
  const it = db.data.feed.find((f) => f.id === fid);
  if (!it) return null;
  Object.assign(it, patch, { updatedAt: now() });
  save();
  broadcast('feed.update', it);
  return it;
}
export function removeFeed(fid) {
  const i = db.data.feed.findIndex((f) => f.id === fid);
  if (i >= 0) { db.data.feed.splice(i, 1); save(); broadcast('feed.remove', { id: fid }); }
}

/* ---------------- topics ---------------- */
const COLORS = ['blue', 'orange', 'green', 'purple', 'pink', 'teal', 'yellow'];
export function upsertTopic({ title, emoji, status }) {
  if (!title) return null;
  const key = title.trim().toLowerCase();
  let t = db.data.topics.find((x) => x.title.toLowerCase() === key);
  if (!t) {
    t = { id: id('t_'), title: title.trim(), emoji: emoji || '', color: COLORS[db.data.topics.length % COLORS.length], status: status || 'active', createdAt: now(), updatedAt: now() };
    db.data.topics.push(t);
    broadcast('topic.add', t);
  } else {
    if (emoji) t.emoji = emoji;
    if (status) t.status = status;
    t.updatedAt = now();
    broadcast('topic.update', t);
  }
  save();
  return t;
}
export function setTopicStatus(tid, status) {
  const t = db.data.topics.find((x) => x.id === tid);
  if (!t) return;
  t.status = status; t.updatedAt = now();
  if (status === 'needs_you') resurface(t, true);
  save();
  broadcast('topic.update', t);
}

/* ---------------- topic lifecycle (working / settled / snoozed / unread) ----------------
 * Works like T3 Code threads:
 *  - working:  the agent is running on this topic right now (main turn or a background task).
 *  - settle:   "done for now". Settling while the topic is working applies when the work ends.
 *              Any new activity in the topic brings it back.
 *  - snooze:   hidden until snoozedUntil, then it comes back marked unread. New agent activity
 *              or a "needs you" wakes it early.
 *  - unread:   set when a settled/snoozed topic resurfaces; cleared when you open the topic.
 */
const lifecycle = { mainTopicId: null };

function resurface(t, fromAgent) {
  let changed = false;
  if (t.settledAt) { t.settledAt = null; if (fromAgent) t.unread = true; changed = true; }
  if (t.snoozedUntil) { t.snoozedUntil = null; if (fromAgent) t.unread = true; changed = true; }
  return changed;
}

function topicActivity(tid, { fromUser }) {
  const t = db.data.topics.find((x) => x.id === tid);
  if (!t) return;
  // A message you write yourself cancels a pending settle; agent work during a turn doesn't.
  if (fromUser) t.settlePending = false;
  if (resurface(t, !fromUser)) broadcast('topic.update', t);
}

export function organizeTopic(tid, action, { until } = {}) {
  const t = db.data.topics.find((x) => x.id === tid);
  if (!t) return null;
  switch (action) {
    case 'settle':
      t.snoozedUntil = null; t.unread = false;
      if (t.working) t.settlePending = true; else { t.settledAt = now(); t.settlePending = false; }
      break;
    case 'unsettle': t.settledAt = null; t.settlePending = false; break;
    case 'snooze': {
      const ts = typeof until === 'number' ? until : Date.parse(until);
      if (!Number.isFinite(ts) || ts <= now()) throw Object.assign(new Error('Snooze needs a time in the future'), { status: 400 });
      t.snoozedUntil = ts; t.settledAt = null; t.settlePending = false; t.unread = false;
      break;
    }
    case 'unsnooze': t.snoozedUntil = null; break;
    case 'mark_unread': t.unread = true; break;
    case 'mark_read': t.unread = false; break;
    default: throw Object.assign(new Error(`Unknown action ${action}`), { status: 400 });
  }
  save();
  broadcast('topic.update', t);
  return t;
}

// Recompute which topics the agent is working on: the main turn's current topic + running tasks.
export function refreshWorking() {
  const ids = new Set();
  if (lifecycle.mainTopicId) ids.add(lifecycle.mainTopicId);
  for (const k of db.data.tasks) if (k.status === 'running' && k.topicId) ids.add(k.topicId);
  let changed = false;
  for (const t of db.data.topics) {
    const w = ids.has(t.id);
    if (!!t.working === w) continue;
    t.working = w;
    if (!w && t.settlePending) { t.settledAt = now(); t.settlePending = false; }
    changed = true;
    broadcast('topic.update', t);
  }
  if (changed) save();
}
export function setMainWorking(topicId) {
  if (lifecycle.mainTopicId === (topicId || null)) return;
  lifecycle.mainTopicId = topicId || null;
  refreshWorking();
}

// Called by the scheduler: bring back topics whose snooze ran out.
export function wakeSnoozedTopics() {
  const woke = [];
  for (const t of db.data.topics) {
    if (t.snoozedUntil && t.snoozedUntil <= now()) {
      t.snoozedUntil = null; t.unread = true;
      broadcast('topic.update', t);
      woke.push(t);
    }
  }
  if (woke.length) save();
  return woke;
}

/* ---------------- artifacts ---------------- */
const ART_DIR = path.join(DATA_DIR, 'artifacts');
export function artifactPath(aid, version) {
  return path.join(ART_DIR, aid, `v${version}.txt`);
}
export function saveArtifact({ aid, title, kind, content, summary, topicId, preview, refresh }) {
  let a = aid && db.data.artifacts.find((x) => x.id === aid);
  if (!a) {
    a = { id: id('a_'), title, kind: kind || 'page', summary: summary || '', topicId: topicId || null, pinned: false, version: 0, versions: [], createdAt: now(), refresh: refresh || '', preview: preview || null };
    db.data.artifacts.unshift(a);
  }
  a.version += 1;
  if (title) a.title = title;
  if (kind) a.kind = kind;
  if (summary !== undefined) a.summary = summary;
  if (preview !== undefined) a.preview = preview;
  if (refresh !== undefined) a.refresh = refresh;
  a.updatedAt = now();
  a.versions.push({ v: a.version, ts: a.updatedAt });
  fs.mkdirSync(path.join(ART_DIR, a.id), { recursive: true });
  fs.writeFileSync(artifactPath(a.id, a.version), content ?? '');
  save();
  broadcast('artifact.upsert', a);
  return a;
}
export function readArtifact(aid, version) {
  const a = db.data.artifacts.find((x) => x.id === aid);
  if (!a) return null;
  const v = version || a.version;
  try { return { ...a, content: fs.readFileSync(artifactPath(a.id, v), 'utf8'), viewingVersion: v }; } catch { return { ...a, content: '', viewingVersion: v }; }
}
export function deleteArtifact(aid) {
  db.data.artifacts = db.data.artifacts.filter((a) => a.id !== aid);
  fs.rmSync(path.join(ART_DIR, aid), { recursive: true, force: true });
  save();
  broadcast('artifact.remove', { id: aid });
}

/* ---------------- tasks ---------------- */
export function upsertTask(t) {
  let task = db.data.tasks.find((x) => x.id === t.id);
  if (!task) {
    task = { id: id('k_'), status: 'queued', progress: null, steps: [], transcript: [], createdAt: now(), ...t };
    db.data.tasks.unshift(task);
  } else Object.assign(task, t);
  task.updatedAt = now();
  save();
  broadcast('task.upsert', publicTask(task));
  if (t.status) refreshWorking();
  return task;
}
export function publicTask(t) {
  const { transcript, ...rest } = t;
  return { ...rest, steps: rest.steps.slice(-200) };
}
export function addTaskStep(task, step) {
  task.steps.push({ ts: now(), ...step });
  if (task.steps.length > 500) task.steps.splice(0, task.steps.length - 500);
  task.updatedAt = now();
  save();
  broadcast('task.upsert', publicTask(task));
}

/* ---------------- approvals ---------------- */
export function addApproval(a) {
  const ap = { id: id('ap_'), status: 'pending', createdAt: now(), ...a };
  db.data.approvals.push(ap);
  save();
  broadcast('approval.upsert', ap);
  return ap;
}
export function updateApproval(apid, patch) {
  const ap = db.data.approvals.find((x) => x.id === apid);
  if (!ap) return null;
  Object.assign(ap, patch, { updatedAt: now() });
  save();
  broadcast('approval.upsert', ap);
  return ap;
}

/* ---------------- usage ---------------- */
export function addUsage(u) {
  if (!u) return;
  const s = db.data.usage;
  s.inputTokens += u.input_tokens || u.prompt_tokens || 0;
  s.outputTokens += u.output_tokens || u.completion_tokens || 0;
  s.cacheReadTokens += u.cache_read_input_tokens || 0;
  s.cacheWriteTokens += u.cache_creation_input_tokens || 0;
  s.requests += 1;
  save();
  broadcast('usage', s);
}
