import { getSettings } from './config.js';
import { log } from './util.js';

// Your Claude subscription's usage limits, the same numbers Claude Code's /usage shows.
// Asked through the official Agent SDK (Claude Code reads them with your own login); this does
// not run the model and costs nothing. The SDK marks this call experimental, so failures are soft.
const SDK = '@anthropic-ai/claude-agent-sdk';
let cache = null; // { at, data }
let inflight = null;

const WINDOWS = [
  ['five_hour', 'Current session', '5-hour window'],
  ['seven_day', 'This week', 'All models'],
  ['seven_day_opus', 'This week: Opus', 'Opus only'],
  ['seven_day_sonnet', 'This week: Sonnet', 'Sonnet only'],
  ['seven_day_oauth_apps', 'This week: apps', 'Apps signed in with Claude'],
];

function normalize(u) {
  const rl = u.rate_limits || {};
  const windows = [];
  for (const [key, label, hint] of WINDOWS) {
    const w = rl[key];
    if (w && w.utilization !== null && w.utilization !== undefined) windows.push({ key, label, hint, percent: w.utilization, resetsAt: w.resets_at });
  }
  for (const m of rl.model_scoped || []) if (m.utilization !== null) windows.push({ key: `model:${m.display_name}`, label: `This week: ${m.display_name}`, hint: `${m.display_name} only`, percent: m.utilization, resetsAt: m.resets_at });
  const ex = rl.extra_usage;
  return {
    subscription: u.subscription_type,
    available: !!u.rate_limits_available,
    windows,
    extraUsage: ex ? { enabled: !!ex.is_enabled, used: ex.used_credits, limit: ex.monthly_limit, percent: ex.utilization, currency: ex.currency } : null,
    breakdown: (rl.seven_day_breakdown?.rows || []).map((r) => ({ label: r.display_name, percent: r.percent })),
    fetchedAt: Date.now(),
  };
}

async function fetchUsage() {
  const sdk = await import(SDK);
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete env[k];
  const ac = new AbortController();
  let release;
  const hold = new Promise((r) => (release = r));
  async function* input() { await hold; } // keep Claude Code open without sending a prompt
  const c = getSettings().provider.claudeSub || {};
  const q = sdk.query({ prompt: input(), options: { tools: [], settingSources: [], persistSession: false, env, abortController: ac, cwd: '/tmp', ...(c.claudePath ? { pathToClaudeCodeExecutable: c.claudePath } : {}) } });
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    return normalize(await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
  } finally {
    clearTimeout(timer); release(); ac.abort();
  }
}

export async function getPlanUsage({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.data;
  inflight ||= fetchUsage().then((data) => { cache = { at: Date.now(), data }; return data; }).finally(() => { inflight = null; });
  try { return await inflight; }
  catch (e) {
    log.warn('plan usage:', e.message);
    if (cache) return { ...cache.data, stale: true };
    throw Object.assign(new Error(`Couldn't read your Claude plan usage: ${e.message}`), { status: 502 });
  }
}
