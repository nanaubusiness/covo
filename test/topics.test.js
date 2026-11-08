import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'covo-topics-'));
const { db, upsertTopic, addFeed, organizeTopic, setMainWorking, upsertTask, setTopicStatus, wakeSnoozedTopics } = await import('../server/db.js');

const fresh = (title) => upsertTopic({ title: `${title} ${Math.random()}`, status: 'in_progress' });

test('settle files a topic away; new agent activity brings it back unread', () => {
  const t = fresh('Hiring');
  organizeTopic(t.id, 'settle');
  assert.ok(t.settledAt);
  addFeed({ kind: 'assistant', text: 'Omar replied.', topicId: t.id });
  assert.equal(t.settledAt, null);
  assert.equal(t.unread, true);
});

test('your own message unsettles without marking unread', () => {
  const t = fresh('Supplier');
  organizeTopic(t.id, 'settle');
  addFeed({ kind: 'user', text: 'one more thing', topicId: t.id });
  assert.equal(t.settledAt, null);
  assert.ok(!t.unread);
});

test('working follows the main turn and running tasks; settling while working waits for the end', () => {
  const t = fresh('Seed round');
  setMainWorking(t.id);
  assert.equal(t.working, true);
  organizeTopic(t.id, 'settle');
  assert.equal(t.settledAt ?? null, null, 'not settled mid-turn');
  assert.equal(t.settlePending, true);
  addFeed({ kind: 'assistant', text: 'Still going', topicId: t.id });
  assert.equal(t.settlePending, true, 'agent output during the turn keeps the pending settle');
  setMainWorking(null);
  assert.equal(t.working, false);
  assert.ok(t.settledAt, 'settled when the turn ended');

  const u = fresh('Deliveries');
  const task = upsertTask({ title: 'x', topicId: u.id, status: 'running' });
  assert.equal(u.working, true);
  upsertTask({ id: task.id, status: 'done' });
  assert.equal(u.working, false);
});

test('snooze hides until the time, then wakes unread; needs_you wakes it early', () => {
  const t = fresh('Showroom');
  assert.throws(() => organizeTopic(t.id, 'snooze', { until: Date.now() - 1000 }), /future/);
  organizeTopic(t.id, 'snooze', { until: Date.now() + 60_000 });
  assert.ok(t.snoozedUntil);
  assert.deepEqual(wakeSnoozedTopics().map((x) => x.id), []);
  t.snoozedUntil = Date.now() - 1;
  assert.deepEqual(wakeSnoozedTopics().map((x) => x.id), [t.id]);
  assert.equal(t.snoozedUntil, null);
  assert.equal(t.unread, true);

  organizeTopic(t.id, 'mark_read');
  organizeTopic(t.id, 'snooze', { until: new Date(Date.now() + 3600e3).toISOString() });
  setTopicStatus(t.id, 'needs_you');
  assert.equal(t.snoozedUntil, null);
  assert.equal(t.unread, true);
});

test('organize API: settle, snooze and errors', async () => {
  const s = await startServer();
  try {
    await s.req('POST', '/api/auth/setup', { password: 'secret123', name: 'Sara' });
    const topics = (await s.req('GET', '/api/bootstrap')).body.topics;
    assert.ok(topics.length, 'demo seeds topics');
    const id = topics[0].id;
    const a = await s.req('POST', `/api/topics/${id}/organize`, { action: 'settle' });
    assert.equal(a.status, 200);
    assert.ok(a.body.settledAt || a.body.settlePending);
    const b = await s.req('POST', `/api/topics/${id}/organize`, { action: 'snooze', until: Date.now() + 3600e3 });
    assert.ok(b.body.snoozedUntil);
    assert.equal(b.body.settledAt, null);
    assert.equal((await s.req('POST', `/api/topics/${id}/organize`, { action: 'nope' })).status, 400);
    assert.equal((await s.req('POST', '/api/topics/missing/organize', { action: 'settle' })).status, 404);
    assert.equal((await s.req('GET', '/api/bootstrap')).body.topics.find((x) => x.id === id).snoozedUntil, b.body.snoozedUntil);
  } finally { await s.stop(); }
});
