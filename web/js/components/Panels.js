import { html, useState, useEffect, useRef } from '../../vendor/preact-htm.js';
import { Icon, KIND_ICON } from '../lib/icons.js';
import { t, getLang } from '../lib/i18n.js';
import { api } from '../api.js';
import { useStore, setUI, get, toast } from '../store.js';
import { StatusIcon, Avatar, Toggle, Seg, Sheet, fmtTime, cx } from './ui.js';
import { Orb } from './Orb.js';
import { ApprovalCard } from './Cards.js';
import { TaskRow, groupOf } from './Tasks.js';
import { sendMessage } from './Composer.js';
import { saveSettings } from './settings/common.js';
import { needsCount } from '../needs.js';
import { transcriptOf } from '../lib/speech.js';
import { TopicList } from './Topics.js';
import { ChatList } from './Chat.js';

// Weekly plan usage at a glance (Claude subscription), refreshed every 5 minutes.
function UsageItem({ onPick }) {
  const provider = useStore((s) => s.provider);
  const [u, setU] = useState(null);
  useEffect(() => {
    if (provider !== 'claude-sub' || api.isLocal()) return;
    const load = () => api.get('/api/plan-usage').then(setU).catch(() => {});
    load(); const i = setInterval(load, 300_000); return () => clearInterval(i);
  }, [provider]);
  if (provider !== 'claude-sub' || api.isLocal()) return null;
  const week = u?.windows?.find((w) => w.key === 'seven_day');
  const p = week ? Math.round(week.percent) : null;
  return html`<button class="topic-item" onClick=${() => { setUI({ drawer: false, settings: 'usage' }); onPick?.(); }}><${Icon} name="chart" size="sm" /><span class="t">${t('Usage')}</span>${p !== null && html`<span class=${`pill usage-pill ${p >= 90 ? 'bad' : p >= 70 ? 'warn' : ''}`}>${p}% week</span>`}</button>`;
}
export { TopicList };

/* ───────────── shared: search ───────────── */
function useSearch(q) {
  const s = useStore((x) => x);
  if (!q.trim()) return null;
  const l = q.toLowerCase();
  return {
    topics: s.topics.filter((x) => x.title.toLowerCase().includes(l)).slice(0, 6),
    tasks: s.tasks.filter((x) => (x.title + ' ' + (x.note || '')).toLowerCase().includes(l)).slice(0, 6),
    artifacts: s.artifacts.filter((x) => (x.title + ' ' + (x.summary || '')).toLowerCase().includes(l)).slice(0, 6),
    messages: s.feed.filter((f) => f.text && f.text.toLowerCase().includes(l)).slice(-6).reverse(),
  };
}

function SearchResults({ r, done }) {
  if (!r) return null;
  const go = (fn) => () => { fn(); done?.(); };
  const empty = !r.topics.length && !r.tasks.length && !r.artifacts.length && !r.messages.length;
  if (empty) return html`<div class="hint" style="padding:8px 12px">No results.</div>`;
  return html`<div class="stack" style="gap:2px;padding:4px 0">
    ${r.topics.map((x) => html`<button class="topic-item" onClick=${go(() => setUI({ topicFilter: x.id, tab: 'chat' }))}><${StatusIcon} status=${x.status} emoji=${x.emoji} /><span class="t">${x.title}</span></button>`)}
    ${r.tasks.map((x) => html`<button class="topic-item" onClick=${go(() => setUI({ task: x.id, panel: 'task' }))}><${Icon} name="tasks" size="sm" /><span class="t">${x.title}</span></button>`)}
    ${r.artifacts.map((x) => html`<button class="topic-item" onClick=${go(() => setUI({ viewer: { id: x.id }, panel: 'artifact' }))}><${Icon} name=${KIND_ICON[x.kind] || 'file'} size="sm" /><span class="t">${x.title}</span></button>`)}
    ${r.messages.map((x) => html`<button class="topic-item" onClick=${go(() => setUI({ topicFilter: x.topicId || null, tab: 'chat' }))}><${Icon} name="chat" size="sm" /><span class="t">${x.text.replace(/\s+/g, ' ').slice(0, 80)}</span></button>`)}
  </div>`;
}

