import { html, useState, useEffect, useRef, useLayoutEffect } from '../../vendor/preact-htm.js';
import { Icon } from '../lib/icons.js';
import { t } from '../lib/i18n.js';
import { api } from '../api.js';
import { useStore, setUI, toast } from '../store.js';
import { renderMarkdown, splitBubbles } from '../lib/md.js';
import { StatusIcon, cx, ago } from './ui.js';
import { ApprovalCard } from './Cards.js';
import { Composer } from './Composer.js';

// Separate chats: every background task, and every extra Duet you start with "New chat",
// is its own conversation with its own history. They run in parallel with the main thread.

const isChat = (x) => x.mode === 'chat';
const isWorking = (x) => ['running', 'queued'].includes(x.status);

export async function startChat(message) {
  try {
    const task = await api.post('/api/chats', { message });
    setUI({ chat: task.id, tab: 'chat', drawer: false, topicFilter: null });
  } catch (e) { toast({ title: 'Could not start chat', body: e.message }); }
}
export const openChat = (id) => setUI({ chat: id, tab: 'chat', drawer: false, topicFilter: null, panel: 'none', task: null });

/* Sidebar / drawer list */
export function ChatList({ onPick }) {
  const chats = useStore((s) => s.tasks.filter(isChat));
  const cur = useStore((s) => s.ui.chat);
  const sorted = [...chats].sort((a, b) => (isWorking(b) - isWorking(a)) || b.updatedAt - a.updatedAt).slice(0, 30);
  return html`
    <button class=${cx('topic-item', cur === 'new' && 'on')} onClick=${() => { setUI({ chat: 'new', tab: 'chat', topicFilter: null }); onPick?.(); }}><${Icon} name="plus" size="sm" /><span class="t">${t('New chat')}</span></button>
    ${sorted.map((x) => html`<button class=${cx('topic-item', cur === x.id && 'on')} onClick=${() => { openChat(x.id); onPick?.(); }}>
      <${StatusIcon} status=${x.status === 'needs_you' ? 'needs_you' : 'in_progress'} working=${isWorking(x)} />
      <span class="t">${x.title}</span>${isWorking(x) ? html`<span class="working-label">${t('Working')}</span>` : html`<span class="muted xs">${ago(x.updatedAt)}</span>`}
    </button>`)}`;
}

function Step({ s }) {
  if (s.kind === 'user') return html`<div class="msg me"><div class="bubble me" dir="auto">${s.text}</div></div>`;
  if (s.kind === 'assistant' || s.kind === 'report') {
    return html`<div class="msg">${splitBubbles(s.text).map((p) => html`<div dir="auto" class="bubble ai" dangerouslySetInnerHTML=${{ __html: renderMarkdown(p) }}></div>`)}
      ${s.kind === 'report' && html`<span class="meta-time">Also posted in the main chat</span>`}</div>`;
  }
  if (s.kind === 'tool') return html`<div class="chat-tool"><${Icon} name="zap" size="sm" /><span>${s.text}</span></div>`;
  if (s.kind === 'error') return html`<div class="error-note">${s.text}</div>`;
  if (s.kind === 'created') return html`<div class="chat-note"><b>Task</b> ${s.text}</div>`;
  return html`<div class="chat-note">${s.text}</div>`; // update / event
}

/* The conversation of one task or chat */
export function ChatView({ id, variant = 'm' }) {
  const task = useStore((s) => s.tasks.find((x) => x.id === id));
  const stream = useStore((s) => s.taskStream?.[id] || '');
  const approvals = useStore((s) => s.approvals.filter((a) => a.taskId === id && a.status === 'pending'));
  const [steps, setSteps] = useState(null);
  const scroller = useRef(null);
  useEffect(() => { api.get(`/api/tasks/${id}`).then((r) => setSteps(r.steps || [])).catch(() => setSteps([])); }, [id, task?.updatedAt]);
  useLayoutEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [steps?.length, stream.length, approvals.length]);
  if (!task) return html`<div class="chat-empty">${t('This chat no longer exists.')}</div>`;
  const working = isWorking(task);
  const act = (action) => api.post(`/api/tasks/${id}/action`, { action }).catch((e) => toast({ title: e.message }));
  return html`<div class=${cx('chat-view', variant)}>
    <div class="chat-head">
      <button class="icon-btn" aria-label=${t('Back to main chat')} title=${t('Main chat')} onClick=${() => setUI({ chat: null })}><${Icon} name="left" /></button>
      <div class="grow" style="min-width:0">
        <b class="chat-title">${task.title}</b>
        <small class="muted">${isChat(task) ? t('Separate chat') : t('Task')} · ${working ? html`<span class="working-label">${t('Working')}</span>` : task.status === 'needs_you' ? t('Needs you') : task.status === 'idle' ? t('Waiting for you') : t(task.status)}</small>
      </div>
      ${working && html`<button class="btn ghost sm" onClick=${() => act('pause')}><${Icon} name="pause" size="sm" />${t('Pause')}</button>`}
      ${task.status === 'paused' && html`<button class="btn ghost sm" onClick=${() => act('resume')}><${Icon} name="play" size="sm" />${t('Resume')}</button>`}
      ${!isChat(task) && html`<button class="icon-btn" title=${t('Details')} aria-label=${t('Details')} onClick=${() => setUI({ task: id, panel: 'task' })}><${Icon} name="info" /></button>`}
    </div>
    <div class="scroll chat-scroll" ref=${scroller}>
      <div class=${cx('feed', variant === 'd' && 'd-center')}><div class="feed-inner">
        ${steps === null ? html`<div class="hint">${t('Loading…')}</div>` : steps.map((s) => html`<${Step} s=${s} />`)}
        ${stream && html`<div class="msg">${splitBubbles(stream).map((p) => html`<div dir="auto" class="bubble ai" dangerouslySetInnerHTML=${{ __html: renderMarkdown(p) }}></div>`)}</div>`}
        ${approvals.map((a) => html`<${ApprovalCard} id=${a.id} />`)}
        ${working && !stream && html`<div class="typing" aria-label="typing"><i></i><i></i><i></i></div>`}
      </div></div>
    </div>
  </div>`;
}

export function ChatComposer({ id }) {
  const task = useStore((s) => s.tasks.find((x) => x.id === id));
  if (!task) return null;
  const send = (message) => api.post(`/api/tasks/${id}/action`, { message }).catch((e) => toast({ title: 'Not sent', body: e.message }));
  return html`<${Composer} onSend=${send} placeholder=${isChat(task) ? t('Message this chat') : t('Message this task')} />`;
}

/* Starting a new parallel Duet */
export function NewChatView({ variant = 'm' }) {
  return html`<div class=${cx('chat-view', variant)}>
    <div class="chat-head">
      <button class="icon-btn" aria-label=${t('Back to main chat')} onClick=${() => setUI({ chat: null })}><${Icon} name="left" /></button>
      <div class="grow"><b class="chat-title">${t('New chat')}</b><small class="muted">${t('A separate Duet that works in parallel with your main chat')}</small></div>
    </div>
    <div class="chat-empty"><h2>${t('What should this Duet work on?')}</h2><div class="muted">${t('It has the same tools, memory and permissions, its own conversation, and keeps going while you use other chats.')}</div></div>
  </div>`;
}
export function NewChatComposer() {
  return html`<${Composer} onSend=${startChat} placeholder=${t('Start a new chat…')} autoFocus />`;
}
