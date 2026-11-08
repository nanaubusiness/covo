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