/* ───────────── Mobile drawer (hamburger) ───────────── */
export function Drawer() {
  const s = useStore((x) => x);
  const [q, setQ] = useState('');
  const r = useSearch(q);
  const close = () => setUI({ drawer: false });
  const needs = needsCount(s);
  const online = s.devices.filter((d) => d.online && d.enabled).length;
  const nav = (tab) => () => { setUI({ tab, drawer: false, topicFilter: null, chat: null }); };
  return html`<div class="overlay" onClick=${close}></div>
  <nav class="drawer" aria-label="Menu">
    <div class="row" style="padding:12px 12px 8px"><${Orb} size=${34} /><b class="serif grow" style="font-size:var(--fs-xl);font-weight:500">${s.settings?.agent?.name || 'Covo'}</b>
      <button class="icon-btn" aria-label=${t('Close')} onClick=${close}><${Icon} name="x" /></button></div>
    <div style="padding:0 12px 8px"><div class="composer" style="padding:2px 8px;align-items:center"><${Icon} name="search" size="sm" cls="muted" /><input value=${q} onInput=${(e) => setQ(e.target.value)} placeholder=${t('Search')} style="flex:1;border:0;outline:0;background:transparent;height:34px" /></div></div>
    <div class="scroll" style="flex:1;min-height:0">
      ${r ? html`<div style="padding:0 8px"><${SearchResults} r=${r} done=${close} /></div>` : html`
      ${s.provider === 'demo' && html`<div style="margin:4px 12px 8px;padding:12px;border-radius:var(--r-md);background:var(--accent-soft)">
        <b style="font-size:var(--fs-sm)">${t('Demo mode')}</b><div class="hint" style="color:var(--ink-2);margin:2px 0 8px">You're watching a scripted demo. Connect Claude to run your own agent.</div>
        <button class="btn primary sm" onClick=${() => setUI({ drawer: false, settings: 'model' })}>${t('Connect a model')}</button></div>`}
      <div class="nav">
        <button class=${s.ui.tab === 'chat' && !s.ui.chat ? 'on' : ''} onClick=${nav('chat')}><${Icon} name="chat" />${t('Chat')}</button>
        <button class=${s.ui.tab === 'tasks' ? 'on' : ''} onClick=${nav('tasks')}><${Icon} name="tasks" />${t('Tasks')}${needs > 0 && html`<span class="count">${needs}</span>`}</button>
        <button class=${s.ui.tab === 'make' ? 'on' : ''} onClick=${nav('make')}><${Icon} name="make" />${t('Make')}</button>
      </div>
      <div class="side-sec"><h4>${t('Chats')}</h4><${ChatList} onPick=${close} /></div>
      <div class="side-sec"><h4>${t('Topics')}</h4><${TopicList} onPick=${close} /></div>
      <div class="side-sec"><h4>${t('Routines')}</h4>
        ${s.routines.map((x) => html`<button class="topic-item" onClick=${() => setUI({ drawer: false, settings: 'routines' })}><${Icon} name="clock" size="sm" /><span class="t">${x.title}</span><span class="muted" style="font-size:var(--fs-xs)">${x.enabled ? x.time : 'off'}</span></button>`)}
      </div>`}
    </div>
    <div style="border-top:1px solid var(--line);padding:8px" class="stack">
      <${UsageItem} />
      <button class="topic-item" onClick=${() => setUI({ drawer: false, settings: 'devices' })}><${Icon} name="cpu" size="sm" /><span class="t">${t('Devices')}</span><span class="pill"><span class=${cx('d', online && 'on')}></span>${online} online</span></button>
      <button class="topic-item" onClick=${() => setUI({ drawer: false, settings: 'general' })}><${Icon} name="settings" size="sm" /><span class="t">${t('Settings')}</span></button>
    </div>
  </nav>`;
}

