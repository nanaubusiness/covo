import { html, useState, useEffect, useRef } from '../../vendor/preact-htm.js';
import { Icon } from '../lib/icons.js';
import { t, getLang } from '../lib/i18n.js';
import { api } from '../api.js';
import { useStore, setUI, toast } from '../store.js';
import { StatusIcon, cx, useNow } from './ui.js';

// Topics behave like T3 Code threads:
//   Working  → the agent is on it right now (live spinner + "Working").
//   Settle   → done for now; files it under "Settled". New activity brings it back.
//   Snooze   → hidden until a time you pick, then it comes back marked unread.

export const organize = (topic, action, until) =>
  api.post(`/api/topics/${topic.id}/organize`, { action, ...(until ? { until } : {}) }).catch((e) => toast({ title: e.message, kind: 'error' }));

const loc = () => (getLang() === 'ar' ? 'ar' : undefined);
function at(daysAhead, hour) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return d;
}
function snoozeOptions() {
  const now = new Date();
  const opts = [{ label: t('In 1 hour'), until: new Date(now.getTime() + 3600e3) }];
  if (now.getHours() < 17) opts.push({ label: t('This evening'), until: at(0, 18) });
  opts.push({ label: t('Tomorrow'), until: at(1, 9) });
  let toMonday = (8 - now.getDay()) % 7 || 7;
  if (toMonday <= 1) toMonday += 7; // on Sunday, "next week" is the Monday after tomorrow
  opts.push({ label: t('Next week'), until: at(toMonday, 9) });
  return opts;
}
export function fmtUntil(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(loc(), { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  if (d - Date.now() < 6 * 86400e3) return `${d.toLocaleDateString(loc(), { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString(loc(), { month: 'short', day: 'numeric' });
}

export function TopicMenu({ topic, onClose, align = 'end' }) {
  const ref = useRef(null);
  const [custom, setCustom] = useState(false);
  useEffect(() => {
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => document.addEventListener('pointerdown', away), 0);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, []);
  const run = (action, until) => { organize(topic, action, until?.getTime?.() ?? until); onClose(); };
  const settled = !!(topic.settledAt || topic.settlePending);
  return html`<div class=${cx('topic-menu', align === 'center' && 'center')} ref=${ref} role="menu" onClick=${(e) => e.stopPropagation()}>
    ${settled
      ? html`<button role="menuitem" onClick=${() => run('unsettle')}><${Icon} name="history" size="sm" />${t('Unsettle')}</button>`
      : html`<button role="menuitem" onClick=${() => run('settle')}><${Icon} name="checkCircle" size="sm" />${topic.working ? t('Settle when done') : t('Settle')}</button>`}
    ${topic.snoozedUntil
      ? html`<button role="menuitem" onClick=${() => run('unsnooze')}><${Icon} name="bell" size="sm" />${t('Unsnooze')}</button>`
      : html`<div class="menu-label"><${Icon} name="clock" size="sm" />${t('Snooze')}</div>
        ${snoozeOptions().map((o) => html`<button role="menuitem" class="sub" onClick=${() => run('snooze', o.until)}><span class="grow">${o.label}</span><small>${fmtUntil(o.until.getTime())}</small></button>`)}
        ${custom
          ? html`<div class="sub"><input class="input" type="datetime-local" autofocus onChange=${(e) => e.target.value && run('snooze', new Date(e.target.value))} /></div>`
          : html`<button role="menuitem" class="sub" onClick=${() => setCustom(true)}>${t('Pick a time…')}</button>`}`}
    <hr />
    ${topic.unread
      ? html`<button role="menuitem" onClick=${() => run('mark_read')}><${Icon} name="eye" size="sm" />${t('Mark as read')}</button>`
      : html`<button role="menuitem" onClick=${() => run('mark_unread')}><${Icon} name="eyeOff" size="sm" />${t('Mark as unread')}</button>`}
  </div>`;
}

function TopicRow({ x, filter, onPick, menu, setMenu }) {
  const open = () => {
    setUI({ topicFilter: filter === x.id ? null : x.id, tab: 'chat' });
    if (x.unread) organize(x, 'mark_read');
    onPick?.();
  };
  const right = x.working
    ? html`<span class="working-label">${t('Working')}</span>`
    : x.snoozedUntil
      ? html`<span class="muted xs">${fmtUntil(x.snoozedUntil)}</span>`
      : x.settlePending ? html`<span class="muted xs">${t('Settling')}</span>` : null;
  return html`<div class=${cx('topic-row', menu === x.id && 'menu-open')}>
    <button class=${cx('topic-item', filter === x.id && 'on', x.unread && 'unread', (x.settledAt || x.snoozedUntil) && 'quiet')} onClick=${open}>
      <${StatusIcon} status=${x.status} emoji=${x.emoji} working=${x.working} /><span class="t">${x.title}</span>${right}${x.unread && html`<span class="unread-dot" aria-label=${t('Unread')}></span>`}
    </button>
    <button class="icon-btn sm topic-more" aria-label=${t('Topic actions')} aria-haspopup="menu" onClick=${(e) => { e.stopPropagation(); setMenu(menu === x.id ? null : x.id); }}><${Icon} name="more" size="sm" /></button>
    ${menu === x.id && html`<${TopicMenu} topic=${x} onClose=${() => setMenu(null)} />`}
  </div>`;
}

export function TopicList({ onPick, compact }) {
  const topics = useStore((s) => s.topics.filter((x) => !x.archived));
  const filter = useStore((s) => s.ui.topicFilter);
  const [menu, setMenu] = useState(null);
  const [showSnoozed, setShowSnoozed] = useState(true);
  const [showSettled, setShowSettled] = useState(false);
  useNow(30000); // keep "until" labels fresh
  if (!topics.length) return html`<div class="hint" style="padding:4px 10px">Topics appear as your agent works.</div>`;

  const rank = (x) => (x.status === 'needs_you' ? 0 : x.working ? 1 : 2);
  const active = topics.filter((x) => !x.settledAt && !x.snoozedUntil)
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt).slice(0, compact ? 12 : 40);
  const snoozed = topics.filter((x) => x.snoozedUntil && !x.settledAt).sort((a, b) => a.snoozedUntil - b.snoozedUntil);
  const settled = topics.filter((x) => x.settledAt).sort((a, b) => b.settledAt - a.settledAt).slice(0, 40);
  const row = (x) => html`<${TopicRow} key=${x.id} x=${x} filter=${filter} onPick=${onPick} menu=${menu} setMenu=${setMenu} />`;
  const group = (label, list, shown, setShown) => list.length > 0 && html`
    <button class="topic-group" aria-expanded=${shown} onClick=${() => setShown(!shown)}><${Icon} name=${shown ? 'down' : 'right'} size="sm" />${label}<span class="n">${list.length}</span></button>
    ${shown && list.map(row)}`;

  return html`
    ${active.length ? active.map(row) : html`<div class="hint" style="padding:4px 10px">${t('All caught up.')}</div>`}
    ${group(t('Snoozed'), snoozed, showSnoozed, setShowSnoozed)}
    ${group(t('Settled'), settled, showSettled, setShowSettled)}`;
}
