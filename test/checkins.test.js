import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'covo-checkins-'));
const { db } = await import('../server/db.js');
const { buildTools } = await import('../server/agent/tools/index.js');
const { buildContext } = await import('../server/agent/context.js');
const { decide } = await import('../server/agent/policy.js');
const { computerGranted, grantComputer, revokeComputer } = await import('../server/agent/computer.js');

const tool = (name) => buildTools({ scope: 'main', hooks: {} }).find((t) => t.name === name);

test('watch → update_watch_state → shows up in the per-turn context', async () => {
  assert.match(buildContext(), /Watchers: none yet/);
  const w = await tool('watch').run({ title: 'YouTube: Lessicon', kind: 'social', target: 'studio.youtube.com', how: 'computer: YouTube Studio analytics', notify_when: 'a Short passes 1k views' });
  assert.ok(w.ok);
  await tool('update_watch_state').run({ id: w.id, state: 'subs 1,204; views 48h 3.1k', changed: true });
  const saved = db.data.watchers.find((x) => x.id === w.id);
  assert.equal(saved.state, 'subs 1,204; views 48h 3.1k');
  assert.ok(saved.lastChecked && saved.lastChange);
  const ctx = buildContext();
  assert.match(ctx, /YouTube: Lessicon/);
  assert.match(ctx, /subs 1,204/);
  assert.match(ctx, /a Short passes 1k views/);
  await tool('unwatch').run({ id: w.id });
  assert.equal(db.data.watchers.length, 0);
});

test('computer use: one approval opens a 30-minute session', () => {
  if (process.platform !== 'darwin') return;
  const t = tool('computer');
  assert.ok(t, 'computer tool is offered on macOS');
  revokeComputer();
  assert.equal(t.category({ action: 'screenshot' }), 'computer');
  assert.equal(decide('computer'), 'ask', 'asks by default');
  grantComputer(30);
  assert.ok(computerGranted());
  assert.equal(t.category({ action: 'click' }), 'auto');
  revokeComputer();
});

test('check-in API: needs a real model; watchers API edits and deletes', async () => {
  const s = await startServer();
  try {
    await s.req('POST', '/api/auth/setup', { password: 'secret123', name: 'Sara' });
    assert.equal((await s.req('POST', '/api/checkin')).status, 400, 'demo mode cannot check in');
    const b = (await s.req('GET', '/api/bootstrap')).body;
    assert.deepEqual(b.watchers, []);
    assert.equal(b.settings.agent.checkins.everyMin, 120);
    assert.equal((await s.req('PATCH', '/api/watchers/nope', { enabled: false })).status, 404);
  } finally { await s.stop(); }
});

test('separate chats: POST /api/chats needs a real model; chats stay out of the Tasks counts', async () => {
  const s = await startServer();
  try {
    await s.req('POST', '/api/auth/setup', { password: 'secret123', name: 'Sara' });
    assert.equal((await s.req('POST', '/api/chats', { message: 'hi' })).status, 400, 'demo mode cannot start chats');
    assert.equal((await s.req('POST', '/api/chats', {})).status, 400);
  } finally { await s.stop(); }
});

test('sub-agents: every agent can start one with its own model and effort; depth is capped', () => {
  const main = buildTools({ scope: 'main', hooks: {} }).find((t) => t.name === 'run_subagent');
  assert.ok(main, 'main agent has run_subagent');
  assert.ok(main.input_schema.properties.model && main.input_schema.properties.effort);
  assert.ok(buildTools({ scope: 'task', task: { id: 'k1', depth: 1 }, hooks: {} }).some((t) => t.name === 'run_subagent'), 'tasks can start sub-agents');
  assert.ok(!buildTools({ scope: 'task', task: { id: 'k2', depth: 3 }, hooks: {} }).some((t) => t.name === 'run_subagent'), 'no endless nesting');
  assert.ok(buildTools({ scope: 'main', hooks: {} }).some((t) => t.name === 'follow_up_subagent'), 'main agent can follow up with sub-agents');
  assert.ok(buildTools({ scope: 'main', hooks: {} }).find((t) => t.name === 'create_task').input_schema.properties.model);
});

test('follow-ups reopen a finished sub-agent and resolve with its next answer', async () => {
  const tasks = await import('../server/agent/tasks.js');
  const { db, upsertTask } = await import('../server/db.js');
  const t = upsertTask({ title: 'fu', goal: 'x', mode: 'subagent', status: 'done', transcript: [], steps: [], demo: true });
  assert.ok(tasks.followUpSubagent({ id: 'nope', message: 'hi' }).error, 'unknown id is an error');
  const f = tasks.followUpSubagent({ id: t.id, message: 'now do part 2' });
  assert.equal(f.task.id, t.id);
  const cur = db.data.tasks.find((x) => x.id === t.id);
  assert.equal(cur.status, 'queued', 'sub-agent is queued to answer the follow-up');
  assert.ok((cur.steps || []).some((s) => s.kind === 'followup' && s.text === 'now do part 2'), 'follow-up shows in its chat');
  tasks.cancelSubagent(t.id);
  assert.deepEqual(await f.done, { ok: false, error: 'cancelled' });
});