/* ───────────── Desktop sidebar ───────────── */
export function Sidebar() {
  const s = useStore((x) => x);
  const [q, setQ] = useState('');
  const r = useSearch(q);
  const needs = needsCount(s);
  const online = s.devices.filter((d) => d.online && d.enabled).length;
  const p = s.settings?.profile || {};
  return html`<aside class="d-side">
    <div class="brand"><${Orb} /><b class="grow">${s.settings?.agent?.name || 'Covo'}</b>
      ${s.provider === 'demo' && html`<button class="badge warn" onClick=${() => setUI({ settings: 'model' })} title=${t('Connect a model')}>${t('Demo mode')}</button>`}</div>
    <div style="padding:0 10px 6px"><div class="composer" style="padding:0 8px;box-shadow:none;border-radius:var(--r-md);align-items:center"><${Icon} name="search" size="sm" cls="muted" /><input value=${q} onInput=${(e) => setQ(e.target.value)} placeholder=${t('Search')} style="flex:1;min-width:0;border:0;outline:0;background:transparent;height:34px;font-size:var(--fs-md)" /></div></div>
    <div class="scroll" style="flex:1;min-height:0">
      ${r ? html`<div style="padding:0 8px"><${SearchResults} r=${r} done=${() => setQ('')} /></div>` : html`
      <div class="nav">
        <button class=${s.ui.tab === 'chat' && !s.ui.chat ? 'on' : ''} onClick=${() => setUI({ tab: 'chat', topicFilter: null, chat: null })}><${Icon} name="chat" />${t('Chat')}</button>
        <button class=${s.ui.tab === 'tasks' ? 'on' : ''} onClick=${() => setUI({ tab: 'tasks' })}><${Icon} name="tasks" />${t('Tasks')}${needs > 0 && html`<span class="count">${needs}</span>`}</button>
        <button class=${s.ui.tab === 'make' ? 'on' : ''} onClick=${() => setUI({ tab: 'make' })}><${Icon} name="make" />${t('Make')}</button>
      </div>
      <div class="side-sec"><h4>${t('Chats')}</h4><${ChatList} /></div>
      <div class="side-sec"><h4>${t('Topics')}</h4><${TopicList} /></div>
      <div class="side-sec"><h4>${t('Routines')}<button class="icon-btn sm" aria-label="Edit routines" onClick=${() => setUI({ settings: 'routines' })}><${Icon} name="plus" size="sm" /></button></h4>
        ${s.routines.map((x) => html`<button class="topic-item" onClick=${() => setUI({ settings: 'routines' })}><${Icon} name="clock" size="sm" /><span class="t">${x.title}</span><span class="muted" style="font-size:var(--fs-xs)">${x.enabled ? x.time : 'off'}</span></button>`)}
      </div>`}
    </div>
    <div class="foot">
      <${UsageItem} />
      <button class="topic-item" onClick=${() => setUI({ settings: 'devices' })}><${Icon} name="cpu" size="sm" /><span class="t">${t('Devices')}</span><span class="pill"><span class=${cx('d', online && 'on')}></span>${online}</span></button>
      <button class="topic-item" onClick=${() => setUI({ settings: 'general' })}><${Icon} name="settings" size="sm" /><span class="t">${t('Settings')}</span><span class="kbd">,</span></button>
      <button class="me-row" onClick=${() => setUI({ profile: true })}><span class="av"><${Avatar} name=${p.name} color=${p.avatarColor} size=${30} /></span><span class="grow"><b style="font-size:var(--fs-md);font-weight:500">${p.name || 'You'}</b><small>${s.provider === 'demo' ? t('Demo mode') : s.settings?.provider?.[s.provider === 'claude-sub' ? 'claudeSub' : s.provider]?.model || s.provider}</small></span></button>
    </div>
  </aside>`;
}

/* ───────────── Desktop right panel: overview ───────────── */
export function Overview() {
  const s = useStore((x) => x);
  const pending = s.approvals.filter((a) => a.status === 'pending');
  const needsTasks = s.tasks.filter((x) => x.status === 'needs_you');
  const prog = s.tasks.filter((x) => groupOf(x) === 'progress');
  const pinned = s.artifacts.filter((a) => a.pinned).slice(0, 6);
  const recent = s.artifacts.slice(0, 4);
  const dev = s.settings?.developer?.enabled && s.settings?.developer?.showUsage;
  return html`<div class="d-panel">
    <div class="panel-head"><h3>${t('Overview')}</h3><button class="icon-btn" aria-label=${t('Close')} onClick=${() => setUI({ panel: 'none' })}><${Icon} name="x" /></button></div>
    <div class="panel-body scroll"><div class="ov">
      <div class="stat-row">
        <div class="stat"><b>${needsCount(s)}</b><small>${t('Needs you')}</small></div>
        <div class="stat"><b>${prog.length}</b><small>${t('In progress')}</small></div>
        <div class="stat"><b>${s.artifacts.length}</b><small>${t('Make')}</small></div>
      </div>
      ${pending.length > 0 && html`<div><h5>${t('Waiting for approval')}</h5><div class="stack">${pending.map((a) => html`<${ApprovalCard} id=${a.id} />`)}</div></div>`}
      ${needsTasks.length > 0 && html`<div><h5>${t('Needs you')}</h5><div class="list">${needsTasks.map((x) => html`<${TaskRow} task=${x} />`)}</div></div>`}
      ${prog.length > 0 && html`<div><h5>${t('In progress')}</h5><div class="list">${prog.slice(0, 6).map((x) => html`<${TaskRow} task=${x} />`)}</div></div>`}
      ${(pinned.length ? pinned : recent).length > 0 && html`<div><h5>${pinned.length ? t('Pinned') : t('Recent')}</h5><div class="stack" style="gap:2px">${(pinned.length ? pinned : recent).map((a) => html`
        <button class="topic-item" onClick=${() => setUI({ viewer: { id: a.id }, panel: 'artifact' })}><${Icon} name=${KIND_ICON[a.kind] || 'file'} size="sm" /><span class="t">${a.title}</span><span class="muted" style="font-size:var(--fs-xs)">${fmtTime(a.updatedAt)}</span></button>`)}</div></div>`}
      ${dev && s.usage && html`<div><h5>Usage (all time)</h5><div class="hint">${s.usage.requests} requests · ${s.usage.inputTokens.toLocaleString()} in · ${s.usage.outputTokens.toLocaleString()} out · ${s.usage.cacheReadTokens.toLocaleString()} cache reads</div></div>`}
    </div></div>
  </div>`;
}

/* ───────────── Profile sheet (tap "M") ───────────── */
let installEvt = null;
if (typeof window !== 'undefined') window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });

export function ProfileSheet() {
  const s = useStore((x) => x);
  const p = s.settings?.profile || {};
  const ap = s.settings?.appearance || {};
  const close = () => setUI({ profile: false });
  const mode = ['classic', 'classic-dark', 'system'].includes(ap.theme) ? ap.theme : 'custom';
  const signOut = async () => { await api.post('/api/auth/logout').catch(() => {}); location.reload(); };
  return html`<${Sheet} title=${t('Profile')} onClose=${close} small>
    <div class="stack" style="padding:4px 16px 20px;gap:14px">
      <div class="row" style="gap:12px"><${Avatar} name=${p.name} color=${p.avatarColor} size=${52} />
        <div class="grow"><b style="font-size:var(--fs-lg)">${p.name || 'You'}</b><div class="hint">${p.email || (s.provider === 'demo' ? t('Demo mode') : `${s.provider} · ${s.settings?.provider?.[s.provider === 'claude-sub' ? 'claudeSub' : s.provider]?.model || ''}`)}</div></div>
        <button class="btn outline sm" onClick=${() => setUI({ profile: false, settings: 'profile' })}>${t('Edit')}</button></div>
      <div class="group" style="margin:0">
        <div class="item"><${Icon} name="palette" /><div class="txt"><b>${t('Theme')}</b></div>
          <${Seg} value=${mode} onChange=${(v) => v !== 'custom' && saveSettings({ appearance: { theme: v } })} options=${[{ id: 'classic', label: '', icon: 'sun' }, { id: 'classic-dark', label: '', icon: 'moon' }, { id: 'system', label: '', icon: 'monitor' }]} /></div>
        <div class="item"><${Icon} name="globe" /><div class="txt"><b>${t('Language')}</b></div>
          <${Seg} value=${p.language || 'en'} onChange=${(v) => saveSettings({ profile: { language: v } })} options=${[{ id: 'en', label: 'EN' }, { id: 'ar', label: 'ع' }]} /></div>
        <div class="item"><${Icon} name="code" /><div class="txt"><b>${t('Developer')}</b><small>Show tool calls, raw events and token usage</small></div>
          <${Toggle} on=${s.settings?.developer?.enabled} onChange=${(v) => saveSettings({ developer: { enabled: v } })} /></div>
        <div class="item link" onClick=${() => setUI({ profile: false, settings: 'general' })}><${Icon} name="settings" /><div class="txt"><b>${t('Settings')}</b></div><${Icon} name="right" size="sm" cls="flip-rtl" /></div>
        ${installEvt && html`<div class="item link" onClick=${() => installEvt.prompt()}><${Icon} name="download" /><div class="txt"><b>Install app</b><small>Add to your home screen / desktop</small></div></div>`}
      </div>
      ${/CovoApp/.test(navigator.userAgent) && !api.isLocal() && html`<button class="btn outline" onClick=${() => { location.href = 'https://localhost/?disconnect=1'; }}><${Icon} name="phone" size="sm" />Use on this device instead</button>`}
      ${!api.isStatic() && html`<button class="btn outline" onClick=${signOut}><${Icon} name="logout" size="sm" />${t('Sign out')}</button>`}
    </div>
  <//>`;
}

/* ───────────── Voice mode ─────────────
 * A spoken conversation: listen until you stop talking (voice-activity detection), transcribe
 * with Whisper on the Mac, send to the chat you're in, wait for the reply, read it aloud with a Mac
 * voice, then listen again. Tap the orb to interrupt. Falls back to the browser's speech
 * recognition / voices when the Mac services aren't available. */
const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
const plain = (md) => md.replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/[*_`#>]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
const SILENCE_MS = 1300;   // this much quiet after speech ends your turn
const MAX_TURN_MS = 90_000;

export function VoiceMode() {
  const [phase, setPhase] = useState('starting'); // starting | listening | transcribing | thinking | speaking | denied | error
  const [cap, setCap] = useState('');
  const [level, setLevel] = useState(0);
  const chatId = useStore((s) => s.ui.chat && s.ui.chat !== 'new' ? s.ui.chat : null);
  const st = useRef({ alive: true, stream: null, ctx: null, rec: null, audio: null, raf: 0, sr: null, wait: 0 });
  const lang = getLang();
  const server = !api.isLocal();
  const canWhisper = () => server && get().transcribe && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  const cleanup = () => {
    const x = st.current; x.alive = false;
    cancelAnimationFrame(x.raf); clearInterval(x.wait);
    try { x.rec?.state === 'recording' && x.rec.stop(); } catch {}
    try { x.sr?.abort(); } catch {}
    x.stream?.getTracks().forEach((t) => t.stop());
    x.ctx?.close?.().catch?.(() => {});
    if (x.audio) { x.audio.pause(); x.audio.src = ''; }
    window.speechSynthesis?.cancel();
  };
  const close = () => { cleanup(); setUI({ voice: false }); };

  // ── speaking ──
  const say = async (text) => {
    const x = st.current; if (!x.alive) return;
    setPhase('speaking'); setCap(plain(text));
    const done = () => { if (st.current.alive) listen(); };
    if (server && get().speak) {
      try {
        const r = await fetch('/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), credentials: 'same-origin' });
        if (!r.ok) throw new Error('speak failed');
        const url = URL.createObjectURL(await r.blob());
        x.audio.src = url; x.audio.onended = () => { URL.revokeObjectURL(url); done(); };
        await x.audio.play(); return;
      } catch {}
    }
    if (window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(plain(text));
      u.lang = /[؀-ۿ]/.test(text) ? 'ar' : navigator.language || 'en-US';
      u.onend = done; u.onerror = done; speechSynthesis.speak(u); return;
    }
    done();
  };
  const interrupt = () => {
    const x = st.current;
    if (phase === 'speaking') { x.audio?.pause(); window.speechSynthesis?.cancel(); listen(); }
    else if (phase === 'listening' && x.rec?.state === 'recording') x.rec.stop(); // "I'm done talking"
  };

  // ── waiting for the reply (by message id, not clock, so phone/Mac clock drift can't break it) ──
  const awaitReply = (seen, chat, stepsBefore) => {
    const x = st.current; clearInterval(x.wait);
    const t0 = Date.now();
    x.wait = setInterval(async () => {
      if (!x.alive) return clearInterval(x.wait);
      let text = '';
      if (chat) {
        const task = get().tasks.find((t) => t.id === chat);
        if (!task || ['running', 'queued'].includes(task.status)) return;
        const d = await api.get(`/api/tasks/${chat}`).catch(() => null);
        text = (d?.steps || []).slice(stepsBefore).filter((s) => s.kind === 'assistant').map((s) => s.text).join('\n\n');
      } else {
        const s = get();
        if (['thinking', 'writing', 'working'].includes(s.agentState)) return;
        const fresh = s.feed.filter((f) => !seen.has(f.id) && f.kind === 'assistant' && !f.streaming && !f.progress);
        if (!fresh.length && Date.now() - t0 < 4000) return; // give the turn a moment to start
        text = fresh.map((f) => f.text).join('\n\n');
      }
      clearInterval(x.wait);
      if (text.trim()) say(text); else listen();
    }, 400);
  };

  const send = async (text) => {
    const x = st.current; if (!x.alive) return;
    setCap(text); setPhase('thinking');
    try {
      if (chatId) {
        const before = (await api.get(`/api/tasks/${chatId}`).catch(() => ({ steps: [] }))).steps?.length || 0;
        await api.post(`/api/tasks/${chatId}/action`, { message: text, voice: true });
        awaitReply(null, chatId, before);
      } else {
        const seen = new Set(get().feed.map((f) => f.id));
        await api.post('/api/messages', { text, voice: true });
        awaitReply(seen, null, 0);
      }
    } catch (e) { setPhase('error'); setCap(e.message); }
  };

  // ── listening ──
  const listenWhisper = async () => {
    const x = st.current;
    if (!x.stream) {
      try { x.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
      catch { setPhase('denied'); return; }
      x.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = x.ctx.createMediaStreamSource(x.stream);
      x.an = x.ctx.createAnalyser(); x.an.fftSize = 1024; src.connect(x.an);
    }
    if (!x.alive) return;
    await x.ctx.resume?.();
    const rec = new MediaRecorder(x.stream); const chunks = []; x.rec = rec;
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onstop = async () => {
      cancelAnimationFrame(x.raf); setLevel(0);
      if (!x.alive) return;
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (!heard || blob.size < 2000) return listen();
      setPhase('transcribing');
      try {
        const r = await fetch('/api/transcribe', { method: 'POST', body: blob, headers: { 'Content-Type': blob.type }, credentials: 'same-origin' });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'transcribe failed');
        if (j.text?.trim()) send(j.text.trim()); else listen();
      } catch (e) { setPhase('error'); setCap(e.message); }
    };
    // Voice-activity detection: adapt to the room's noise, end the turn after a pause.
    const buf = new Float32Array(x.an.fftSize);
    let floor = 0.01, heard = false, lastVoice = 0; const t0 = performance.now();
    const tick = () => {
      if (!x.alive || rec.state !== 'recording') return;
      x.an.getFloatTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (!heard) floor = floor * 0.95 + rms * 0.05;
      const voiced = rms > Math.max(0.015, floor * 2.5);
      if (voiced) { heard = true; lastVoice = now; }
      setLevel(Math.min(1, rms * 12));
      if ((heard && now - lastVoice > SILENCE_MS) || now - t0 > MAX_TURN_MS) { rec.stop(); return; }
      x.raf = requestAnimationFrame(tick);
    };
    rec.start(250); setPhase('listening'); setCap('');
    x.raf = requestAnimationFrame(tick);
  };
  const listenBrowser = () => {
    if (!SR) { setPhase('error'); setCap('Voice needs the Duet app on your Mac or a browser with speech recognition.'); return; }
    const x = st.current; const r = new SR(); x.sr = r;
    r.lang = lang === 'ar' ? 'ar-IQ' : navigator.language || 'en-US';
    r.interimResults = true; r.continuous = false;
    let finalText = '';
    r.onresult = (ev) => { const s = transcriptOf(ev.results); if ([...ev.results].some((y) => y.isFinal)) finalText = s; setCap(s); };
    r.onend = () => { if (!x.alive) return; if (finalText.trim()) send(finalText.trim()); else setTimeout(() => x.alive && listen(), 300); };
    r.onerror = (e) => { if (e.error === 'not-allowed') setPhase('denied'); };
    setPhase('listening'); setCap('');
    try { r.start(); } catch {}
  };
  const listen = () => (canWhisper() ? listenWhisper() : listenBrowser());

  useEffect(() => {
    // Opened by a tap: unlock audio playback for the whole session (phones block autoplay otherwise).
    const a = new Audio(); a.playsInline = true; st.current.audio = a;
    a.src = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    a.play().catch(() => {});
    listen();
    return cleanup;
  }, []);

  const orbState = phase === 'listening' ? 'listening' : phase === 'thinking' || phase === 'transcribing' ? 'thinking' : phase === 'speaking' ? 'writing' : 'idle';
  const label = { starting: t('Starting…'), listening: t('Listening…'), transcribing: t('Got it…'), thinking: t('Thinking…'), speaking: t('Speaking…'), denied: 'Microphone access was denied. Allow it for this app and reopen voice mode.', error: t('Something went wrong') }[phase];
  return html`<div class="voice" role="dialog" aria-label=${t('Voice mode')}>
    <div style=${`transform:scale(${1 + level * 0.25});transition:transform .08s`}><${Orb} state=${orbState} onClick=${interrupt} /></div>
    <div class="cap">${cap || label}</div>
    ${cap && html`<div class="hint" style="margin-top:6px">${label}</div>`}
    <div class="hint" style="margin-top:4px">${phase === 'speaking' ? t('Tap the orb to interrupt') : phase === 'listening' ? t('Pause when you’re done, or tap the orb') : ''}${chatId ? ` · ${t('in this chat')}` : ''}</div>
    <div class="ctrls">
      <button aria-label=${t('Listen again')} onClick=${() => { st.current.audio?.pause(); window.speechSynthesis?.cancel(); clearInterval(st.current.wait); listen(); }}><${Icon} name="mic" /></button>
      <button class="end" aria-label=${t('Close')} onClick=${close}><${Icon} name="x" /></button>
    </div>
  </div>`;
}
